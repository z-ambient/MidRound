'use strict';
// Every response — static files, API routes, JSON 404s, the SPA fallback —
// must carry the defensive headers set by the middleware in server.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb, startServer } = require('./helpers');

useTempDb();

let server, base;
test.before(async () => ({ server, base } = await startServer()));
test.after(() => server.close());

for (const path of ['/', '/api/me', '/api/nope', '/definitely-not-a-page']) {
  test(`security headers are present on ${path}`, async () => {
    const res = await fetch(base + path);
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  });
}

test('unknown API paths return JSON 404, never an HTML error page', async () => {
  const res = await fetch(base + '/api/nope');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

test('x-powered-by is not exposed', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.headers.get('x-powered-by'), null);
});
