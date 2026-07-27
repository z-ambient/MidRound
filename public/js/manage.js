// MidRound — Management Mode views
import { api } from './api.js';
import { esc, safeHref, sideBadge, statusBadge, badge, fmtDate, fmtRel, toast, confirmDialog, inputDialog, emptyState, spinner, tagsHtml, opt, linesToArr, arrToLines, debounce, ICONS } from './ui.js';
import { state, can, nav, query, trackView, roleLabel } from './main.js';

const teamUrl = (p) => `/api/teams/${state.teamId}${p}`;

const BUYS = [['pistol', 'Pistol'], ['full', 'Full buy'], ['semi', 'Semi-buy'], ['eco', 'Eco'], ['save', 'Save']];

function toLocalInput(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function buyLabel(b) {
  return ({ pistol: 'Pistol', eco: 'Eco', semi: 'Semi-buy', save: 'Save', full: 'Full buy', force: 'Semi-buy', 'anti-eco': 'Full buy' })[b] || b || '';
}

// stable tactical ordering: CT before T, then Pistol > Save > Semi > Eco > Full, then map/name
const BUY_ORDER = { pistol: 0, save: 1, semi: 2, eco: 3, full: 4 };
const SIDE_ORDER = { CT: 0, T: 1 };
const STATUS_ORDER = { active: 0, draft: 1, archived: 2 };
export function stratSort(list) {
  return list.sort((a, b) =>
    (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) ||
    (SIDE_ORDER[a.side] ?? 2) - (SIDE_ORDER[b.side] ?? 2) ||
    (BUY_ORDER[a.buy_type] ?? 5) - (BUY_ORDER[b.buy_type] ?? 5) ||
    a.map.localeCompare(b.map) ||
    a.name.localeCompare(b.name));
}

// ---------- shared components ----------
export function sideTag(side) {
  return side === 'T'
    ? '<span class="side-tag t">T</span>'
    : '<span class="side-tag ct">CT</span>';
}

// faint map image band at the top of the page (cleared by the router on navigation);
// pass blur=true on pages that put text straight over the image
function setMapAmbient(el, mapName, blur = false) {
  const main = el.closest('.main');
  if (!main) return;
  if (mapName) {
    const slug = String(mapName).toLowerCase().replace(/[^a-z0-9]/g, '');
    const url = `url('/img/maps/${slug}.jpg')`;
    const changed = main.classList.contains('map-ambient') && main.style.getPropertyValue('--map-img') !== url;
    main.style.setProperty('--map-img', url);
    main.classList.toggle('map-blur', blur);
    if (changed) {
      // recreate the band so the new map's fade-in replays
      main.classList.remove('map-ambient');
      void main.offsetWidth;
    }
    main.classList.add('map-ambient');
  } else {
    main.classList.remove('map-ambient', 'map-blur');
    main.style.removeProperty('--map-img');
  }
}

export function stratCard(s, { href } = {}) {
  const link = href || `#/strategies/${s.id}`;
  return `
    <a class="card ${s.side === 'T' ? 'tint-t' : 'tint-ct'}" href="${link}">
      <div class="card-title">
        <span class="grow">${s.favorite ? `<span title="Favorite" style="color:var(--accent)">${ICONS.starFill}</span> ` : ''}${esc(s.name)} ${statusBadge(s.status)}</span>
        ${sideTag(s.side)}
      </div>
      <div class="card-sub">${mapDot(s.map)}${esc(s.map)} · ${esc(buyLabel(s.buy_type) || 'Any buy')}</div>
      ${s.summary ? `<div class="card-summary">${esc(s.summary.length > 130 ? s.summary.slice(0, 130) + '…' : s.summary)}</div>` : ''}
    </a>`;
}

export function tendencyHtml(td, { removable } = {}) {
  const meta = [
    td.player_name ? badge(td.player_name, 'neutral') : '',
    td.map ? badge(td.map) : '',
    td.side ? badge(td.side + ' side', td.side === 'T' ? 't' : 'ct') : '',
    td.site ? badge(td.site) : '',
    td.round_type ? badge(td.round_type) : '',
    td.category ? badge(td.category) : '',
    td.severity === 'high' ? badge('KEY READ', 'warn') : '',
  ].filter(Boolean).join(' ');
  return `
    <div class="tendency ${td.severity === 'high' ? 'high' : ''}">
      ${removable ? `<button class="t-del" data-del-tendency="${td.id}" title="Remove tendency">✕</button>` : ''}
      ${meta ? `<div class="t-meta">${meta}</div>` : ''}
      <div class="t-text">${esc(td.text)}</div>
    </div>`;
}

// FACEIT skill-level tint (1 gray → 10 red, roughly matching FACEIT's own ladder colors)
function levelColor(l) {
  if (l >= 10) return '#e2543e';
  if (l >= 8) return '#e0a458';
  if (l >= 4) return '#e8c56a';
  if (l >= 2) return '#57b97e';
  return 'var(--text-3)';
}

// ELO + last-30 stat lines for an opponent player (from faceit_stats JSON), or ''
export function playerStatsHtml(p) {
  let fs = null;
  try { fs = p.faceit_stats ? JSON.parse(p.faceit_stats) : null; } catch { /* ignore */ }
  if (!fs || (!fs.elo && !fs.games)) return '';
  const lvl = fs.level ? `<span style="color:${levelColor(fs.level)};font-weight:700">Lv ${fs.level}</span> · ` : '';
  const elo = fs.elo != null ? `${lvl}<b>${fs.elo}</b> ELO` : lvl;
  const line2 = fs.games
    ? `<div class="pc-stats">Last ${fs.games}: ${fs.kd ?? '—'} K/D · ${fs.adr ?? '—'} ADR · ${fs.hs ?? '—'}% HS · ${fs.win ?? '—'}% W</div>`
    : '';
  return `${elo ? `<div class="pc-elo">${elo}</div>` : ''}${line2}`;
}

export function strategyDetailHtml(s) {
  return `
    ${s.summary ? `<div class="callout ${s.side === 'CT' ? 'blue' : ''}">${esc(s.summary)}</div>` : ''}
    ${(s.warnings || []).length ? `<div class="warnbox"><ul>${s.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    ${s.objective ? `<div class="section"><h3>Primary objective</h3><p>${esc(s.objective)}</p></div>` : ''}
    ${s.required_utility ? `<div class="section"><h3>Required utility</h3><p class="small" style="color:var(--text-2)">${esc(s.required_utility)}</p></div>` : ''}
    ${(s.steps || []).length ? `<div class="section"><h3>Step by step</h3><ol class="steps">${s.steps.map(x => `<li><span>${esc(x)}</span></li>`).join('')}</ol></div>` : ''}
    ${(s.attachments || []).length ? `<div class="section"><h3>Attachments</h3><ul class="bullets">${s.attachments.map(a =>
      `<li>${esc(a.type || 'link')}: ${safeHref(a.url)
        ? `<a style="color:var(--blue)" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.label || a.url)}</a>`
        : `<span title="Link removed — not a web URL">${esc(a.label || a.url)}</span>`}</li>`).join('')}</ul></div>` : ''}`;
}

// ---------- dashboard ----------
function initials(name) {
  const words = String(name || '').replace(/"[^"]*"/g, '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

// FACEIT skill-level badge — inline SVG ring + level number in the official tier colors
export function faceitBadge(level, size = 20) {
  const n = Number(level);
  if (!n || n < 1) return '';
  const lvl = Math.min(10, Math.round(n));
  const c = lvl >= 10 ? '#fe1f00' : lvl >= 8 ? '#ff6309' : lvl >= 4 ? '#ffc800' : lvl >= 2 ? '#1ce400' : '#cdcdcd';
  const r = 8, cf = 2 * Math.PI * r;
  const arc = (cf * lvl / 10).toFixed(2);
  return `<svg class="fc-badge" width="${size}" height="${size}" viewBox="0 0 20 20" role="img" aria-label="FACEIT level ${lvl}">
    <circle cx="10" cy="10" r="9.4" fill="#16222f" stroke="#2e4155" stroke-width="1"/>
    <circle cx="10" cy="10" r="${r}" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="1.7"/>
    <circle cx="10" cy="10" r="${r}" fill="none" stroke="${c}" stroke-width="1.7"
      stroke-dasharray="${arc} ${cf.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 10 10)"/>
    <text x="10" y="${lvl === 10 ? 12.8 : 13.3}" text-anchor="middle" font-size="${lvl === 10 ? 7.2 : 9.2}" font-weight="800" fill="${c}">${lvl}</text>
  </svg>`;
}

// best-effort link from a member's display name to a FACEIT roster entry
// (matches the quoted nickname in 'First "Nick" Last', then exact/partial nickname)
export function faceitFor(name, roster) {
  if (!Array.isArray(roster) || !roster.length) return null;
  const low = (s) => String(s || '').toLowerCase();
  const nick = (String(name || '').match(/"([^"]+)"/) || [])[1];
  return (nick && roster.find(p => low(p.nickname) === low(nick)))
    || roster.find(p => low(p.nickname) === low(name))
    || (nick && roster.find(p => low(p.nickname).includes(low(nick)) || low(nick).includes(low(p.nickname))))
    || null;
}

// badge + elo pair for row right-edges; entry needs {level, elo}
const fcInline = (fp) => fp && fp.level
  ? `<span class="fc-side">${faceitBadge(fp.level)}${fp.elo ? `<b>${fp.elo}</b>` : ''}</span>` : '';

// deterministic muted identity color per map name (used for dots on chips/coverage)
export function mapDot(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="map-dot" style="background:hsl(${h},40%,62%)"></span>`;
}

// deterministic radar-style minimap thumbnail for a map (SVG data URI)
export function mapThumb(name) {
  let seed = 0;
  for (const ch of String(name)) seed = (seed * 131 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  let shapes = '';
  for (let i = 0; i < 8; i++) {
    const x = (rnd() * 84) | 0, y = (rnd() * 46) | 0;
    const w = 10 + ((rnd() * 30) | 0), h = 7 + ((rnd() * 16) | 0);
    shapes += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="rgba(255,255,255,${(0.1 + rnd() * 0.14).toFixed(3)})"/>`;
  }
  for (let i = 0; i < 3; i++) {
    shapes += `<path d="M${(rnd() * 100) | 0} ${(rnd() * 64) | 0} L${(rnd() * 100) | 0} ${(rnd() * 64) | 0}" stroke="rgba(255,255,255,0.16)" stroke-width="3" stroke-linecap="round"/>`;
  }
  shapes += `<circle cx="${8 + rnd() * 84}" cy="${8 + rnd() * 48}" r="4.5" fill="rgba(224,164,88,0.7)"/>`;
  shapes += `<circle cx="${8 + rnd() * 84}" cy="${8 + rnd() * 48}" r="4.5" fill="rgba(95,168,232,0.7)"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 64">${shapes}</svg>`;
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
}

// scrim + photo + generated-minimap fallback, as a style string
export function mapBg(name, topA, botA) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  return `background-image: linear-gradient(180deg, rgba(22,34,47,${topA}), rgba(22,34,47,${botA})), url('/img/maps/${slug}.jpg'), ${mapThumb(name)};`;
}

export function mapTile(name, label, active, dataAttrs = '') {
  const style = name
    ? mapBg(name, 0.27, 0.88)
    : `background-image: linear-gradient(180deg, rgba(22,34,47,0), rgba(22,34,47,0.55)), linear-gradient(120deg, rgba(224,164,88,0.32), rgba(22,34,47,0.1) 50%, rgba(95,168,232,0.32));`;
  return `<button class="map-tile ${active ? 'active' : ''}" style="${style}" ${dataAttrs}><span>${esc(label)}</span></button>`;
}

function untilText(iso) {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'starting now';
  const h = Math.round(diff / 3600000);
  if (h < 1) return 'in less than an hour';
  if (h < 24) return `in ${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  if (d === 1) return 'tomorrow';
  return `in ${d} days`;
}

function fmtMatchDate(iso) {
  if (!iso) return 'Not scheduled';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export async function viewDashboard(el) {
  el.innerHTML = spinner();
  const onTeam = !!state.teamId;
  let d, allMatches, allStrats;
  if (onTeam) {
    [d, allMatches, allStrats] = await Promise.all([
      api.get(teamUrl('/dashboard')),
      api.get(teamUrl('/matches')),
      api.get(teamUrl('/strategies')),
    ]);
  } else {
    // same dashboard, personal data: strategies are the user's own, and the
    // team-fed modules (calendar, next match, roster) render empty in place
    const [maps, mine] = await Promise.all([api.get('/api/maps'), api.get('/api/strategies')]);
    allMatches = [];
    allStrats = mine;
    const by_map = {};
    for (const m of maps) {
      const on = mine.filter(s => s.map === m.name && s.status === 'active');
      by_map[m.name] = { total: on.length, t: on.filter(s => s.side === 'T').length, ct: on.filter(s => s.side === 'CT').length };
    }
    d = { next_match: null, by_map, roster: [], faceit_roster: [], archived_count: 0 };
  }
  const team = state.me.teams.find(t => t.id === state.teamId);
  const org = team ? state.me.orgs.find(o => o.id === team.org_id) : null;

  const nm = d.next_match;

  const matchInfo = nm ? `
    <div class="h-info">
      <div class="kicker"><span class="live-dot"></span>Next match · ${esc(untilText(nm.scheduled_at))}</div>
      <div class="h-opp">vs ${esc(nm.opponent_name || 'TBD')}</div>
      <div class="h-meta">${esc(nm.event || '')}</div>
      <div class="h-when"><b>${esc(fmtMatchDate(nm.scheduled_at))}</b> · ${esc(nm.format || '')}${nm.starting_side ? ` · starting ${esc(nm.starting_side)} side` : ''}</div>
      ${nm.expected_maps.length ? `<div class="h-maps">${nm.expected_maps.map(m => `<span class="map-chip">${mapDot(m)}${esc(m)}</span>`).join('')}</div>` : ''}
      <div class="h-actions">
        <a class="btn primary" href="#/match-mode/${nm.id}">${ICONS.play} Team Match Mode</a>
        <a class="btn" href="#/matches/${nm.id}">Match details</a>
      </div>
      <div class="hero-note">${nm.pin_count ? `<b>${nm.pin_count} pinned call${nm.pin_count === 1 ? '' : 's'}</b> ready for this match` : 'No calls pinned yet'}</div>
    </div>` : onTeam ? `
    <div class="h-info">
      <div class="kicker">Next match</div>
      <div class="h-opp">Nothing scheduled</div>
      <div class="h-meta">Create a match to set the veto plan and pin your calls.</div>
      <div class="h-actions">
        <a class="btn primary" href="#/match-mode/team">${ICONS.play} Team Match Mode</a>
        ${can('matches') ? `<a class="btn" href="#/matches">Set up a match</a>` : ''}
      </div>
    </div>` : `
    <div class="h-info">
      <div class="kicker">Next match</div>
      <div class="h-opp">You're not on a team</div>
      <div class="h-meta">Team matches appear here once you join or create a team from Team &amp; access.</div>
      <div class="h-actions">
        <a class="btn primary" href="#/match-mode/solo">${ICONS.play} Solo Match Mode</a>
        <a class="btn" href="#/strategies/new">+ New strategy</a>
      </div>
    </div>`;

  const mapsCovered = Object.values(d.by_map).filter(v => v.total > 0).length;
  const mapsTotal = Object.keys(d.by_map).length;
  const activeCount = Object.values(d.by_map).reduce((a, v) => a + v.total, 0);

  const maxSide = Math.max(1, ...Object.values(d.by_map).flatMap(v => [v.t, v.ct]));
  const covW = (n) => Math.max(n > 0 ? 6 : 0, Math.round(n / maxSide * 100));
  const covRows = Object.entries(d.by_map)
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([m, v]) => `
      <a class="cov-row ${v.total === 0 ? 'zero' : ''}" style="${mapBg(m, 0.93, 0.98)} background-size: cover; background-position: center;" href="#/strategies?map=${encodeURIComponent(m)}">
        <span class="cv-map">${mapDot(m)}${esc(m)}</span>
        <span class="cov-bars">
          ${v.total === 0
            ? `<span class="cov-bar none" style="width:100%"></span>`
            : `<span class="cov-bar" style="width:${covW(v.t)}%" title="${v.t} T-side"></span>
               <span class="cov-bar ct" style="width:${covW(v.ct)}%" title="${v.ct} CT-side"></span>`}
        </span>
        <span class="cov-n">${v.total === 0 ? 'no prep' : `${v.t} T · ${v.ct} CT`}</span>
      </a>`).join('');

  const stratRow = (s) => `
    <a class="list-row" href="#/strategies/${s.id}">
      <span class="side-rail ${s.side === 'T' ? 't' : 'ct'}"></span>
      <span class="grow">
        <span class="r-name">${esc(s.name)}</span>
        <div class="r-sub">${esc(s.map)} · ${esc(buyLabel(s.buy_type) || 'Any buy')}${s.status === 'draft' ? ' · draft' : ''}</div>
      </span>
      <span class="r-side">${esc(fmtRel(s.updated_at) || '')}</span>
    </a>`;

  el.innerHTML = `
    <div class="dash-page">
    <div class="page-head center" style="margin-bottom:18px">
      <div><h1>${esc(team ? team.name : 'Dashboard')}</h1><div class="sub">${esc(org ? org.name : '')}</div></div>
    </div>
    <div class="dash-grid">
      <div>
        <div class="dash-topcard">
          ${matchInfo}
          <div class="cal-embed" id="cal-card"></div>
        </div>
        <div class="sec">
          <div class="sec-head">
            <div class="head-left">
              <h2>Strategies <span class="h-count" id="strat-count"></span></h2>
              <div class="filter-chips" id="strat-filters"></div>
            </div>
            <span>${onTeam ? '' : `<a href="#/strategies/new" style="margin-right:14px">+ New strategy</a>`}<a href="#/strategies">Open library →</a></span>
          </div>
          <div class="list-card" id="strat-list"></div>
        </div>
        ${d.archived_count ? `<div class="small" style="padding:12px 4px 0"><a href="#/strategies?status=archived" style="color:var(--text-3)">${d.archived_count} archived strateg${d.archived_count === 1 ? 'y' : 'ies'} →</a></div>` : ''}
      </div>
      <div>
        <aside class="dash-side" style="margin-bottom:16px">
          <div class="team-card">
            <div class="team-logo">${onTeam ? esc(initials(team ? team.name : 'MR')) : '—'}</div>
            <div class="tc-name">${onTeam ? esc(team ? team.name : '') : 'No team yet'}</div>
            <div class="tc-org">${onTeam ? esc(org ? org.name : '') : "You're not on a team"}</div>
          </div>
          <div class="cal-head"><b>Roster</b><a href="#/team" class="small" style="color:var(--text-3)">${onTeam ? 'Manage' : 'Team & access'} →</a></div>
          ${!onTeam ? `<div class="small muted" style="padding:8px 6px">You're not on a team — create or join one from Team &amp; access.</div>`
          : d.roster.length ? d.roster.map(p => `
            <a class="list-row" href="#/players/${p.id}">
              <span class="avatar">${esc(initials(p.name))}</span>
              <span class="grow"><span class="r-name">${esc(p.name)}</span><div class="r-sub">${esc(p.game_role || '')}${p.is_starter ? '' : ' · sub'}${!p.game_role && p.user ? esc(p.user.name) : ''}</div></span>
              ${fcInline(p.faceit_stats) || (p.faceit_stats && p.faceit_stats.elo ? `<span class="fc-side"><b>${p.faceit_stats.elo}</b></span>` : '')}
            </a>`).join('')
          : (d.faceit_roster || []).length ? d.faceit_roster.map(p => `
            <div class="list-row">
              <span class="avatar">${esc(initials(p.nickname))}</span>
              <span class="grow"><span class="r-name">${esc(p.nickname)}</span><div class="r-sub">via FACEIT</div></span>
              ${fcInline(p) || (p.elo ? `<span class="fc-side"><b>${p.elo}</b></span>` : '')}
            </div>`).join('')
          : `<div class="small muted" style="padding:8px 6px">No roster yet — invite teammates or connect FACEIT.</div>`}
        </aside>
        <div class="sec">
          <div class="sec-head"><h2>Map coverage <span class="h-count">${mapsCovered}/${mapsTotal}</span></h2><a href="#/strategies">Library →</a></div>
          <div class="list-card">${covRows}</div>
        </div>
      </div>
    </div>
    </div>`;

  // ---- strategy list with map filter ----
  const active = stratSort(allStrats.filter(s => s.status === 'active'));
  const draftStrats = allStrats.filter(s => s.status === 'draft');
  const stratMaps = [...new Set(allStrats.map(s => s.map))].sort();
  let mapFilter = localStorage.getItem('mr.dash.map') || 'all';
  if (mapFilter !== 'all' && !stratMaps.includes(mapFilter)) mapFilter = 'all';

  function renderStrats() {
    const fActive = mapFilter === 'all' ? active : active.filter(s => s.map === mapFilter);
    el.querySelector('#strat-filters').innerHTML = [
      `<button class="chip ${mapFilter === 'all' ? 'active' : ''}" data-mapf="all">All maps</button>`,
      ...stratMaps.map(m => `<button class="chip ${mapFilter === m ? 'active' : ''}" data-mapf="${esc(m)}">${mapDot(m)}${esc(m)}</button>`),
    ].join('');
    el.querySelector('#strat-count').textContent = `· ${fActive.length} active`;
    const stratList = el.querySelector('#strat-list');
    // faint map watermark behind the list: the filtered map, else the next match's first map
    const wmMap = mapFilter !== 'all' ? mapFilter
      : (nm && nm.expected_maps && nm.expected_maps[0]) || stratMaps[0] || 'Mirage';
    stratList.setAttribute('style',
      `${mapBg(wmMap, 0.94, 0.985)} background-size: cover; background-position: center;`);
    stratList.innerHTML = fActive.length
      ? fActive.map(stratRow).join('')
      : emptyState(mapFilter === 'all' ? 'No strategies yet' : `No active strategies for ${mapFilter}`,
          (!onTeam || can('strategies')) ? 'Create one from the library.' : '');
    el.querySelectorAll('[data-mapf]').forEach(b => b.onclick = () => {
      mapFilter = b.dataset.mapf;
      localStorage.setItem('mr.dash.map', mapFilter);
      renderStrats();
    });
  }
  renderStrats();

  // ---- match calendar ----
  const dated = allMatches.filter(m => m.scheduled_at);
  const byDay = {};
  for (const m of dated) {
    const dt = new Date(m.scheduled_at);
    const k = `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`;
    (byDay[k] = byDay[k] || []).push(m);
  }
  const upcomingList = dated
    .filter(m => new Date(m.scheduled_at).getTime() > Date.now() - 12 * 3600000 && m.status === 'upcoming')
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
    .slice(0, 3);

  let calOffset = 0;
  const calCard = el.querySelector('#cal-card');
  function renderCal() {
    const base = new Date();
    base.setDate(1);
    base.setMonth(base.getMonth() + calOffset);
    const y = base.getFullYear(), mo = base.getMonth();
    const label = base.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const firstDow = (new Date(y, mo, 1).getDay() + 6) % 7; // Monday-first
    const totalCells = 42; // always 6 rows so the tile never changes height between months
    const today = new Date();

    let cells = '';
    for (let i = 0; i < totalCells; i++) {
      const date = new Date(y, mo, i - firstDow + 1);
      const out = date.getMonth() !== mo;
      const k = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const dayMatches = byDay[k] || [];
      const isToday = date.toDateString() === today.toDateString();
      if (dayMatches.length) {
        const m = dayMatches[0];
        cells += `<button class="cal-day match ${dayMatches.every(x => x.status !== 'upcoming') ? 'past' : ''} ${out ? 'out' : ''}"
          data-goto="#/matches/${m.id}" title="vs ${esc(m.opponent ? m.opponent.name : 'TBD')}">${date.getDate()}</button>`;
      } else {
        cells += `<span class="cal-day ${out ? 'out' : ''} ${isToday ? 'today' : ''}">${date.getDate()}</span>`;
      }
    }

    calCard.innerHTML = `
      <div class="cal-head">
        <b>${esc(label)}</b>
        <div class="cal-nav">
          <button data-cal="-1" aria-label="Previous month">‹</button>
          <button data-cal="1" aria-label="Next month">›</button>
        </div>
      </div>
      <div class="cal-grid">
        ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(dw => `<span class="cal-dow">${dw[0]}</span>`).join('')}
        ${cells}
      </div>
      ${upcomingList.length ? `
        <div class="cal-agenda">
          ${upcomingList.map(m => `
            <a href="#/matches/${m.id}">
              <span class="cal-date-chip">${esc(new Date(m.scheduled_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</span>
              <span class="r-name">vs ${esc(m.opponent ? m.opponent.name : 'TBD')}</span>
              <span class="a-t">${esc(new Date(m.scheduled_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}</span>
            </a>`).join('')}
        </div>` : ''}`;

    calCard.querySelectorAll('[data-cal]').forEach(b => b.onclick = () => { calOffset += Number(b.dataset.cal); renderCal(); });
    calCard.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { location.hash = b.dataset.goto; });
  }
  renderCal();
}

// ---------- strategy library ----------
// The library has two scopes: "Your Strats" (personal strategies you created)
// and "Team Strats" (the team's shared bank). New strategies are always
// created personal; they reach Team Strats via "Add to Team Strats".
function stratListUrl(params) {
  const scope = params.scope === 'team' && state.teamId ? 'team' : 'mine';
  const qs = new URLSearchParams(Object.fromEntries(
    Object.entries(params).filter(([k, v]) => v && k !== 'scope')));
  return (scope === 'team' ? teamUrl('/strategies') : '/api/strategies') + '?' + qs;
}

export async function viewStrategies(el) {
  const q = query();
  const scope = q.scope === 'team' && state.teamId ? 'team' : 'mine';
  el.innerHTML = spinner();
  const [maps, list] = await Promise.all([
    api.get('/api/maps'),
    api.get(stratListUrl(q)),
  ]);

  stratSort(list);

  const chip = (param, value, label, extra = '') =>
    `<button class="chip ${(q[param] || '') === value ? 'active' : ''}" data-f="${param}" data-v="${esc(value)}">${extra}${esc(label)}</button>`;

  el.innerHTML = `
    <div class="lib-page">
    <div class="page-head center">
      <div>
        <h1>Strategy library</h1>
        <div class="sub">${list.length} strateg${list.length === 1 ? 'y' : 'ies'}${q.status === 'archived' ? ' · archived' : ''}</div>
        <div class="filter-chips" style="justify-content:center;margin-top:12px">
          <button class="chip ${scope === 'mine' ? 'active' : ''}" data-scope="mine">Your Strats</button>
          ${state.teamId
            ? `<button class="chip ${scope === 'team' ? 'active' : ''}" data-scope="team">Team Strats</button>`
            : `<button class="chip" disabled title="You're not on a team">Team Strats</button>`}
        </div>
        <div class="head-actions" style="justify-content:center;margin-top:12px">
          ${q.status === 'archived' ? `<a class="btn small" href="#/strategies">← Back to active</a>` : ''}
          <a class="btn primary" href="#/strategies/new">+ New strategy</a>
        </div>
      </div>
    </div>
    <div class="lib-filters">
      <div class="map-tiles">
        ${mapTile(null, 'All maps', !(q.map), `data-f="map" data-v=""`)}
        ${maps.map(m => mapTile(m.name, m.name, q.map === m.name, `data-f="map" data-v="${esc(m.name)}"`)).join('')}
        ${can('strategies') ? `<button class="map-tile add" id="add-map" title="Add a map"><span>+ Add map</span></button>` : ''}
      </div>
      <div class="filter-chips">
        ${chip('side', '', 'Both sides')}
        ${chip('side', 'T', 'T side')}
        ${chip('side', 'CT', 'CT side')}
        <span class="chip-divider"></span>
        ${chip('buy_type', '', 'Any buy')}
        ${BUYS.map(([v, l]) => chip('buy_type', v, l)).join('')}
      </div>
    </div>
    <div class="grid cols-3" id="strat-grid">
      ${list.length ? list.map(s => stratCard(s)).join('') : emptyState('No strategies match',
        scope === 'team' ? 'Team Strats fill up when members add their strategies with "Add to Team Strats".'
          : 'Try clearing a filter, or create a new strategy.')}
    </div>
    </div>`;

  setMapAmbient(el, q.map);

  // scope switch re-renders the page against the other list
  el.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => {
    const cur2 = { ...query(), scope: b.dataset.scope === 'team' ? 'team' : '' };
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(cur2).filter(([, v]) => v)));
    const hash = '#/strategies' + ([...qs].length ? '?' + qs : '');
    history.replaceState(null, '', hash);
    localStorage.setItem('mr.route', hash);
    viewStrategies(el);
  });

  // filter switches update in place — only the cards re-render (and flow in),
  // the page chrome stays put and the map band fades in on its own clock
  const cur = { ...q };
  async function applyFilters() {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(cur).filter(([, v]) => v)));
    const hash = '#/strategies' + ([...qs].length ? '?' + qs : '');
    history.replaceState(null, '', hash);
    localStorage.setItem('mr.route', hash);
    let fresh;
    try { fresh = await api.get(stratListUrl(cur)); }
    catch (e) { toast(e.message, 'err'); return; }
    stratSort(fresh);
    el.querySelector('#strat-grid').innerHTML = fresh.length
      ? fresh.map(s => stratCard(s)).join('')
      : emptyState('No strategies match',
          cur.scope === 'team' ? 'Team Strats fill up when members add their strategies with "Add to Team Strats".'
            : 'Try clearing a filter, or create a new strategy.');
    el.querySelectorAll('[data-f]').forEach(b =>
      b.classList.toggle('active', (cur[b.dataset.f] || '') === b.dataset.v));
    const sub = el.querySelector('.page-head .sub');
    if (sub) sub.textContent = `${fresh.length} strateg${fresh.length === 1 ? 'y' : 'ies'}${cur.status === 'archived' ? ' · archived' : ''}`;
    setMapAmbient(el, cur.map);
  }

  el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
    if (b.dataset.v) cur[b.dataset.f] = b.dataset.v;
    else delete cur[b.dataset.f];
    applyFilters();
  });

  const addMap = el.querySelector('#add-map');
  if (addMap) addMap.onclick = async () => {
    const name = await inputDialog({
      title: 'Add map',
      label: 'Map name',
      placeholder: 'e.g. Overpass',
      confirmText: 'Add map',
    });
    if (!name) return;
    try {
      await api.post('/api/maps', { name });
      toast('Map added', 'ok');
      viewStrategies(el);
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ---------- strategy detail ----------
export async function viewStrategyDetail(el, id) {
  el.innerHTML = spinner();
  const s = await api.get(`/api/strategies/${id}`);
  trackView('strategy', s.id);

  // Personal ownership: only the creator edits. Team members who see this
  // via Team Strats can read and favorite it. "Add to Team Strats" shares
  // the strategy into the current team's bank (creator + edit rights only).
  const mine = s.created_by === state.me.user.id;
  const inTeam = !!state.teamId && (s.shared_team_ids || []).includes(state.teamId);
  const canShare = mine && !!state.teamId && can('strategies') && !inTeam;
  const canUnshare = inTeam && (mine || can('team'));

  el.innerHTML = `
    <div class="strat-wrap">
    <div class="detail-head">
      <div class="page-head">
        <div>
          <h1>${esc(s.name)} ${statusBadge(s.status)}</h1>
          <div class="detail-meta">
            ${sideTag(s.side)} ${badge(s.map)} ${s.buy_type ? badge(buyLabel(s.buy_type)) : ''}
            ${inTeam ? badge('In Team Strats', 'ok') : ''}
          </div>
        </div>
        <div class="head-actions">
          <button class="btn" id="btn-fav" title="Favorite">${s.favorite ? ICONS.starFill : ICONS.star} ${s.favorite ? 'Favorited' : 'Favorite'}</button>
          ${canShare ? `<button class="btn primary" id="btn-share">Add to Team Strats</button>` : ''}
          ${canUnshare ? `<button class="btn" id="btn-unshare">Remove from Team Strats</button>` : ''}
          ${mine ? `
            <a class="btn" href="#/strategies/${s.id}/edit">Edit</a>
            <button class="btn" id="btn-dup">Duplicate</button>
            ${s.status !== 'archived'
              ? `<button class="btn danger" id="btn-arch">Archive</button>`
              : `<button class="btn" id="btn-restore">Restore</button><button class="btn danger" id="btn-del">Delete forever</button>`}
          ` : ''}
        </div>
      </div>
      <div class="small muted">Created by ${esc(s.created_by_name || 'unknown')} · updated ${esc(fmtRel(s.updated_at))} ${(s.tags || []).length ? '· ' + tagsHtml(s.tags) : ''}</div>
    </div>
    ${strategyDetailHtml(s)}
    </div>`;

  setMapAmbient(el, s.map, true);

  el.querySelector('#btn-fav').onclick = async (e) => {
    if (s.favorite) { await api.del(`/api/strategies/${s.id}/favorite`); } else { await api.post(`/api/strategies/${s.id}/favorite`); }
    viewStrategyDetail(el, id);
  };
  el.querySelector('#btn-share') && (el.querySelector('#btn-share').onclick = async () => {
    try {
      await api.post(`/api/strategies/${s.id}/share`, { team_id: state.teamId });
      toast('Added to Team Strats', 'ok');
      viewStrategyDetail(el, id);
    } catch (e) { toast(e.message, 'err'); }
  });
  el.querySelector('#btn-unshare') && (el.querySelector('#btn-unshare').onclick = async () => {
    if (!await confirmDialog({ title: 'Remove from Team Strats?', message: `"${s.name}" leaves the team bank. The strategy itself stays with its creator.`, confirmText: 'Remove', danger: true })) return;
    try {
      await api.del(`/api/strategies/${s.id}/share/${state.teamId}`);
      toast('Removed from Team Strats', 'ok');
      viewStrategyDetail(el, id);
    } catch (e) { toast(e.message, 'err'); }
  });
  el.querySelector('#btn-dup') && (el.querySelector('#btn-dup').onclick = async () => {
    const copy = await api.post(`/api/strategies/${s.id}/duplicate`);
    toast('Duplicated as draft', 'ok');
    nav(`/strategies/${copy.id}/edit`);
  });
  el.querySelector('#btn-arch') && (el.querySelector('#btn-arch').onclick = async () => {
    if (!await confirmDialog({ title: 'Archive strategy?', message: `"${s.name}" will move to the archive. You can restore it later.`, confirmText: 'Archive', danger: true })) return;
    await api.put(`/api/strategies/${s.id}`, { status: 'archived' });
    toast('Archived', 'ok');
    viewStrategyDetail(el, id);
  });
  el.querySelector('#btn-restore') && (el.querySelector('#btn-restore').onclick = async () => {
    await api.put(`/api/strategies/${s.id}`, { status: 'active' });
    toast('Restored', 'ok');
    viewStrategyDetail(el, id);
  });
  el.querySelector('#btn-del') && (el.querySelector('#btn-del').onclick = async () => {
    if (!await confirmDialog({ title: 'Delete forever?', message: `"${s.name}" will be permanently deleted. This cannot be undone.`, confirmText: 'Delete forever', danger: true })) return;
    await api.del(`/api/strategies/${s.id}`);
    toast('Deleted', 'ok');
    nav('/strategies');
  });
}

// ---------- strategy editor ----------
export async function viewStrategyEdit(el, id) {
  // creating is open to everyone (new strategies are always personal);
  // editing an existing one is creator-only
  el.innerHTML = spinner();
  const maps = await api.get('/api/maps');
  let s = id ? await api.get(`/api/strategies/${id}`) : {
    name: '', map: query().map || 'Mirage', side: query().side || 'T', buy_type: 'full',
    required_utility: '', objective: '', summary: '', steps: [],
    warnings: [], attachments: [], status: 'draft',
  };
  if (id && s.created_by !== state.me.user.id) {
    el.innerHTML = emptyState('Not allowed', 'Only the creator can edit this strategy.');
    return;
  }

  const attRow = (a = {}) => `
    <div class="rolerow-wide" data-att-row style="margin-bottom:8px">
      <select data-af="type"><option value="image" ${a.type === 'image' ? 'selected' : ''}>Image</option><option value="video" ${a.type === 'video' ? 'selected' : ''}>Video link</option><option value="diagram" ${a.type === 'diagram' ? 'selected' : ''}>Diagram</option></select>
      <input data-af="url" placeholder="https://…" value="${esc(a.url || '')}">
      <div class="row-item"><input data-af="label" placeholder="Label" value="${esc(a.label || '')}"><button class="btn ghost small" data-del-att type="button">✕</button></div>
    </div>`;

  el.innerHTML = `
    <div class="page-head">
      <div><h1>${id ? 'Edit strategy' : 'New strategy'}</h1><div class="sub">${id ? esc(s.name) : 'Name it, tag it, write the call.'}</div></div>
      <div class="head-actions">${id ? `<a class="btn" href="#/strategies/${id}">View</a>` : ''}</div>
    </div>
    <form id="strat-form" class="panel" style="padding:20px">
      <div class="form-grid">
        <div class="field" style="grid-column:1/-1"><label>Name *</label><input name="name" required value="${esc(s.name)}" placeholder="e.g. A Split"></div>
        <div class="field"><label>Map</label><select name="map">${maps.map(m => opt(m.name, m.name, s.map)).join('')}</select></div>
        <div class="field"><label>Side</label><select name="side">${opt('T', 'T side', s.side)}${opt('CT', 'CT side', s.side)}</select></div>
        <div class="field"><label>Buy</label><select name="buy_type">${BUYS.map(([v, l]) => opt(v, l, s.buy_type || 'full')).join('')}</select></div>
        <div class="field"><label>Status</label><select name="status">${opt('active', 'Active', s.status)}${opt('draft', 'Draft', s.status)}${s.status === 'archived' ? opt('archived', 'Archived', s.status) : ''}</select></div>
      </div>
      <div class="field"><label>CALL — the short summary the IGL reads mid-round</label><textarea name="summary" rows="3">${esc(s.summary || '')}</textarea></div>
      <div class="field"><label>Warnings (one per line)</label><textarea name="warnings" rows="3">${esc(arrToLines(s.warnings))}</textarea></div>
      <div class="field"><label>Primary objective</label><textarea name="objective" rows="2">${esc(s.objective || '')}</textarea></div>
      <div class="field"><label>Required utility</label><textarea name="required_utility" rows="2">${esc(s.required_utility || '')}</textarea></div>
      <div class="field"><label>Step by step — optional (one step per line)</label><textarea name="steps" rows="6">${esc(arrToLines(s.steps))}</textarea></div>
      <details class="editor-section" ${(s.attachments || []).length ? 'open' : ''}>
        <summary>Attachments</summary>
        <div class="es-body">
          <div id="att-list">${(s.attachments || []).map(a => attRow(a)).join('')}</div>
          <button class="btn small" type="button" id="add-att">+ Add attachment</button>
        </div>
      </details>
      <div class="savebar">
        <button class="btn primary" type="submit">${id ? 'Save changes' : 'Create strategy'}</button>
        <span class="save-status" id="save-status">${id ? 'Autosave is on — changes save a moment after you stop typing.' : ''}</span>
      </div>
    </form>`;

  const attList = el.querySelector('#att-list');
  el.querySelector('#add-att').onclick = () => {
    attList.insertAdjacentHTML('beforeend', attRow({}));
    wireRemove();
  };
  function wireRemove() {
    el.querySelectorAll('[data-del-att]').forEach(b => b.onclick = () => { b.closest('[data-att-row]').remove(); scheduleAutosave(); });
  }
  wireRemove();

  function collect() {
    const f = new FormData(el.querySelector('#strat-form'));
    const attachments = [...el.querySelectorAll('[data-att-row]')].map(row => {
      const g = (k) => row.querySelector(`[data-af="${k}"]`).value.trim();
      return { type: row.querySelector('[data-af="type"]').value, url: g('url'), label: g('label') };
    }).filter(a => a.url);
    return {
      name: f.get('name').trim(), map: f.get('map'), side: f.get('side'),
      buy_type: f.get('buy_type'), status: f.get('status'),
      summary: f.get('summary').trim() || null,
      warnings: linesToArr(f.get('warnings')),
      objective: f.get('objective').trim() || null,
      required_utility: f.get('required_utility').trim() || null,
      steps: linesToArr(f.get('steps')),
      attachments,
    };
  }

  const status = el.querySelector('#save-status');
  async function save(navigateAfter) {
    const body = collect();
    if (!body.name) { toast('Strategy needs a name', 'err'); return; }
    status.textContent = 'Saving…';
    status.classList.remove('saved');
    try {
      if (id) {
        s = await api.put(`/api/strategies/${id}`, body);
      } else {
        s = await api.post('/api/strategies', body);
        id = s.id;
        history.replaceState(null, '', `#/strategies/${id}/edit`);
        localStorage.setItem('mr.route', `#/strategies/${id}/edit`);
      }
      status.textContent = `Saved · ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
      status.classList.add('saved');
      if (navigateAfter) nav(`/strategies/${id}`);
    } catch (e2) {
      status.textContent = '';
      toast(e2.message, 'err');
    }
  }

  const scheduleAutosave = debounce(() => { if (id) save(false); }, 1200);
  el.querySelector('#strat-form').addEventListener('input', scheduleAutosave);
  el.querySelector('#strat-form').onsubmit = (e) => { e.preventDefault(); save(true); };
}

// ---------- opponents ----------
export async function viewOpponentDetail(el, id) {
  if (!state.teamId) { el.innerHTML = emptyState("You're not on a team", 'Create or join a team from Team & access to scout opponents.'); return; }
  el.innerHTML = spinner();
  const o = await api.get(`/api/opponents/${id}`);
  trackView('opponent', o.id);
  const editable = can('scouting');
  const ro = editable ? '' : 'readonly';

  // recent-form + per-map win rates pulled from FACEIT (auto-refreshed daily)
  const intelHtml = (it) => !it ? '' : `
    <div class="panel" style="margin-bottom:16px">
      <h2>FACEIT intel <span class="h-count">· last ${(it.recent || []).length ? Math.min(8, it.recent.length) : 0} matches · updated ${esc(fmtRel(it.at) || 'now')}</span></h2>
      <div class="fi-top">
        ${(it.recent || []).length ? `<span class="fi-form">${it.recent.slice(0, 8).map(w => `<span class="fi-dot ${w ? 'w' : 'l'}" title="${w ? 'Win' : 'Loss'}"></span>`).join('')}</span>` : ''}
        ${it.matches != null ? `<span class="small muted">${it.matches} lifetime matches</span>` : ''}
        ${it.win_rate != null ? `<span class="small muted">· ${it.win_rate}% win rate</span>` : ''}
      </div>
      ${(it.maps || []).length ? `<div class="fi-maps">${it.maps.slice(0, 7).map(mr => `
        <div class="fi-map">
          <span class="fi-name">${mapDot(mr.map)}${esc(mr.map)}</span>
          <span class="fi-bar"><span style="width:${Math.min(100, mr.win_rate || 0)}%"></span></span>
          <span class="fi-n">${mr.win_rate != null ? `${mr.win_rate}% W` : '—'} · ${mr.matches} played</span>
        </div>`).join('')}</div>` : ''}
    </div>`;

  const fieldInput = (label, key, ph = '') => `
    <div class="field"><label>${esc(label)}</label>
    <input data-opp-field="${key}" ${ro} value="${esc(o[key] || '')}" placeholder="${esc(ph)}"></div>`;
  const fieldArea = (label, key, rows, ph = '') => `
    <div class="field"><label>${esc(label)}</label>
    <textarea data-opp-field="${key}" rows="${rows}" ${ro} placeholder="${esc(ph)}">${esc(o[key] || '')}</textarea></div>`;

  el.innerHTML = `
    <div class="page-head center" style="margin-bottom:16px">
      <div>
        <div class="team-logo" style="width:62px;height:62px;font-size:1.15rem">${esc(initials(o.name))}</div>
        <h1>${esc(o.name)}</h1>
        <div class="sub">Opponent scouting report${editable ? ' · autosaves as you type' : ''}</div>
        <div class="head-actions" style="justify-content:center;margin-top:10px;align-items:center">
          <span class="save-status" id="opp-save"></span>
          ${editable ? `<button class="btn ghost small danger" id="del-opp">Delete opponent</button>` : ''}
        </div>
      </div>
    </div>

    <div class="opp-profile">
      <div class="form-grid">
        ${fieldInput('Team name', 'name')}
        ${fieldInput('Map pool', 'map_pool', 'Mirage, Inferno, …')}
        ${fieldInput('Preferred picks', 'preferred_picks')}
        ${fieldInput('Preferred bans', 'preferred_bans')}
      </div>
      ${fieldArea('General playstyle', 'playstyle', 2, 'How do they play? Pace, aggression, utility discipline…')}
      <div class="form-2col">
        ${fieldArea('Economy tendencies', 'econ_notes', 3, 'Force-buy habits, save patterns…')}
        ${fieldArea('Notes from previous matches', 'notes', 3, 'What worked, what to expect next time…')}
      </div>
    </div>

    <div id="intel-wrap">${intelHtml(o.faceit_intel)}</div>

    <div class="opp-cols">
      <div>
        <div class="sec-head"><h2>Tendencies <span class="h-count">· ${o.tendencies.length}</span></h2></div>
        <div id="tendency-list">
          ${o.tendencies.length ? o.tendencies.map(td => tendencyHtml(td, { removable: editable })).join('')
            : emptyState('No tendencies recorded', editable ? 'Add reads from scrims and demos below.' : '')}
        </div>
        ${editable ? `
          <details class="add-drawer">
            <summary class="btn small">+ Add tendency</summary>
            <form id="add-tendency" class="panel" style="margin-top:10px">
              <div class="field"><label>Tendency *</label><textarea name="text" rows="2" required placeholder='e.g. "On Mirage CT side, their connector player pushes underpass after losing mid control."'></textarea></div>
              <div class="form-grid">
                <div class="field"><label>Player</label><select name="opponent_player_id"><option value="">Team-wide</option>${o.players.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
                <div class="field"><label>Map</label><input name="map" placeholder="Any"></div>
                <div class="field"><label>Side</label><select name="side"><option value="">Any</option><option>T</option><option>CT</option></select></div>
                <div class="field"><label>Site / area</label><input name="site" placeholder="Any"></div>
                <div class="field"><label>Round type</label><select name="round_type"><option value="">Any</option><option>pistol</option><option>eco</option><option>semi</option><option>full</option></select></div>
                <div class="field"><label>Severity</label><select name="severity"><option value="normal">Normal</option><option value="high">Key read (alert)</option></select></div>
              </div>
              <button class="btn primary small" type="submit">Add tendency</button>
            </form>
          </details>` : ''}
      </div>
      <div>
        <div class="sec-head"><h2>Player profiles <span class="h-count">· ${o.players.length}</span></h2></div>
        <div class="list-card">
          ${o.players.map(p => {
            let fs = null; try { fs = JSON.parse(p.faceit_stats || 'null'); } catch { /* optional */ }
            return `
            <details class="pl-item">
              <summary>
                <span class="avatar">${esc(initials(p.name))}</span>
                <span class="grow">
                  <span class="r-name">${esc(p.name)}</span>
                  <div class="r-sub">${esc(p.role || 'Unknown role')}${p.aggression ? ` · ${esc(p.aggression)}` : ''}</div>
                </span>
                ${fs && fs.level ? `<span class="fc-side">${faceitBadge(fs.level)}${fs.elo ? `<b>${fs.elo}</b>` : ''}</span>` : ''}
                <svg class="pl-chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>
              </summary>
              <div class="pl-body">
                ${playerStatsHtml(p)}
                ${p.positions ? `<div class="rc-duty"><b>Positions:</b> ${esc(p.positions)}</div>` : ''}
                ${p.weapons ? `<div class="rc-duty"><b>Weapons:</b> ${esc(p.weapons)}</div>` : ''}
                ${p.habits ? `<div class="rc-duty"><b>Habits:</b> ${esc(p.habits)}</div>` : ''}
                ${p.weaknesses ? `<div class="rc-duty" style="color:var(--ok)"><b>Weaknesses:</b> ${esc(p.weaknesses)}</div>` : ''}
                ${p.notes ? `<div class="rc-util">${esc(p.notes)}</div>` : ''}
                ${editable ? `<button class="btn ghost small danger" data-del-player="${p.id}" style="margin-top:8px">Remove player</button>` : ''}
              </div>
            </details>`;
          }).join('') || emptyState('No player profiles yet', editable ? 'Add their lineup below.' : '')}
        </div>
        ${editable ? `
          <details class="add-drawer">
            <summary class="btn small">+ Add player</summary>
            <form id="add-player" class="panel" style="margin-top:10px">
              <div class="form-grid">
                <div class="field"><label>Steam name *</label><input name="name" required></div>
                <div class="field"><label>Role</label><input name="role" placeholder="AWP, Entry, IGL…"></div>
                <div class="field"><label>Aggression</label><select name="aggression"><option value="">—</option><option>passive</option><option>balanced</option><option>aggressive</option></select></div>
              </div>
              <div class="field"><label>Common positions</label><input name="positions"></div>
              <div class="field"><label>Preferred weapons</label><input name="weapons"></div>
              <div class="field"><label>Habits (utility, rotations, pistols, clutches)</label><textarea name="habits" rows="2"></textarea></div>
              <div class="field"><label>Known weaknesses</label><textarea name="weaknesses" rows="2"></textarea></div>
              <div class="field"><label>Matchup notes</label><textarea name="notes" rows="2"></textarea></div>
              <button class="btn primary small" type="submit">Add player</button>
            </form>
          </details>` : ''}
      </div>
    </div>`;

  if (!editable) return;

  // auto-populate FACEIT intel when linked and stale (>24h); silent if unavailable
  const it = o.faceit_intel;
  const stale = !it || !it.at || (Date.now() - new Date(it.at).getTime() > 24 * 3600000);
  if (o.faceit_team_id && stale) {
    api.post(`/api/opponents/${o.id}/faceit-intel`)
      .then(fresh => { el.querySelector('#intel-wrap').innerHTML = intelHtml(fresh.faceit_intel); })
      .catch(() => { /* not linked / no data — leave the page as-is */ });
  }

  const saveStatus = el.querySelector('#opp-save');
  const saveProfile = debounce(async () => {
    const body = {};
    el.querySelectorAll('[data-opp-field]').forEach(i => body[i.dataset.oppField] = i.value.trim() || null);
    if (!body.name) return;
    saveStatus.textContent = 'Saving…';
    saveStatus.classList.remove('saved');
    try {
      await api.put(`/api/opponents/${id}`, body);
      saveStatus.textContent = 'Saved';
      saveStatus.classList.add('saved');
    } catch (e) { saveStatus.textContent = ''; toast(e.message, 'err'); }
  }, 900);
  el.querySelectorAll('[data-opp-field]').forEach(i => i.addEventListener('input', saveProfile));

  el.querySelector('#del-opp').onclick = async () => {
    if (!await confirmDialog({ title: 'Delete opponent?', message: `All scouting for "${o.name}" — players and tendencies — will be permanently deleted.`, confirmText: 'Delete', danger: true })) return;
    await api.del(`/api/opponents/${id}`);
    nav('/opponents');
  };

  el.querySelector('#add-tendency')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api.post(`/api/opponents/${id}/tendencies`, {
        text: f.get('text'), opponent_player_id: f.get('opponent_player_id') || null,
        map: f.get('map') || null, side: f.get('side') || null, site: f.get('site') || null,
        round_type: f.get('round_type') || null, severity: f.get('severity'),
      });
      viewOpponentDetail(el, id);
    } catch (err) { toast(err.message, 'err'); }
  });

  el.querySelector('#add-player')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api.post(`/api/opponents/${id}/players`, Object.fromEntries(['name', 'role', 'aggression', 'positions', 'weapons', 'habits', 'weaknesses', 'notes'].map(k => [k, f.get(k) || null])));
      viewOpponentDetail(el, id);
    } catch (err) { toast(err.message, 'err'); }
  });

  el.querySelectorAll('[data-del-tendency]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog({ title: 'Remove tendency?', message: 'This note will be deleted.', confirmText: 'Remove', danger: true })) return;
    await api.del(`/api/tendencies/${b.dataset.delTendency}`);
    viewOpponentDetail(el, id);
  });
  el.querySelectorAll('[data-del-player]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog({ title: 'Remove player profile?', message: 'The player profile and their attached tendencies will be deleted.', confirmText: 'Remove', danger: true })) return;
    await api.del(`/api/opponent-players/${b.dataset.delPlayer}`);
    viewOpponentDetail(el, id);
  });
}

// ---------- matches ----------
export async function viewMatches(el) {
  if (!state.teamId) {
    // same page shell, team modules empty
    el.innerHTML = `
      <div class="mo-page">
      <div class="page-head center">
        <div>
          <h1>Matches</h1>
          <div class="sub">You're not on a team</div>
        </div>
      </div>
      <div class="mo-cols">
        <div>
          <div class="sec">
            <div class="sec-head"><h2>Upcoming</h2></div>
            ${emptyState("You're not on a team", 'Create or join a team from Team & access to use team match prep.')}
          </div>
        </div>
        <div>
          <div class="sec">
            <div class="sec-head"><h2>Opponents</h2></div>
            ${emptyState("You're not on a team", 'Opponent scouting lives with your team.')}
          </div>
        </div>
      </div>
      </div>`;
    return;
  }
  el.innerHTML = spinner();
  const [matches, opps] = await Promise.all([api.get(teamUrl('/matches')), api.get(teamUrl('/opponents'))]);
  const upcoming = matches.filter(m => m.status === 'upcoming')
    .sort((a, b) => (a.scheduled_at || '9999').localeCompare(b.scheduled_at || '9999'));
  const past = matches.filter(m => m.status !== 'upcoming')
    .sort((a, b) => (b.scheduled_at || '').localeCompare(a.scheduled_at || ''));

  // most recently played first; never-played opponents follow, alphabetically
  const lastPlayed = {};
  for (const m of matches) {
    const oid = (m.opponent && m.opponent.id) || m.opponent_id;
    if (!oid || !m.scheduled_at || m.status === 'upcoming') continue;
    if (!lastPlayed[oid] || m.scheduled_at > lastPlayed[oid]) lastPlayed[oid] = m.scheduled_at;
  }
  const sortedOpps = opps.slice().sort((a, b) =>
    (lastPlayed[b.id] || '').localeCompare(lastPlayed[a.id] || '') || a.name.localeCompare(b.name));

  const row = (m, isNext = false) => {
    let fr = null;
    try { fr = m.faceit_result ? JSON.parse(m.faceit_result) : null; } catch { /* ignore */ }
    return `
    <a class="list-row match-row ${isNext ? 'next' : ''}" href="#/matches/${m.id}">
      <span class="cal-date-chip">${m.scheduled_at ? esc(new Date(m.scheduled_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) : 'TBD'}</span>
      <span class="avatar">${esc(initials(m.opponent ? m.opponent.name : '?'))}</span>
      <span class="grow">
        <span class="r-name">${isNext ? '<span class="live-dot"></span>' : ''}vs ${esc(m.opponent ? m.opponent.name : 'TBD')}</span>
        <div class="r-sub">${esc(m.event || 'No event set')}</div>
      </span>
      <span class="mr-maps">${(m.expected_maps || []).map(x => `<span title="${esc(x)}">${mapDot(x)}</span>`).join('')}</span>
      ${fr ? badge(`${fr.result === 'win' ? 'W' : fr.result === 'loss' ? 'L' : 'T'} ${fr.score}`, fr.result === 'win' ? 'ok' : fr.result === 'loss' ? 'warn' : 'neutral') : ''}
      ${m.faceit_match_id ? badge('FACEIT', 'neutral') : ''}
      ${badge(m.format)}
      <span class="r-side">${m.scheduled_at
        ? esc(new Date(m.scheduled_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })) +
          (m.status === 'upcoming' ? `<span class="mr-until"> · ${esc(untilText(m.scheduled_at))}</span>` : '')
        : ''}</span>
    </a>`;
  };

  el.innerHTML = `
    <div class="mo-page">
    <div class="page-head center">
      <div>
        <h1>Matches</h1>
        <div class="sub">${matches.length} match${matches.length === 1 ? '' : 'es'} · ${opps.length} opponent${opps.length === 1 ? '' : 's'} scouted</div>
        <div class="head-actions" style="justify-content:center;margin-top:12px">
          ${can('matches') ? `<button class="btn primary" id="add-match">+ New match</button>` : ''}
          ${can('scouting') ? `<button class="btn" id="add-opp">+ New opponent</button>` : ''}
        </div>
      </div>
    </div>
    <div class="mo-cols">
      <div>
        ${matches.length ? `
          ${upcoming.length ? `
            <div class="sec">
              <div class="sec-head"><h2>Upcoming <span class="h-count">· ${upcoming.length}</span></h2></div>
              <div class="match-list">${upcoming.map((m, i) => row(m, i === 0)).join('')}</div>
            </div>` : ''}
          ${past.length ? `
            <div class="sec">
              <div class="sec-head"><h2>Played <span class="h-count">· ${past.length}</span></h2></div>
              <div class="match-list">${past.map(m => row(m)).join('')}</div>
            </div>` : ''}
        ` : emptyState('No matches yet', can('matches') ? 'Create your first match to plan the veto and pin calls.' : '')}
      </div>
      <div>
        <div class="sec">
          <div class="sec-head"><h2>Opponents <span class="h-count">· ${opps.length}</span></h2></div>
          ${opps.length ? `
            <div class="match-list">
              ${sortedOpps.map(o => `
                <a class="list-row opp-row" href="#/opponents/${o.id}">
                  <span class="team-logo or-logo">${esc(initials(o.name))}</span>
                  <span class="grow">
                    <span class="r-name">${esc(o.name)}</span>
                    <div class="r-sub">${lastPlayed[o.id] ? `played ${esc(fmtRel(lastPlayed[o.id]))} · ` : ''}${o.player_count} player${o.player_count === 1 ? '' : 's'} · ${o.tendency_count} tendenc${o.tendency_count === 1 ? 'y' : 'ies'}</div>
                  </span>
                  ${o.key_count ? badge(`${o.key_count} key`, 'warn') : ''}
                </a>`).join('')}
            </div>` : emptyState('No opponents yet', can('scouting') ? 'Add your next opponent to start scouting.' : '')}
        </div>
      </div>
    </div>
    </div>`;
  const addOpp = el.querySelector('#add-opp');
  if (addOpp) addOpp.onclick = async () => {
    const name = await inputDialog({
      title: 'New opponent',
      label: 'Team name',
      placeholder: 'e.g. Ironclad Syndicate',
      confirmText: 'Create opponent',
    });
    if (!name) return;
    try {
      const o = await api.post(teamUrl('/opponents'), { name });
      nav(`/opponents/${o.id}`);
    } catch (e) { toast(e.message, 'err'); }
  };
  const btn = el.querySelector('#add-match');
  if (btn) btn.onclick = async () => {
    const name = await inputDialog({
      title: 'New match',
      label: 'Opponent team',
      placeholder: 'Type a team name — existing or new',
      confirmText: 'Create match',
      options: opps.map(o => o.name),
      hint: 'Unknown teams are added to Opponents automatically.',
    });
    if (!name) return;
    try {
      const existing = opps.find(o => o.name.toLowerCase() === name.toLowerCase());
      let opponentId = existing ? existing.id : null;
      if (!opponentId) {
        const o = await api.post(teamUrl('/opponents'), { name });
        opponentId = o.id;
        toast(`"${name}" added to Opponents`, 'ok');
      }
      const m = await api.post(teamUrl('/matches'), { opponent_id: opponentId, format: 'BO3' });
      nav(`/matches/${m.id}`);
    } catch (e) { toast(e.message, 'err'); }
  };
}

export async function viewMatchDetail(el, id) {
  if (!state.teamId) { el.innerHTML = emptyState("You're not on a team", 'Create or join a team from Team & access to use team match prep.'); return; }
  el.innerHTML = spinner();
  const [m, opps, allStrats, members, slots] = await Promise.all([
    api.get(`/api/matches/${id}`),
    api.get(teamUrl('/opponents')),
    api.get(teamUrl('/strategies')),
    api.get(teamUrl('/members')),
    api.get(teamUrl('/players')).catch(() => []),
  ]);
  trackView('match', m.id);
  const editable = can('matches');
  const pinnedIds = new Set(m.pins.map(p => p.id));

  const fr = m.faceit_result;
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
  const resultStrip = fr ? `
    <div class="result-strip ${fr.result}">
      <span class="rs-letter">${fr.result === 'win' ? 'W' : fr.result === 'loss' ? 'L' : 'T'}</span>
      <span class="rs-score">${esc(fr.score)}</span>
      <span class="chips">${fr.maps.map(mp => badge(`${esc(cap(mp.map))} ${mp.us}–${mp.them}`, mp.win ? 'ok' : 'warn')).join(' ')}</span>
    </div>` : '';

  const myTeam = state.me.teams.find(t => t.id === state.teamId);
  const statsOf = (p) => { try { return JSON.parse(p.faceit_stats || 'null') || {}; } catch { return {}; } };
  const eloOf = (p) => statsOf(p).elo || 0;
  const low = (s) => String(s || '').toLowerCase();
  const slotFor = (e) => slots.find(s =>
    (e.uid && s.user_id === e.uid) || low(s.name) === low(e.name) || low(s.faceit_nickname) === low(e.name)) || null;
  const ourNames = (m.roster_users.length
    ? m.roster_users.map(u => ({ name: u.name, uid: u.id, sub: u.game_role || '', fp: faceitFor(u.name, m.team_faceit_roster) }))
    : (m.team_faceit_roster || []).map(p => ({ name: p.nickname, sub: '', fp: p })))
    .sort((a, b) => ((b.fp && b.fp.elo) || 0) - ((a.fp && a.fp.elo) || 0));
  const theirPlayers = (m.opponent_players || []).slice().sort((a, b) => eloOf(b) - eloOf(a));
  const luAvatar = (name) => `<span class="avatar lu-avatar">${esc(initials(name))}</span>`;
  const lineupsPanel = (ourNames.length || theirPlayers.length) ? `
    <div class="opp-profile" style="padding:20px 24px 14px;margin-bottom:20px">
      <div class="lineup-cols">
        <div>
          <div class="lu-head">${esc(myTeam ? myTeam.name : 'Our team')}</div>
          ${ourNames.map(p => {
            const sl = slotFor(p);
            const inner = `<span>${luAvatar(p.name)}${esc(p.name)}</span><span class="lu-right">${fcInline(p.fp)}${p.sub ? `<span class="muted small">${esc(p.sub)}</span>` : ''}</span>`;
            return sl ? `<a class="lu-row" href="#/players/${sl.id}">${inner}</a>` : `<div class="lu-row">${inner}</div>`;
          }).join('') || '<div class="small muted">No roster yet — invite teammates or connect FACEIT.</div>'}
        </div>
        <div>
          <div class="lu-head">${esc(m.opponent ? m.opponent.name : 'Opponent')}</div>
          ${theirPlayers.map(p => { const st = statsOf(p); return `<div class="lu-row"><span>${luAvatar(p.name)}${esc(p.name)}</span><span class="lu-right">${fcInline(st) || (st.elo ? `<span class="muted small">${st.elo} ELO</span>` : '')}</span></div>`; }).join('') || '<div class="small muted">No players scouted yet.</div>'}
          ${m.opponent ? `<a class="small" style="color:var(--blue);display:inline-block;margin-top:8px" href="#/opponents/${m.opponent.id}">Full scouting →</a>` : ''}
        </div>
      </div>
    </div>` : '';

  const sbTable = (rows, label) => `
    <div>
      <div class="lu-head">${esc(label)}</div>
      <table class="sb-table">
        <thead><tr><th>Player</th><th>K</th><th>D</th><th>A</th><th>K/D</th><th>ADR</th><th>HS%</th></tr></thead>
        <tbody>${rows.map(p => `<tr><td>${esc(p.nickname)}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.assists}</td><td>${p.kd}</td><td>${p.adr}</td><td>${p.hs}</td></tr>`).join('')}</tbody>
      </table>
    </div>`;
  const scoreboard = fr && (fr.ours.length || fr.theirs.length) ? `
    <div class="panel" style="margin-top:16px">
      <h2>Scoreboard</h2>
      <div class="lineup-cols sb-cols">
        ${sbTable(fr.ours, myTeam ? myTeam.name : 'Our team')}
        ${sbTable(fr.theirs, m.opponent ? m.opponent.name : 'Opponent')}
      </div>
    </div>` : '';

  const eligibleMembers = members.members.filter(mm => ['igl', 'player'].includes(mm.role) || mm.game_role);
  const setupPanel = `
      <div class="panel">
        <h2>Match setup</h2>
        <div class="form-grid">
          <div class="field"><label>Opponent</label>
            <select data-mf="opponent_id" ${editable ? '' : 'disabled'}>
              <option value="">TBD</option>
              ${opps.map(o => `<option value="${o.id}" ${m.opponent_id === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
            </select></div>
          <div class="field"><label>Date & time</label><input type="datetime-local" data-mf="scheduled_at" ${editable ? '' : 'readonly'} value="${m.scheduled_at ? esc(toLocalInput(m.scheduled_at)) : ''}"></div>
          <div class="field"><label>League / tournament</label><input data-mf="event" ${editable ? '' : 'readonly'} value="${esc(m.event || '')}"></div>
          <div class="field"><label>Format</label><select data-mf="format" ${editable ? '' : 'disabled'}>${['BO1', 'BO3', 'BO5'].map(f => opt(f, f, m.format)).join('')}</select></div>
          <div class="field"><label>Starting side</label><select data-mf="starting_side" ${editable ? '' : 'disabled'}><option value="">Unknown</option>${opt('T', 'T side', m.starting_side)}${opt('CT', 'CT side', m.starting_side)}</select></div>
          <div class="field"><label>Expected maps (comma-separated)</label><input data-mf="expected_maps" ${editable ? '' : 'readonly'} value="${esc((m.expected_maps || []).join(', '))}"></div>
        </div>
        <div class="field"><label>Map veto notes</label><textarea data-mf="veto_notes" ${editable ? '' : 'readonly'}>${esc(m.veto_notes || '')}</textarea></div>
        ${eligibleMembers.length ? `
        <h2 style="margin-top:14px">Active roster</h2>
        <div class="rowlist">
          ${eligibleMembers.map(mm => `
            <label class="row-item" style="cursor:pointer;font-weight:400">
              <input type="checkbox" data-roster="${mm.id}" ${m.roster.includes(mm.id) ? 'checked' : ''} ${editable ? '' : 'disabled'} style="width:16px;height:16px;accent-color:var(--accent)">
              <span class="grow">${esc(mm.name)}</span><span class="small muted">${esc(mm.game_role || roleLabel(mm.role))}</span>
            </label>`).join('')}
        </div>` : ''}
      </div>`;

  const pinsPanel = `
        <div class="panel" style="margin-bottom:14px">
          <h2>Pinned strategies (${m.pins.length})</h2>
          <div class="rowlist">
            ${m.pins.map(p => `
              <div class="row-item">
                <a class="grow" href="#/strategies/${p.id}"><b>${esc(p.name)}</b> <span class="small muted">${esc(p.map)}</span></a>
                ${sideBadge(p.side)}
                ${editable ? `<button class="btn ghost small" data-unpin="${p.id}">Unpin</button>` : ''}
              </div>`).join('') || emptyState('Nothing pinned yet', 'Pinned calls are the first thing the IGL sees in Match Mode.')}
          </div>
          ${editable ? `
            <form id="add-pin" class="row-item" style="margin-top:10px">
              <select name="sid" class="grow">
                <option value="">Pin a strategy…</option>
                ${allStrats.filter(s => !pinnedIds.has(s.id) && s.status === 'active').map(s => `<option value="${s.id}">${esc(s.name)} (${esc(s.map)}, ${s.side})</option>`).join('')}
              </select>
              <button class="btn small" type="submit">${ICONS.pin} Pin</button>
            </form>` : ''}
        </div>`;

  const notesPanels = ['reminder'].map(kind => `
          <div class="panel" style="margin-bottom:14px">
            <h2>Reminders</h2>
            <div class="rowlist">
              ${m.notes.filter(n => n.kind === kind).map(n => `
                <div class="row-item"><span class="grow small">${esc(n.text)}</span>
                ${editable ? `<button class="btn ghost small" data-del-note="${n.id}">✕</button>` : ''}</div>`).join('') || `<div class="small muted">None yet.</div>`}
            </div>
            ${editable ? `
              <form data-add-note="${kind}" class="row-item" style="margin-top:10px">
                <input name="text" placeholder="Add ${kind === 'timeout' ? 'timeout note' : 'reminder'}…" class="grow">
                <button class="btn small" type="submit">Add</button>
              </form>` : ''}
          </div>`).join('');

  const isPlayed = m.status === 'completed';
  el.innerHTML = `
    <div class="page-head center" style="margin-bottom:14px">
      <div>
        <div class="kicker">${isPlayed ? 'Played' : `<span class="live-dot"></span>${esc(untilText(m.scheduled_at) || 'Upcoming')}`}${m.faceit_match_id ? ' · FACEIT' : ''}</div>
        <h1 class="mh-title">vs ${esc(m.opponent ? m.opponent.name : 'TBD')}</h1>
        <div class="sub">${esc(m.event || 'Match')} · ${esc(m.format || '')} · ${esc(fmtMatchDate(m.scheduled_at))}</div>
        <div class="head-actions" style="justify-content:center;margin-top:12px;align-items:center">
          <a class="btn ${isPlayed ? '' : 'primary'}" href="#/match-mode/${m.id}">${ICONS.play} Match Mode</a>
          ${editable ? `<span class="save-status" id="m-save"></span><button class="btn ghost small danger" id="del-match">Delete</button>` : ''}
        </div>
      </div>
    </div>
    ${isPlayed ? `
      ${resultStrip}
      ${scoreboard}
      <details class="editor-section" style="margin-top:18px">
        <summary>Match details, pins & notes</summary>
        <div class="es-body">
          <div class="grid cols-2" style="margin-top:12px">
            ${setupPanel}
            <div>${pinsPanel}${notesPanels}</div>
          </div>
        </div>
      </details>`
    : `
      ${lineupsPanel}
      <div class="grid cols-2">
        ${setupPanel}
        <div>${pinsPanel}${notesPanels}</div>
      </div>`}`;

  if (!editable) return;
  const reload = () => viewMatchDetail(el, id);
  const saveStatus = el.querySelector('#m-save');

  const saveMatch = debounce(async () => {
    const g = (k) => el.querySelector(`[data-mf="${k}"]`).value;
    saveStatus.textContent = 'Saving…';
    try {
      await api.put(`/api/matches/${id}`, {
        opponent_id: g('opponent_id') ? Number(g('opponent_id')) : null,
        scheduled_at: g('scheduled_at') ? new Date(g('scheduled_at')).toISOString() : null,
        event: g('event').trim() || null, format: g('format'), starting_side: g('starting_side') || null,
        expected_maps: g('expected_maps').split(',').map(s => s.trim()).filter(Boolean),
        veto_notes: g('veto_notes').trim() || null,
        roster: [...el.querySelectorAll('[data-roster]:checked')].map(c => Number(c.dataset.roster)),
      });
      saveStatus.textContent = 'Saved';
      saveStatus.classList.add('saved');
    } catch (e) { saveStatus.textContent = ''; toast(e.message, 'err'); }
  }, 800);
  el.querySelectorAll('[data-mf], [data-roster]').forEach(i => i.addEventListener('input', saveMatch));

  el.querySelector('#del-match').onclick = async () => {
    if (!await confirmDialog({ title: 'Delete match?', message: 'The match, its pins, notes, and checklist will be permanently deleted.', confirmText: 'Delete', danger: true })) return;
    await api.del(`/api/matches/${id}`);
    nav('/matches');
  };

  el.querySelector('#add-pin').onsubmit = async (e) => {
    e.preventDefault();
    const sid = new FormData(e.target).get('sid');
    if (!sid) return;
    await api.post(`/api/matches/${id}/pins`, { strategy_id: Number(sid) });
    reload();
  };
  el.querySelectorAll('[data-unpin]').forEach(b => b.onclick = async () => {
    await api.del(`/api/matches/${id}/pins/${b.dataset.unpin}`);
    reload();
  });
  el.querySelectorAll('[data-add-note]').forEach(f => f.onsubmit = async (e) => {
    e.preventDefault();
    const text = new FormData(f).get('text').trim();
    if (!text) return;
    await api.post(`/api/matches/${id}/notes`, { kind: f.dataset.addNote, text });
    reload();
  });
  el.querySelectorAll('[data-del-note]').forEach(b => b.onclick = async () => {
    await api.del(`/api/match-notes/${b.dataset.delNote}`);
    reload();
  });
}

// ---------- team ----------
// ---------- player lookup ----------
export async function viewPlayerLookup(el) {
  if (!state.teamId) {
    // lookups run through the team's FACEIT API key — keep the page shell,
    // disable the form
    el.innerHTML = `
      <div class="lookup-page">
      <div class="page-head center">
        <div>
          <h1>Player Lookup</h1>
          <div class="sub">Pull any player's FACEIT stats by nickname</div>
        </div>
      </div>
      <form class="lookup-bar">
        <input placeholder="FACEIT nickname…" disabled>
        <button class="btn primary" type="button" disabled>Look up</button>
      </form>
      ${emptyState("You're not on a team", 'Lookups use your team\'s FACEIT connection — create or join a team from Team & access.')}
      </div>`;
    return;
  }
  const last = localStorage.getItem('mr.lookup') || '';
  el.innerHTML = `
    <div class="lookup-page">
    <div class="page-head center">
      <div>
        <h1>Player Lookup</h1>
        <div class="sub">Pull any player's FACEIT stats by nickname</div>
      </div>
    </div>
    <form id="lookup-form" class="lookup-bar">
      <input id="lookup-input" placeholder="FACEIT nickname…" value="${esc(last)}" autocomplete="off" spellcheck="false">
      <button class="btn primary" type="submit">Look up</button>
    </form>
    <div id="lookup-result"></div>
    </div>`;

  const input = el.querySelector('#lookup-input');
  const out = el.querySelector('#lookup-result');

  // Good / OK / Bad vs overall FACEIT benchmarks: the ladder's mid (level 5)
  // averages ≈1.04 K/D and 77 ADR, pros hold 50–60%+ HS and 80–100+ ADR, and
  // elo-balanced matchmaking centers win rates on 50%.
  const RATE = {
    kd:  (v) => v >= 1.1 ? 'good' : v >= 0.9 ? 'ok' : 'bad',
    adr: (v) => v >= 80 ? 'good' : v >= 65 ? 'ok' : 'bad',
    hs:  (v) => v >= 50 ? 'good' : v >= 40 ? 'ok' : 'bad',
    win: (v) => v >= 55 ? 'good' : v >= 45 ? 'ok' : 'bad',
  };
  const rateChip = (kind, v) => {
    if (v == null) return '';
    const r = RATE[kind](v);
    return `<span class="rate-chip ${r}">${r === 'good' ? 'Good' : r === 'ok' ? 'OK' : 'Bad'}</span>`;
  };
  // bar scales: what a "full" bar means per stat (K/D 2.0, ADR 120, % are natural)
  const BAR_MAX = { kd: 2, adr: 120, hs: 100, win: 100 };
  const statTile = (kind, v, label, display) => {
    const chip = rateChip(kind, v);
    const bar = v != null
      ? `<div class="stat-bar"><span class="${RATE[kind](v)}" style="width:${Math.round(Math.min(100, Math.max(0, v / BAR_MAX[kind] * 100)))}%"></span></div>`
      : '';
    return `<div class="stat-tile"><div class="v">${display}</div><div class="l">${esc(label)}</div>${bar}${chip}</div>`;
  };

  const matchRow = (rm) => {
    const mapName = rm.map ? rm.map[0].toUpperCase() + rm.map.slice(1) : '—';
    return `
      <div class="pp-match">
        <span class="pp-res ${rm.win ? 'w' : 'l'}">${rm.win ? 'W' : 'L'}</span>
        <span class="pp-map">${mapDot(mapName)}${esc(mapName)}</span>
        <span class="pp-score">${esc(rm.score || '')}</span>
        <span class="pp-kda">${rm.k}–${rm.d}${rm.kd != null ? ` · ${rm.kd} K/D` : ''}${rm.adr != null ? ` · ${rm.adr} ADR` : ''}</span>
        <span class="small muted pp-when">${rm.at ? esc(fmtRel(rm.at)) : ''}</span>
      </div>`;
  };

  async function run(nick) {
    if (!nick) return;
    localStorage.setItem('mr.lookup', nick);
    out.innerHTML = spinner('Pulling FACEIT stats…');
    let r;
    try { r = await api.get(teamUrl('/faceit-lookup?nickname=' + encodeURIComponent(nick))); }
    catch (e) { out.innerHTML = emptyState('Lookup failed', e.message); return; }
    const fs = r.stats || {};
    let rows = fs.recent || [];
    let hasMore = rows.length >= 10;

    out.innerHTML = `
      <div class="lookup-card">
        <div class="lookup-head">
          <span class="team-logo" style="width:84px;height:84px;font-size:1.55rem">${esc(initials(r.nickname))}</span>
          <div>
            <div class="lookup-name">${esc(r.nickname)}</div>
            <div class="small muted">${r.country ? esc(String(r.country).toUpperCase()) + ' · ' : ''}FACEIT · updated just now</div>
          </div>
          <div class="pp-elo-row" style="margin-left:auto">
            ${faceitBadge(fs.level, 60)}
            <div class="pp-elo">${fs.elo ?? '—'} <span class="small muted">ELO</span></div>
          </div>
        </div>
        ${fs.games ? `
          <div class="stat-strip" style="margin-top:16px">
            ${statTile('kd', fs.kd, `K/D · last ${fs.games}`, fs.kd ?? '—')}
            ${statTile('adr', fs.adr, 'ADR', fs.adr ?? '—')}
            ${statTile('hs', fs.hs, 'Headshots', fs.hs != null ? fs.hs + '%' : '—')}
            ${statTile('win', fs.win, 'Win rate', fs.win != null ? fs.win + '%' : '—')}
          </div>` : '<p class="small muted" style="margin-top:14px">No recent match stats for this player.</p>'}
        ${rows.length ? `
          <div style="margin-top:18px">
            <div class="sec-head"><h2 id="lu-mcount"></h2></div>
            <div class="lu-matches" id="lu-matches"></div>
          </div>` : ''}
      </div>`;

    // last two visible rows blur as a preview and View More floats over them
    // (same collapse treatment as LaneLens's matchup history)
    function renderMatches() {
      const wrap = out.querySelector('#lu-matches');
      if (!wrap) return;
      wrap.innerHTML = rows.map(matchRow).join('');
      const rowEls = [...wrap.children];
      if (hasMore && rowEls.length >= 4) {
        rowEls[rowEls.length - 2].classList.add('lu-blur-soft');
        rowEls[rowEls.length - 1].classList.add('lu-blur-hard');
        const overlay = document.createElement('div');
        overlay.className = 'lu-viewmore';
        overlay.innerHTML = `<button class="btn primary" type="button">View More</button>`;
        overlay.querySelector('button').onclick = loadMore;
        wrap.appendChild(overlay);
        overlay.style.height = (rowEls[rowEls.length - 2].offsetHeight + rowEls[rowEls.length - 1].offsetHeight) + 'px';
      }
      const h2 = out.querySelector('#lu-mcount');
      if (h2) h2.innerHTML = `${hasMore ? 'Last' : 'All'} ${rows.length} matches <span class="h-count">· PUGs & league</span>`;
    }

    async function loadMore() {
      const btn = out.querySelector('.lu-viewmore button');
      if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
      try {
        const more = await api.get(teamUrl(`/faceit-matches?player_id=${encodeURIComponent(r.player_id)}&offset=${rows.length}&limit=20`));
        rows = rows.concat(more);
        hasMore = more.length === 20;
      } catch (e) { toast(e.message, 'err'); hasMore = false; }
      renderMatches();
    }

    renderMatches();
  }

  el.querySelector('#lookup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    run(input.value.trim());
  });
  if (last) run(last);
  input.focus();
}

// ---------- player profile ----------
export async function viewPlayerProfile(el, id) {
  if (!state.teamId) { el.innerHTML = emptyState("You're not on a team", 'Player profiles belong to a team roster.'); return; }
  el.innerHTML = spinner();
  let p;
  try { p = await api.get(`/api/team-players/${id}`); }
  catch (e) { el.innerHTML = emptyState('Player not found', e.message); return; }

  const statTile = (v, l) => `<div class="stat-tile"><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`;

  function render(pl) {
    p = pl;
    const fs = p.faceit_stats;
    el.innerHTML = `
      <div class="page-head center" style="margin-bottom:16px">
        <div>
          <div class="team-logo" style="width:74px;height:74px;font-size:1.3rem">${esc(initials(p.name))}</div>
          <h1>${esc(p.name)}</h1>
          <div class="sub">${esc(p.game_role || 'No role set')}${p.is_starter ? '' : ' · Substitute'}${p.user ? ` · controlled by ${esc(p.user.name)}` : ' · open seat'}</div>
        </div>
      </div>
      <div class="pp-grid">
        <div class="panel">
          <h2>FACEIT ${fs && fs.at ? `<span class="h-count">· updated ${esc(fmtRel(fs.at))}</span>` : ''}</h2>
          ${fs ? `
            <div class="pp-elo-row">
              ${faceitBadge(fs.level, 46)}
              <div>
                <div class="pp-elo">${fs.elo ?? '—'} <span class="small muted">ELO</span></div>
                ${p.faceit_nickname ? `<div class="small muted">as ${esc(p.faceit_nickname)}</div>` : ''}
              </div>
            </div>
            ${fs.games ? `
              <div class="stat-strip" style="margin:16px 0 0">
                ${statTile(fs.kd ?? '—', `K/D · last ${fs.games}`)}
                ${statTile(fs.adr ?? '—', 'ADR')}
                ${statTile(fs.hs != null ? fs.hs + '%' : '—', 'Headshots')}
                ${statTile(fs.win != null ? fs.win + '%' : '—', 'Win rate')}
              </div>` : `<p class="small muted" style="margin-top:12px">No recent match stats found yet.</p>`}`
          : `<p class="small muted">No FACEIT stats pulled yet — the lookup uses the nickname “${esc(p.faceit_nickname || p.name)}”.</p>`}
          <button class="btn small" id="pp-refresh" style="margin-top:16px">Refresh from FACEIT</button>
        </div>
        <div class="panel">
          <h2>Details</h2>
          <div class="rowlist">
            <div class="row-item"><span class="muted small grow">Role</span><b>${esc(p.game_role || '—')}</b></div>
            <div class="row-item"><span class="muted small grow">Lineup</span><b>${p.is_starter ? 'Starter' : 'Substitute'}</b></div>
            <div class="row-item"><span class="muted small grow">Controlled by</span>
              <span style="text-align:right"><b>${p.user ? esc(p.user.name) : 'Unassigned'}</b>${p.user ? `<div class="small muted">${esc(p.user.email)}</div>` : ''}</span></div>
            <div class="row-item"><span class="muted small grow">FACEIT nickname</span><b>${esc(p.faceit_nickname || p.name)}</b></div>
          </div>
          ${can('team') ? `<p class="small muted" style="margin-top:10px">Assign users and edit the roster on the <a href="#/team" style="color:var(--blue)">Team page</a>.</p>` : ''}
        </div>
      </div>
      ${fs && (fs.recent || []).length ? `
        <div class="panel" style="margin-top:16px">
          <h2>Last ${fs.recent.length} matches <span class="h-count">· PUGs & league</span></h2>
          <div>
            ${fs.recent.map(r => {
              const mapName = r.map ? r.map[0].toUpperCase() + r.map.slice(1) : '—';
              return `
              <div class="pp-match">
                <span class="pp-res ${r.win ? 'w' : 'l'}">${r.win ? 'W' : 'L'}</span>
                <span class="pp-map">${mapDot(mapName)}${esc(mapName)}</span>
                <span class="pp-score">${esc(r.score || '')}</span>
                <span class="pp-kda">${r.k}–${r.d}${r.kd != null ? ` · ${r.kd} K/D` : ''}${r.adr != null ? ` · ${r.adr} ADR` : ''}</span>
                <span class="small muted pp-when">${r.at ? esc(fmtRel(r.at)) : ''}</span>
              </div>`;
            }).join('')}
          </div>
        </div>` : ''}`;

    const btn = el.querySelector('#pp-refresh');
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Refreshing…';
      try {
        render(await api.post(`/api/team-players/${id}/faceit-refresh`));
        toast('FACEIT stats updated', 'ok');
      } catch (e) {
        toast(e.message, 'err');
        btn.disabled = false; btn.textContent = 'Refresh from FACEIT';
      }
    };
  }
  render(p);

  // auto-pull when never fetched, missing match history, or stale (>24h)
  const fs = p.faceit_stats;
  const stale = !fs || !fs.at || fs.recent === undefined
    || (Date.now() - new Date(fs.at).getTime() > 24 * 3600000);
  if (stale) api.post(`/api/team-players/${id}/faceit-refresh`).then(render).catch(() => { /* not linked */ });
}

export async function viewTeam(el) {
  if (!state.teamId) return viewTeamOnboarding(el);
  el.innerHTML = spinner();
  const [data, fc, players] = await Promise.all([
    api.get(teamUrl('/members')),
    api.get(teamUrl('/faceit')),
    api.get(teamUrl('/players')),
  ]);
  const admin = can('team');

  const rosterHtml = `
    <div class="panel" style="margin-top:14px">
      <h2>Roster</h2>
      <p class="small muted" style="margin-bottom:10px">The players on the team. ${admin ? 'Assign a user to a player to hand them that seat; players without a user are just roster entries.' : 'Click a player to see their profile and FACEIT stats.'}</p>
      <div class="rowlist">
        ${players.map(p => {
          const fs = p.faceit_stats;
          return `
          <div class="row-item">
            <a class="avatar" href="#/players/${p.id}">${esc(initials(p.name))}</a>
            <div class="grow">
              <a href="#/players/${p.id}"><b>${esc(p.name)}</b></a>
              <div class="small muted">${esc(p.game_role || 'No role')}${p.is_starter ? '' : ' · sub'}${p.user ? ` · controlled by ${esc(p.user.name)}` : ' · unassigned'}</div>
            </div>
            ${fs && fs.level ? `<span class="fc-side">${faceitBadge(fs.level)}${fs.elo ? `<b>${fs.elo}</b>` : ''}</span>` : ''}
            ${admin ? `
              <select data-assign="${p.id}" style="width:auto">
                <option value="">Unassigned</option>
                ${data.members.map(mm => `<option value="${mm.id}" ${p.user_id === mm.id ? 'selected' : ''}>${esc(mm.name)}</option>`).join('')}
              </select>
              <button class="btn ghost small danger" data-del-slot="${p.id}" title="Remove player">✕</button>` : ''}
          </div>`;
        }).join('') || '<div class="small muted">No players yet — add your lineup below.</div>'}
      </div>
      ${admin ? `
        <form id="add-player-slot" class="row-item" style="margin-top:12px">
          <input name="name" required placeholder="Player name / FACEIT nickname" class="grow">
          <input name="game_role" placeholder="Role (AWP, Entry…)" style="width:170px">
          <button class="btn primary small" type="submit">Add player</button>
        </form>` : ''}
    </div>`;

  const faceitHtml = `
    <div class="panel" style="margin-top:14px">
      <h2>FACEIT sync</h2>
      ${fc.connected ? `
        <div class="row-item">
          <span class="avatar">FC</span>
          <div class="grow">
            <b>${esc(fc.team_name || 'FACEIT team')}</b>
            <div class="small muted">Auto-sync every 30 min · last sync: ${fc.last_sync ? esc(fmtRel(fc.last_sync)) : 'never'}</div>
          </div>
          ${can('matches') ? `<button class="btn small" id="fc-sync">Sync now</button>` : ''}
          ${admin ? `<button class="btn ghost small danger" id="fc-disc">Disconnect</button>` : ''}
        </div>
        ${(fc.roster || []).length ? `<div style="margin-top:10px">${fc.roster.map(p =>
          `<span class="fc-chip">${faceitBadge(p.level, 18)}${esc(p.nickname)}${p.elo ? `<b>${p.elo}</b>` : ''}</span>`).join(' ')}</div>` : ''}
        <p class="small muted" style="margin-top:8px">Scheduled league and tournament matches are imported into Matches automatically; unknown opponents and their rosters are added to Opponents.</p>`
      : admin ? `
        <p class="small muted" style="margin-bottom:12px">Connect your FACEIT team to import scheduled matches, opponents, and the calendar automatically.</p>
        <form id="fc-form">
          <div class="form-2col">
            <div class="field"><label>FACEIT Data API key</label><input name="api_key" type="password" required placeholder="Server-side API key" autocomplete="off"></div>
            <div class="field"><label>FACEIT team URL or team id</label><input name="team" required placeholder="https://www.faceit.com/en/teams/…"></div>
          </div>
          <button class="btn primary small" type="submit">Connect FACEIT</button>
        </form>
        <p class="small muted" style="margin-top:10px">Create a free server-side API key at developers.faceit.com (App Studio → API keys). The key is stored on your MidRound server and never shown again.</p>`
      : `<p class="small muted">Not connected. A team admin can connect your FACEIT team here.</p>`}
    </div>`;
  let invitesHtml = '';
  if (admin) {
    const invites = await api.get(teamUrl('/invites'));
    invitesHtml = `
      <div class="panel" style="margin-top:14px">
        <h2>Invites</h2>
        <p class="small muted" style="margin-bottom:8px"><b>Existing account?</b> Invite them by email — the invite appears in their profile menu and they join with one click.</p>
        <form id="direct-invite" class="row-item" style="margin-bottom:14px">
          <input name="email" type="email" required placeholder="teammate@email.com" class="grow" autocomplete="off">
          <select name="role" style="width:auto">
            ${['view', 'edit'].map(r => `<option value="${r}">${roleLabel(r)}</option>`).join('')}
          </select>
          <button class="btn primary small" type="submit">Send invite</button>
        </form>
        <p class="small muted" style="margin-bottom:8px"><b>New to MidRound?</b> Generate a one-time code — they redeem it right after creating their account.</p>
        <form id="gen-invite" class="row-item" style="margin-bottom:12px">
          <select name="role" class="grow">
            ${['view', 'edit'].map(r => `<option value="${r}">${roleLabel(r)}</option>`).join('')}
          </select>
          <button class="btn primary small" type="submit">Generate invite code</button>
        </form>
        <div class="rowlist">
          ${invites.map(i => `
            <div class="row-item">
              ${i.email
                ? `<span class="grow"><b>${esc(i.email)}</b><div class="small muted">direct invite</div></span>`
                : `<code class="grow" style="color:var(--accent);font-family:ui-monospace,monospace">${esc(i.code)}</code>`}
              ${badge(roleLabel(i.role))}
              ${i.used_by ? badge('accepted', 'ok') : badge('pending')}
              ${i.used_by ? '' : `<button class="btn ghost small" data-del-invite="${i.id}" title="Revoke">✕</button>`}
            </div>`).join('') || '<div class="small muted">No invites yet.</div>'}
        </div>
      </div>`;
  }

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Team & access</h1><div class="sub">Members, roles, and invites. Your role: <b>${esc(roleLabel(data.my_role))}</b></div></div>
    </div>
    <div class="panel">
      <h2>Members (${data.members.length})</h2>
      <div class="rowlist">
        ${data.members.map(mm => `
          <div class="row-item">
            <div class="grow"><b>${esc(mm.name)}</b><div class="small muted">${esc(mm.email)}</div></div>
            ${mm.role === 'owner'
              ? badge('Owner', 'ok')
              : admin ? `
                <select data-role-for="${mm.id}" style="width:auto">
                  ${opt('edit', 'Edit access', mm.role)}${opt('view', 'View only', mm.role)}
                </select>
                <button class="btn ghost small danger" data-remove="${mm.id}">Kick</button>`
              : badge(roleLabel(mm.role), 'neutral')}
          </div>`).join('')}
      </div>
      <div class="small muted" style="margin-top:12px">
        <b>Owner:</b> everything, including team management · <b>Edit access:</b> create and change strategies, matches, and scouting · <b>View only:</b> read everything. Everyone can use Match Mode.
      </div>
    </div>
    ${rosterHtml}
    ${faceitHtml}
    ${invitesHtml}`;

  // FACEIT handlers (some available to non-admin match managers)
  const fcSync = el.querySelector('#fc-sync');
  if (fcSync) fcSync.onclick = async () => {
    fcSync.disabled = true;
    fcSync.textContent = 'Syncing…';
    try {
      const s = await api.post(teamUrl('/faceit/sync'));
      toast(`FACEIT sync: ${s.created} new, ${s.updated} updated across ${s.championships} competition${s.championships === 1 ? '' : 's'}${s.players ? ` · ${s.players} players imported` : ''}${s.errors.length ? ` · ${s.errors.length} warning(s)` : ''}`, 'ok');
      viewTeam(el);
    } catch (e) { toast(e.message, 'err'); fcSync.disabled = false; fcSync.textContent = 'Sync now'; }
  };
  el.querySelector('#fc-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const r = await api.put(teamUrl('/faceit'), { api_key: f.get('api_key'), team: f.get('team') });
      toast(`Connected to FACEIT team "${r.team_name}"`, 'ok');
      viewTeam(el);
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false; btn.textContent = 'Connect FACEIT';
    }
  });
  const fcDisc = el.querySelector('#fc-disc');
  if (fcDisc) fcDisc.onclick = async () => {
    if (!await confirmDialog({ title: 'Disconnect FACEIT?', message: 'Auto-sync stops. Already-imported matches and opponents stay.', confirmText: 'Disconnect', danger: true })) return;
    await api.del(teamUrl('/faceit'));
    viewTeam(el);
  };

  if (!admin) return;
  el.querySelectorAll('[data-role-for]').forEach(s => s.onchange = async () => {
    try { await api.put(teamUrl(`/members/${s.dataset.roleFor}`), { role: s.value }); toast('Access updated', 'ok'); }
    catch (e) { toast(e.message, 'err'); viewTeam(el); }
  });
  el.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog({ title: 'Kick member?', message: 'They will lose access to all team content immediately. Any player they controlled stays on the roster, unassigned.', confirmText: 'Kick', danger: true })) return;
    try { await api.del(teamUrl(`/members/${b.dataset.remove}`)); viewTeam(el); }
    catch (e) { toast(e.message, 'err'); }
  });
  el.querySelectorAll('[data-assign]').forEach(s => s.onchange = async () => {
    try {
      await api.put(`/api/team-players/${s.dataset.assign}`, { user_id: s.value ? Number(s.value) : null });
      toast('Roster updated', 'ok');
      viewTeam(el);
    } catch (e) { toast(e.message, 'err'); viewTeam(el); }
  });
  el.querySelectorAll('[data-del-slot]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog({ title: 'Remove player?', message: 'The roster slot and its FACEIT stats are removed. Linked user accounts are not affected.', confirmText: 'Remove', danger: true })) return;
    try { await api.del(`/api/team-players/${b.dataset.delSlot}`); viewTeam(el); }
    catch (e) { toast(e.message, 'err'); }
  });
  el.querySelector('#add-player-slot')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api.post(teamUrl('/players'), { name: f.get('name'), game_role: f.get('game_role') || null });
      viewTeam(el);
    } catch (err) { toast(err.message, 'err'); }
  });
  el.querySelector('#direct-invite')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api.post(teamUrl('/invites/direct'), { email: f.get('email'), role: f.get('role') });
      toast('Invite sent — it will appear in their profile menu', 'ok');
      viewTeam(el);
    } catch (err) { toast(err.message, 'err'); }
  });
  el.querySelector('#gen-invite')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const role = new FormData(e.target).get('role');
    try {
      const r = await api.post(teamUrl('/invites'), { role });
      toast(`Invite code: ${r.code}`, 'ok');
      viewTeam(el);
    } catch (err) { toast(err.message, 'err'); }
  });
  el.querySelectorAll('[data-del-invite]').forEach(b => b.onclick = async () => {
    await api.del(`/api/invites/${b.dataset.delInvite}`);
    viewTeam(el);
  });
}

// Team & access without a team — the one place for team onboarding: accept a
// pending invite, redeem an invite code, or create a new organization. The
// rest of the app works fine without any of it.
async function viewTeamOnboarding(el) {
  el.innerHTML = spinner();
  let invites = [];
  try { invites = await api.get('/api/me/invites'); } catch { /* optional */ }

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Team & access</h1><div class="sub">You're not on a team — join one or create your own whenever you're ready.</div></div>
    </div>
    <div id="gs-err"></div>
    <div class="panel" style="margin-bottom:14px">
      <h2>Your invites${invites.length ? ` (${invites.length})` : ''}</h2>
      <div class="rowlist">
        ${invites.length ? invites.map(i => `
          <div class="row-item">
            <span class="grow small"><b>${esc(i.team_name || i.org_name)}</b> · ${esc(roleLabel(i.role))}
              <div class="muted">invited by ${esc(i.invited_by || 'a team owner')}</div></span>
            <button class="btn primary small" data-acc="${i.id}">Accept</button>
            <button class="btn ghost small" data-dec="${i.id}">Decline</button>
          </div>`).join('')
        : '<div class="small muted">No pending invites. Ask a team owner to invite this email, or use an invite code below.</div>'}
      </div>
      <form id="onb-code" class="row-item" style="margin-top:12px">
        <input name="code" placeholder="Have an invite code? Paste it here" class="grow" autocomplete="off">
        <button class="btn small" type="submit">Join with code</button>
      </form>
    </div>
    <div class="panel">
      <h2>Create a new organization</h2>
      <p class="small muted" style="margin-bottom:10px">You become the owner and can invite teammates afterwards.</p>
      <form id="onb-org">
        <div class="form-2col">
          <div class="field"><label>Organization name</label><input name="orgName" required placeholder="e.g. Northlight Esports"></div>
          <div class="field"><label>Team name</label><input name="teamName" placeholder="Main Team"></div>
        </div>
        <button class="btn primary small" type="submit">Create organization</button>
      </form>
    </div>`;

  const err = (m) => { el.querySelector('#gs-err').innerHTML = `<div class="auth-err">${esc(m)}</div>`; };
  const enter = (teamId) => {
    if (teamId) localStorage.setItem('mr.teamId', String(teamId));
    localStorage.removeItem('mr.route');
    location.hash = '#/';
    location.reload();
  };

  el.querySelectorAll('[data-acc]').forEach(b => b.onclick = async () => {
    try { enter((await api.post(`/api/invites/${b.dataset.acc}/accept`)).team_id); }
    catch (e) { err(e.message); }
  });
  el.querySelectorAll('[data-dec]').forEach(b => b.onclick = async () => {
    try { await api.post(`/api/invites/${b.dataset.dec}/decline`); viewTeamOnboarding(el); }
    catch (e) { err(e.message); }
  });
  el.querySelector('#onb-code').onsubmit = async (e) => {
    e.preventDefault();
    const code = new FormData(e.target).get('code')?.trim();
    if (!code) return err('Paste an invite code first');
    try { enter((await api.post('/api/invites/redeem', { code })).team_id); }
    catch (e2) { err(e2.message); }
  };
  el.querySelector('#onb-org').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      enter((await api.post('/api/orgs', {
        name: f.get('orgName'), teamName: f.get('teamName')?.trim() || undefined,
      })).team_id);
    } catch (e2) { err(e2.message); }
  };
}

