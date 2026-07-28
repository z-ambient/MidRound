#!/usr/bin/env node
'use strict';
// Put the demo workspace back the way it shipped.
//
// The demo sign-in is published on the login page, so anyone can use it and
// anyone can change what they find. This removes the demo org and its eight
// accounts, then re-seeds — leaving every other account, org and strategy in
// the database untouched.
//
//   npm run reset-demo -- --dry     show what would go, change nothing
//   npm run reset-demo              do it
//
// Honours MIDROUND_DB_PATH / DATABASE_URL exactly like the server does, so
// point it at the same database the app is using.
const path = require('path');
const db = require(path.join(__dirname, '..', 'db'));
const { DEMO_ORG, DEMO_EMAILS, seedIfEmpty } = require(path.join(__dirname, '..', 'seed'));

const dry = process.argv.includes('--dry');

async function main() {
  await db.init();

  const org = await db.get('SELECT id, name FROM organizations WHERE name = ?', DEMO_ORG);
  const users = [];
  for (const email of DEMO_EMAILS) {
    const u = await db.get('SELECT id, email FROM users WHERE email = ?', email);
    if (u) users.push(u);
  }

  if (!org && !users.length) {
    console.log('No demo workspace found — nothing to remove. Seeding a fresh one.');
  } else {
    const ids = users.map((u) => u.id);
    const holes = ids.map(() => '?').join(',');
    const count = async (sql, ...args) => (ids.length ? (await db.get(sql, ...args)).c : 0);

    // strategies.created_by carries no foreign key, so nothing cascades from
    // deleting the accounts — they have to go explicitly or they are orphaned
    const strategies = await count(`SELECT COUNT(*) AS c FROM strategies WHERE created_by IN (${holes})`, ...ids);
    const teams = org ? (await db.get('SELECT COUNT(*) AS c FROM teams WHERE org_id = ?', org.id)).c : 0;
    const matches = org
      ? (await db.get(`SELECT COUNT(*) AS c FROM matches WHERE team_id IN (SELECT id FROM teams WHERE org_id = ?)`, org.id)).c
      : 0;

    console.log(`Demo workspace to remove:`);
    console.log(`  org         ${org ? `"${org.name}" (id ${org.id})` : '(none)'}`);
    console.log(`  accounts    ${users.length}${users.length ? ' — ' + users.map((u) => u.email).join(', ') : ''}`);
    console.log(`  teams       ${teams}`);
    console.log(`  matches     ${matches}`);
    console.log(`  strategies  ${strategies}`);

    // everything NOT being touched, so the blast radius is visible up front
    const otherUsers = (await db.get(
      ids.length ? `SELECT COUNT(*) AS c FROM users WHERE id NOT IN (${holes})` : 'SELECT COUNT(*) AS c FROM users',
      ...ids)).c;
    const otherOrgs = (await db.get(
      org ? 'SELECT COUNT(*) AS c FROM organizations WHERE id != ?' : 'SELECT COUNT(*) AS c FROM organizations',
      ...(org ? [org.id] : []))).c;
    console.log(`Left alone: ${otherUsers} other account(s), ${otherOrgs} other org(s).`);

    if (dry) { console.log('\n--dry: nothing changed.'); return; }

    if (ids.length) {
      await db.run(`DELETE FROM strategies WHERE created_by IN (${holes})`, ...ids);
    }
    if (org) await db.run('DELETE FROM organizations WHERE id = ?', org.id);
    if (ids.length) await db.run(`DELETE FROM users WHERE id IN (${holes})`, ...ids);
    console.log('\nRemoved.');
  }

  if (dry) return;
  await seedIfEmpty();

  const org2 = await db.get('SELECT id FROM organizations WHERE name = ?', DEMO_ORG);
  const strat = await db.get(`SELECT COUNT(*) AS c FROM strategies s JOIN team_strategies ts ON ts.strategy_id = s.id
    WHERE ts.team_id IN (SELECT id FROM teams WHERE org_id = ?)`, org2 ? org2.id : -1);
  console.log(`Re-seeded: demo org id ${org2 ? org2.id : '?'}, ${strat.c} strategies in the team bank.`);
}

main().catch((e) => { console.error('reset-demo failed:', e.message); process.exit(1); });
