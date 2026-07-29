#!/usr/bin/env node
'use strict';
// Give existing accounts the starter strategies new signups now get.
//
// Registration installs a personal T and CT default per map (see
// starter-strategies.js). Accounts created before that shipped never got them,
// so this backfills. By default it only touches accounts with an EMPTY personal
// library — anyone who has written their own strategies is left alone, since
// dropping 16 templates into a library someone already curated is not a favour.
//
//   npm run install-starters -- --dry          show who would get them
//   npm run install-starters                   do it
//   npm run install-starters -- --email=a@b.c  just that account
//   npm run install-starters -- --force        include accounts that already
//                                              have personal strategies
//
// The strategies are personal: nothing here writes team_strategies, so no
// team's bank changes. Honours MIDROUND_DB_PATH / DATABASE_URL like the server.
const path = require('path');
const db = require(path.join(__dirname, '..', 'db'));
const { installStarterStrategies } = require(path.join(__dirname, '..', 'starter-strategies'));

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const force = argv.includes('--force');
const emailArg = (argv.find((a) => a.startsWith('--email=')) || '').split('=')[1];

async function main() {
  await db.init();

  const users = emailArg
    ? await db.all('SELECT id, name, email FROM users WHERE email = ? ORDER BY id', emailArg.toLowerCase())
    : await db.all('SELECT id, name, email FROM users ORDER BY id');

  if (emailArg && !users.length) {
    console.log(`No account with email ${emailArg}.`);
    return;
  }

  const targets = [];
  const skipped = [];
  for (const u of users) {
    const own = (await db.get('SELECT COUNT(*) AS c FROM strategies WHERE created_by = ?', u.id)).c;
    if (own && !force) skipped.push({ ...u, own });
    else targets.push({ ...u, own });
  }

  console.log(`${users.length} account(s) checked.`);
  for (const u of targets) {
    console.log(`  install → ${u.email}${u.own ? ` (already has ${u.own}, --force)` : ''}`);
  }
  for (const u of skipped) {
    console.log(`  skip      ${u.email} — has ${u.own} personal strateg${u.own === 1 ? 'y' : 'ies'}`);
  }

  if (!targets.length) { console.log('\nNothing to do.'); return; }
  if (dry) { console.log('\n--dry: nothing changed.'); return; }

  let total = 0;
  for (const u of targets) {
    total += await installStarterStrategies(u.id);
  }
  console.log(`\nInstalled ${total} personal strateg${total === 1 ? 'y' : 'ies'} across ${targets.length} account(s). No team bank was touched.`);
}

main().catch((e) => { console.error('install-starters failed:', e.message); process.exit(1); });
