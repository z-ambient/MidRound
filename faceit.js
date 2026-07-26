// MidRound — FACEIT Data API sync
// Pulls a team's scheduled/ongoing league & tournament matches into local matches,
// auto-creating opponents. Uses the server-side FACEIT Data API key (Bearer auth).
const BASE = process.env.FACEIT_API_BASE || 'https://open.faceit.com/data/v4';

async function fApi(key, path) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${key}` } });
  if (res.status === 401 || res.status === 403) {
    const e = new Error('FACEIT rejected the API key'); e.code = 401; throw e;
  }
  if (res.status === 404) { const e = new Error('Not found on FACEIT'); e.code = 404; throw e; }
  if (!res.ok) throw new Error(`FACEIT error ${res.status}`);
  return res.json();
}

// Accepts a raw team id or a team page URL like https://www.faceit.com/en/teams/<uuid>/...
function extractTeamId(input) {
  const s = String(input || '').trim();
  const m = s.match(/teams\/([0-9a-f][0-9a-f-]{30,40})/i) || s.match(/^([0-9a-f][0-9a-f-]{30,40})$/i);
  return m ? m[1] : s;
}

async function lookupTeam(key, teamInput) {
  const id = extractTeamId(teamInput);
  if (!id) throw new Error('FACEIT team id or team URL required');
  const t = await fApi(key, `/teams/${encodeURIComponent(id)}`);
  return { id: t.team_id || id, name: t.name || t.nickname || 'Unknown team', game: t.game || null };
}

const iso = (epochSec) => epochSec ? new Date(epochSec * 1000).toISOString() : null;

function mapStatus(s) {
  const st = String(s || '').toUpperCase();
  if (['FINISHED', 'COMPLETED', 'CANCELLED', 'ABORTED'].includes(st)) return 'completed';
  if (['ONGOING', 'LIVE', 'MANUAL_RESULT'].includes(st)) return 'live';
  return 'upcoming';
}

// ELO/level + aggregated last-30-matches stats for one player.
async function enrichPlayer(key, pid, game) {
  const out = { at: new Date().toISOString() };
  try {
    const p = await fApi(key, `/players/${pid}`);
    const g = (p.games || {})[game] || {};
    out.elo = g.faceit_elo ?? null;
    out.level = g.skill_level ?? null;
  } catch { return null; }
  try {
    const s = await fApi(key, `/players/${pid}/games/${game}/stats?offset=0&limit=30`);
    const items = s.items || [];
    if (items.length) {
      let k = 0, d = 0, adr = 0, adrN = 0, hs = 0, hsN = 0, w = 0;
      for (const it of items) {
        const st = it.stats || {};
        k += +st['Kills'] || 0;
        d += +st['Deaths'] || 0;
        if (st['ADR'] != null) { adr += +st['ADR'] || 0; adrN++; }
        if (st['Headshots %'] != null) { hs += +st['Headshots %'] || 0; hsN++; }
        if (st['Result'] === '1' || st['Result'] === 1) w++;
      }
      out.games = items.length;
      out.kd = d ? +(k / d).toFixed(2) : null;
      out.adr = adrN ? Math.round(adr / adrN) : null;
      out.hs = hsN ? Math.round(hs / hsN) : null;
      out.win = Math.round((w / items.length) * 100);
      // last 10 individual matches (PUGs + league), newest first
      out.recent = items.slice(0, 10).map(mapMatchItem);
    }
  } catch { /* stats are optional */ }
  return out;
}

// one row of a player's match history, in the shape the client renders
function mapMatchItem(it) {
  const st = it.stats || {};
  return {
    map: String(st['Map'] || '').replace(/^de_/, ''),
    score: String(st['Score'] || '').replace(/\s+/g, ''),
    win: String(st['Result']) === '1',
    k: +st['Kills'] || 0,
    d: +st['Deaths'] || 0,
    kd: st['K/D Ratio'] != null ? +st['K/D Ratio'] : null,
    adr: st['ADR'] != null ? Math.round(+st['ADR']) : null,
    at: st['Match Finished At'] ? new Date(+st['Match Finished At']).toISOString() : null,
  };
}

// paged match history for any player, newest first. The stats endpoint only
// honors offsets that are multiples of the limit, so page by 10 and stitch
// (offset should be a multiple of 10).
async function playerMatches(key, pid, game = 'cs2', offset = 0, limit = 20) {
  const out = [];
  let cur = offset;
  while (out.length < limit) {
    const page = await fApi(key, `/players/${pid}/games/${game}/stats?offset=${cur}&limit=10`);
    const items = (page.items || []).map(mapMatchItem);
    out.push(...items);
    if (items.length < 10) break;
    cur += 10;
  }
  return out.slice(0, limit);
}

// FACEIT account lookup by exact nickname (throws 404 if no such player).
async function playerByNickname(key, nickname) {
  return fApi(key, `/players?nickname=${encodeURIComponent(nickname)}`);
}

// Recent form + per-map win rates for an opponent's FACEIT team (from /teams/{id}/stats).
async function teamIntel(key, teamId, game = 'cs2') {
  const s = await fApi(key, `/teams/${encodeURIComponent(teamId)}/stats/${encodeURIComponent(game)}`);
  const life = s.lifetime || {};
  const num = (v) => (v == null || v === '' ? null : +v);
  const intel = {
    at: new Date().toISOString(),
    matches: num(life['Matches']),
    win_rate: num(life['Win Rate %']),
    // most recent first, "1" = win
    recent: Array.isArray(life['Recent Results']) ? life['Recent Results'].map(r => String(r) === '1') : [],
  };
  intel.maps = (s.segments || [])
    .filter(seg => String(seg.type || '').toLowerCase() === 'map' || /^de_/i.test(seg.label || ''))
    .map(seg => ({
      map: String(seg.label || '').replace(/^de_/i, '').replace(/^\w/, c => c.toUpperCase()),
      matches: num((seg.stats || {})['Matches']),
      win_rate: num((seg.stats || {})['Win Rate %']),
    }))
    .filter(m => m.map && m.matches)
    .sort((a, b) => b.matches - a.matches);
  return intel;
}

// Parse /matches/{id}/stats into a compact result + scoreboard, from our team's perspective.
function parseMatchStats(stats, ourId) {
  const rounds = stats.rounds || [];
  const maps = [];
  const agg = new Map(); // nickname -> aggregate row
  let wins = 0, losses = 0;
  for (const r of rounds) {
    const teams = r.teams || [];
    const usTeam = teams.find(t => t.team_id === ourId);
    const themTeam = teams.find(t => t.team_id !== ourId);
    if (!usTeam || !themTeam) continue;
    const us = +((usTeam.team_stats || {})['Final Score']) || 0;
    const them = +((themTeam.team_stats || {})['Final Score']) || 0;
    const win = (usTeam.team_stats || {})['Team Win'] === '1';
    win ? wins++ : losses++;
    maps.push({ map: String((r.round_stats || {})['Map'] || '').replace(/^de_/, ''), us, them, win });
    for (const [teamObj, ours] of [[usTeam, true], [themTeam, false]]) {
      for (const p of (teamObj.players || [])) {
        const st = p.player_stats || {};
        const cur = agg.get(p.nickname) || { nickname: p.nickname, ours, kills: 0, deaths: 0, assists: 0, adr: 0, hs: 0, n: 0 };
        cur.kills += +st['Kills'] || 0;
        cur.deaths += +st['Deaths'] || 0;
        cur.assists += +st['Assists'] || 0;
        cur.adr += +st['ADR'] || 0;
        cur.hs += +st['Headshots %'] || 0;
        cur.n++;
        agg.set(p.nickname, cur);
      }
    }
  }
  if (!maps.length) return null;
  const board = [...agg.values()].map(p => ({
    nickname: p.nickname, ours: p.ours,
    kills: p.kills, deaths: p.deaths, assists: p.assists,
    kd: p.deaths ? +(p.kills / p.deaths).toFixed(2) : p.kills,
    adr: Math.round(p.adr / p.n), hs: Math.round(p.hs / p.n),
  }));
  return {
    result: wins > losses ? 'win' : (losses > wins ? 'loss' : 'tie'),
    score: maps.length > 1 ? `${wins}–${losses}` : `${maps[0].us}–${maps[0].them}`,
    maps,
    ours: board.filter(b => b.ours).sort((a, b) => b.kills - a.kills),
    theirs: board.filter(b => !b.ours).sort((a, b) => b.kills - a.kills),
  };
}

// Sync one MidRound team that has faceit_api_key + faceit_team_id configured.
// Returns a summary; never throws on per-championship failures (collected in errors[]).
async function syncTeam(db, team) {
  const key = team.faceit_api_key;
  const fteam = team.faceit_team_id;
  const summary = { created: 0, updated: 0, championships: 0, players: 0, stats: 0, results: 0, errors: [] };
  const now = () => new Date().toISOString();
  const touchedOpponents = new Map(); // faceit faction id -> local opponent id
  let game = 'cs2';

  // Discover championships two ways:
  //  1. the legacy team tournaments endpoint (open tournaments)
  //  2. the roster's recent match history (ESEA league seasons only surface here —
  //     /teams/{id}/tournaments does NOT list league championships)
  const champIds = new Set();
  try {
    const tours = await fApi(key, `/teams/${fteam}/tournaments?offset=0&limit=50`);
    for (const t of (tours.items || [])) {
      const id = t.tournament_id || t.championship_id || t.id;
      if (id) champIds.add(id);
    }
  } catch (e) {
    if (e.code !== 404) summary.errors.push(`tournaments: ${e.message}`);
  }
  try {
    const teamInfo = await fApi(key, `/teams/${fteam}`);
    game = teamInfo.game || 'cs2';
    // keep our own FACEIT lineup for display (nicknames + elo, not accounts)
    const roster = [];
    for (const m of (teamInfo.members || [])) {
      const entry = { nickname: m.nickname || '?', user_id: m.user_id || null };
      if (m.user_id) {
        try {
          const p = await fApi(key, `/players/${m.user_id}`);
          const g = (p.games || {})[game] || {};
          entry.elo = g.faceit_elo ?? null;
          entry.level = g.skill_level ?? null;
        } catch { /* optional */ }
      }
      roster.push(entry);
    }
    db.prepare('UPDATE teams SET faceit_roster = ? WHERE id = ?').run(JSON.stringify(roster), team.id);
    for (const mem of (teamInfo.members || []).slice(0, 4)) {
      if (!mem.user_id) continue;
      try {
        const hist = await fApi(key, `/players/${mem.user_id}/history?game=${encodeURIComponent(game)}&offset=0&limit=20`);
        for (const h of (hist.items || [])) {
          if (h.competition_type === 'championship' && h.competition_id) champIds.add(h.competition_id);
        }
      } catch { /* member history unavailable — not fatal */ }
    }
  } catch (e) {
    summary.errors.push(`team lookup: ${e.message}`);
  }

  const starters = db.prepare('SELECT user_id FROM team_members WHERE team_id = ? AND is_starter = 1').all(team.id).map(r => r.user_id);

  const upsertMatch = (m, eventName) => {
    const factions = Object.values(m.teams || {});
    const ours = factions.find(f => (f.faction_id || f.team_id) === fteam);
    const opp = factions.find(f => (f.faction_id || f.team_id) !== fteam);
    if (!ours || !opp) return;
    const oppName = opp.name || opp.nickname || 'Unknown team';
    const matchId = m.match_id || m.id;
    if (!matchId) return;

    // opponent: reuse by name (case-insensitive) or create
    const oppFid = opp.faction_id || opp.team_id || null;
    let oppRow = db.prepare('SELECT id FROM opponents WHERE team_id = ? AND lower(name) = lower(?)').get(team.id, oppName);
    if (!oppRow) {
      const t = now();
      const oid = db.prepare(`INSERT INTO opponents (team_id, name, notes, faceit_team_id, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
        .run(team.id, oppName, 'Imported from FACEIT.', oppFid, t, t).lastInsertRowid;
      oppRow = { id: oid };
    } else if (oppFid) {
      db.prepare('UPDATE opponents SET faceit_team_id = COALESCE(faceit_team_id, ?) WHERE id = ?').run(oppFid, oppRow.id);
    }
    if (oppFid) touchedOpponents.set(oppFid, oppRow.id);

    const scheduled = iso(m.scheduled_at || m.started_at);
    const format = m.best_of ? `BO${m.best_of}` : 'BO1';
    const status = mapStatus(m.status);
    const event = m.competition_name || eventName || 'FACEIT match';

    const existing = db.prepare('SELECT * FROM matches WHERE team_id = ? AND faceit_match_id = ?').get(team.id, matchId);
    if (existing) {
      db.prepare(`UPDATE matches SET opponent_id = ?, scheduled_at = ?, event = ?, format = ?, status = ? WHERE id = ?`)
        .run(oppRow.id, scheduled, event, format, status, existing.id);
      summary.updated++;
    } else {
      db.prepare(`INSERT INTO matches
        (team_id, opponent_id, scheduled_at, event, format, expected_maps, veto_notes, starting_side, roster, subs, status, created_by, created_at, faceit_match_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        team.id, oppRow.id, scheduled, event, format, '[]', null, null,
        JSON.stringify(starters), '[]', status, null, now(), matchId);
      summary.created++;
    }
  };

  for (const cid of champIds) {
    let champName = null;
    try { champName = (await fApi(key, `/championships/${cid}`)).name || null; } catch { /* optional */ }
    let any = false;
    for (const type of ['upcoming', 'ongoing', 'past']) {
      try {
        const page = await fApi(key, `/championships/${cid}/matches?type=${type}&offset=0&limit=100`);
        for (const m of (page.items || [])) upsertMatch(m, champName);
        any = true;
      } catch (e) {
        if (e.code !== 404) summary.errors.push(`championship ${cid.slice(0, 8)}…: ${e.message}`);
      }
    }
    if (any) summary.championships++;
  }

  // enemy rosters: import each touched opponent's FACEIT lineup as scouting player profiles
  for (const [fid, oppId] of touchedOpponents) {
    try {
      const info = await fApi(key, `/teams/${fid}`);
      for (const mem of (info.members || [])) {
        if (!mem.nickname) continue;
        const exists = db.prepare('SELECT 1 FROM opponent_players WHERE opponent_id = ? AND lower(name) = lower(?)').get(oppId, mem.nickname);
        if (!exists) {
          db.prepare('INSERT INTO opponent_players (opponent_id, name, notes, faceit_player_id) VALUES (?,?,?,?)')
            .run(oppId, mem.nickname, 'Imported from FACEIT.', mem.user_id || null);
          summary.players++;
        } else if (mem.user_id) {
          db.prepare('UPDATE opponent_players SET faceit_player_id = COALESCE(faceit_player_id, ?) WHERE opponent_id = ? AND lower(name) = lower(?)')
            .run(mem.user_id, oppId, mem.nickname);
        }
      }
    } catch (e) {
      if (e.code !== 404) summary.errors.push(`roster ${String(fid).slice(0, 8)}…: ${e.message}`);
    }
  }

  // refresh ELO + last-30 stats for opponent players (at most every 24h, capped per sync)
  const stale = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const toEnrich = db.prepare(`
    SELECT op.id, op.faceit_player_id FROM opponent_players op
    JOIN opponents o ON o.id = op.opponent_id
    WHERE o.team_id = ? AND op.faceit_player_id IS NOT NULL
      AND (op.faceit_stats IS NULL OR json_extract(op.faceit_stats, '$.at') < ?)
    LIMIT 40`).all(team.id, stale);
  for (const row of toEnrich) {
    const st = await enrichPlayer(key, row.faceit_player_id, game);
    if (st) {
      db.prepare('UPDATE opponent_players SET faceit_stats = ? WHERE id = ?').run(JSON.stringify(st), row.id);
      summary.stats++;
    }
  }

  // results + scoreboards for finished matches that don't have one yet
  const needResults = db.prepare(`SELECT id, faceit_match_id FROM matches
    WHERE team_id = ? AND faceit_match_id IS NOT NULL AND status = 'completed' AND faceit_result IS NULL
    LIMIT 10`).all(team.id);
  for (const row of needResults) {
    try {
      const stats = await fApi(key, `/matches/${row.faceit_match_id}/stats`);
      const parsed = parseMatchStats(stats, fteam);
      if (parsed) {
        db.prepare('UPDATE matches SET faceit_result = ? WHERE id = ?').run(JSON.stringify(parsed), row.id);
        summary.results++;
      }
    } catch (e) {
      if (e.code !== 404) summary.errors.push(`result ${row.faceit_match_id.slice(0, 10)}…: ${e.message}`);
    }
  }

  db.prepare('UPDATE teams SET faceit_last_sync = ? WHERE id = ?').run(new Date().toISOString(), team.id);
  return summary;
}

module.exports = { lookupTeam, syncTeam, extractTeamId, teamIntel, enrichPlayer, playerByNickname, playerMatches };
