'use strict';
// Session hygiene: tokens are stored as sha256 hashes (never plaintext),
// cookies carry the right flags, and startup cleanup purges expired or
// malformed rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { useTempDb, startServer, cookieOf, postJson, login } = require('./helpers');

useTempDb();
const db = require('../db');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

let server, base;
test.before(async () => ({ server, base } = await startServer()));
test.after(() => server.close());

test('session tokens are stored hashed, never in plaintext', async () => {
  const res = await postJson(base, '/api/auth/register', {
    email: 'hashcheck@example.com',
    password: 'password123',
    name: 'Hash Check',
  });
  assert.equal(res.status, 200);
  const token = cookieOf(res).split('=')[1];
  assert.ok(token, 'register must set a session cookie');

  const rows = await db.all('SELECT token_hash FROM sessions');
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.match(row.token_hash, /^[0-9a-f]{64}$/, 'every stored token must be a sha256 hex digest');
    assert.notEqual(row.token_hash, token, 'the raw token must never be stored');
  }
  assert.ok(rows.some((r) => r.token_hash === sha256(token)), 'the hash of the issued token must be stored');
});

test('session cookie is HttpOnly + SameSite=Lax, and Secure only over HTTPS', async () => {
  const res = await postJson(base, '/api/auth/login', {
    email: 'hashcheck@example.com',
    password: 'password123',
  });
  const raw = res.headers.get('set-cookie') || '';
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  assert.ok(!/;\s*Secure/.test(raw), 'plain-http request must not get a Secure cookie (it would vanish)');

  // COOKIE_SECURE=1 is the explicit production override
  process.env.COOKIE_SECURE = '1';
  try {
    const secureRes = await postJson(base, '/api/auth/login', {
      email: 'hashcheck@example.com',
      password: 'password123',
    });
    assert.match(secureRes.headers.get('set-cookie') || '', /;\s*Secure/);
  } finally {
    delete process.env.COOKIE_SECURE;
  }
});

test('cleanup purges expired sessions and non-sha256 token rows, keeps live ones', async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 3600_000).toISOString();
  const ins = (hash, exp) =>
    db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', hash, 1, past, exp);
  await ins(sha256('expired-session'), past);
  await ins('plaintext-token-stored-by-accident', future); // not a 64-hex digest
  await ins(sha256('live-session'), future);

  await db.cleanupSessions();

  const hashes = (await db.all('SELECT token_hash FROM sessions')).map((r) => r.token_hash);
  assert.ok(!hashes.includes(sha256('expired-session')), 'expired row must be deleted');
  assert.ok(!hashes.includes('plaintext-token-stored-by-accident'), 'malformed row must be deleted');
  assert.ok(hashes.includes(sha256('live-session')), 'valid unexpired row must survive');
});

test('an expired session cookie is rejected and removed', async () => {
  const token = 'e'.repeat(64); // raw token presented by the "browser"
  const past = new Date(Date.now() - 1000).toISOString();
  await db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    sha256(token), 1, past, past);

  const res = await fetch(base + '/api/me', { headers: { cookie: `mr_session=${token}` } });
  assert.equal(res.status, 401);
  const row = await db.get('SELECT 1 AS x FROM sessions WHERE token_hash = ?', sha256(token));
  assert.equal(row, undefined, 'presenting an expired session must delete it');
});

test('a fresh login still works end to end', async () => {
  const cookie = await login(base, 'casey@northlight.gg', 'demo1234');
  const res = await fetch(base + '/api/me', { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.email, 'casey@northlight.gg');
});
