'use strict';
// What every install must have, demo seed or not.
//
// Both of these regressed the same way once: they lived in the demo seed,
// which never runs in production (NODE_ENV=production skips it). The result
// was an install with no maps — an empty strategy library and an empty map
// picker — and a login page advertising a demo account that did not exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb, startServer, cookieOf, postJson } = require('./helpers');

useTempDb();
const db = require('../db');
const { DEMO_LOGIN } = require('../seed');

let server, base;

test.before(async () => { ({ server, base } = await startServer()); });
test.after(() => server.close());

test('the active-duty map pool exists and is not duplicated', async () => {
  const maps = await db.all('SELECT name FROM maps WHERE active = 1 ORDER BY name');
  assert.ok(maps.length >= 7, `expected the CS2 pool, got ${maps.length}`);
  for (const m of ['Mirage', 'Inferno', 'Nuke', 'Ancient', 'Anubis', 'Dust2', 'Train']) {
    assert.ok(maps.some((x) => x.name === m), `missing map ${m}`);
  }
  const dupes = await db.all('SELECT name FROM maps GROUP BY name HAVING COUNT(*) > 1');
  assert.deepEqual(dupes, [], 'init() and the demo seed must not both insert maps');
});

test('a brand-new user with no team can see the maps', async () => {
  const reg = await postJson(base, '/api/auth/register', {
    email: 'mapless@example.com', password: 'password123', name: 'Map Less',
  });
  assert.equal(reg.status, 200);
  const cookie = cookieOf(reg);

  const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
  assert.deepEqual(me.teams, [], 'this user must have no team');

  const maps = await (await fetch(base + '/api/maps', { headers: { cookie } })).json();
  assert.ok(maps.length >= 7, 'the strategy library would have no map tiles');
});

test('the advertised demo login actually signs in', async () => {
  const demo = await (await fetch(base + '/api/demo')).json();
  assert.equal(demo.available, true, 'demo data is seeded in tests');
  // exactly the credentials the login page shows the user
  const res = await postJson(base, '/api/auth/login', {
    email: demo.email, password: demo.password,
  });
  assert.equal(res.status, 200, 'the login page must never advertise a credential that fails');
  assert.equal(demo.email, DEMO_LOGIN.email);
});

test('the demo hint is withheld when the demo account is absent', async () => {
  await db.run('DELETE FROM users WHERE email = ?', DEMO_LOGIN.email);
  const demo = await (await fetch(base + '/api/demo')).json();
  assert.equal(demo.available, false, 'a production install must not advertise the demo');
  assert.equal(demo.password, undefined, 'no credentials when there is no demo account');
});
