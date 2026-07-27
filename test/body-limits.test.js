'use strict';
// Oversized or malformed request bodies must be rejected cheaply with the
// app's generic JSON error shape — and must never be echoed back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb, startServer } = require('./helpers');

useTempDb();

let server, base;
test.before(async () => ({ server, base } = await startServer()));
test.after(() => server.close());

test('bodies over the 64kb limit are rejected with a generic 413', async () => {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a'.repeat(70 * 1024) }),
  });
  assert.equal(res.status, 413);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: 'Request body too large' });
  assert.ok(!text.includes('aaaaaaaa'), 'rejected input must not be echoed');
});

test('malformed JSON is rejected with a generic 400 and not echoed', async () => {
  const marker = 'MARKER_THAT_MUST_NOT_LEAK';
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: `{"email": ${marker}`,
  });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: 'Invalid request' });
  assert.ok(!text.includes(marker), 'rejected input must not be echoed');
});
