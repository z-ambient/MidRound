// MidRound — API server
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');
const faceit = require('./faceit');
const { rateLimit, clientIp, TRUSTED_PROXY_HOPS } = require('./rate-limit');
const { installStarterStrategies } = require('./starter-strategies');
const v = require('./validate');

const app = express();
const PORT = process.env.PORT || 4310;
const SESSION_DAYS = 30;

// Database access is async (Postgres driver), so every handler that touches
// the database is an async function. Express 4 does not forward a rejected
// async handler to the error middleware on its own — this wrapper does.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Legitimate MidRound payloads (even a fully detailed strategy) are a few KB;
// 64 KB is generous and stops a client posting megabytes into JSON columns.
app.use(express.json({ limit: '64kb' }));
app.disable('x-powered-by');

// Turn body-parser failures into the app's generic JSON error shape. The
// default Express error page would echo details of the rejected input back;
// we never do that.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  next(err);
});

// ---------- rate limits ----------
// Per-IP budgets (keyed by the spoof-resistant clientIp in rate-limit.js):
// - auth actions happen a handful of times per session; 10/minute never
//   touches a real user but shuts down scripted abuse
// - /api/me is polled on page load and gets more headroom
// - writes are bounded so one client can't hammer the database
// - FACEIT routes spend the team's server-side API key (and its own quota),
//   so they get the tightest shared budget
// - the demo hint is read on every visit to the login page and must not
//   compete with /api/me for the same budget: exhausting it used to make the
//   hint disappear, which looks like the demo account was removed
const authLimiter = rateLimit({ max: 10 });
const meLimiter = rateLimit({ max: 30 });
const demoLimiter = rateLimit({ max: 120 });
const writeLimiter = rateLimit({ max: 120 });
const faceitLimiter = rateLimit({ max: 10 });

// One write budget across all non-auth API writes (auth has its own limiter).
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.path.startsWith('/auth/')) return next();
  return writeLimiter(req, res, next);
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  next();
});

// ---------- helpers ----------
const now = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const parseJ = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

function getCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// Is this request really HTTPS? We never enable Express "trust proxy"
// globally (that would let any client spoof req.ip and req.secure with one
// header). Instead: direct TLS counts, an explicit COOKIE_SECURE=1 override
// counts, and behind a configured trusted proxy we read X-Forwarded-Proto
// from the trusted (rightmost) end only — same reasoning as clientIp.
function requestIsSecure(req) {
  if (process.env.COOKIE_SECURE === '1') return true;
  if (req.secure) return true;
  if (TRUSTED_PROXY_HOPS > 0) {
    const protos = String(req.headers['x-forwarded-proto'] || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (protos.length) return protos[protos.length - 1] === 'https';
  }
  return false;
}

// Session cookie: HttpOnly (no script access), SameSite=Lax (CSRF cushion),
// and Secure whenever the request actually arrived over HTTPS so the browser
// never sends the token in cleartext.
function sessionCookieFlags(req) {
  return `HttpOnly; SameSite=Lax; Path=/${requestIsSecure(req) ? '; Secure' : ''}`;
}

function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie',
    `mr_session=${token}; ${sessionCookieFlags(req)}; Max-Age=${SESSION_DAYS * 86400}`);
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `mr_session=; ${sessionCookieFlags(req)}; Max-Age=0`);
}

// Failed-login tracker (on top of the per-minute authLimiter): 20 wrong
// passwords per 15 minutes per IP, keyed by the spoof-resistant clientIp.
const loginAttempts = new Map();
function loginLimited(ip) {
  const rec = loginAttempts.get(ip) || { n: 0, ts: Date.now() };
  if (Date.now() - rec.ts > 15 * 60 * 1000) { rec.n = 0; rec.ts = Date.now(); }
  return rec.n >= 20;
}
function noteLoginFail(ip) {
  const rec = loginAttempts.get(ip) || { n: 0, ts: Date.now() };
  rec.n++;
  loginAttempts.set(ip, rec);
}

// ---------- auth middleware ----------
const auth = ah(async (req, res, next) => {
  const token = getCookies(req).mr_session;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const sess = await db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
  if (!sess || sess.expires_at < now()) {
    if (sess) await db.run('DELETE FROM sessions WHERE id = ?', sess.id);
    return res.status(401).json({ error: 'Session expired' });
  }
  req.user = await db.get('SELECT id, email, name FROM users WHERE id = ?', sess.user_id);
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
});

async function orgRole(userId, orgId) {
  const m = await db.get('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?', orgId, userId);
  return m ? m.role : null;
}

async function teamAccess(req, teamId) {
  const team = await db.get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!team) return null;
  const role = await orgRole(req.user.id, team.org_id);
  return role ? { team, role } : null;
}

// access model: owner (everything + team management), edit (all content), view (read only).
// Match Mode is available to every member.
const CAN = {
  strategies: ['owner', 'edit'],
  scouting:   ['owner', 'edit'],
  matches:    ['owner', 'edit'],
  team:       ['owner'],
};

// Resolve team access + domain permission. Sends the error response itself
// and returns null when denied, so callers can simply `if (!gate) return`.
async function gateTeam(req, res, teamId, domain) {
  if (!teamId) { res.status(404).json({ error: 'Not found' }); return null; }
  const access = await teamAccess(req, teamId);
  if (!access) { res.status(403).json({ error: 'No access to this team' }); return null; }
  if (domain && !CAN[domain].includes(access.role)) {
    res.status(403).json({ error: 'Your role cannot make this change' });
    return null;
  }
  req.access = access;
  req.teamId = teamId;
  return access;
}

// requires access + write permission for a domain; attaches req.access
function requireTeam(domain) {
  return ah(async (req, res, next) => {
    const teamId = Number(req.params.teamId || req.teamId);
    // missing team behaves like no access (403), same as always
    const access = teamId ? await gateTeam(req, res, teamId, domain) : await gateTeam(req, res, -1, domain);
    if (access) next();
  });
}

// resolve a child resource -> team, then check
async function resourceTeam(kind, id) {
  const q = {
    opponent: 'SELECT team_id FROM opponents WHERE id = ?',
    match: 'SELECT team_id FROM matches WHERE id = ?',
    team_player: 'SELECT team_id FROM team_players WHERE id = ?',
  }[kind];
  const row = await db.get(q, id);
  return row ? row.team_id : null;
}

// Strategy access: strategies are personal (created_by) and optionally
// designated into team strategy banks (team_strategies). The creator can do
// everything; members of a team the strategy is shared with can view it.
// Returns { strategy, creator } or null.
async function strategyAccess(req, id) {
  const strategy = await db.get('SELECT * FROM strategies WHERE id = ?', id);
  if (!strategy) return null;
  if (strategy.created_by === req.user.id) return { strategy, creator: true };
  const shares = await db.all('SELECT team_id FROM team_strategies WHERE strategy_id = ?', id);
  for (const s of shares) {
    if (await teamAccess(req, s.team_id)) return { strategy, creator: false };
  }
  return null;
}

// mode 'view': creator or member of a team it's shared with.
// mode 'edit': creator only — sharing to a team never grants edit rights.
// No access answers 404 (not 403) so foreign strategy ids stay unconfirmed.
function requireStrategy(mode) {
  return ah(async (req, res, next) => {
    const access = await strategyAccess(req, Number(req.params.id));
    if (!access) return res.status(404).json({ error: 'Not found' });
    if (mode === 'edit' && !access.creator) {
      return res.status(403).json({ error: 'Only the creator can change this strategy' });
    }
    req.strategy = access.strategy;
    req.strategyCreator = access.creator;
    next();
  });
}

function requireResource(kind, domain) {
  return ah(async (req, res, next) => {
    const teamId = await resourceTeam(kind, Number(req.params.id));
    if (await gateTeam(req, res, teamId, domain)) next();
  });
}

// ---------- auth routes ----------
app.post('/api/auth/register', authLimiter, ah(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (typeof email !== 'string' || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  // bcrypt only reads the first 72 bytes; reject longer so nothing is silently ignored
  if (password.length > 72) return res.status(400).json({ error: 'Password must be at most 72 characters' });
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const lenErr = v.firstError(v.requiredString(name, 'Name', 80));
  if (lenErr) return res.status(400).json({ error: lenErr });
  if (await db.get('SELECT id FROM users WHERE email = ?', email.toLowerCase())) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  // The account starts with no organization — the user creates one or joins
  // via invite from inside the app (POST /api/orgs, /api/invites/redeem).
  const t = now();
  const userId = (await db.run(
    'INSERT INTO users (email, name, password_hash, created_at) VALUES (?,?,?,?) RETURNING id',
    email.toLowerCase(), name.trim(), bcrypt.hashSync(password, 10), t)).id;

  // A personal T and CT default per map, so the new account opens on a library
  // and a Match Mode board with something in them. Never fatal: an account
  // without its starters beats a signup that failed at the last step.
  try {
    await installStarterStrategies(userId, t);
  } catch (e) {
    console.error(`[midround] starter strategies failed for user ${userId}: ${e.message}`);
  }

  const token = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    sha256(token), userId, t, new Date(Date.now() + SESSION_DAYS * 86400000).toISOString());
  setSessionCookie(req, res, token);
  res.json({ ok: true });
}));

app.post('/api/auth/login', authLimiter, ah(async (req, res) => {
  const ip = clientIp(req);
  if (loginLimited(ip)) return res.status(429).json({ error: 'Too many attempts — try again in a few minutes' });
  const { email, password } = req.body || {};
  const user = (typeof email === 'string' && email.length <= 254)
    ? await db.get('SELECT * FROM users WHERE email = ?', email.toLowerCase()) : null;
  if (!user || !bcrypt.compareSync(String(password || '').slice(0, 72), user.password_hash)) {
    noteLoginFail(ip);
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    sha256(token), user.id, now(), new Date(Date.now() + SESSION_DAYS * 86400000).toISOString());
  setSessionCookie(req, res, token);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', authLimiter, auth, ah(async (req, res) => {
  const token = getCookies(req).mr_session;
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  clearSessionCookie(req, res);
  res.json({ ok: true });
}));

// Does this install actually have the demo workspace? The login page only
// offers the demo sign-in when the answer is yes: production skips the demo
// seed, and a hint for an account that does not exist just looks broken.
// The credentials are the demo's published ones (the page prints them), and
// are returned only when that seeded account really is present.
app.get('/api/demo', demoLimiter, ah(async (req, res) => {
  // required lazily: db.js keeps production from ever loading the seeder, and
  // this only reads its constants — it never seeds.
  const { DEMO_LOGIN } = require('./seed');
  const exists = await db.get('SELECT 1 AS x FROM users WHERE email = ?', DEMO_LOGIN.email);
  res.json(exists ? { available: true, ...DEMO_LOGIN } : { available: false });
}));

app.get('/api/me', meLimiter, auth, ah(async (req, res) => {
  const orgs = await db.all(`
    SELECT o.id, o.name, m.role FROM organizations o
    JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ?`, req.user.id);
  const teams = orgs.length ? await db.all(`
    SELECT t.id, t.org_id, t.name FROM teams t
    WHERE t.org_id IN (${orgs.map(() => '?').join(',')})`, ...orgs.map(o => o.id)) : [];
  res.json({ user: req.user, orgs, teams });
}));

// ---------- organizations ----------
// In-app onboarding: create a new organization (+ first team); caller becomes owner.
app.post('/api/orgs', auth, ah(async (req, res) => {
  const { name, teamName } = req.body || {};
  const lenErr = v.firstError(
    v.requiredString(name, 'Organization name', 120),
    v.optionalString(teamName, 'Team name', 80),
  );
  if (lenErr) return res.status(400).json({ error: lenErr });
  const t = now();
  const orgId = (await db.run('INSERT INTO organizations (name, created_at) VALUES (?,?) RETURNING id', name.trim(), t)).id;
  await db.run('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)', orgId, req.user.id, 'owner');
  const teamId = (await db.run('INSERT INTO teams (org_id, name) VALUES (?,?) RETURNING id',
    orgId, (teamName || '').trim() || 'Main Team')).id;
  res.json({ ok: true, org_id: orgId, team_id: teamId });
}));

// ---------- maps ----------
app.get('/api/maps', auth, ah(async (req, res) => {
  res.json(await db.all('SELECT * FROM maps WHERE active = 1 ORDER BY name'));
}));
app.post('/api/maps', auth, ah(async (req, res) => {
  // adding a map requires edit rights in at least one org
  const anyEditor = await db.get(`SELECT 1 AS x FROM org_members WHERE user_id = ? AND role IN ('owner','edit')`, req.user.id);
  if (!anyEditor) return res.status(403).json({ error: 'Your role cannot add maps' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Map name required' });
  if (name.length > 50) return res.status(400).json({ error: 'Map name must be at most 50 characters' });
  try {
    await db.run('INSERT INTO maps (name, active) VALUES (?,1)', name);
  } catch { return res.status(409).json({ error: 'Map already exists' }); }
  res.json({ ok: true });
}));

// ---------- strategies ----------
const STRAT_JSON = ['tags', 'steps', 'roles', 'timings', 'midround', 'reactions', 'warnings', 'attachments'];

// Shared checks for creating/updating a strategy. On updates (partial=true)
// a field is only checked when the client actually sent it.
function strategyError(b, partial) {
  const has = (k) => !partial || b[k] !== undefined;
  return v.firstError(
    has('name') && v.requiredString(b.name, 'Name', 120),
    has('map') && v.requiredString(b.map, 'Map', 50),
    has('side') && v.oneOf(b.side, 'Side', ['T', 'CT']),
    v.optionalString(b.category, 'Category', 50),
    v.optionalString(b.buy_type, 'Buy type', 30),
    v.optionalString(b.site, 'Site', 50),
    v.optionalString(b.map_area, 'Map area', 120),
    v.optionalOneOf(b.difficulty, 'Difficulty', ['basic', 'standard', 'advanced']),
    v.optionalString(b.spawn_dependency, 'Spawn dependency', 2000),
    v.optionalString(b.required_utility, 'Required utility', 2000),
    v.optionalString(b.objective, 'Objective', 5000),
    v.optionalString(b.summary, 'Summary', 5000),
    v.optionalString(b.backup, 'Backup plan', 5000),
    v.stringArray(b.tags, 'Tags', { maxItems: 30, maxLen: 60 }),
    v.stringArray(b.steps, 'Steps'),
    v.stringArray(b.timings, 'Timings'),
    v.stringArray(b.midround, 'Mid-round calls'),
    v.stringArray(b.reactions, 'Reactions'),
    v.stringArray(b.warnings, 'Warnings'),
    v.objectArray(b.roles, 'Roles', { maxItems: 20 }),
    v.attachmentList(b.attachments),
  );
}

async function stratOut(row, userId) {
  if (!row) return null;
  const out = { ...row };
  for (const k of STRAT_JSON) out[k] = parseJ(row[k], []);
  if (userId != null) {
    out.favorite = !!(await db.get('SELECT 1 AS x FROM favorites WHERE user_id = ? AND strategy_id = ?', userId, row.id));
  }
  const creator = row.created_by ? await db.get('SELECT name FROM users WHERE id = ?', row.created_by) : null;
  out.created_by_name = creator ? creator.name : null;
  // which team banks this strategy has been added to ("In Team Strats" state)
  out.shared_team_ids = (await db.all('SELECT team_id FROM team_strategies WHERE strategy_id = ?', row.id))
    .map(r => r.team_id);
  return out;
}

// Appends the library filters (map/side/buy/status/tag/text) to a strategy
// list query. Column names are prefixed with the `s` alias so the same code
// serves the personal list and the team-bank join.
function stratListFilters(q, sql, args) {
  const eq = { map: 'map', side: 'side', category: 'category', buy_type: 'buy_type', site: 'site', difficulty: 'difficulty', status: 'status' };
  for (const [param, col] of Object.entries(eq)) {
    if (q[param]) { sql += ` AND s.${col} = ?`; args.push(q[param]); }
  }
  if (!q.status) sql += ` AND s.status != 'archived'`;
  if (q.tag) { sql += ` AND s.tags LIKE ?`; args.push(`%"${q.tag}"%`); }
  if (q.q) {
    sql += ` AND (s.name LIKE ? OR s.summary LIKE ? OR s.objective LIKE ? OR s.tags LIKE ?)`;
    const like = `%${q.q}%`;
    args.push(like, like, like, like);
  }
  return sql + ' ORDER BY s.updated_at DESC';
}

// the signed-in user's personal strategies — no team required
app.get('/api/strategies', auth, ah(async (req, res) => {
  const args = [req.user.id];
  const sql = stratListFilters(req.query, 'SELECT s.* FROM strategies s WHERE s.created_by = ?', args);
  const rows = await db.all(sql, ...args);
  res.json(await Promise.all(rows.map(r => stratOut(r, req.user.id))));
}));

// a team's strategy bank: personal strategies designated via team_strategies
app.get('/api/teams/:teamId/strategies', auth, requireTeam(null), ah(async (req, res) => {
  const args = [req.access.team.id];
  const sql = stratListFilters(req.query, `SELECT s.*, ts.added_by AS shared_by
    FROM strategies s JOIN team_strategies ts ON ts.strategy_id = s.id WHERE ts.team_id = ?`, args);
  const rows = await db.all(sql, ...args);
  res.json(await Promise.all(rows.map(r => stratOut(r, req.user.id))));
}));

// New strategies are always personal. There is no create-into-team-bank route;
// the bank is populated by sharing an existing personal strategy below.
app.post('/api/strategies', auth, ah(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.map || !b.side) {
    return res.status(400).json({ error: 'Name, map, and side are required' });
  }
  const err = strategyError(b, false);
  if (err) return res.status(400).json({ error: err });
  b.category = b.category || 'General';
  const t = now();
  const id = (await db.run(`INSERT INTO strategies
    (name, map, side, category, buy_type, site, map_area, tags, difficulty, spawn_dependency, required_utility,
     objective, summary, steps, roles, timings, midround, reactions, backup, warnings, attachments, status, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    b.name, b.map, b.side, b.category, b.buy_type || null, b.site || null, b.map_area || null,
    JSON.stringify(b.tags || []), b.difficulty || 'standard', b.spawn_dependency || null, b.required_utility || null,
    b.objective || null, b.summary || null, JSON.stringify(b.steps || []), JSON.stringify(b.roles || []),
    JSON.stringify(b.timings || []), JSON.stringify(b.midround || []), JSON.stringify(b.reactions || []),
    b.backup || null, JSON.stringify(b.warnings || []), JSON.stringify(b.attachments || []),
    b.status === 'draft' ? 'draft' : 'active', req.user.id, t, t
  )).id;
  res.json(await stratOut(await db.get('SELECT * FROM strategies WHERE id = ?', id), req.user.id));
}));

// "Add to Team Strats": designate one of your personal strategies into a team
// bank. Requires being its creator AND having edit rights on that team.
app.post('/api/strategies/:id/share', auth, requireStrategy('edit'), ah(async (req, res) => {
  const teamId = Number(req.body?.team_id);
  if (!(await gateTeam(req, res, teamId, 'strategies'))) return;
  await db.run(`INSERT INTO team_strategies (strategy_id, team_id, added_by, created_at)
    VALUES (?,?,?,?) ON CONFLICT DO NOTHING`, req.strategy.id, teamId, req.user.id, now());
  res.json(await stratOut(await db.get('SELECT * FROM strategies WHERE id = ?', req.strategy.id), req.user.id));
}));

// Remove from Team Strats — only the designation goes away, never the
// strategy. Allowed for the creator, or a team owner curating the bank.
app.delete('/api/strategies/:id/share/:teamId', auth, requireStrategy('view'), ah(async (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!req.strategyCreator) {
    const access = await teamAccess(req, teamId);
    if (!access || !CAN.team.includes(access.role)) {
      return res.status(403).json({ error: 'Only the creator or a team owner can remove this from Team Strats' });
    }
  }
  await db.run('DELETE FROM team_strategies WHERE strategy_id = ? AND team_id = ?', req.strategy.id, teamId);
  res.json(await stratOut(await db.get('SELECT * FROM strategies WHERE id = ?', req.strategy.id), req.user.id));
}));

app.get('/api/strategies/:id', auth, requireStrategy('view'), ah(async (req, res) => {
  res.json(await stratOut(req.strategy, req.user.id));
}));

app.put('/api/strategies/:id', auth, requireStrategy('edit'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const err = strategyError(b, true);
  if (err) return res.status(400).json({ error: err });
  const cur = await db.get('SELECT * FROM strategies WHERE id = ?', id);
  const val = (k, d) => (b[k] !== undefined ? b[k] : d);
  await db.run(`UPDATE strategies SET
    name=?, map=?, side=?, category=?, buy_type=?, site=?, map_area=?, tags=?, difficulty=?, spawn_dependency=?,
    required_utility=?, objective=?, summary=?, steps=?, roles=?, timings=?, midround=?, reactions=?, backup=?,
    warnings=?, attachments=?, status=?, updated_at=? WHERE id=?`,
    val('name', cur.name), val('map', cur.map), val('side', cur.side), val('category', cur.category),
    val('buy_type', cur.buy_type), val('site', cur.site), val('map_area', cur.map_area),
    JSON.stringify(val('tags', parseJ(cur.tags, []))), val('difficulty', cur.difficulty),
    val('spawn_dependency', cur.spawn_dependency), val('required_utility', cur.required_utility),
    val('objective', cur.objective), val('summary', cur.summary),
    JSON.stringify(val('steps', parseJ(cur.steps, []))), JSON.stringify(val('roles', parseJ(cur.roles, []))),
    JSON.stringify(val('timings', parseJ(cur.timings, []))), JSON.stringify(val('midround', parseJ(cur.midround, []))),
    JSON.stringify(val('reactions', parseJ(cur.reactions, []))), val('backup', cur.backup),
    JSON.stringify(val('warnings', parseJ(cur.warnings, []))), JSON.stringify(val('attachments', parseJ(cur.attachments, []))),
    ['active', 'draft', 'archived'].includes(b.status) ? b.status : cur.status, now(), id
  );
  res.json(await stratOut(await db.get('SELECT * FROM strategies WHERE id = ?', id), req.user.id));
}));

// duplicating makes a fresh personal draft of your own — copies are never
// auto-shared to any team bank
app.post('/api/strategies/:id/duplicate', auth, requireStrategy('edit'), ah(async (req, res) => {
  const cur = req.strategy;
  const t = now();
  const id = (await db.run(`INSERT INTO strategies
    (name, map, side, category, buy_type, site, map_area, tags, difficulty, spawn_dependency, required_utility,
     objective, summary, steps, roles, timings, midround, reactions, backup, warnings, attachments, status, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    cur.name + ' (copy)', cur.map, cur.side, cur.category, cur.buy_type, cur.site, cur.map_area,
    cur.tags, cur.difficulty, cur.spawn_dependency, cur.required_utility, cur.objective, cur.summary,
    cur.steps, cur.roles, cur.timings, cur.midround, cur.reactions, cur.backup, cur.warnings, cur.attachments,
    'draft', req.user.id, t, t
  )).id;
  res.json(await stratOut(await db.get('SELECT * FROM strategies WHERE id = ?', id), req.user.id));
}));

app.delete('/api/strategies/:id', auth, requireStrategy('edit'), ah(async (req, res) => {
  if (req.strategy.status !== 'archived') return res.status(400).json({ error: 'Archive a strategy before deleting it permanently' });
  await db.run('DELETE FROM strategies WHERE id = ?', req.strategy.id);
  res.json({ ok: true });
}));

app.post('/api/strategies/:id/favorite', auth, requireStrategy('view'), ah(async (req, res) => {
  await db.run('INSERT INTO favorites (user_id, strategy_id) VALUES (?,?) ON CONFLICT DO NOTHING',
    req.user.id, Number(req.params.id));
  res.json({ ok: true });
}));
app.delete('/api/strategies/:id/favorite', auth, requireStrategy('view'), ah(async (req, res) => {
  await db.run('DELETE FROM favorites WHERE user_id = ? AND strategy_id = ?', req.user.id, Number(req.params.id));
  res.json({ ok: true });
}));

// ---------- opponents ----------
async function oppOut(row) {
  if (!row) return null;
  const players = await db.all('SELECT * FROM opponent_players WHERE opponent_id = ? ORDER BY name', row.id);
  const tendencies = await db.all(`
    SELECT td.*, op.name AS player_name FROM tendencies td
    LEFT JOIN opponent_players op ON op.id = td.opponent_player_id
    WHERE td.opponent_id = ? ORDER BY td.severity = 'high' DESC, td.id`, row.id);
  return { ...row, players, tendencies, faceit_intel: parseJ(row.faceit_intel, null) };
}

app.get('/api/teams/:teamId/opponents', auth, requireTeam(null), ah(async (req, res) => {
  const rows = await db.all('SELECT * FROM opponents WHERE team_id = ? ORDER BY name', req.access.team.id);
  const out = [];
  for (const r of rows) {
    out.push({
      ...r,
      player_count: (await db.get('SELECT COUNT(*) AS c FROM opponent_players WHERE opponent_id = ?', r.id)).c,
      tendency_count: (await db.get('SELECT COUNT(*) AS c FROM tendencies WHERE opponent_id = ?', r.id)).c,
      key_count: (await db.get(`SELECT COUNT(*) AS c FROM tendencies WHERE opponent_id = ? AND severity = 'high'`, r.id)).c,
    });
  }
  res.json(out);
}));

// Shared checks for creating/updating an opponent (partial=true on updates).
function opponentError(b, partial) {
  const has = (k) => !partial || b[k] !== undefined;
  return v.firstError(
    has('name') && v.requiredString(b.name, 'Opponent name', 120),
    v.optionalString(b.org_name, 'Organization name', 120),
    v.optionalString(b.playstyle, 'Playstyle', 5000),
    v.optionalString(b.map_pool, 'Map pool', 1000),
    v.optionalString(b.preferred_picks, 'Preferred picks', 1000),
    v.optionalString(b.preferred_bans, 'Preferred bans', 1000),
    v.optionalString(b.econ_notes, 'Economy notes', 5000),
    v.optionalString(b.notes, 'Notes', 5000),
  );
}

app.post('/api/teams/:teamId/opponents', auth, requireTeam('scouting'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Opponent name required' });
  const err = opponentError(b, false);
  if (err) return res.status(400).json({ error: err });
  const t = now();
  const id = (await db.run(`INSERT INTO opponents
    (team_id, name, org_name, playstyle, map_pool, preferred_picks, preferred_bans, econ_notes, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    req.access.team.id, b.name, b.org_name || null, b.playstyle || null, b.map_pool || null,
    b.preferred_picks || null, b.preferred_bans || null, b.econ_notes || null, b.notes || null, t, t
  )).id;
  res.json(await oppOut(await db.get('SELECT * FROM opponents WHERE id = ?', id)));
}));

app.get('/api/opponents/:id', auth, requireResource('opponent', null), ah(async (req, res) => {
  res.json(await oppOut(await db.get('SELECT * FROM opponents WHERE id = ?', Number(req.params.id))));
}));

app.put('/api/opponents/:id', auth, requireResource('opponent', 'scouting'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.get('SELECT * FROM opponents WHERE id = ?', id);
  const b = req.body || {};
  const err = opponentError(b, true);
  if (err) return res.status(400).json({ error: err });
  const val = (k) => (b[k] !== undefined ? b[k] : cur[k]);
  await db.run(`UPDATE opponents SET name=?, org_name=?, playstyle=?, map_pool=?, preferred_picks=?,
    preferred_bans=?, econ_notes=?, notes=?, updated_at=? WHERE id=?`,
    val('name'), val('org_name'), val('playstyle'), val('map_pool'), val('preferred_picks'),
    val('preferred_bans'), val('econ_notes'), val('notes'), now(), id);
  res.json(await oppOut(await db.get('SELECT * FROM opponents WHERE id = ?', id)));
}));

// pull recent form + per-map win rates for a FACEIT-linked opponent and store them
app.post('/api/opponents/:id/faceit-intel', faceitLimiter, auth, requireResource('opponent', 'scouting'), ah(async (req, res) => {
  const opp = await db.get('SELECT * FROM opponents WHERE id = ?', Number(req.params.id));
  if (!opp.faceit_team_id) return res.status(400).json({ error: 'This opponent is not linked to a FACEIT team' });
  const team = await db.get('SELECT faceit_api_key FROM teams WHERE id = ?', opp.team_id);
  if (!team.faceit_api_key) return res.status(400).json({ error: 'Connect FACEIT on the Team page first' });
  try {
    const intel = await faceit.teamIntel(team.faceit_api_key, opp.faceit_team_id);
    await db.run('UPDATE opponents SET faceit_intel = ? WHERE id = ?', JSON.stringify(intel), opp.id);
    res.json(await oppOut(await db.get('SELECT * FROM opponents WHERE id = ?', opp.id)));
  } catch (e) {
    res.status(502).json({ error: e.code === 404 ? 'FACEIT has no stats for this team yet' : e.message });
  }
}));

app.delete('/api/opponents/:id', auth, requireResource('opponent', 'scouting'), ah(async (req, res) => {
  await db.run('DELETE FROM opponents WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
}));

// opponent players
// Shared checks for creating/updating an opponent player (partial on update).
function opponentPlayerError(b, partial) {
  const has = (k) => !partial || b[k] !== undefined;
  return v.firstError(
    has('name') && v.requiredString(b.name, 'Player name', 80),
    v.optionalString(b.role, 'Role', 80),
    v.optionalString(b.positions, 'Positions', 2000),
    v.optionalString(b.weapons, 'Weapons', 1000),
    v.optionalOneOf(b.aggression, 'Aggression', ['passive', 'balanced', 'aggressive']),
    v.optionalString(b.habits, 'Habits', 2000),
    v.optionalString(b.weaknesses, 'Weaknesses', 2000),
    v.optionalString(b.notes, 'Notes', 2000),
  );
}

app.post('/api/opponents/:id/players', auth, requireResource('opponent', 'scouting'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Player name required' });
  const err = opponentPlayerError(b, false);
  if (err) return res.status(400).json({ error: err });
  await db.run(`INSERT INTO opponent_players (opponent_id, name, role, positions, weapons, aggression, habits, weaknesses, notes)
    VALUES (?,?,?,?,?,?,?,?,?)`, Number(req.params.id), b.name, b.role || null, b.positions || null,
    b.weapons || null, b.aggression || null, b.habits || null, b.weaknesses || null, b.notes || null);
  res.json(await oppOut(await db.get('SELECT * FROM opponents WHERE id = ?', Number(req.params.id))));
}));

app.put('/api/opponent-players/:pid', auth, ah(async (req, res) => {
  const p = await db.get('SELECT * FROM opponent_players WHERE id = ?', Number(req.params.pid));
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (!await gateTeam(req, res, await resourceTeam('opponent', p.opponent_id), 'scouting')) return;
  const b = req.body || {};
  const err = opponentPlayerError(b, true);
  if (err) return res.status(400).json({ error: err });
  const val = (k) => (b[k] !== undefined ? b[k] : p[k]);
  await db.run(`UPDATE opponent_players SET name=?, role=?, positions=?, weapons=?, aggression=?, habits=?, weaknesses=?, notes=? WHERE id=?`,
    val('name'), val('role'), val('positions'), val('weapons'), val('aggression'), val('habits'), val('weaknesses'), val('notes'), p.id);
  res.json(await oppOut(await db.get('SELECT * FROM opponents WHERE id = ?', p.opponent_id)));
}));

app.delete('/api/opponent-players/:pid', auth, ah(async (req, res) => {
  const p = await db.get('SELECT * FROM opponent_players WHERE id = ?', Number(req.params.pid));
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (!await gateTeam(req, res, await resourceTeam('opponent', p.opponent_id), 'scouting')) return;
  await db.run('DELETE FROM opponent_players WHERE id = ?', p.id);
  res.json({ ok: true });
}));

// tendencies
app.post('/api/opponents/:id/tendencies', auth, requireResource('opponent', 'scouting'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.text) return res.status(400).json({ error: 'Tendency text required' });
  const err = v.firstError(
    v.requiredString(b.text, 'Tendency text', 2000),
    v.optionalIdNumber(b.opponent_player_id, 'Player'),
    v.optionalString(b.map, 'Map', 50),
    v.optionalOneOf(b.side, 'Side', ['T', 'CT']),
    v.optionalString(b.site, 'Site', 50),
    v.optionalString(b.round_type, 'Round type', 50),
    v.optionalString(b.category, 'Category', 50),
  );
  if (err) return res.status(400).json({ error: err });
  if (b.opponent_player_id) {
    // the linked player must belong to THIS opponent, not someone else's scouting data
    const op = await db.get('SELECT opponent_id FROM opponent_players WHERE id = ?', Number(b.opponent_player_id));
    if (!op || op.opponent_id !== Number(req.params.id)) {
      return res.status(400).json({ error: 'That player is not on this opponent' });
    }
  }
  await db.run(`INSERT INTO tendencies (opponent_id, opponent_player_id, map, side, site, round_type, category, text, severity, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    Number(req.params.id), b.opponent_player_id || null, b.map || null, b.side || null, b.site || null,
    b.round_type || null, b.category || null, b.text, b.severity === 'high' ? 'high' : 'normal', req.user.id, now());
  res.json(await oppOut(await db.get('SELECT * FROM opponents WHERE id = ?', Number(req.params.id))));
}));

app.delete('/api/tendencies/:tid', auth, ah(async (req, res) => {
  const td = await db.get('SELECT * FROM tendencies WHERE id = ?', Number(req.params.tid));
  if (!td) return res.status(404).json({ error: 'Not found' });
  if (!await gateTeam(req, res, await resourceTeam('opponent', td.opponent_id), 'scouting')) return;
  await db.run('DELETE FROM tendencies WHERE id = ?', td.id);
  res.json({ ok: true });
}));

// ---------- matches ----------
async function matchOut(row, userId) {
  if (!row) return null;
  const out = { ...row };
  out.expected_maps = parseJ(row.expected_maps, []);
  out.roster = parseJ(row.roster, []);
  out.subs = parseJ(row.subs, []);
  out.opponent = row.opponent_id ? await db.get('SELECT * FROM opponents WHERE id = ?', row.opponent_id) : null;
  const pinRows = await db.all(`
    SELECT s.*, p.sort FROM match_pins p JOIN strategies s ON s.id = p.strategy_id
    WHERE p.match_id = ? ORDER BY p.sort`, row.id);
  out.pins = await Promise.all(pinRows.map(s => stratOut(s, userId)));
  out.notes = await db.all('SELECT * FROM match_notes WHERE match_id = ? ORDER BY kind, sort', row.id);
  out.roster_users = out.roster.length
    ? await db.all(`SELECT u.id, u.name, tm.game_role FROM users u
        LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = ?
        WHERE u.id IN (${out.roster.map(() => '?').join(',')})`, row.team_id, ...out.roster)
    : [];
  out.opponent_players = row.opponent_id
    ? await db.all('SELECT * FROM opponent_players WHERE opponent_id = ?', row.opponent_id)
    : [];
  out.team_faceit_roster = parseJ((await db.get('SELECT faceit_roster FROM teams WHERE id = ?', row.team_id)).faceit_roster, []);
  out.faceit_result = parseJ(row.faceit_result, null);
  return out;
}

app.get('/api/teams/:teamId/matches', auth, requireTeam(null), ah(async (req, res) => {
  const rows = await db.all('SELECT * FROM matches WHERE team_id = ? ORDER BY scheduled_at DESC', req.access.team.id);
  const out = [];
  for (const r of rows) {
    out.push({
      ...r,
      expected_maps: parseJ(r.expected_maps, []),
      opponent: r.opponent_id ? await db.get('SELECT id, name FROM opponents WHERE id = ?', r.opponent_id) : null,
    });
  }
  res.json(out);
}));

// Shared checks for creating/updating a match.
async function matchError(b, teamId) {
  const err = v.firstError(
    v.optionalIdNumber(b.opponent_id, 'Opponent'),
    v.optionalString(b.scheduled_at, 'Match time', 40),
    v.optionalString(b.event, 'Event', 200),
    v.optionalOneOf(b.format, 'Format', ['BO1', 'BO3', 'BO5']),
    v.stringArray(b.expected_maps, 'Expected maps', { maxItems: 10, maxLen: 50 }),
    v.optionalString(b.veto_notes, 'Veto notes', 5000),
    v.optionalOneOf(b.starting_side, 'Starting side', ['T', 'CT']),
    v.numberArray(b.roster, 'Roster', { maxItems: 20 }),
    v.numberArray(b.subs, 'Subs', { maxItems: 20 }),
  );
  if (err) return err;
  // a linked opponent must belong to this team, not leak another team's scouting
  if (b.opponent_id && (await resourceTeam('opponent', Number(b.opponent_id))) !== teamId) {
    return 'Opponent not found';
  }
  return null;
}

app.post('/api/teams/:teamId/matches', auth, requireTeam('matches'), ah(async (req, res) => {
  const b = req.body || {};
  const err = await matchError(b, req.access.team.id);
  if (err) return res.status(400).json({ error: err });
  const id = (await db.run(`INSERT INTO matches
    (team_id, opponent_id, scheduled_at, event, format, expected_maps, veto_notes, starting_side, roster, subs, status, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    req.access.team.id, b.opponent_id || null, b.scheduled_at || null, b.event || null, b.format || 'BO3',
    JSON.stringify(b.expected_maps || []), b.veto_notes || null, b.starting_side || null,
    JSON.stringify(b.roster || []), JSON.stringify(b.subs || []), 'upcoming', req.user.id, now()
  )).id;
  res.json(await matchOut(await db.get('SELECT * FROM matches WHERE id = ?', id), req.user.id));
}));

app.get('/api/matches/:id', auth, requireResource('match', null), ah(async (req, res) => {
  res.json(await matchOut(await db.get('SELECT * FROM matches WHERE id = ?', Number(req.params.id)), req.user.id));
}));

app.put('/api/matches/:id', auth, requireResource('match', 'matches'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.get('SELECT * FROM matches WHERE id = ?', id);
  const b = req.body || {};
  const err = await matchError(b, req.teamId);
  if (err) return res.status(400).json({ error: err });
  const val = (k, json) => b[k] !== undefined ? (json ? JSON.stringify(b[k]) : b[k]) : cur[k];
  await db.run(`UPDATE matches SET opponent_id=?, scheduled_at=?, event=?, format=?, expected_maps=?, veto_notes=?,
    starting_side=?, roster=?, subs=?, status=? WHERE id=?`,
    val('opponent_id'), val('scheduled_at'), val('event'), val('format'), val('expected_maps', true),
    val('veto_notes'), val('starting_side'), val('roster', true), val('subs', true),
    ['upcoming', 'live', 'completed'].includes(b.status) ? b.status : cur.status, id);
  res.json(await matchOut(await db.get('SELECT * FROM matches WHERE id = ?', id), req.user.id));
}));

app.delete('/api/matches/:id', auth, requireResource('match', 'matches'), ah(async (req, res) => {
  await db.run('DELETE FROM matches WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
}));

// pins
app.post('/api/matches/:id/pins', auth, requireResource('match', 'matches'), ah(async (req, res) => {
  const matchId = Number(req.params.id);
  const sid = Number(req.body?.strategy_id);
  // pins come from this team's strategy bank — a strategy must be in Team
  // Strats before it can be pinned to a team match
  const shared = await db.get('SELECT 1 AS x FROM team_strategies WHERE strategy_id = ? AND team_id = ?', sid, req.teamId);
  if (!shared) return res.status(400).json({ error: 'Strategy not found' });
  const max = (await db.get('SELECT COALESCE(MAX(sort),-1) AS m FROM match_pins WHERE match_id = ?', matchId)).m;
  await db.run('INSERT INTO match_pins (match_id, strategy_id, sort) VALUES (?,?,?) ON CONFLICT DO NOTHING', matchId, sid, max + 1);
  res.json({ ok: true });
}));
app.delete('/api/matches/:id/pins/:sid', auth, requireResource('match', 'matches'), ah(async (req, res) => {
  await db.run('DELETE FROM match_pins WHERE match_id = ? AND strategy_id = ?', Number(req.params.id), Number(req.params.sid));
  res.json({ ok: true });
}));

// notes
app.post('/api/matches/:id/notes', auth, requireResource('match', 'matches'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.text || b.kind !== 'reminder') return res.status(400).json({ error: 'Note text and kind required' });
  const err = v.requiredString(b.text, 'Note text', 2000);
  if (err) return res.status(400).json({ error: err });
  const max = (await db.get('SELECT COALESCE(MAX(sort),-1) AS m FROM match_notes WHERE match_id = ? AND kind = ?', Number(req.params.id), b.kind)).m;
  await db.run('INSERT INTO match_notes (match_id, kind, text, sort) VALUES (?,?,?,?)', Number(req.params.id), b.kind, b.text, max + 1);
  res.json({ ok: true });
}));
app.delete('/api/match-notes/:nid', auth, ah(async (req, res) => {
  const n = await db.get('SELECT * FROM match_notes WHERE id = ?', Number(req.params.nid));
  if (!n) return res.status(404).json({ error: 'Not found' });
  if (!await gateTeam(req, res, await resourceTeam('match', n.match_id), 'matches')) return;
  await db.run('DELETE FROM match_notes WHERE id = ?', n.id);
  res.json({ ok: true });
}));

// ---------- recents ----------
app.post('/api/recents', auth, ah(async (req, res) => {
  const { item_type, item_id } = req.body || {};
  if (!['strategy', 'opponent', 'match'].includes(item_type) || !Number(item_id)) {
    return res.status(400).json({ error: 'Bad recent item' });
  }
  // The item must exist AND be accessible to the signed-in user. Existence
  // alone is not enough: answering differently for inaccessible ids would
  // both confirm private ids and let anyone write recents rows pointing at
  // data they cannot see. Same 404 either way, on purpose.
  if (item_type === 'strategy') {
    if (!(await strategyAccess(req, Number(item_id)))) return res.status(404).json({ error: 'Not found' });
  } else {
    const teamId = await resourceTeam(item_type, Number(item_id));
    if (teamId == null || !(await teamAccess(req, teamId))) return res.status(404).json({ error: 'Not found' });
  }
  await db.run(`INSERT INTO recents (user_id, item_type, item_id, viewed_at) VALUES (?,?,?,?)
    ON CONFLICT (user_id, item_type, item_id) DO UPDATE SET viewed_at = excluded.viewed_at`,
    req.user.id, item_type, Number(item_id), now());
  res.json({ ok: true });
}));

app.get('/api/teams/:teamId/recents', auth, requireTeam(null), ah(async (req, res) => {
  const rows = await db.all('SELECT * FROM recents WHERE user_id = ? ORDER BY viewed_at DESC LIMIT 12', req.user.id);
  const out = [];
  for (const r of rows) {
    if (r.item_type === 'strategy') {
      // strategies I can still see in this context: my own, or in this team's bank
      const s = await db.get(`SELECT id, name, map, side, category FROM strategies
        WHERE id = ? AND (created_by = ? OR EXISTS (
          SELECT 1 FROM team_strategies ts WHERE ts.strategy_id = strategies.id AND ts.team_id = ?))`,
        r.item_id, req.user.id, req.access.team.id);
      if (s) out.push({ type: 'strategy', ...s, viewed_at: r.viewed_at });
    } else if (r.item_type === 'opponent') {
      const o = await db.get('SELECT id, name FROM opponents WHERE id = ? AND team_id = ?', r.item_id, req.access.team.id);
      if (o) out.push({ type: 'opponent', ...o, viewed_at: r.viewed_at });
    } else if (r.item_type === 'match') {
      const m = await db.get('SELECT id, event, opponent_id FROM matches WHERE id = ? AND team_id = ?', r.item_id, req.access.team.id);
      if (m) {
        const opp = m.opponent_id ? await db.get('SELECT name FROM opponents WHERE id = ?', m.opponent_id) : null;
        out.push({ type: 'match', id: m.id, name: opp ? `vs ${opp.name}` : (m.event || 'Match'), viewed_at: r.viewed_at });
      }
    }
  }
  res.json(out);
}));

// ---------- search ----------
app.get('/api/teams/:teamId/search', auth, requireTeam(null), ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ strategies: [], opponents: [], players: [], tendencies: [], matches: [] });
  const like = `%${q}%`;
  const teamId = req.access.team.id;
  res.json({
    strategies: await db.all(`SELECT s.id, s.name, s.map, s.side, s.category, s.status FROM strategies s
      WHERE (s.created_by = ? OR EXISTS (SELECT 1 FROM team_strategies ts WHERE ts.strategy_id = s.id AND ts.team_id = ?))
      AND (s.name LIKE ? OR s.summary LIKE ? OR s.objective LIKE ? OR s.tags LIKE ?) LIMIT 15`,
      req.user.id, teamId, like, like, like, like),
    opponents: await db.all(`SELECT id, name FROM opponents WHERE team_id = ? AND (name LIKE ? OR playstyle LIKE ? OR notes LIKE ?) LIMIT 8`,
      teamId, like, like, like),
    players: await db.all(`SELECT op.id, op.name, op.role, op.opponent_id, o.name AS opponent_name
      FROM opponent_players op JOIN opponents o ON o.id = op.opponent_id
      WHERE o.team_id = ? AND (op.name LIKE ? OR op.habits LIKE ? OR op.notes LIKE ?) LIMIT 8`,
      teamId, like, like, like),
    tendencies: await db.all(`SELECT td.id, td.text, td.map, td.side, td.severity, td.opponent_id, o.name AS opponent_name
      FROM tendencies td JOIN opponents o ON o.id = td.opponent_id
      WHERE o.team_id = ? AND td.text LIKE ? LIMIT 10`, teamId, like),
    matches: await db.all(`SELECT m.id, m.event, m.scheduled_at, o.name AS opponent_name
      FROM matches m LEFT JOIN opponents o ON o.id = m.opponent_id
      WHERE m.team_id = ? AND (m.event LIKE ? OR o.name LIKE ? OR m.veto_notes LIKE ?) LIMIT 8`,
      teamId, like, like, like),
  });
}));

// ---------- team / org management ----------
app.get('/api/teams/:teamId/members', auth, requireTeam(null), ah(async (req, res) => {
  const orgId = req.access.team.org_id;
  const members = await db.all(`
    SELECT u.id, u.name, u.email, m.role, tm.game_role, tm.is_starter
    FROM org_members m JOIN users u ON u.id = m.user_id
    LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = ?
    WHERE m.org_id = ? ORDER BY
      CASE m.role WHEN 'owner' THEN 0 WHEN 'edit' THEN 1 ELSE 2 END, u.name`,
    req.access.team.id, orgId);
  res.json({ members, my_role: req.access.role });
}));

const VALID_ROLES = ['owner', 'edit', 'view'];

app.put('/api/teams/:teamId/members/:uid', auth, requireTeam('team'), ah(async (req, res) => {
  const orgId = req.access.team.org_id;
  const uid = Number(req.params.uid);
  const b = req.body || {};
  const target = await db.get('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?', orgId, uid);
  if (!target) return res.status(404).json({ error: 'Not a member' });
  const gameRoleErr = v.optionalString(b.game_role, 'Game role', 50);
  if (gameRoleErr) return res.status(400).json({ error: gameRoleErr });
  if (b.role !== undefined) {
    if (!VALID_ROLES.includes(b.role)) return res.status(400).json({ error: 'Invalid role' });
    if (target.role === 'owner' && req.access.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change the owner role' });
    if (uid === req.user.id && target.role === 'owner' && b.role !== 'owner') {
      const owners = (await db.get(`SELECT COUNT(*) AS c FROM org_members WHERE org_id = ? AND role = 'owner'`, orgId)).c;
      if (owners <= 1) return res.status(400).json({ error: 'The organization must keep at least one owner' });
    }
    await db.run('UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?', b.role, orgId, uid);
  }
  if (b.game_role !== undefined || b.is_starter !== undefined) {
    const tm = await db.get('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?', req.access.team.id, uid);
    if (tm) {
      await db.run('UPDATE team_members SET game_role = ?, is_starter = ? WHERE team_id = ? AND user_id = ?',
        b.game_role !== undefined ? b.game_role : tm.game_role,
        b.is_starter !== undefined ? (b.is_starter ? 1 : 0) : tm.is_starter,
        req.access.team.id, uid);
    } else {
      await db.run('INSERT INTO team_members (team_id, user_id, game_role, is_starter) VALUES (?,?,?,?)',
        req.access.team.id, uid, b.game_role || null, b.is_starter ? 1 : 0);
    }
  }
  res.json({ ok: true });
}));

app.delete('/api/teams/:teamId/members/:uid', auth, requireTeam('team'), ah(async (req, res) => {
  const orgId = req.access.team.org_id;
  const uid = Number(req.params.uid);
  const target = await db.get('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?', orgId, uid);
  if (!target) return res.status(404).json({ error: 'Not a member' });
  if (target.role === 'owner') return res.status(400).json({ error: 'Transfer ownership before removing an owner' });
  await db.run('DELETE FROM org_members WHERE org_id = ? AND user_id = ?', orgId, uid);
  await db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', req.access.team.id, uid);
  // their player slot stays on the roster, just unassigned
  await db.run('UPDATE team_players SET user_id = NULL WHERE team_id = ? AND user_id = ?', req.access.team.id, uid);
  res.json({ ok: true });
}));

// ---------- team roster (player slots) ----------
async function playerOut(row) {
  if (!row) return null;
  const out = { ...row, faceit_stats: parseJ(row.faceit_stats, null) };
  out.user = row.user_id ? await db.get('SELECT id, name, email FROM users WHERE id = ?', row.user_id) : null;
  return out;
}

app.get('/api/teams/:teamId/players', auth, requireTeam(null), ah(async (req, res) => {
  const rows = await db.all('SELECT * FROM team_players WHERE team_id = ? ORDER BY is_starter DESC, name', req.access.team.id);
  res.json(await Promise.all(rows.map(playerOut)));
}));

app.post('/api/teams/:teamId/players', auth, requireTeam('team'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Player name required' });
  const err = v.firstError(
    v.requiredString(b.name, 'Player name', 80),
    v.optionalString(b.game_role, 'Game role', 50),
    v.optionalString(b.faceit_nickname, 'FACEIT nickname', 80),
  );
  if (err) return res.status(400).json({ error: err });
  const id = (await db.run('INSERT INTO team_players (team_id, name, game_role, is_starter, faceit_nickname) VALUES (?,?,?,?,?) RETURNING id',
    req.access.team.id, String(b.name).trim(), b.game_role || null, b.is_starter === false ? 0 : 1, b.faceit_nickname || null)).id;
  res.json(await playerOut(await db.get('SELECT * FROM team_players WHERE id = ?', id)));
}));

app.get('/api/team-players/:id', auth, requireResource('team_player', null), ah(async (req, res) => {
  res.json(await playerOut(await db.get('SELECT * FROM team_players WHERE id = ?', Number(req.params.id))));
}));

app.put('/api/team-players/:id', auth, requireResource('team_player', 'team'), ah(async (req, res) => {
  const p = await db.get('SELECT * FROM team_players WHERE id = ?', Number(req.params.id));
  const b = req.body || {};
  const err = v.firstError(
    b.name !== undefined && v.requiredString(b.name, 'Player name', 80),
    v.optionalString(b.game_role, 'Game role', 50),
    v.optionalString(b.faceit_nickname, 'FACEIT nickname', 80),
  );
  if (err) return res.status(400).json({ error: err });
  if (b.user_id !== undefined && b.user_id !== null && b.user_id !== '') {
    // assignee must belong to the org and can only control one slot per team
    const role = await orgRole(Number(b.user_id), req.access.team.org_id);
    if (!role) return res.status(400).json({ error: 'That user is not a member of this organization' });
    const taken = await db.get('SELECT id FROM team_players WHERE team_id = ? AND user_id = ? AND id != ?',
      p.team_id, Number(b.user_id), p.id);
    if (taken) return res.status(400).json({ error: 'That user already controls another player on this team' });
  }
  const val = (k, cur) => b[k] !== undefined ? b[k] : cur;
  await db.run('UPDATE team_players SET name=?, game_role=?, is_starter=?, user_id=?, faceit_nickname=? WHERE id=?',
    String(val('name', p.name)).trim() || p.name, val('game_role', p.game_role),
    b.is_starter !== undefined ? (b.is_starter ? 1 : 0) : p.is_starter,
    b.user_id !== undefined ? (Number(b.user_id) || null) : p.user_id,
    val('faceit_nickname', p.faceit_nickname), p.id);
  res.json(await playerOut(await db.get('SELECT * FROM team_players WHERE id = ?', p.id)));
}));

app.delete('/api/team-players/:id', auth, requireResource('team_player', 'team'), ah(async (req, res) => {
  await db.run('DELETE FROM team_players WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
}));

// auto-pull FACEIT stats for a player slot (nickname lookup + ELO/level + last-30 aggregate)
app.post('/api/team-players/:id/faceit-refresh', faceitLimiter, auth, requireResource('team_player', null), ah(async (req, res) => {
  const p = await db.get('SELECT * FROM team_players WHERE id = ?', Number(req.params.id));
  const team = await db.get('SELECT faceit_api_key FROM teams WHERE id = ?', p.team_id);
  if (!team.faceit_api_key) return res.status(400).json({ error: 'Connect FACEIT on the Team page first' });
  const nickErr = v.optionalString(req.body && req.body.nickname, 'Nickname', 80);
  if (nickErr) return res.status(400).json({ error: nickErr });
  const nickname = String((req.body && req.body.nickname) || p.faceit_nickname || p.name).trim();
  try {
    let pid = p.faceit_player_id;
    if (!pid || (req.body && req.body.nickname)) {
      const fp = await faceit.playerByNickname(team.faceit_api_key, nickname);
      pid = fp.player_id;
    }
    const st = await faceit.enrichPlayer(team.faceit_api_key, pid, 'cs2');
    if (!st) return res.status(502).json({ error: 'FACEIT lookup failed' });
    await db.run('UPDATE team_players SET faceit_player_id = ?, faceit_nickname = ?, faceit_stats = ? WHERE id = ?',
      pid, nickname, JSON.stringify(st), p.id);
    res.json(await playerOut(await db.get('SELECT * FROM team_players WHERE id = ?', p.id)));
  } catch (e) {
    res.status(502).json({ error: e.code === 404 ? `No FACEIT player named "${nickname}"` : e.message });
  }
}));

// look up any FACEIT player by nickname (uses the team's API key)
app.get('/api/teams/:teamId/faceit-lookup', faceitLimiter, auth, requireTeam(null), ah(async (req, res) => {
  const nickname = String(req.query.nickname || '').trim();
  if (!nickname) return res.status(400).json({ error: 'Nickname required' });
  if (nickname.length > 80) return res.status(400).json({ error: 'Nickname must be at most 80 characters' });
  const t = await db.get('SELECT faceit_api_key FROM teams WHERE id = ?', req.access.team.id);
  if (!t.faceit_api_key) return res.status(400).json({ error: 'Connect FACEIT on the Team page first' });
  try {
    const p = await faceit.playerByNickname(t.faceit_api_key, nickname);
    const stats = await faceit.enrichPlayer(t.faceit_api_key, p.player_id, 'cs2');
    res.json({ nickname: p.nickname, country: p.country || null, player_id: p.player_id, stats: stats || {} });
  } catch (e) {
    res.status(e.code === 404 ? 404 : 502).json({
      error: e.code === 404 ? `No FACEIT player named "${nickname}"` : e.message,
    });
  }
}));

// paged match history for a looked-up player
app.get('/api/teams/:teamId/faceit-matches', faceitLimiter, auth, requireTeam(null), ah(async (req, res) => {
  const pid = String(req.query.player_id || '').trim();
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  if (!pid) return res.status(400).json({ error: 'player_id required' });
  if (pid.length > 80) return res.status(400).json({ error: 'player_id must be at most 80 characters' });
  const t = await db.get('SELECT faceit_api_key FROM teams WHERE id = ?', req.access.team.id);
  if (!t.faceit_api_key) return res.status(400).json({ error: 'Connect FACEIT on the Team page first' });
  try {
    res.json(await faceit.playerMatches(t.faceit_api_key, pid, 'cs2', offset, limit));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

app.get('/api/teams/:teamId/invites', auth, requireTeam('team'), ah(async (req, res) => {
  res.json(await db.all('SELECT id, role, code, email, created_at, used_by FROM invites WHERE org_id = ? ORDER BY id DESC', req.access.team.org_id));
}));

// direct invite to an EXISTING account — lands in their profile menu, no code needed
app.post('/api/teams/:teamId/invites/direct', auth, requireTeam('team'), ah(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = req.body?.role;
  if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
  if (!['edit', 'view'].includes(role)) return res.status(400).json({ error: 'Invalid invite role' });
  const user = await db.get('SELECT id FROM users WHERE email = ?', email);
  if (!user) return res.status(404).json({ error: 'No account with that email — generate an invite code instead; they redeem it after signing up' });
  if (await orgRole(user.id, req.access.team.org_id)) return res.status(409).json({ error: 'That user is already a member of this organization' });
  if (await db.get('SELECT 1 AS x FROM invites WHERE org_id = ? AND email = ? AND used_by IS NULL', req.access.team.org_id, email)) {
    return res.status(409).json({ error: 'That user already has a pending invite' });
  }
  const code = crypto.randomBytes(9).toString('base64url');
  await db.run('INSERT INTO invites (org_id, team_id, role, code, email, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
    req.access.team.org_id, req.access.team.id, role, code, email, req.user.id, now());
  res.json({ ok: true });
}));

// the signed-in user's pending invites (in-app inbox)
app.get('/api/me/invites', auth, ah(async (req, res) => {
  res.json(await db.all(`
    SELECT i.id, i.role, i.created_at, o.name AS org_name, t.name AS team_name, u.name AS invited_by
    FROM invites i
    JOIN organizations o ON o.id = i.org_id
    LEFT JOIN teams t ON t.id = i.team_id
    LEFT JOIN users u ON u.id = i.created_by
    WHERE i.email = ? AND i.used_by IS NULL ORDER BY i.id DESC`, req.user.email));
}));

app.post('/api/invites/:iid/accept', auth, ah(async (req, res) => {
  const inv = await db.get('SELECT * FROM invites WHERE id = ? AND used_by IS NULL', Number(req.params.iid));
  if (!inv || inv.email !== req.user.email) return res.status(404).json({ error: 'Invite not found' });
  if (!(await orgRole(req.user.id, inv.org_id))) {
    await db.run('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)', inv.org_id, req.user.id, inv.role);
  }
  if (inv.team_id && !(await db.get('SELECT 1 AS x FROM team_members WHERE team_id = ? AND user_id = ?', inv.team_id, req.user.id))) {
    await db.run('INSERT INTO team_members (team_id, user_id, is_starter) VALUES (?,?,0)', inv.team_id, req.user.id);
  }
  await db.run('UPDATE invites SET used_by = ? WHERE id = ?', req.user.id, inv.id);
  res.json({ ok: true, team_id: inv.team_id });
}));

// Redeem an invite code from inside the app (signup no longer accepts codes).
// authLimiter keeps codes from being brute-forced.
app.post('/api/invites/redeem', authLimiter, auth, ah(async (req, res) => {
  const code = req.body?.code;
  const lenErr = v.firstError(v.requiredString(code, 'Invite code', 50));
  if (lenErr) return res.status(400).json({ error: lenErr });
  const inv = await db.get('SELECT * FROM invites WHERE code = ? AND used_by IS NULL', code.trim());
  if (!inv) return res.status(400).json({ error: 'Invalid or already-used invite code' });
  if (inv.email && inv.email !== req.user.email) {
    return res.status(400).json({ error: 'This invite is addressed to a different email' });
  }
  if (await orgRole(req.user.id, inv.org_id)) {
    return res.status(409).json({ error: 'You are already a member of this organization' });
  }
  await db.run('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)', inv.org_id, req.user.id, inv.role);
  if (inv.team_id && !(await db.get('SELECT 1 AS x FROM team_members WHERE team_id = ? AND user_id = ?', inv.team_id, req.user.id))) {
    await db.run('INSERT INTO team_members (team_id, user_id, is_starter) VALUES (?,?,0)', inv.team_id, req.user.id);
  }
  await db.run('UPDATE invites SET used_by = ? WHERE id = ?', req.user.id, inv.id);
  res.json({ ok: true, team_id: inv.team_id });
}));

app.post('/api/invites/:iid/decline', auth, ah(async (req, res) => {
  const inv = await db.get('SELECT * FROM invites WHERE id = ? AND used_by IS NULL', Number(req.params.iid));
  if (!inv || inv.email !== req.user.email) return res.status(404).json({ error: 'Invite not found' });
  await db.run('DELETE FROM invites WHERE id = ?', inv.id);
  res.json({ ok: true });
}));

app.post('/api/teams/:teamId/invites', auth, requireTeam('team'), ah(async (req, res) => {
  const role = req.body?.role;
  if (!VALID_ROLES.includes(role) || role === 'owner') return res.status(400).json({ error: 'Invalid invite role' });
  const code = crypto.randomBytes(9).toString('base64url');
  await db.run('INSERT INTO invites (org_id, team_id, role, code, created_by, created_at) VALUES (?,?,?,?,?,?)',
    req.access.team.org_id, req.access.team.id, role, code, req.user.id, now());
  res.json({ code });
}));

app.delete('/api/invites/:iid', auth, ah(async (req, res) => {
  const inv = await db.get('SELECT * FROM invites WHERE id = ?', Number(req.params.iid));
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const role = await orgRole(req.user.id, inv.org_id);
  if (!CAN.team.includes(role)) return res.status(403).json({ error: 'Your role cannot manage invites' });
  await db.run('DELETE FROM invites WHERE id = ?', inv.id);
  res.json({ ok: true });
}));

// ---------- FACEIT integration ----------
app.get('/api/teams/:teamId/faceit', auth, requireTeam(null), ah(async (req, res) => {
  const t = await db.get('SELECT faceit_team_id, faceit_team_name, faceit_last_sync, faceit_api_key, faceit_roster FROM teams WHERE id = ?', req.access.team.id);
  res.json({
    connected: !!(t.faceit_team_id && t.faceit_api_key),
    team_id: t.faceit_team_id,
    team_name: t.faceit_team_name,
    last_sync: t.faceit_last_sync,
    roster: parseJ(t.faceit_roster, []),
    can_manage: CAN.team.includes(req.access.role),
  });
}));

app.put('/api/teams/:teamId/faceit', faceitLimiter, auth, requireTeam('team'), ah(async (req, res) => {
  const { api_key, team } = req.body || {};
  if (!api_key || !team) return res.status(400).json({ error: 'FACEIT API key and team id (or team URL) are required' });
  const err = v.firstError(
    v.requiredString(api_key, 'FACEIT API key', 200),
    v.requiredString(team, 'FACEIT team', 300),
  );
  if (err) return res.status(400).json({ error: err });
  try {
    const info = await faceit.lookupTeam(String(api_key).trim(), String(team));
    await db.run('UPDATE teams SET faceit_team_id = ?, faceit_team_name = ?, faceit_api_key = ? WHERE id = ?',
      info.id, info.name, String(api_key).trim(), req.access.team.id);
    res.json({ ok: true, team_name: info.name, team_id: info.id });
  } catch (e) {
    const msg = e.code === 401 ? 'FACEIT rejected the API key — check it on developers.faceit.com'
      : e.code === 404 ? 'Team not found on FACEIT — paste the team page URL or team id'
      : `Could not reach FACEIT: ${e.message}`;
    res.status(400).json({ error: msg });
  }
}));

app.delete('/api/teams/:teamId/faceit', auth, requireTeam('team'), ah(async (req, res) => {
  await db.run('UPDATE teams SET faceit_team_id = NULL, faceit_team_name = NULL, faceit_api_key = NULL, faceit_last_sync = NULL WHERE id = ?',
    req.access.team.id);
  res.json({ ok: true });
}));

app.post('/api/teams/:teamId/faceit/sync', faceitLimiter, auth, requireTeam('matches'), ah(async (req, res) => {
  const team = await db.get('SELECT * FROM teams WHERE id = ?', req.access.team.id);
  if (!team.faceit_team_id || !team.faceit_api_key) {
    return res.status(400).json({ error: 'FACEIT is not connected for this team yet' });
  }
  try {
    const summary = await faceit.syncTeam(team);
    res.json(summary);
  } catch (e) {
    res.status(502).json({ error: `FACEIT sync failed: ${e.message}` });
  }
}));

// background poll: keep synced teams fresh (matches rescheduled, new league rounds)
const FACEIT_POLL_MS = 30 * 60 * 1000;
setInterval(async () => {
  try {
    const teams = await db.all('SELECT * FROM teams WHERE faceit_team_id IS NOT NULL AND faceit_api_key IS NOT NULL');
    for (const team of teams) {
      try {
        const s = await faceit.syncTeam(team);
        if (s.created || s.updated) console.log(`[faceit] team ${team.id}: +${s.created} new, ${s.updated} updated`);
        // a sync that reached FACEIT but couldn't read part of it still counts
        // as "last synced"; without this the failure is invisible
        for (const err of s.errors) console.error(`[faceit] team ${team.id}: ${err}`);
      } catch (e) {
        console.error(`[faceit] sync failed for team ${team.id}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[faceit] poll failed: ${e.message}`);
  }
}, FACEIT_POLL_MS).unref();

// ---------- dashboard ----------
app.get('/api/teams/:teamId/dashboard', auth, requireTeam(null), ah(async (req, res) => {
  const teamId = req.access.team.id;
  const maps = (await db.all('SELECT name FROM maps WHERE active = 1 ORDER BY name')).map(m => m.name);
  const count = async (sql, ...args) => (await db.get(sql, ...args)).c;
  // the team dashboard reads the team's strategy bank (Team Strats)
  const bank = `FROM strategies s JOIN team_strategies ts ON ts.strategy_id = s.id WHERE ts.team_id = ?`;
  const byMap = {};
  for (const m of maps) {
    byMap[m] = {
      total: await count(`SELECT COUNT(*) AS c ${bank} AND s.map = ? AND s.status = 'active'`, teamId, m),
      t: await count(`SELECT COUNT(*) AS c ${bank} AND s.map = ? AND s.side = 'T' AND s.status = 'active'`, teamId, m),
      ct: await count(`SELECT COUNT(*) AS c ${bank} AND s.map = ? AND s.side = 'CT' AND s.status = 'active'`, teamId, m),
      pistol: await count(`SELECT COUNT(*) AS c ${bank} AND s.map = ? AND s.category = 'Pistol' AND s.status = 'active'`, teamId, m),
    };
  }
  // `scheduled_at IS NULL` first: an undated match is not the next one. SQLite
  // sorts NULLs before every date, so without this a match with no time set —
  // routine for a league fixture before both teams confirm — outranks a real
  // one and takes over the dashboard as "Next match · Not scheduled".
  const nextRow = await db.get(`SELECT m.*, o.name AS opponent_name
    FROM matches m LEFT JOIN opponents o ON o.id = m.opponent_id
    WHERE m.team_id = ? AND m.status = 'upcoming'
    ORDER BY m.scheduled_at IS NULL, m.scheduled_at LIMIT 1`, teamId);
  let next_match = null;
  if (nextRow) {
    next_match = {
      id: nextRow.id, opponent_id: nextRow.opponent_id, opponent_name: nextRow.opponent_name,
      event: nextRow.event, format: nextRow.format, scheduled_at: nextRow.scheduled_at,
      starting_side: nextRow.starting_side, expected_maps: parseJ(nextRow.expected_maps, []),
      pin_count: await count('SELECT COUNT(*) AS c FROM match_pins WHERE match_id = ?', nextRow.id),
    };
  }
  const rosterRows = await db.all('SELECT * FROM team_players WHERE team_id = ? ORDER BY is_starter DESC, name', teamId);
  res.json({
    next_match,
    upcoming: await db.all(`SELECT m.id, m.scheduled_at, m.event, m.format, o.name AS opponent_name
      FROM matches m LEFT JOIN opponents o ON o.id = m.opponent_id
      WHERE m.team_id = ? AND m.status = 'upcoming'
      ORDER BY m.scheduled_at IS NULL, m.scheduled_at LIMIT 5`, teamId),
    recent_strategies: await db.all(`SELECT s.id, s.name, s.map, s.side, s.category, s.status, s.updated_at
      ${bank} AND s.status != 'archived' ORDER BY s.updated_at DESC LIMIT 6`, teamId),
    drafts: await db.all(`SELECT s.id, s.name, s.map, s.side, s.category ${bank} AND s.status = 'draft' ORDER BY s.updated_at DESC LIMIT 6`, teamId),
    archived_count: await count(`SELECT COUNT(*) AS c ${bank} AND s.status = 'archived'`, teamId),
    opponents: await db.all(`SELECT o.id, o.name,
      (SELECT COUNT(*) FROM tendencies t WHERE t.opponent_id = o.id) AS tendency_count,
      (SELECT COUNT(*) FROM opponent_players p WHERE p.opponent_id = o.id) AS player_count
      FROM opponents o WHERE o.team_id = ? ORDER BY o.name`, teamId),
    by_map: byMap,
    roster: await Promise.all(rosterRows.map(playerOut)),
    faceit_roster: parseJ((await db.get('SELECT faceit_roster FROM teams WHERE id = ?', teamId)).faceit_roster, []),
  });
}));

// unknown API paths get a JSON 404 (with the security headers), never HTML
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- static ----------
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
  }
}));

app.get(/^\/(?!api\/).*/, (req, res) => {
  // A request that names a file and got this far is a missing asset, not a
  // route. Handing it index.html answers 200 with HTML, so a mistyped image
  // path looks like it worked and silently falls back instead of failing.
  if (path.extname(req.path)) return res.status(404).type('text/plain').send('Not found');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

// Schema + seed + cleanup must finish before the server takes traffic.
// Tests import { app, ready }, await ready, then listen on an ephemeral port.
const ready = db.init().then(() => db.seedIfEmpty()).then(() => db.cleanupSessions());

if (require.main === module) {
  ready
    .then(() => app.listen(PORT, () => console.log(
      `MidRound running on http://localhost:${PORT} (${db.usingPostgres ? 'Postgres' : 'SQLite'})`)))
    .catch((err) => { console.error('Failed to start:', err); process.exit(1); });
}

module.exports = { app, ready };
