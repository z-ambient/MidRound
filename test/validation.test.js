'use strict';
// Request-body validation on the content routes — especially attachment URLs:
// HTML-escaping is not enough for URLs, so javascript:/data: schemes must be
// rejected at save time.
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb, startServer, login } = require('./helpers');

useTempDb();

let server, base, cookie, teamId;

async function createStrategy(body) {
  return fetch(base + `/api/teams/${teamId}/strategies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Test strat', map: 'Mirage', side: 'T', ...body }),
  });
}

test.before(async () => {
  ({ server, base } = await startServer());
  cookie = await login(base, 'casey@northlight.gg', 'demo1234');
  const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
  teamId = me.teams[0].id;
});
test.after(() => server.close());

test('javascript: attachment URLs are rejected', async () => {
  const res = await createStrategy({
    attachments: [{ type: 'link', url: 'javascript:alert(document.cookie)', label: 'demo' }],
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /http/);
});

test('data: attachment URLs are rejected', async () => {
  const res = await createStrategy({
    attachments: [{ type: 'link', url: 'data:text/html,<script>alert(1)</script>', label: 'demo' }],
  });
  assert.equal(res.status, 400);
});

test('normal https attachments are accepted', async () => {
  const res = await createStrategy({
    attachments: [{ type: 'video', url: 'https://example.com/demo.mp4', label: 'scrim demo' }],
  });
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.attachments[0].url, 'https://example.com/demo.mp4');
});

test('overlong names are rejected', async () => {
  const res = await createStrategy({ name: 'X'.repeat(121) });
  assert.equal(res.status, 400);
});

test('side must be T or CT', async () => {
  const res = await createStrategy({ side: 'SPECTATOR' });
  assert.equal(res.status, 400);
});

test('oversized list fields are rejected', async () => {
  const res = await createStrategy({ steps: Array.from({ length: 51 }, (_, i) => `step ${i}`) });
  assert.equal(res.status, 400);
});

test('partial updates still work and are validated', async () => {
  const created = await (await createStrategy({})).json();

  const ok = await fetch(base + `/api/strategies/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ summary: 'Updated summary only' }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).summary, 'Updated summary only');

  const bad = await fetch(base + `/api/strategies/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ attachments: [{ url: 'javascript:alert(1)' }] }),
  });
  assert.equal(bad.status, 400);
});
