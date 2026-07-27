// MidRound — API server
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, seedIfEmpty, cleanupSessions } = require('./db');
const faceit = require('./faceit');
const { rateLimit, clientIp, TRUSTED_PROXY_HOPS } = require('./rate-limit');
const v = require('./validate');

seedIfEmpty();
cleanupSessions();

const app = express();
const PORT = process.env.PORT || 4310;
const SESSION_DAYS = 30;

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
const authLimiter = rateLimit({ max: 10 });
const meLimiter = rateLimit({ max: 30 });
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
function auth(req, res, next) {
  const token = getCookies(req).mr_session;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const sess = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!sess || sess.expires_at < now()) {
    if (sess) db.prepare('DELETE FROM sessions WHERE id = ?').run(sess.id);
    return res.status(401).json({ error: 'Session expired' });
  }
  req.user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(sess.user_id);
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

function orgRole(userId, orgId) {
  const m = db.prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?').get(orgId, userId);
  return m ? m.role : null;
}

function teamAccess(req, teamId) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) return null;
  const role = orgRole(req.user.id, team.org_id);
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

// requires access + write permission for a domain; attaches req.access
function requireTeam(domain) {
  return (req, res, next) => {
    const teamId = Number(req.params.teamId || req.teamId);
    const access = teamAccess(req, teamId);
    if (!access) return res.status(403).json({ error: 'No access to this team' });
    if (domain && !CAN[domain].includes(access.role)) {
      return res.status(403).json({ error: 'Your role cannot make this change' });
    }
    req.access = access;
    next();
  };
}

// resolve a child resource -> team, then check
function resourceTeam(kind, id) {
  const q = {
    strategy: 'SELECT team_id FROM strategies WHERE id = ?',
    opponent: 'SELECT team_id FROM opponents WHERE id = ?',
    match: 'SELECT team_id FROM matches WHERE id = ?',
    team_player: 'SELECT team_id FROM team_players WHERE id = ?',
  }[kind];
  const row = db.prepare(q).get(id);
  return row ? row.team_id : null;
}

function requireResource(kind, domain) {
  return (req, res, next) => {
    const teamId = resourceTeam(kind, Number(req.params.id));
    if (!teamId) return res.status(404).json({ error: 'Not found' });
    req.teamId = teamId;
    requireTeam(domain)(req, res, next);
  };
}

// ---------- auth routes ----------
app.post('/api/auth/register', authLimiter, (req, res) => {
  const { email, password, name, invite, orgName, teamName } = req.body || {};
  if (typeof email !== 'string' || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  // bcrypt only reads the first 72 bytes; reject longer so nothing is silently ignored
  if (password.length > 72) return res.status(400).json({ error: 'Password must be at most 72 characters' });
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const lenErr = v.firstError(
    v.requiredString(name, 'Name', 80),
    v.optionalString(invite, 'Invite code', 50),
    v.optionalString(orgName, 'Organization name', 120),
    v.optionalString(teamName, 'Team name', 80),
  );
  if (lenErr) return res.status(400).json({ error: lenErr });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase())) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  let inv = null;
  if (invite) {
    inv = db.prepare('SELECT * FROM invites WHERE code = ? AND used_by IS NULL').get(invite.trim());
    if (!inv) return res.status(400).json({ error: 'Invalid or already-used invite code' });
    if (inv.email && inv.email !== email.toLowerCase()) {
      return res.status(400).json({ error: 'This invite is addressed to a different email' });
    }
  } else if (!orgName || !orgName.trim()) {
    return res.status(400).json({ error: 'Provide an invite code, or an organization name to create a new organization' });
  }

  const t = now();
  const userId = db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?,?,?,?)')
    .run(email.toLowerCase(), name.trim(), bcrypt.hashSync(password, 10), t).lastInsertRowid;

  if (inv) {
    db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)').run(inv.org_id, userId, inv.role);
    if (inv.team_id) db.prepare('INSERT INTO team_members (team_id, user_id, is_starter) VALUES (?,?,0)').run(inv.team_id, userId);
    db.prepare('UPDATE invites SET used_by = ? WHERE id = ?').run(userId, inv.id);
  } else {
    const orgId = db.prepare('INSERT INTO organizations (name, created_at) VALUES (?,?)').run(orgName.trim(), t).lastInsertRowid;
    db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)').run(orgId, userId, 'owner');
    db.prepare('INSERT INTO teams (org_id, name) VALUES (?,?)').run(orgId, (teamName || 'Main Team').trim());
  }

  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha256(token), userId, t, new Date(Date.now() + SESSION_DAYS * 86400000).toISOString());
  setSessionCookie(req, res, token);
  res.json({ ok: true });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const ip = clientIp(req);
  if (loginLimited(ip)) return res.status(429).json({ error: 'Too many attempts — try again in a few minutes' });
  const { email, password } = req.body || {};
  const user = (typeof email === 'string' && email.length <= 254)
    ? db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) : null;
  if (!user || !bcrypt.compareSync(String(password || '').slice(0, 72), user.password_hash)) {
    noteLoginFail(ip);
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha256(token), user.id, now(), new Date(Date.now() + SESSION_DAYS * 86400000).toISOString());
  setSessionCookie(req, res, token);
  res.json({ ok: true });
});

app.post('/api/auth/logout', authLimiter, auth, (req, res) => {
  const token = getCookies(req).mr_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/me', meLimiter, auth, (req, res) => {
  const orgs = db.prepare(`
    SELECT o.id, o.name, m.role FROM organizations o
    JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ?`).all(req.user.id);
  const teams = orgs.length ? db.prepare(`
    SELECT t.id, t.org_id, t.name FROM teams t
    WHERE t.org_id IN (${orgs.map(() => '?').join(',')})`).all(...orgs.map(o => o.id)) : [];
  res.json({ user: req.user, orgs, teams });
});

// ---------- maps ----------
app.get('/api/maps', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM maps WHERE active = 1 ORDER BY name').all());
});
app.post('/api/maps', auth, (req, res) => {
  // adding a map requires edit rights in at least one org
  const anyEditor = db.prepare(`SELECT 1 FROM org_members WHERE user_id = ? AND role IN ('owner','edit')`).get(req.user.id);
  if (!anyEditor) return res.status(403).json({ error: 'Your role cannot add maps' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Map name required' });
  if (name.length > 50) return res.status(400).json({ error: 'Map name must be at most 50 characters' });
  try {
    db.prepare('INSERT INTO maps (name, active) VALUES (?,1)').run(name);
  } catch { return res.status(409).json({ error: 'Map already exists' }); }
  res.json({ ok: true });
});

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
function stratOut(row, userId) {
  if (!row) return null;
  const out = { ...row };
  for (const k of STRAT_JSON) out[k] = parseJ(row[k], []);
  if (userId != null) {
    out.favorite = !!db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND strategy_id = ?').get(userId, row.id);
  }
  const creator = row.created_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(row.created_by) : null;
  out.created_by_name = creator ? creator.name : null;
  return out;
}

app.get('/api/teams/:teamId/strategies', auth, requireTeam(null), (req, res) => {
  const q = req.query;
  let sql = 'SELECT * FROM strategies WHERE team_id = ?';
  const args = [req.access.team.id];
  const eq = { map: 'map', side: 'side', category: 'category', buy_type: 'buy_type', site: 'site', difficulty: 'difficulty', status: 'status' };
  for (const [param, col] of Object.entries(eq)) {
    if (q[param]) { sql += ` AND ${col} = ?`; args.push(q[param]); }
  }
  if (!q.status) sql += ` AND status != 'archived'`;
  if (q.tag) { sql += ` AND tags LIKE ?`; args.push(`%"${q.tag}"%`); }
  if (q.q) {
    sql += ` AND (name LIKE ? OR summary LIKE ? OR objective LIKE ? OR tags LIKE ?)`;
    const like = `%${q.q}%`;
    args.push(like, like, like, like);
  }
  sql += ' ORDER BY updated_at DESC';
  res.json(db.prepare(sql).all(...args).map(r => stratOut(r, req.user.id)));
});

app.post('/api/teams/:teamId/strategies', auth, requireTeam('strategies'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.map || !b.side) {
    return res.status(400).json({ error: 'Name, map, and side are required' });
  }
  const err = strategyError(b, false);
  if (err) return res.status(400).json({ error: err });
  b.category = b.category || 'General';
  const t = now();
  const id = db.prepare(`INSERT INTO strategies
    (team_id, name, map, side, category, buy_type, site, map_area, tags, difficulty, spawn_dependency, required_utility,
     objective, summary, steps, roles, timings, midround, reactions, backup, warnings, attachments, status, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.access.team.id, b.name, b.map, b.side, b.category, b.buy_type || null, b.site || null, b.map_area || null,
    JSON.stringify(b.tags || []), b.difficulty || 'standard', b.spawn_dependency || null, b.required_utility || null,
    b.objective || null, b.summary || null, JSON.stringify(b.steps || []), JSON.stringify(b.roles || []),
    JSON.stringify(b.timings || []), JSON.stringify(b.midround || []), JSON.stringify(b.reactions || []),
    b.backup || null, JSON.stringify(b.warnings || []), JSON.stringify(b.attachments || []),
    b.status === 'draft' ? 'draft' : 'active', req.user.id, t, t
  ).lastInsertRowid;
  res.json(stratOut(db.prepare('SELECT * FROM strategies WHERE id = ?').get(id), req.user.id));
});

app.get('/api/strategies/:id', auth, requireResource('strategy', null), (req, res) => {
  res.json(stratOut(db.prepare('SELECT * FROM strategies WHERE id = ?').get(Number(req.params.id)), req.user.id));
});

app.put('/api/strategies/:id', auth, requireResource('strategy', 'strategies'), (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const err = strategyError(b, true);
  if (err) return res.status(400).json({ error: err });
  const cur = db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
  const val = (k, d) => (b[k] !== undefined ? b[k] : d);
  db.prepare(`UPDATE strategies SET
    name=?, map=?, side=?, category=?, buy_type=?, site=?, map_area=?, tags=?, difficulty=?, spawn_dependency=?,
    required_utility=?, objective=?, summary=?, steps=?, roles=?, timings=?, midround=?, reactions=?, backup=?,
    warnings=?, attachments=?, status=?, updated_at=? WHERE id=?`).run(
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
  res.json(stratOut(db.prepare('SELECT * FROM strategies WHERE id = ?').get(id), req.user.id));
});

app.post('/api/strategies/:id/duplicate', auth, requireResource('strategy', 'strategies'), (req, res) => {
  const cur = db.prepare('SELECT * FROM strategies WHERE id = ?').get(Number(req.params.id));
  const t = now();
  const id = db.prepare(`INSERT INTO strategies
    (team_id, name, map, side, category, buy_type, site, map_area, tags, difficulty, spawn_dependency, required_utility,
     objective, summary, steps, roles, timings, midround, reactions, backup, warnings, attachments, status, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    cur.team_id, cur.name + ' (copy)', cur.map, cur.side, cur.category, cur.buy_type, cur.site, cur.map_area,
    cur.tags, cur.difficulty, cur.spawn_dependency, cur.required_utility, cur.objective, cur.summary,
    cur.steps, cur.roles, cur.timings, cur.midround, cur.reactions, cur.backup, cur.warnings, cur.attachments,
    'draft', req.user.id, t, t
  ).lastInsertRowid;
  res.json(stratOut(db.prepare('SELECT * FROM strategies WHERE id = ?').get(id), req.user.id));
});

app.delete('/api/strategies/:id', auth, requireResource('strategy', 'strategies'), (req, res) => {
  const cur = db.prepare('SELECT status FROM strategies WHERE id = ?').get(Number(req.params.id));
  if (cur.status !== 'archived') return res.status(400).json({ error: 'Archive a strategy before deleting it permanently' });
  db.prepare('DELETE FROM strategies WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/strategies/:id/favorite', auth, requireResource('strategy', null), (req, res) => {
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, strategy_id) VALUES (?,?)').run(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/strategies/:id/favorite', auth, requireResource('strategy', null), (req, res) => {
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND strategy_id = ?').run(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

// ---------- opponents ----------
function oppOut(row) {
  if (!row) return null;
  const players = db.prepare('SELECT * FROM opponent_players WHERE opponent_id = ? ORDER BY name').all(row.id);
  const tendencies = db.prepare(`
    SELECT td.*, op.name AS player_name FROM tendencies td
    LEFT JOIN opponent_players op ON op.id = td.opponent_player_id
    WHERE td.opponent_id = ? ORDER BY td.severity = 'high' DESC, td.id`).all(row.id);
  return { ...row, players, tendencies, faceit_intel: parseJ(row.faceit_intel, null) };
}

app.get('/api/teams/:teamId/opponents', auth, requireTeam(null), (req, res) => {
  const rows = db.prepare('SELECT * FROM opponents WHERE team_id = ? ORDER BY name').all(req.access.team.id);
  res.json(rows.map(r => ({
    ...r,
    player_count: db.prepare('SELECT COUNT(*) c FROM opponent_players WHERE opponent_id = ?').get(r.id).c,
    tendency_count: db.prepare('SELECT COUNT(*) c FROM tendencies WHERE opponent_id = ?').get(r.id).c,
    key_count: db.prepare(`SELECT COUNT(*) c FROM tendencies WHERE opponent_id = ? AND severity = 'high'`).get(r.id).c,
  })));
});

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

app.post('/api/teams/:teamId/opponents', auth, requireTeam('scouting'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Opponent name required' });
  const err = opponentError(b, false);
  if (err) return res.status(400).json({ error: err });
  const t = now();
  const id = db.prepare(`INSERT INTO opponents
    (team_id, name, org_name, playstyle, map_pool, preferred_picks, preferred_bans, econ_notes, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.access.team.id, b.name, b.org_name || null, b.playstyle || null, b.map_pool || null,
    b.preferred_picks || null, b.preferred_bans || null, b.econ_notes || null, b.notes || null, t, t
  ).lastInsertRowid;
  res.json(oppOut(db.prepare('SELECT * FROM opponents WHERE id = ?').get(id)));
});

app.get('/api/opponents/:id', auth, requireResource('opponent', null), (req, res) => {
  res.json(oppOut(db.prepare('SELECT * FROM opponents WHERE id = ?').get(Number(req.params.id))));
});

app.put('/api/opponents/:id', auth, requireResource('opponent', 'scouting'), (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM opponents WHERE id = ?').get(id);
  const b = req.body || {};
  const err = opponentError(b, true);
  if (err) return res.status(400).json({ error: err });
  const val = (k) => (b[k] !== undefined ? b[k] : cur[k]);
  db.prepare(`UPDATE opponents SET name=?, org_name=?, playstyle=?, map_pool=?, preferred_picks=?,
    preferred_bans=?, econ_notes=?, notes=?, updated_at=? WHERE id=?`).run(
    val('name'), val('org_name'), val('playstyle'), val('map_pool'), val('preferred_picks'),
    val('preferred_bans'), val('econ_notes'), val('notes'), now(), id);
  res.json(oppOut(db.prepare('SELECT * FROM opponents WHERE id = ?').get(id)));
});

// pull recent form + per-map win rates for a FACEIT-linked opponent and store them
app.post('/api/opponents/:id/faceit-intel', faceitLimiter, auth, requireResource('opponent', 'scouting'), async (req, res) => {
  const opp = db.prepare('SELECT * FROM opponents WHERE id = ?').get(Number(req.params.id));
  if (!opp.faceit_team_id) return res.status(400).json({ error: 'This opponent is not linked to a FACEIT team' });
  const team = db.prepare('SELECT faceit_api_key FROM teams WHERE id = ?').get(opp.team_id);
  if (!team.faceit_api_key) return res.status(400).json({ error: 'Connect FACEIT on the Team page first' });
  try {
    const intel = await faceit.teamIntel(team.faceit_api_key, opp.faceit_team_id);
    db.prepare('UPDATE opponents SET faceit_intel = ? WHERE id = ?').run(JSON.stringify(intel), opp.id);
    res.json(oppOut(db.prepare('SELECT * FROM opponents WHERE id = ?').get(opp.id)));
  } catch (e) {
    res.status(502).json({ error: e.code === 404 ? 'FACEIT has no stats for this team yet' : e.message });
  }
});

app.delete('/api/opponents/:id', auth, requireResource('opponent', 'scouting'), (req, res) => {
  db.prepare('DELETE FROM opponents WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

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

app.post('/api/opponents/:id/players', auth, requireResource('opponent', 'scouting'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Player name required' });
  const err = opponentPlayerError(b, false);
  if (err) return res.status(400).json({ error: err });
  db.prepare(`INSERT INTO opponent_players (opponent_id, name, role, positions, weapons, aggression, habits, weaknesses, notes)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(Number(req.params.id), b.name, b.role || null, b.positions || null,
    b.weapons || null, b.aggression || null, b.habits || null, b.weaknesses || null, b.notes || null);
  res.json(oppOut(db.prepare('SELECT * FROM opponents WHERE id = ?').get(Number(req.params.id))));
});

app.put('/api/opponent-players/:pid', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM opponent_players WHERE id = ?').get(Number(req.params.pid));
  if (!p) return res.status(404).json({ error: 'Not found' });
  req.params.id = p.opponent_id;
  requireResource('opponent', 'scouting')(req, res, () => {
    const b = req.body || {};
    const err = opponentPlayerError(b, true);
    if (err) return res.status(400).json({ error: err });
    const val = (k) => (b[k] !== undefined ? b[k] : p[k]);
    db.prepare(`UPDATE opponent_players SET name=?, role=?, positions=?, weapons=?, aggression=?, habits=?, weaknesses=?, notes=? WHERE id=?`)
      .run(val('name'), val('role'), val('positions'), val('weapons'), val('aggression'), val('habits'), val('weaknesses'), val('notes'), p.id);
    res.json(oppOut(db.prepare('SELECT * FROM opponents WHERE id = ?').get(p.opponent_id)));
  });
});

app.delete('/api/opponent-players/:pid', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM opponent_players WHERE id = ?').get(Number(req.params.pid));
  if (!p) return res.status(404).json({ error: 'Not found' });
  req.params.id = p.opponent_id;
  requireResource('opponent', 'scouting')(req, res, () => {
    db.prepare('DELETE FROM opponent_players WHERE id = ?').run(p.id);
    res.json({ ok: true });
  });
});

// tendencies
app.post('/api/opponents/:id/tendencies', auth, requireResource('opponent', 'scouting'), (req, res) => {
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
    const op = db.prepare('SELECT opponent_id FROM opponent_players WHERE id = ?').get(Number(b.opponent_player_id));
    if (!op || op.opponent_id !== Number(req.params.id)) {
      return res.status(400).json({ error: 'That player is not on this opponent' });
    }
  }
  db.prepare(`INSERT INTO tendencies (opponent_id, opponent_player_id, map, side, site, round_type, category, text, severity, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    Number(req.params.id), b.opponent_player_id || null, b.map || null, b.side || null, b.site || null,
    b.round_type || null, b.category || null, b.text, b.severity === 'high' ? 'high' : 'normal', req.user.id, now());
  res.json(oppOut(db.prepare('SELECT * FROM opponents WHERE id = ?').get(Number(req.params.id))));
});

app.delete('/api/tendencies/:tid', auth, (req, res) => {
  const td = db.prepare('SELECT * FROM tendencies WHERE id = ?').get(Number(req.params.tid));
  if (!td) return res.status(404).json({ error: 'Not found' });
  req.params.id = td.opponent_id;
  requireResource('opponent', 'scouting')(req, res, () => {
    db.prepare('DELETE FROM tendencies WHERE id = ?').run(td.id);
    res.json({ ok: true });
  });
});

// ---------- matches ----------
function matchOut(row, userId) {
  if (!row) return null;
  const out = { ...row };
  out.expected_maps = parseJ(row.expected_maps, []);
  out.roster = parseJ(row.roster, []);
  out.subs = parseJ(row.subs, []);
  out.opponent = row.opponent_id ? db.prepare('SELECT * FROM opponents WHERE id = ?').get(row.opponent_id) : null;
  out.pins = db.prepare(`
    SELECT s.*, p.sort FROM match_pins p JOIN strategies s ON s.id = p.strategy_id
    WHERE p.match_id = ? ORDER BY p.sort`).all(row.id).map(s => stratOut(s, userId));
  out.notes = db.prepare('SELECT * FROM match_notes WHERE match_id = ? ORDER BY kind, sort').all(row.id);
  out.roster_users = out.roster.length
    ? db.prepare(`SELECT u.id, u.name, tm.game_role FROM users u
        LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = ?
        WHERE u.id IN (${out.roster.map(() => '?').join(',')})`).all(row.team_id, ...out.roster)
    : [];
  out.opponent_players = row.opponent_id
    ? db.prepare('SELECT * FROM opponent_players WHERE opponent_id = ?').all(row.opponent_id)
    : [];
  out.team_faceit_roster = parseJ(db.prepare('SELECT faceit_roster FROM teams WHERE id = ?').get(row.team_id).faceit_roster, []);
  out.faceit_result = parseJ(row.faceit_result, null);
  return out;
}

app.get('/api/teams/:teamId/matches', auth, requireTeam(null), (req, res) => {
  const rows = db.prepare('SELECT * FROM matches WHERE team_id = ? ORDER BY scheduled_at DESC').all(req.access.team.id);
  res.json(rows.map(r => ({
    ...r,
    expected_maps: parseJ(r.expected_maps, []),
    opponent: r.opponent_id ? db.prepare('SELECT id, name FROM opponents WHERE id = ?').get(r.opponent_id) : null,
  })));
});

// Shared checks for creating/updating a match (partial=true on updates).
function matchError(b, teamId) {
  return v.firstError(
    v.optionalIdNumber(b.opponent_id, 'Opponent'),
    v.optionalString(b.scheduled_at, 'Match time', 40),
    v.optionalString(b.event, 'Event', 200),
    v.optionalOneOf(b.format, 'Format', ['BO1', 'BO3', 'BO5']),
    v.stringArray(b.expected_maps, 'Expected maps', { maxItems: 10, maxLen: 50 }),
    v.optionalString(b.veto_notes, 'Veto notes', 5000),
    v.optionalOneOf(b.starting_side, 'Starting side', ['T', 'CT']),
    v.numberArray(b.roster, 'Roster', { maxItems: 20 }),
    v.numberArray(b.subs, 'Subs', { maxItems: 20 }),
    // a linked opponent must belong to this team, not leak another team's scouting
    b.opponent_id && resourceTeam('opponent', Number(b.opponent_id)) !== teamId && 'Opponent not found',
  );
}

app.post('/api/teams/:teamId/matches', auth, requireTeam('matches'), (req, res) => {
  const b = req.body || {};
  const err = matchError(b, req.access.team.id);
  if (err) return res.status(400).json({ error: err });
  const id = db.prepare(`INSERT INTO matches
    (team_id, opponent_id, scheduled_at, event, format, expected_maps, veto_notes, starting_side, roster, subs, status, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.access.team.id, b.opponent_id || null, b.scheduled_at || null, b.event || null, b.format || 'BO3',
    JSON.stringify(b.expected_maps || []), b.veto_notes || null, b.starting_side || null,
    JSON.stringify(b.roster || []), JSON.stringify(b.subs || []), 'upcoming', req.user.id, now()
  ).lastInsertRowid;
  res.json(matchOut(db.prepare('SELECT * FROM matches WHERE id = ?').get(id), req.user.id));
});

app.get('/api/matches/:id', auth, requireResource('match', null), (req, res) => {
  res.json(matchOut(db.prepare('SELECT * FROM matches WHERE id = ?').get(Number(req.params.id)), req.user.id));
});

app.put('/api/matches/:id', auth, requireResource('match', 'matches'), (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
  const b = req.body || {};
  const err = matchError(b, req.teamId);
  if (err) return res.status(400).json({ error: err });
  const val = (k, json) => b[k] !== undefined ? (json ? JSON.stringify(b[k]) : b[k]) : cur[k];
  db.prepare(`UPDATE matches SET opponent_id=?, scheduled_at=?, event=?, format=?, expected_maps=?, veto_notes=?,
    starting_side=?, roster=?, subs=?, status=? WHERE id=?`).run(
    val('opponent_id'), val('scheduled_at'), val('event'), val('format'), val('expected_maps', true),
    val('veto_notes'), val('starting_side'), val('roster', true), val('subs', true),
    ['upcoming', 'live', 'completed'].includes(b.status) ? b.status : cur.status, id);
  res.json(matchOut(db.prepare('SELECT * FROM matches WHERE id = ?').get(id), req.user.id));
});

app.delete('/api/matches/:id', auth, requireResource('match', 'matches'), (req, res) => {
  db.prepare('DELETE FROM matches WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// pins
app.post('/api/matches/:id/pins', auth, requireResource('match', 'matches'), (req, res) => {
  const matchId = Number(req.params.id);
  const sid = Number(req.body?.strategy_id);
  if (resourceTeam('strategy', sid) !== req.teamId) return res.status(400).json({ error: 'Strategy not found' });
  const max = db.prepare('SELECT COALESCE(MAX(sort),-1) m FROM match_pins WHERE match_id = ?').get(matchId).m;
  db.prepare('INSERT OR IGNORE INTO match_pins (match_id, strategy_id, sort) VALUES (?,?,?)').run(matchId, sid, max + 1);
  res.json({ ok: true });
});
app.delete('/api/matches/:id/pins/:sid', auth, requireResource('match', 'matches'), (req, res) => {
  db.prepare('DELETE FROM match_pins WHERE match_id = ? AND strategy_id = ?').run(Number(req.params.id), Number(req.params.sid));
  res.json({ ok: true });
});

// notes
app.post('/api/matches/:id/notes', auth, requireResource('match', 'matches'), (req, res) => {
  const b = req.body || {};
  if (!b.text || b.kind !== 'reminder') return res.status(400).json({ error: 'Note text and kind required' });
  const err = v.requiredString(b.text, 'Note text', 2000);
  if (err) return res.status(400).json({ error: err });
  const max = db.prepare('SELECT COALESCE(MAX(sort),-1) m FROM match_notes WHERE match_id = ? AND kind = ?').get(Number(req.params.id), b.kind).m;
  db.prepare('INSERT INTO match_notes (match_id, kind, text, sort) VALUES (?,?,?,?)').run(Number(req.params.id), b.kind, b.text, max + 1);
  res.json({ ok: true });
});
app.delete('/api/match-notes/:nid', auth, (req, res) => {
  const n = db.prepare('SELECT * FROM match_notes WHERE id = ?').get(Number(req.params.nid));
  if (!n) return res.status(404).json({ error: 'Not found' });
  req.params.id = n.match_id;
  requireResource('match', 'matches')(req, res, () => {
    db.prepare('DELETE FROM match_notes WHERE id = ?').run(n.id);
    res.json({ ok: true });
  });
});

// ---------- recents ----------
app.post('/api/recents', auth, (req, res) => {
  const { item_type, item_id } = req.body || {};
  if (!['strategy', 'opponent', 'match'].includes(item_type) || !Number(item_id)) {
    return res.status(400).json({ error: 'Bad recent item' });
  }
  // The item must exist AND belong to a team the signed-in user can access.
  // Existence alone is not enough: answering differently for other teams'
  // ids would both confirm private ids and let anyone write recents rows
  // pointing at data they cannot see. Same 404 either way, on purpose.
  const teamId = resourceTeam(item_type, Number(item_id));
  if (teamId == null || !teamAccess(req, teamId)) return res.status(404).json({ error: 'Not found' });
  db.prepare('INSERT OR REPLACE INTO recents (user_id, item_type, item_id, viewed_at) VALUES (?,?,?,?)')
    .run(req.user.id, item_type, Number(item_id), now());
  res.json({ ok: true });
});

app.get('/api/teams/:teamId/recents', auth, requireTeam(null), (req, res) => {
  const rows = db.prepare('SELECT * FROM recents WHERE user_id = ? ORDER BY viewed_at DESC LIMIT 12').all(req.user.id);
  const out = [];
  for (const r of rows) {
    if (r.item_type === 'strategy') {
      const s = db.prepare('SELECT id, name, map, side, category FROM strategies WHERE id = ? AND team_id = ?').get(r.item_id, req.access.team.id);
      if (s) out.push({ type: 'strategy', ...s, viewed_at: r.viewed_at });
    } else if (r.item_type === 'opponent') {
      const o = db.prepare('SELECT id, name FROM opponents WHERE id = ? AND team_id = ?').get(r.item_id, req.access.team.id);
      if (o) out.push({ type: 'opponent', ...o, viewed_at: r.viewed_at });
    } else if (r.item_type === 'match') {
      const m = db.prepare('SELECT id, event, opponent_id FROM matches WHERE id = ? AND team_id = ?').get(r.item_id, req.access.team.id);
      if (m) {
        const opp = m.opponent_id ? db.prepare('SELECT name FROM opponents WHERE id = ?').get(m.opponent_id) : null;
        out.push({ type: 'match', id: m.id, name: opp ? `vs ${opp.name}` : (m.event || 'Match'), viewed_at: r.viewed_at });
      }
    }
  }
  res.json(out);
});

// ---------- search ----------
app.get('/api/teams/:teamId/search', auth, requireTeam(null), (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ strategies: [], opponents: [], players: [], tendencies: [], matches: [] });
  const like = `%${q}%`;
  const teamId = req.access.team.id;
  res.json({
    strategies: db.prepare(`SELECT id, name, map, side, category, status FROM strategies
      WHERE team_id = ? AND (name LIKE ? OR summary LIKE ? OR objective LIKE ? OR tags LIKE ?) LIMIT 15`)
      .all(teamId, like, like, like, like),
    opponents: db.prepare(`SELECT id, name FROM opponents WHERE team_id = ? AND (name LIKE ? OR playstyle LIKE ? OR notes LIKE ?) LIMIT 8`)
      .all(teamId, like, like, like),
    players: db.prepare(`SELECT op.id, op.name, op.role, op.opponent_id, o.name AS opponent_name
      FROM opponent_players op JOIN opponents o ON o.id = op.opponent_id
      WHERE o.team_id = ? AND (op.name LIKE ? OR op.habits LIKE ? OR op.notes LIKE ?) LIMIT 8`)
      .all(teamId, like, like, like),
    tendencies: db.prepare(`SELECT td.id, td.text, td.map, td.side, td.severity, td.opponent_id, o.name AS opponent_name
      FROM tendencies td JOIN opponents o ON o.id = td.opponent_id
      WHERE o.team_id = ? AND td.text LIKE ? LIMIT 10`).all(teamId, like),
    matches: db.prepare(`SELECT m.id, m.event, m.scheduled_at, o.name AS opponent_name
      FROM matches m LEFT JOIN opponents o ON o.id = m.opponent_id
      WHERE m.team_id = ? AND (m.event LIKE ? OR o.name LIKE ? OR m.veto_notes LIKE ?) LIMIT 8`)
      .all(teamId, like, like, like),
  });
});

// ---------- team / org management ----------
app.get('/api/teams/:teamId/members', auth, requireTeam(null), (req, res) => {
  const orgId = req.access.team.org_id;
  const members = db.prepare(`
    SELECT u.id, u.name, u.email, m.role, tm.game_role, tm.is_starter
    FROM org_members m JOIN users u ON u.id = m.user_id
    LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = ?
    WHERE m.org_id = ? ORDER BY
      CASE m.role WHEN 'owner' THEN 0 WHEN 'edit' THEN 1 ELSE 2 END, u.name`)
    .all(req.access.team.id, orgId);
  res.json({ members, my_role: req.access.role });
});

const VALID_ROLES = ['owner', 'edit', 'view'];

app.put('/api/teams/:teamId/members/:uid', auth, requireTeam('team'), (req, res) => {
  const orgId = req.access.team.org_id;
  const uid = Number(req.params.uid);
  const b = req.body || {};
  const target = db.prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?').get(orgId, uid);
  if (!target) return res.status(404).json({ error: 'Not a member' });
  const gameRoleErr = v.optionalString(b.game_role, 'Game role', 50);
  if (gameRoleErr) return res.status(400).json({ error: gameRoleErr });
  if (b.role !== undefined) {
    if (!VALID_ROLES.includes(b.role)) return res.status(400).json({ error: 'Invalid role' });
    if (target.role === 'owner' && req.access.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change the owner role' });
    if (uid === req.user.id && target.role === 'owner' && b.role !== 'owner') {
      const owners = db.prepare(`SELECT COUNT(*) c FROM org_members WHERE org_id = ? AND role = 'owner'`).get(orgId).c;
      if (owners <= 1) return res.status(400).json({ error: 'The organization must keep at least one owner' });
    }
    db.prepare('UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?').run(b.role, orgId, uid);
  }
  if (b.game_role !== undefined || b.is_starter !== undefined) {
    const tm = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(req.access.team.id, uid);
    if (tm) {
      db.prepare('UPDATE team_members SET game_role = ?, is_starter = ? WHERE team_id = ? AND user_id = ?')
        .run(b.game_role !== undefined ? b.game_role : tm.game_role,
             b.is_starter !== undefined ? (b.is_starter ? 1 : 0) : tm.is_starter,
             req.access.team.id, uid);
    } else {
      db.prepare('INSERT INTO team_members (team_id, user_id, game_role, is_starter) VALUES (?,?,?,?)')
        .run(req.access.team.id, uid, b.game_role || null, b.is_starter ? 1 : 0);
    }
  }
  res.json({ ok: true });
});

app.delete('/api/teams/:teamId/members/:uid', auth, requireTeam('team'), (req, res) => {
  const orgId = req.access.team.org_id;
  const uid = Number(req.params.uid);
  const target = db.prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?').get(orgId, uid);
  if (!target) return res.status(404).json({ error: 'Not a member' });
  if (target.role === 'owner') return res.status(400).json({ error: 'Transfer ownership before removing an owner' });
  db.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?').run(orgId, uid);
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(req.access.team.id, uid);
  // their player slot stays on the roster, just unassigned
  db.prepare('UPDATE team_players SET user_id = NULL WHERE team_id = ? AND user_id = ?').run(req.access.team.id, uid);
  res.json({ ok: true });
});

// ---------- team roster (player slots) ----------
function playerOut(row) {
  if (!row) return null;
  const out = { ...row, faceit_stats: parseJ(row.faceit_stats, null) };
  out.user = row.user_id ? db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(row.user_id) : null;
  return out;
}

app.get('/api/teams/:teamId/players', auth, requireTeam(null), (req, res) => {
  const rows = db.prepare('SELECT * FROM team_players WHERE team_id = ? ORDER BY is_starter DESC, name').all(req.access.team.id);
  res.json(rows.map(playerOut));
});

app.post('/api/teams/:teamId/players', auth, requireTeam('team'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Player name required' });
  const err = v.firstError(
    v.requiredString(b.name, 'Player name', 80),
    v.optionalString(b.game_role, 'Game role', 50),
    v.optionalString(b.faceit_nickname, 'FACEIT nickname', 80),
  );
  if (err) return res.status(400).json({ error: err });
  const id = db.prepare('INSERT INTO team_players (team_id, name, game_role, is_starter, faceit_nickname) VALUES (?,?,?,?,?)')
    .run(req.access.team.id, String(b.name).trim(), b.game_role || null, b.is_starter === false ? 0 : 1, b.faceit_nickname || null).lastInsertRowid;
  res.json(playerOut(db.prepare('SELECT * FROM team_players WHERE id = ?').get(id)));
});

app.get('/api/team-players/:id', auth, requireResource('team_player', null), (req, res) => {
  res.json(playerOut(db.prepare('SELECT * FROM team_players WHERE id = ?').get(Number(req.params.id))));
});

app.put('/api/team-players/:id', auth, requireResource('team_player', 'team'), (req, res) => {
  const p = db.prepare('SELECT * FROM team_players WHERE id = ?').get(Number(req.params.id));
  const b = req.body || {};
  const err = v.firstError(
    b.name !== undefined && v.requiredString(b.name, 'Player name', 80),
    v.optionalString(b.game_role, 'Game role', 50),
    v.optionalString(b.faceit_nickname, 'FACEIT nickname', 80),
  );
  if (err) return res.status(400).json({ error: err });
  if (b.user_id !== undefined && b.user_id !== null && b.user_id !== '') {
    // assignee must belong to the org and can only control one slot per team
    const role = orgRole(Number(b.user_id), req.access.team.org_id);
    if (!role) return res.status(400).json({ error: 'That user is not a member of this organization' });
    const taken = db.prepare('SELECT id FROM team_players WHERE team_id = ? AND user_id = ? AND id != ?')
      .get(p.team_id, Number(b.user_id), p.id);
    if (taken) return res.status(400).json({ error: 'That user already controls another player on this team' });
  }
  const val = (k, cur) => b[k] !== undefined ? b[k] : cur;
  db.prepare('UPDATE team_players SET name=?, game_role=?, is_starter=?, user_id=?, faceit_nickname=? WHERE id=?')
    .run(String(val('name', p.name)).trim() || p.name, val('game_role', p.game_role),
      b.is_starter !== undefined ? (b.is_starter ? 1 : 0) : p.is_starter,
      b.user_id !== undefined ? (Number(b.user_id) || null) : p.user_id,
      val('faceit_nickname', p.faceit_nickname), p.id);
  res.json(playerOut(db.prepare('SELECT * FROM team_players WHERE id = ?').get(p.id)));
});

app.delete('/api/team-players/:id', auth, requireResource('team_player', 'team'), (req, res) => {
  db.prepare('DELETE FROM team_players WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// auto-pull FACEIT stats for a player slot (nickname lookup + ELO/level + last-30 aggregate)
app.post('/api/team-players/:id/faceit-refresh', faceitLimiter, auth, requireResource('team_player', null), async (req, res) => {
  const p = db.prepare('SELECT * FROM team_players WHERE id = ?').get(Number(req.params.id));
  const team = db.prepare('SELECT faceit_api_key FROM teams WHERE id = ?').get(p.team_id);
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
    db.prepare('UPDATE team_players SET faceit_player_id = ?, faceit_nickname = ?, faceit_stats = ? WHERE id = ?')
      .run(pid, nickname, JSON.stringify(st), p.id);
    res.json(playerOut(db.prepare('SELECT * FROM team_players WHERE id = ?').get(p.id)));
  } catch (e) {
    res.status(502).json({ error: e.code === 404 ? `No FACEIT player named "${nickname}"` : e.message });
  }
});

// look up any FACEIT player by nickname (uses the team's API key)
app.get('/api/teams/:teamId/faceit-lookup', faceitLimiter, auth, requireTeam(null), async (req, res) => {
  const nickname = String(req.query.nickname || '').trim();
  if (!nickname) return res.status(400).json({ error: 'Nickname required' });
  if (nickname.length > 80) return res.status(400).json({ error: 'Nickname must be at most 80 characters' });
  const t = db.prepare('SELECT faceit_api_key FROM teams WHERE id = ?').get(req.access.team.id);
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
});

// paged match history for a looked-up player
app.get('/api/teams/:teamId/faceit-matches', faceitLimiter, auth, requireTeam(null), async (req, res) => {
  const pid = String(req.query.player_id || '').trim();
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  if (!pid) return res.status(400).json({ error: 'player_id required' });
  if (pid.length > 80) return res.status(400).json({ error: 'player_id must be at most 80 characters' });
  const t = db.prepare('SELECT faceit_api_key FROM teams WHERE id = ?').get(req.access.team.id);
  if (!t.faceit_api_key) return res.status(400).json({ error: 'Connect FACEIT on the Team page first' });
  try {
    res.json(await faceit.playerMatches(t.faceit_api_key, pid, 'cs2', offset, limit));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/teams/:teamId/invites', auth, requireTeam('team'), (req, res) => {
  res.json(db.prepare('SELECT id, role, code, email, created_at, used_by FROM invites WHERE org_id = ? ORDER BY id DESC').all(req.access.team.org_id));
});

// direct invite to an EXISTING account — lands in their profile menu, no code needed
app.post('/api/teams/:teamId/invites/direct', auth, requireTeam('team'), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = req.body?.role;
  if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
  if (!['edit', 'view'].includes(role)) return res.status(400).json({ error: 'Invalid invite role' });
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: 'No account with that email — generate an invite code for new users instead' });
  if (orgRole(user.id, req.access.team.org_id)) return res.status(409).json({ error: 'That user is already a member of this organization' });
  if (db.prepare('SELECT 1 FROM invites WHERE org_id = ? AND email = ? AND used_by IS NULL').get(req.access.team.org_id, email)) {
    return res.status(409).json({ error: 'That user already has a pending invite' });
  }
  const code = crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO invites (org_id, team_id, role, code, email, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(req.access.team.org_id, req.access.team.id, role, code, email, req.user.id, now());
  res.json({ ok: true });
});

// the signed-in user's pending invites (in-app inbox)
app.get('/api/me/invites', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT i.id, i.role, i.created_at, o.name AS org_name, t.name AS team_name, u.name AS invited_by
    FROM invites i
    JOIN organizations o ON o.id = i.org_id
    LEFT JOIN teams t ON t.id = i.team_id
    LEFT JOIN users u ON u.id = i.created_by
    WHERE i.email = ? AND i.used_by IS NULL ORDER BY i.id DESC`).all(req.user.email));
});

app.post('/api/invites/:iid/accept', auth, (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE id = ? AND used_by IS NULL').get(Number(req.params.iid));
  if (!inv || inv.email !== req.user.email) return res.status(404).json({ error: 'Invite not found' });
  if (!orgRole(req.user.id, inv.org_id)) {
    db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)').run(inv.org_id, req.user.id, inv.role);
  }
  if (inv.team_id && !db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(inv.team_id, req.user.id)) {
    db.prepare('INSERT INTO team_members (team_id, user_id, is_starter) VALUES (?,?,0)').run(inv.team_id, req.user.id);
  }
  db.prepare('UPDATE invites SET used_by = ? WHERE id = ?').run(req.user.id, inv.id);
  res.json({ ok: true, team_id: inv.team_id });
});

app.post('/api/invites/:iid/decline', auth, (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE id = ? AND used_by IS NULL').get(Number(req.params.iid));
  if (!inv || inv.email !== req.user.email) return res.status(404).json({ error: 'Invite not found' });
  db.prepare('DELETE FROM invites WHERE id = ?').run(inv.id);
  res.json({ ok: true });
});

app.post('/api/teams/:teamId/invites', auth, requireTeam('team'), (req, res) => {
  const role = req.body?.role;
  if (!VALID_ROLES.includes(role) || role === 'owner') return res.status(400).json({ error: 'Invalid invite role' });
  const code = crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO invites (org_id, team_id, role, code, created_by, created_at) VALUES (?,?,?,?,?,?)')
    .run(req.access.team.org_id, req.access.team.id, role, code, req.user.id, now());
  res.json({ code });
});

app.delete('/api/invites/:iid', auth, (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE id = ?').get(Number(req.params.iid));
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const role = orgRole(req.user.id, inv.org_id);
  if (!CAN.team.includes(role)) return res.status(403).json({ error: 'Your role cannot manage invites' });
  db.prepare('DELETE FROM invites WHERE id = ?').run(inv.id);
  res.json({ ok: true });
});

// ---------- FACEIT integration ----------
app.get('/api/teams/:teamId/faceit', auth, requireTeam(null), (req, res) => {
  const t = db.prepare('SELECT faceit_team_id, faceit_team_name, faceit_last_sync, faceit_api_key, faceit_roster FROM teams WHERE id = ?').get(req.access.team.id);
  res.json({
    connected: !!(t.faceit_team_id && t.faceit_api_key),
    team_id: t.faceit_team_id,
    team_name: t.faceit_team_name,
    last_sync: t.faceit_last_sync,
    roster: parseJ(t.faceit_roster, []),
    can_manage: CAN.team.includes(req.access.role),
  });
});

app.put('/api/teams/:teamId/faceit', faceitLimiter, auth, requireTeam('team'), async (req, res) => {
  const { api_key, team } = req.body || {};
  if (!api_key || !team) return res.status(400).json({ error: 'FACEIT API key and team id (or team URL) are required' });
  const err = v.firstError(
    v.requiredString(api_key, 'FACEIT API key', 200),
    v.requiredString(team, 'FACEIT team', 300),
  );
  if (err) return res.status(400).json({ error: err });
  try {
    const info = await faceit.lookupTeam(String(api_key).trim(), String(team));
    db.prepare('UPDATE teams SET faceit_team_id = ?, faceit_team_name = ?, faceit_api_key = ? WHERE id = ?')
      .run(info.id, info.name, String(api_key).trim(), req.access.team.id);
    res.json({ ok: true, team_name: info.name, team_id: info.id });
  } catch (e) {
    const msg = e.code === 401 ? 'FACEIT rejected the API key — check it on developers.faceit.com'
      : e.code === 404 ? 'Team not found on FACEIT — paste the team page URL or team id'
      : `Could not reach FACEIT: ${e.message}`;
    res.status(400).json({ error: msg });
  }
});

app.delete('/api/teams/:teamId/faceit', auth, requireTeam('team'), (req, res) => {
  db.prepare('UPDATE teams SET faceit_team_id = NULL, faceit_team_name = NULL, faceit_api_key = NULL, faceit_last_sync = NULL WHERE id = ?')
    .run(req.access.team.id);
  res.json({ ok: true });
});

app.post('/api/teams/:teamId/faceit/sync', faceitLimiter, auth, requireTeam('matches'), async (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.access.team.id);
  if (!team.faceit_team_id || !team.faceit_api_key) {
    return res.status(400).json({ error: 'FACEIT is not connected for this team yet' });
  }
  try {
    const summary = await faceit.syncTeam(db, team);
    res.json(summary);
  } catch (e) {
    res.status(502).json({ error: `FACEIT sync failed: ${e.message}` });
  }
});

// background poll: keep synced teams fresh (matches rescheduled, new league rounds)
const FACEIT_POLL_MS = 30 * 60 * 1000;
setInterval(async () => {
  const teams = db.prepare('SELECT * FROM teams WHERE faceit_team_id IS NOT NULL AND faceit_api_key IS NOT NULL').all();
  for (const team of teams) {
    try {
      const s = await faceit.syncTeam(db, team);
      if (s.created || s.updated) console.log(`[faceit] team ${team.id}: +${s.created} new, ${s.updated} updated`);
    } catch (e) {
      console.error(`[faceit] sync failed for team ${team.id}: ${e.message}`);
    }
  }
}, FACEIT_POLL_MS).unref();

// ---------- dashboard ----------
app.get('/api/teams/:teamId/dashboard', auth, requireTeam(null), (req, res) => {
  const teamId = req.access.team.id;
  const maps = db.prepare('SELECT name FROM maps WHERE active = 1 ORDER BY name').all().map(m => m.name);
  const byMap = {};
  for (const m of maps) {
    byMap[m] = {
      total: db.prepare(`SELECT COUNT(*) c FROM strategies WHERE team_id = ? AND map = ? AND status = 'active'`).get(teamId, m).c,
      t: db.prepare(`SELECT COUNT(*) c FROM strategies WHERE team_id = ? AND map = ? AND side = 'T' AND status = 'active'`).get(teamId, m).c,
      ct: db.prepare(`SELECT COUNT(*) c FROM strategies WHERE team_id = ? AND map = ? AND side = 'CT' AND status = 'active'`).get(teamId, m).c,
      pistol: db.prepare(`SELECT COUNT(*) c FROM strategies WHERE team_id = ? AND map = ? AND category = 'Pistol' AND status = 'active'`).get(teamId, m).c,
    };
  }
  const nextRow = db.prepare(`SELECT m.*, o.name AS opponent_name
    FROM matches m LEFT JOIN opponents o ON o.id = m.opponent_id
    WHERE m.team_id = ? AND m.status = 'upcoming' ORDER BY m.scheduled_at LIMIT 1`).get(teamId);
  let next_match = null;
  if (nextRow) {
    next_match = {
      id: nextRow.id, opponent_id: nextRow.opponent_id, opponent_name: nextRow.opponent_name,
      event: nextRow.event, format: nextRow.format, scheduled_at: nextRow.scheduled_at,
      starting_side: nextRow.starting_side, expected_maps: parseJ(nextRow.expected_maps, []),
      pin_count: db.prepare('SELECT COUNT(*) c FROM match_pins WHERE match_id = ?').get(nextRow.id).c,
    };
  }
  res.json({
    next_match,
    upcoming: db.prepare(`SELECT m.id, m.scheduled_at, m.event, m.format, o.name AS opponent_name
      FROM matches m LEFT JOIN opponents o ON o.id = m.opponent_id
      WHERE m.team_id = ? AND m.status = 'upcoming' ORDER BY m.scheduled_at LIMIT 5`).all(teamId),
    recent_strategies: db.prepare(`SELECT id, name, map, side, category, status, updated_at FROM strategies
      WHERE team_id = ? AND status != 'archived' ORDER BY updated_at DESC LIMIT 6`).all(teamId),
    drafts: db.prepare(`SELECT id, name, map, side, category FROM strategies WHERE team_id = ? AND status = 'draft' ORDER BY updated_at DESC LIMIT 6`).all(teamId),
    archived_count: db.prepare(`SELECT COUNT(*) c FROM strategies WHERE team_id = ? AND status = 'archived'`).get(teamId).c,
    opponents: db.prepare(`SELECT o.id, o.name,
      (SELECT COUNT(*) FROM tendencies t WHERE t.opponent_id = o.id) AS tendency_count,
      (SELECT COUNT(*) FROM opponent_players p WHERE p.opponent_id = o.id) AS player_count
      FROM opponents o WHERE o.team_id = ? ORDER BY o.name`).all(teamId),
    by_map: byMap,
    roster: db.prepare('SELECT * FROM team_players WHERE team_id = ? ORDER BY is_starter DESC, name').all(teamId).map(playerOut),
    faceit_roster: parseJ(db.prepare('SELECT faceit_roster FROM teams WHERE id = ?').get(teamId).faceit_roster, []),
  });
});

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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

// Export the app so tests can start it on an ephemeral port; only listen when
// run directly (node server.js).
if (require.main === module) {
  app.listen(PORT, () => console.log(`MidRound running on http://localhost:${PORT}`));
}

module.exports = app;
