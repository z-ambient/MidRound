'use strict';
// /api/recents must not accept ids the signed-in user cannot access:
// answering differently for other teams' ids would confirm private ids and
// let anyone write recents rows pointing at data they cannot see.
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb, startServer, cookieOf, postJson, login } = require('./helpers');

useTempDb();
const db = require('../db');

let server, base;
let memberCookie, outsiderCookie, teamId, strategyId;

test.before(async () => {
  ({ server, base } = await startServer());

  // Casey belongs to the seeded Northlight org and its team.
  memberCookie = await login(base, 'casey@northlight.gg', 'demo1234');
  const me = await (await fetch(base + '/api/me', { headers: { cookie: memberCookie } })).json();
  teamId = me.teams[0].id;
  const strategies = await (await fetch(base + `/api/teams/${teamId}/strategies`, {
    headers: { cookie: memberCookie },
  })).json();
  strategyId = strategies[0].id;

  // The outsider has an account — in a completely different organization.
  // Registration no longer creates an org; that happens in-app afterwards.
  const reg = await postJson(base, '/api/auth/register', {
    email: 'outsider@example.com',
    password: 'password123',
    name: 'Out Sider',
  });
  assert.equal(reg.status, 200);
  outsiderCookie = cookieOf(reg);
  const org = await postJson(base, '/api/orgs', { name: 'Rival Org' }, outsiderCookie);
  assert.equal(org.status, 200);
});
test.after(() => server.close());

test('an outsider cannot record a recent for another team\'s strategy', async () => {
  const res = await postJson(base, '/api/recents',
    { item_type: 'strategy', item_id: strategyId }, outsiderCookie);
  assert.equal(res.status, 404, 'must look identical to a nonexistent id');

  const rows = await db.all(`
    SELECT r.* FROM recents r JOIN users u ON u.id = r.user_id
    WHERE u.email = 'outsider@example.com'`);
  assert.equal(rows.length, 0, 'no recents row may be written for a foreign resource');
});

test('a nonexistent id gets the same 404', async () => {
  const res = await postJson(base, '/api/recents',
    { item_type: 'strategy', item_id: 999999 }, outsiderCookie);
  assert.equal(res.status, 404);
});

test('a team member can still record and read recents', async () => {
  const res = await postJson(base, '/api/recents',
    { item_type: 'strategy', item_id: strategyId }, memberCookie);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const recents = await (await fetch(base + `/api/teams/${teamId}/recents`, {
    headers: { cookie: memberCookie },
  })).json();
  assert.ok(recents.some((r) => r.type === 'strategy' && r.id === strategyId));
});
