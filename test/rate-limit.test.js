'use strict';
// The spoof-resistant client IP function, and the per-route limits on the
// abuse-relevant endpoints. A client can PREPEND fake entries to
// X-Forwarded-For; each trusted proxy APPENDS the address it actually saw,
// so the key must come from the right (trusted) end of the chain.
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDb, startServer, postJson } = require('./helpers');

useTempDb();
const { clientIp, resetRateLimits } = require('../rate-limit');

const fakeReq = (xff, remote = '203.0.113.7') => ({
  headers: xff ? { 'x-forwarded-for': xff } : {},
  socket: { remoteAddress: remote },
});

// ---------- clientIp unit tests (hops passed explicitly) ----------

test('hops=0 (default/local) ignores the forwarded header entirely', () => {
  assert.equal(clientIp(fakeReq('1.2.3.4'), 0), '203.0.113.7');
});

test('single proxy: the rightmost (proxy-appended) entry wins', () => {
  assert.equal(clientIp(fakeReq('9.9.9.9, 1.1.1.1'), 1), '1.1.1.1');
});

test('spoofed left-hand entries cannot move the key', () => {
  const a = clientIp(fakeReq('1.2.3.4, 1.1.1.1'), 1);
  const b = clientIp(fakeReq('5.6.7.8, 1.1.1.1'), 1);
  assert.equal(a, b);
  assert.equal(a, '1.1.1.1');
});

test('two hops: second entry from the right', () => {
  assert.equal(clientIp(fakeReq('9.9.9.9, 1.1.1.1, 10.0.0.1'), 2), '1.1.1.1');
});

test('header shorter than hops fails safe to the socket address', () => {
  assert.equal(clientIp(fakeReq('1.1.1.1', '198.51.100.5'), 2), '198.51.100.5');
});

test('whitespace and empty entries are tolerated', () => {
  assert.equal(clientIp(fakeReq(' 9.9.9.9 ,  1.1.1.1 ,'), 1), '1.1.1.1');
});

// ---------- per-route limits (server booted with default hops=0) ----------

let server, base;
test.before(async () => ({ server, base } = await startServer()));
test.after(() => server.close());

test('login is limited after 10 attempts — even with rotating spoofed headers', async () => {
  resetRateLimits();
  for (let i = 0; i < 10; i++) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // hops=0 means this header must be ignored; rotating it must not
        // mint a fresh rate-limit bucket per request
        'X-Forwarded-For': `1.2.3.${i}`,
      },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' }),
    });
    assert.equal(res.status, 401, `attempt ${i + 1} should be 401, not limited yet`);
  }
  const limited = await postJson(base, '/api/auth/login', {
    email: 'nobody@example.com',
    password: 'wrong-password',
  });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'Too many requests. Wait a minute, then try again.' });
});

test('/api/me is limited after 30 requests', async () => {
  resetRateLimits();
  for (let i = 0; i < 30; i++) {
    const res = await fetch(base + '/api/me');
    assert.equal(res.status, 401, `request ${i + 1} should be 401, not limited yet`);
  }
  assert.equal((await fetch(base + '/api/me')).status, 429);
});

test('API writes share a 120/minute budget', async () => {
  resetRateLimits();
  for (let i = 0; i < 120; i++) {
    // unauthenticated: the write limiter runs before auth, so 401s still count
    const res = await postJson(base, '/api/recents', { item_type: 'strategy', item_id: 1 });
    assert.equal(res.status, 401, `request ${i + 1} should be 401, not limited yet`);
  }
  assert.equal((await postJson(base, '/api/recents', { item_type: 'strategy', item_id: 1 })).status, 429);
});

test('FACEIT lookup is limited after 10 requests', async () => {
  resetRateLimits();
  for (let i = 0; i < 10; i++) {
    // unauthenticated 401s still spend the FACEIT budget (limiter runs first)
    const res = await fetch(base + '/api/teams/1/faceit-lookup?nickname=someone');
    assert.equal(res.status, 401, `request ${i + 1} should be 401, not limited yet`);
  }
  assert.equal((await fetch(base + '/api/teams/1/faceit-lookup?nickname=someone')).status, 429);
});
