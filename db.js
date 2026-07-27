// MidRound — database layer: adapter, schema, migrations, cleanup.
//
// Two backends behind one tiny async API (the LaneLens pattern):
//   - default: zero-config SQLite file next to server.js (node:sqlite),
//     perfect for local dev and hermetic tests
//   - DATABASE_URL=postgres://... switches the same code to Postgres for
//     production (or for learning — run one locally and point at it)
//
// Every query in the app goes through get()/all()/run(), which are async so
// both drivers look identical to callers. Queries are written once, in the
// dialect both databases share:
//   - `?` placeholders (translated to Postgres's $1, $2, ... here)
//   - LIKE (translated to ILIKE on Postgres so search stays case-insensitive,
//     matching SQLite's behavior)
//   - INSERT ... RETURNING id instead of SQLite-only lastInsertRowid
//   - ON CONFLICT upserts instead of SQLite-only INSERT OR REPLACE

const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL || '';
const usingPostgres = DATABASE_URL.startsWith('postgres');

let sqlite = null;
let pool = null;

if (usingPostgres) {
  const pg = require('pg');
  // COUNT(*) comes back as BIGINT, which node-postgres returns as a string
  // to avoid precision loss; our counts are small, so parse to numbers.
  pg.types.setTypeParser(20, (value) => parseInt(value, 10));
  pool = new pg.Pool({ connectionString: DATABASE_URL });
} else {
  const { DatabaseSync } = require('node:sqlite');
  // MIDROUND_DB_PATH lets tests and containers point at their own file.
  const DB_PATH = process.env.MIDROUND_DB_PATH || path.join(__dirname, 'midround.db');
  sqlite = new DatabaseSync(DB_PATH);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
}

// Translate our shared dialect to Postgres: ? -> $1..$n, LIKE -> ILIKE.
function toPg(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`).replace(/\bLIKE\b/g, 'ILIKE');
}

// One row or undefined.
async function get(sql, ...params) {
  if (usingPostgres) return (await pool.query(toPg(sql), params)).rows[0];
  return sqlite.prepare(sql).get(...params);
}

// All rows as an array.
async function all(sql, ...params) {
  if (usingPostgres) return (await pool.query(toPg(sql), params)).rows;
  return sqlite.prepare(sql).all(...params);
}

// Write statement. Returns { changes, id } — id is set when the statement
// ends with RETURNING id.
async function run(sql, ...params) {
  if (usingPostgres) {
    const result = await pool.query(toPg(sql), params);
    return { changes: result.rowCount, id: result.rows[0]?.id };
  }
  if (/\breturning\b/i.test(sql)) {
    const row = sqlite.prepare(sql).get(...params);
    return { changes: 1, id: row?.id };
  }
  const result = sqlite.prepare(sql).run(...params);
  return { changes: result.changes, id: result.lastInsertRowid };
}

// Multi-statement DDL (schema creation).
async function exec(sql) {
  if (usingPostgres) return void (await pool.query(sql));
  sqlite.exec(sql);
}

// ---------- schema ----------
// The only DDL difference: how an auto-incrementing primary key is spelled.
const ID = usingPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id ${ID},
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS organizations (
  id ${ID},
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS org_members (
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE IF NOT EXISTS teams (
  id ${ID},
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_role TEXT,
  is_starter INTEGER DEFAULT 1,
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id ${ID},
  token_hash TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id ${ID},
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  used_by INTEGER
);
CREATE TABLE IF NOT EXISTS maps (
  id ${ID},
  name TEXT UNIQUE NOT NULL,
  active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS strategies (
  id ${ID},
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  map TEXT NOT NULL,
  side TEXT NOT NULL,            -- T | CT
  category TEXT NOT NULL,
  buy_type TEXT,                 -- pistol | eco | force | anti-eco | full
  site TEXT,
  map_area TEXT,
  tags TEXT DEFAULT '[]',        -- json array
  difficulty TEXT,               -- basic | standard | advanced
  spawn_dependency TEXT,
  required_utility TEXT,
  objective TEXT,
  summary TEXT,
  steps TEXT DEFAULT '[]',       -- json array of strings
  roles TEXT DEFAULT '[]',       -- json array {slot, assignee, role, duty, utility}
  timings TEXT DEFAULT '[]',
  midround TEXT DEFAULT '[]',
  reactions TEXT DEFAULT '[]',
  backup TEXT,
  warnings TEXT DEFAULT '[]',
  attachments TEXT DEFAULT '[]', -- json array {type, url, label}
  status TEXT DEFAULT 'active',  -- active | draft | archived
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy_id INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, strategy_id)
);
CREATE TABLE IF NOT EXISTS opponents (
  id ${ID},
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  org_name TEXT,
  playstyle TEXT,
  map_pool TEXT,
  preferred_picks TEXT,
  preferred_bans TEXT,
  econ_notes TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opponent_players (
  id ${ID},
  opponent_id INTEGER NOT NULL REFERENCES opponents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  positions TEXT,
  weapons TEXT,
  aggression TEXT,               -- passive | balanced | aggressive
  habits TEXT,
  weaknesses TEXT,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS tendencies (
  id ${ID},
  opponent_id INTEGER NOT NULL REFERENCES opponents(id) ON DELETE CASCADE,
  opponent_player_id INTEGER REFERENCES opponent_players(id) ON DELETE CASCADE,
  map TEXT,
  side TEXT,
  site TEXT,
  round_type TEXT,
  category TEXT,
  text TEXT NOT NULL,
  severity TEXT DEFAULT 'normal', -- normal | high
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id ${ID},
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  opponent_id INTEGER REFERENCES opponents(id) ON DELETE SET NULL,
  scheduled_at TEXT,
  event TEXT,
  format TEXT,                   -- BO1 | BO3 | BO5
  expected_maps TEXT DEFAULT '[]',
  veto_notes TEXT,
  starting_side TEXT,
  roster TEXT DEFAULT '[]',      -- json array of user ids
  subs TEXT DEFAULT '[]',
  status TEXT DEFAULT 'upcoming',
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS match_pins (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  strategy_id INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  sort INTEGER DEFAULT 0,
  PRIMARY KEY (match_id, strategy_id)
);
CREATE TABLE IF NOT EXISTS match_notes (
  id ${ID},
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- timeout | reminder
  text TEXT NOT NULL,
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recents (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, item_type, item_id)
);
CREATE TABLE IF NOT EXISTS team_players (
  id ${ID},
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  game_role TEXT,
  is_starter INTEGER DEFAULT 1,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  faceit_nickname TEXT,
  faceit_player_id TEXT,
  faceit_stats TEXT
);
CREATE INDEX IF NOT EXISTS idx_strategies_team ON strategies(team_id, map, side, status);
CREATE INDEX IF NOT EXISTS idx_tendencies_opp ON tendencies(opponent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
`;

// lightweight migrations for columns added after first release
async function addColumn(table, column, ddl) {
  if (usingPostgres) {
    await exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${ddl};`);
    return;
  }
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
}

const now = () => new Date().toISOString();
const J = JSON.stringify;

// collapse the legacy 6-role model to owner | edit | view
async function normalizeAccess() {
  await exec(`UPDATE org_members SET role = CASE
    WHEN role = 'owner' THEN 'owner'
    WHEN role IN ('team_admin','coach','analyst','igl') THEN 'edit'
    ELSE 'view' END
    WHERE role NOT IN ('owner','edit','view');`);
  await exec(`UPDATE invites SET role = CASE
    WHEN role IN ('team_admin','coach','analyst','igl') THEN 'edit'
    ELSE 'view' END
    WHERE role NOT IN ('edit','view');`);
}

// build roster slots from legacy team_members game roles, else the FACEIT lineup
async function backfillTeamPlayers() {
  for (const team of await all('SELECT id, faceit_roster FROM teams')) {
    const existing = await get('SELECT COUNT(*) AS c FROM team_players WHERE team_id = ?', team.id);
    if (existing.c) continue;
    const tms = await all(`SELECT tm.user_id, tm.game_role, tm.is_starter, u.name
      FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ? AND tm.game_role IS NOT NULL`, team.id);
    for (const tm of tms) {
      await run(`INSERT INTO team_players (team_id, name, game_role, is_starter, user_id)
        VALUES (?,?,?,?,?)`, team.id, tm.name, tm.game_role, tm.is_starter, tm.user_id);
    }
    if (!tms.length) {
      let fr = []; try { fr = JSON.parse(team.faceit_roster) || []; } catch { /* none */ }
      for (const p of fr) {
        await run(`INSERT INTO team_players (team_id, name, is_starter, faceit_nickname, faceit_player_id, faceit_stats)
          VALUES (?,?,1,?,?,?)`, team.id, p.nickname || '?', p.nickname || null, p.user_id || null,
          (p.elo != null || p.level != null) ? J({ elo: p.elo ?? null, level: p.level ?? null, at: now() }) : null);
      }
    }
  }
}

let initialized = null;

// Create the schema and run migrations. Called once at startup (server.js
// awaits this before listening); safe to call again.
function init() {
  if (!initialized) {
    initialized = (async () => {
      await exec(SCHEMA);
      await addColumn('teams', 'faceit_team_id', 'faceit_team_id TEXT');
      await addColumn('teams', 'faceit_team_name', 'faceit_team_name TEXT');
      await addColumn('teams', 'faceit_api_key', 'faceit_api_key TEXT');
      await addColumn('teams', 'faceit_last_sync', 'faceit_last_sync TEXT');
      await addColumn('teams', 'faceit_roster', 'faceit_roster TEXT');
      await addColumn('matches', 'faceit_match_id', 'faceit_match_id TEXT');
      await addColumn('matches', 'faceit_result', 'faceit_result TEXT');
      await addColumn('opponents', 'faceit_team_id', 'faceit_team_id TEXT');
      await addColumn('opponents', 'faceit_intel', 'faceit_intel TEXT');
      await addColumn('opponent_players', 'faceit_player_id', 'faceit_player_id TEXT');
      await addColumn('opponent_players', 'faceit_stats', 'faceit_stats TEXT');
      await addColumn('invites', 'email', 'email TEXT');
      await exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_faceit ON matches(team_id, faceit_match_id) WHERE faceit_match_id IS NOT NULL;');
      await normalizeAccess();
      await backfillTeamPlayers();
    })();
  }
  return initialized;
}

// Startup cleanup of session rows that must not linger.
//
// Expired rows: normally deleted the next time that session is presented, but
// a session nobody presents again would otherwise sit in the table forever.
// Malformed rows: token_hash must be a sha256 hex digest (exactly 64 hex
// chars). Anything else would be a plaintext token stored by accident — a
// live credential in a leaked database or backup — so it is deleted outright.
// Both checks are idempotent and safe to run on every boot.
async function cleanupSessions() {
  const expired = await run('DELETE FROM sessions WHERE expires_at < ?', now());
  let malformed = 0;
  for (const row of await all('SELECT id, token_hash FROM sessions')) {
    if (!/^[0-9a-f]{64}$/.test(row.token_hash)) {
      malformed += (await run('DELETE FROM sessions WHERE id = ?', row.id)).changes;
    }
  }
  const total = expired.changes + malformed;
  if (total) console.log(`[midround] purged ${total} stale session rows`);
  return total;
}

// Demo data lives in seed.js; required lazily so seed.js can require this
// module's helpers without a circular-import problem. The production check
// lives HERE, before the require, so production never even loads seed.js.
function seedIfEmpty() {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== '1') return;
  return require('./seed').seedIfEmpty();
}

module.exports = { get, all, run, exec, init, cleanupSessions, seedIfEmpty, backfillTeamPlayers, usingPostgres };
