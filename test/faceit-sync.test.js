'use strict';
// FACEIT sync must read a championship's match list to the end.
//
// The list is paged at 100 and FACEIT does not return it in chronological
// order, so a team's own match can sit at any index. Reading only the first
// page silently dropped every match past it — in a real ESEA division that was
// most of them, including matches happening that night.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { useTempDb } = require('./helpers');

useTempDb();

const OUR_TEAM = 'our-faceit-team-id';
const CHAMP = 'champ-1';
const PUG_CHAMP = 'pug-champ-1';
const PAGE = 100;
// deliberately past the first page, where the old code stopped looking
const OURS_AT_INDEX = 141;
const TOTAL_UPCOMING = 164;

const requests = [];

function upcomingItem(i) {
  const mine = i === OURS_AT_INDEX;
  return {
    match_id: mine ? 'match-ours' : `match-filler-${i}`,
    status: 'SCHEDULED',
    scheduled_at: 1785198600, // 2026-07-28T00:30:00Z
    best_of: 1,
    competition_name: 'Test League — Regular Season',
    teams: {
      faction1: { faction_id: mine ? OUR_TEAM : `other-${i}`, name: mine ? 'Us' : `Team ${i}` },
      faction2: { faction_id: `opp-${i}`, name: mine ? 'Awpenheimer' : `Rival ${i}` },
    },
  };
}

// Minimal stand-in for the FACEIT Data API. Anything not modelled 404s, which
// syncTeam treats as "nothing here" — the same as the real API.
function mockFaceit() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    requests.push(p + url.search);
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (p === `/teams/${OUR_TEAM}`) {
      return send(200, {
        team_id: OUR_TEAM, name: 'Our Team', game: 'cs2',
        members: [{ nickname: 'p1', user_id: 'u1' }, { nickname: 'p2', user_id: 'u2' }],
      });
    }
    if (p === '/players/u1/history') {
      // our league season — history names our persistent team id
      return send(200, {
        items: [{
          competition_type: 'championship', competition_id: CHAMP,
          teams: { faction1: { team_id: OUR_TEAM }, faction2: { team_id: 'someone' } },
        }],
      });
    }
    if (p === '/players/u2/history') {
      // a pickup-game championship: our team never appears in its factions
      return send(200, {
        items: [{
          competition_type: 'championship', competition_id: PUG_CHAMP,
          teams: { faction1: { team_id: 'random-a' }, faction2: { team_id: 'random-b' } },
        }],
      });
    }
    if (p === `/championships/${CHAMP}/matches`) {
      const type = url.searchParams.get('type');
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Number(url.searchParams.get('limit')) || PAGE;
      if (type !== 'upcoming') return send(200, { items: [] });
      const all = Array.from({ length: TOTAL_UPCOMING }, (_, i) => upcomingItem(i));
      return send(200, { items: all.slice(offset, offset + limit) });
    }
    return send(404, { error: 'not found' });
  });
}

let server, base, db, faceit, teamId;

test.before(async () => {
  server = mockFaceit();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // faceit.js reads FACEIT_API_BASE at module load, so set it before requiring
  process.env.FACEIT_API_BASE = base;
  db = require('../db');
  faceit = require('../faceit');
  await db.init();

  const t = new Date().toISOString();
  const orgId = (await db.run('INSERT INTO organizations (name, created_at) VALUES (?,?) RETURNING id', 'Org', t)).id;
  teamId = (await db.run(
    'INSERT INTO teams (org_id, name, faceit_team_id, faceit_api_key) VALUES (?,?,?,?) RETURNING id',
    orgId, 'Team', OUR_TEAM, 'test-key')).id;
});
test.after(() => server.close());

test('a match past the first page is still imported', async () => {
  const team = await db.get('SELECT * FROM teams WHERE id = ?', teamId);
  const summary = await faceit.syncTeam(team);

  const ours = await db.get('SELECT * FROM matches WHERE team_id = ? AND faceit_match_id = ?', teamId, 'match-ours');
  assert.ok(ours, `the match at index ${OURS_AT_INDEX} must be imported, not dropped with the rest of page 2`);
  assert.equal(ours.status, 'upcoming');
  assert.equal(ours.scheduled_at, '2026-07-28T00:30:00.000Z');
  assert.equal(summary.errors.length, 0, `sync reported errors: ${summary.errors.join('; ')}`);

  const opp = await db.get('SELECT name FROM opponents WHERE id = ?', ours.opponent_id);
  assert.equal(opp.name, 'Awpenheimer');
});

test('every page of the list is read, and paging stops at the end', async () => {
  const pages = requests.filter((r) => r.startsWith(`/championships/${CHAMP}/matches`) && r.includes('type=upcoming'));
  const offsets = pages.map((r) => Number(new URL(r, 'http://x').searchParams.get('offset')));
  assert.ok(offsets.includes(0) && offsets.includes(100), `expected offsets 0 and 100, got ${offsets}`);
  // 164 items => page at 100 comes back short, so there is no third request
  assert.ok(!offsets.includes(200), 'must stop once a short page arrives, not keep paging');
});

test('a pickup-game championship the team never played is not enumerated', async () => {
  const pug = requests.filter((r) => r.includes(PUG_CHAMP));
  assert.deepEqual(pug, [], 'paging a PUG championship to exhaustion would burn the API budget for matches that can never be ours');
});
