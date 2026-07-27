'use strict';
// Shared plumbing for the security test suite. node --test runs each test
// file in its own process, so every file gets an isolated database and its
// own server on an ephemeral port — tests never touch midround.db.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must run BEFORE require('../server') so db.js opens the throwaway file.
function useTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'midround-test-'));
  process.env.MIDROUND_DB_PATH = path.join(dir, 'test.db');
  return process.env.MIDROUND_DB_PATH;
}

async function startServer() {
  const { app, ready } = require('../server');
  await ready; // schema + seed + cleanup must finish before requests
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// The "name=value" pair of the session cookie set by a response.
function cookieOf(res) {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

async function postJson(base, path, body, cookie) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function login(base, email, password) {
  const res = await postJson(base, '/api/auth/login', { email, password });
  if (res.status !== 200) throw new Error(`login failed with status ${res.status}`);
  return cookieOf(res);
}

module.exports = { useTempDb, startServer, cookieOf, postJson, login };
