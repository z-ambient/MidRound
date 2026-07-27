'use strict';
// Personal strategy ownership + Team Strats designation.
//
// The model under test: every strategy is personal (created_by). A strategy
// reaches a team's bank ("Team Strats") only by being shared via
// team_strategies — sharing never transfers ownership, and removing the
// share never deletes the strategy. Accounts work fully without a team.
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb, startServer, cookieOf, postJson, login } = require('./helpers');

useTempDb();

let server, base;
let solo;          // fresh account, never on a team
let owner, editor, viewer; // seeded Northlight accounts (owner / edit / view roles)
let teamId;

const get = (path, cookie) => fetch(base + path, { headers: { cookie } });
const del = (path, cookie) => fetch(base + path, { method: 'DELETE', headers: { cookie } });
const put = (path, body, cookie) => fetch(base + path, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body),
});
const createStrat = (cookie, body = {}) =>
  postJson(base, '/api/strategies', { name: 'My strat', map: 'Mirage', side: 'T', ...body }, cookie);

test.before(async () => {
  ({ server, base } = await startServer());
  owner = await login(base, 'casey@northlight.gg', 'demo1234');
  editor = await login(base, 'morgan@northlight.gg', 'demo1234');
  viewer = await login(base, 'riley@northlight.gg', 'demo1234');
  const me = await (await get('/api/me', owner)).json();
  teamId = me.teams[0].id;

  const reg = await postJson(base, '/api/auth/register', {
    email: 'solo@example.com', password: 'password123', name: 'Solo Player',
  });
  assert.equal(reg.status, 200);
  solo = cookieOf(reg);
});
test.after(() => server.close());

test('registering creates a signed-in account with no teams', async () => {
  const me = await (await get('/api/me', solo)).json();
  assert.equal(me.user.email, 'solo@example.com');
  assert.deepEqual(me.orgs, []);
  assert.deepEqual(me.teams, []);
});

test('a no-team user has full personal strategy CRUD', async () => {
  // create
  const created = await (await createStrat(solo, { name: 'Solo smoke lineup' })).json();
  assert.equal(created.name, 'Solo smoke lineup');
  assert.equal(created.status, 'active');
  assert.deepEqual(created.shared_team_ids, []);

  // list shows it
  const list = await (await get('/api/strategies', solo)).json();
  assert.ok(list.some((s) => s.id === created.id));

  // read + edit
  assert.equal((await get(`/api/strategies/${created.id}`, solo)).status, 200);
  const updated = await (await put(`/api/strategies/${created.id}`, { summary: 'Updated call' }, solo)).json();
  assert.equal(updated.summary, 'Updated call');

  // duplicate → personal draft copy
  const copy = await (await postJson(base, `/api/strategies/${created.id}/duplicate`, {}, solo)).json();
  assert.equal(copy.status, 'draft');
  assert.match(copy.name, /copy/);

  // favorite
  assert.equal((await postJson(base, `/api/strategies/${created.id}/favorite`, {}, solo)).status, 200);

  // delete requires archiving first
  assert.equal((await del(`/api/strategies/${copy.id}`, solo)).status, 400);
  await put(`/api/strategies/${copy.id}`, { status: 'archived' }, solo);
  const restored = await (await put(`/api/strategies/${copy.id}`, { status: 'active' }, solo)).json();
  assert.equal(restored.status, 'active');
  await put(`/api/strategies/${copy.id}`, { status: 'archived' }, solo);
  assert.equal((await del(`/api/strategies/${copy.id}`, solo)).status, 200);
  assert.equal((await get(`/api/strategies/${copy.id}`, solo)).status, 404);
});

test('personal strategies are invisible to everyone else', async () => {
  const created = await (await createStrat(solo, { name: 'Private read' })).json();
  // another user: detail 404s (same as nonexistent), list never contains it
  assert.equal((await get(`/api/strategies/${created.id}`, owner)).status, 404);
  const ownerList = await (await get('/api/strategies', owner)).json();
  assert.ok(!ownerList.some((s) => s.id === created.id));
});

test('solo strategy source shows only your own strategies', async () => {
  const list = await (await get('/api/strategies', solo)).json();
  assert.ok(list.length > 0);
  const me = await (await get('/api/me', solo)).json();
  assert.ok(list.every((s) => s.created_by === me.user.id));
});

test('non-team users cannot see Team Strats', async () => {
  assert.equal((await get(`/api/teams/${teamId}/strategies`, solo)).status, 403);
});

test('there is no direct create-into-team-strats route', async () => {
  const res = await postJson(base, `/api/teams/${teamId}/strategies`,
    { name: 'Direct', map: 'Mirage', side: 'T' }, owner);
  assert.equal(res.status, 404);
});

test('Add to Team Strats shares a personal strategy with the whole team', async () => {
  const strat = await (await createStrat(editor, { name: 'Morgan A-split v2' })).json();

  // not in the bank yet
  let bank = await (await get(`/api/teams/${teamId}/strategies`, viewer)).json();
  assert.ok(!bank.some((s) => s.id === strat.id));

  const shared = await (await postJson(base, `/api/strategies/${strat.id}/share`, { team_id: teamId }, editor)).json();
  assert.deepEqual(shared.shared_team_ids, [teamId]);

  // every member sees it in Team Strats and can open it
  bank = await (await get(`/api/teams/${teamId}/strategies`, viewer)).json();
  assert.ok(bank.some((s) => s.id === strat.id));
  assert.equal((await get(`/api/strategies/${strat.id}`, viewer)).status, 200);

  // ...but sharing grants no edit rights to anyone else
  assert.equal((await put(`/api/strategies/${strat.id}`, { name: 'hijacked' }, viewer)).status, 403);
  assert.equal((await put(`/api/strategies/${strat.id}`, { name: 'hijacked' }, owner)).status, 403);
  assert.equal((await del(`/api/strategies/${strat.id}`, owner)).status, 403);
  assert.equal((await postJson(base, `/api/strategies/${strat.id}/duplicate`, {}, viewer)).status, 403);

  // members can favorite a team strat
  assert.equal((await postJson(base, `/api/strategies/${strat.id}/favorite`, {}, viewer)).status, 200);
});

test('a view-only member cannot share, and outsiders cannot share into a foreign team', async () => {
  const strat = await (await createStrat(viewer, { name: 'Riley private' })).json();
  // Riley is the creator but has only view rights on the team
  assert.equal((await postJson(base, `/api/strategies/${strat.id}/share`, { team_id: teamId }, viewer)).status, 403);
  // Solo has no access to the team at all
  const strat2 = await (await createStrat(solo)).json();
  assert.equal((await postJson(base, `/api/strategies/${strat2.id}/share`, { team_id: teamId }, solo)).status, 403);
});

test('removing from Team Strats keeps the personal strategy', async () => {
  const strat = await (await createStrat(editor, { name: 'Bank then unbank' })).json();
  await postJson(base, `/api/strategies/${strat.id}/share`, { team_id: teamId }, editor);

  // an edit-role member who is not the creator cannot curate the bank
  const dana = await login(base, 'dana@northlight.gg', 'demo1234');
  assert.equal((await del(`/api/strategies/${strat.id}/share/${teamId}`, dana)).status, 403);

  // a team owner can remove it without touching the strategy
  assert.equal((await del(`/api/strategies/${strat.id}/share/${teamId}`, owner)).status, 200);
  const bank = await (await get(`/api/teams/${teamId}/strategies`, owner)).json();
  assert.ok(!bank.some((s) => s.id === strat.id));
  assert.equal((await get(`/api/strategies/${strat.id}`, editor)).status, 200, 'creator keeps the strategy');

  // once unshared, other members lose read access again
  assert.equal((await get(`/api/strategies/${strat.id}`, viewer)).status, 404);
});

test('match pins only accept strategies from Team Strats', async () => {
  const match = await (await postJson(base, `/api/teams/${teamId}/matches`, { format: 'BO3' }, editor)).json();
  const personal = await (await createStrat(editor, { name: 'Unshared pin target' })).json();
  const rejected = await postJson(base, `/api/matches/${match.id}/pins`, { strategy_id: personal.id }, editor);
  assert.equal(rejected.status, 400);

  await postJson(base, `/api/strategies/${personal.id}/share`, { team_id: teamId }, editor);
  const accepted = await postJson(base, `/api/matches/${match.id}/pins`, { strategy_id: personal.id }, editor);
  assert.equal(accepted.status, 200);
});

test('Team & access: a no-team user can create an organization', async () => {
  const reg = await postJson(base, '/api/auth/register', {
    email: 'founder@example.com', password: 'password123', name: 'Founder',
  });
  const cookie = cookieOf(reg);
  const org = await (await postJson(base, '/api/orgs', { name: 'Fresh Org', teamName: 'Fresh Five' }, cookie)).json();
  assert.ok(org.team_id);
  const me = await (await get('/api/me', cookie)).json();
  assert.equal(me.orgs.length, 1);
  assert.equal(me.teams[0].id, org.team_id);
  assert.equal(me.orgs[0].role, 'owner');
});

test('Team & access: a no-team user can accept an email invite', async () => {
  const reg = await postJson(base, '/api/auth/register', {
    email: 'invitee@example.com', password: 'password123', name: 'Invitee',
  });
  const cookie = cookieOf(reg);
  const sent = await postJson(base, `/api/teams/${teamId}/invites/direct`,
    { email: 'invitee@example.com', role: 'view' }, owner);
  assert.equal(sent.status, 200);

  const invites = await (await get('/api/me/invites', cookie)).json();
  assert.equal(invites.length, 1);
  const accepted = await (await postJson(base, `/api/invites/${invites[0].id}/accept`, {}, cookie)).json();
  assert.equal(accepted.team_id, teamId);
  const me = await (await get('/api/me', cookie)).json();
  assert.ok(me.teams.some((t) => t.id === teamId));
});
