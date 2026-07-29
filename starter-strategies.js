// MidRound — the personal library every new account starts with.
//
// One T and one CT default per active map, so the library, the dashboard and
// Match Mode have something in them on day one instead of an empty shell.
// They are deliberately plain templates — basic difficulty, no roster names,
// no assigned roles — meant to be edited or deleted, not followed as written.
//
// These are PERSONAL strategies: created_by is the new user and nothing here
// writes team_strategies, so a starter only reaches a team's bank if the user
// shares it themselves with "Add to Team Strats". Unlike the demo seed in
// seed.js, this runs on every install, production included.

const db = require('./db');

const STARTERS = require('./seed-data/starter-strategies.json');

const J = (v) => JSON.stringify(v || []);

// Installs the starter set for one user. Returns how many were written.
// Maps the install doesn't run are skipped rather than seeded blind, so the
// set always matches the map picker the user actually sees.
async function installStarterStrategies(userId, at) {
  const t = at || new Date().toISOString();
  const maps = new Set((await db.all('SELECT name FROM maps WHERE active = 1')).map((m) => m.name));
  let written = 0;
  for (const s of STARTERS) {
    if (!maps.has(s.map)) continue;
    await db.run(
      `INSERT INTO strategies
        (name, map, side, category, buy_type, site, map_area, tags, difficulty, spawn_dependency, required_utility,
         objective, summary, steps, roles, timings, midround, reactions, backup, warnings, attachments, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      s.name, s.map, s.side, s.category || 'Default', s.buy_type || null, s.site || null, s.map_area || null,
      J(s.tags), s.difficulty || 'basic', s.spawn_dependency || null, s.required_utility || null,
      s.objective || null, s.summary || null, J(s.steps), J(s.roles),
      J(s.timings), J(s.midround), J(s.reactions), s.backup || null,
      J(s.warnings), J([]), 'active', userId, t, t,
    );
    written++;
  }
  return written;
}

module.exports = { installStarterStrategies, STARTERS };
