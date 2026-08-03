'use strict';
// The production image copies an explicit file list rather than the whole
// directory, which keeps the database, .env and node_modules out of it — and
// which means a new module that nobody adds to the Dockerfile only fails once
// it is deployed, as MODULE_NOT_FOUND at container startup. That happened with
// starter-strategies.js: the tests all passed, the app ran locally, and the
// deploy crash-looped.
//
// So: follow every relative require reachable from server.js and assert the
// image would actually contain it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

// Source paths from `COPY a b c ./dest` lines — the last token is the
// destination, everything between COPY and it is a source.
function copiedPaths() {
  const out = [];
  for (const line of dockerfile.split('\n')) {
    const m = line.match(/^\s*COPY\s+(.+)$/);
    if (!m) continue;
    const parts = m[1].trim().split(/\s+/);
    out.push(...parts.slice(0, -1));
  }
  return out;
}

// Resolve a relative require the way Node would, for the files we use:
// exact path, then .js, then .json.
function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.json`]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Every relative require in the file — including ones inside function bodies,
// which are lazy at runtime but still have to exist in the image.
function localRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  const specs = [...src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  // seed.js builds one path with path.join(__dirname, ...) — catch that shape too
  const joined = [...src.matchAll(/require\(\s*path\.join\(__dirname,\s*([^)]+)\)\s*\)/g)]
    .map((m) => m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).join('/'));
  return [...specs, ...joined.map((j) => (j.startsWith('.') ? j : `./${j}`))];
}

function reachableFrom(entry) {
  const seen = new Set();
  const queue = [path.join(root, entry)];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith('.js')) continue;
    for (const spec of localRequires(file)) {
      const resolved = resolveLocal(file, spec);
      assert.ok(resolved, `${path.relative(root, file)} requires "${spec}", which does not exist`);
      queue.push(resolved);
    }
  }
  return [...seen];
}

test('the production image contains every module server.js can reach', () => {
  const copied = copiedPaths();
  const covered = (rel) => copied.some((c) => c === rel || rel.startsWith(`${c}/`));

  const missing = reachableFrom('server.js')
    .map((f) => path.relative(root, f))
    .filter((rel) => !covered(rel));

  assert.deepEqual(missing, [],
    `these are required at runtime but never COPYd into the image — the container will crash on boot:\n  ${missing.join('\n  ')}`);
});

// The npm scripts are part of the deployed surface too (an operator runs
// reset-demo or install-starters against the live database), so their files
// and everything they pull in have to be in the image as well.
test('the production image contains the npm scripts and their dependencies', () => {
  const copied = copiedPaths();
  const covered = (rel) => copied.some((c) => c === rel || rel.startsWith(`${c}/`));

  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  const entries = Object.values(scripts)
    .map((cmd) => (cmd.match(/node\s+(\S+\.js)/) || [])[1])
    .filter(Boolean);

  for (const entry of entries) {
    const missing = reachableFrom(entry)
      .map((f) => path.relative(root, f))
      .filter((rel) => !covered(rel));
    assert.deepEqual(missing, [], `npm script "${entry}" would fail in the image, missing:\n  ${missing.join('\n  ')}`);
  }
});
