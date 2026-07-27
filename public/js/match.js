// MidRound — Match Mode: the minimal in-match view for the Steam browser.
// One data load on entry, then instant client-side switching.
//
// Three strategy sources, switchable from the top bar:
//   solo  — your own personal strategies, no team needed
//   team  — the team's strategy bank (Team Strats), no match picked
//   match — Team Strats plus a scheduled match's pins, reminders and opponent
import { api } from './api.js';
import { esc, badge, toast, emptyState, spinner, ICONS } from './ui.js';
import { state, nav, trackView } from './main.js';
import { strategyDetailHtml, tendencyHtml, buyLabel, mapDot } from './manage.js';

const BUY_GROUPS = [['pistol', 'Pistol'], ['save', 'Save'], ['semi', 'Semi-buy'], ['eco', 'Eco'], ['full', 'Full buy']];

// Solo is always reachable — it needs nothing but your own strategies.
export function enterSoloMode() { nav('/match-mode/solo'); }

// Team resolves to the match you're actually preparing for when there is one,
// since that adds pins, reminders and the opponent on top of the same Team
// Strats; otherwise it's the plain team bank.
export async function enterTeamMode() {
  if (!state.teamId) { nav('/match-mode/solo'); return; }
  try {
    const matches = await api.get(`/api/teams/${state.teamId}/matches`);
    const upcoming = matches.filter(m => m.status === 'upcoming')
      .sort((a, b) => (a.scheduled_at || '9999').localeCompare(b.scheduled_at || '9999'));
    const last = Number(localStorage.getItem('mr.mm.lastMatch'));
    const target = upcoming.find(m => m.id === last) || upcoming[0];
    nav(target ? `/match-mode/${target.id}` : '/match-mode/team');
  } catch (e) {
    toast(e.message, 'err');
    nav('/match-mode/team');
  }
}

export async function viewMatchMode(root, idStr) {
  const mode = idStr === 'solo' ? 'solo' : idStr === 'team' ? 'team' : 'match';
  const solo = mode === 'solo';
  const matchId = mode === 'match' ? Number(idStr) : null;
  // Both team sources need a team id; without one, fall back rather than
  // firing team requests that would 404.
  if (!solo && !state.teamId) { nav('/match-mode/solo'); return; }
  root.dataset.shell = '';
  root.innerHTML = `<div class="mm-shell mm-shell2"><div class="mm-main2">${spinner('Loading…')}</div></div>`;

  let match = null, opponent = null, maps = [], strategies = [];
  try {
    // solo runs on your personal strategies; team/match modes run on the
    // team's strategy bank (Team Strats)
    [maps, strategies] = await Promise.all([
      api.get('/api/maps'),
      api.get(solo ? '/api/strategies' : `/api/teams/${state.teamId}/strategies`),
    ]);
    if (mode === 'match') {
      match = await api.get(`/api/matches/${matchId}`);
      if (match.opponent_id) opponent = await api.get(`/api/opponents/${match.opponent_id}`);
    }
  } catch (e) {
    root.innerHTML = `<div class="mm-shell mm-shell2"><div class="mm-main2">${emptyState('Could not load Match Mode', e.message)}</div></div>`;
    return;
  }

  const mapNames = maps.map(m => m.name);
  // each source remembers its own map/side/open strategy
  const stKey = `mr.mm.${mode === 'match' ? matchId : mode}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(stKey)) || {}; } catch { /* fresh */ }
  const defaultMap = (match && match.expected_maps && match.expected_maps[0]) || mapNames[0];
  const ui = {
    map: mapNames.includes(saved.map) ? saved.map : (mapNames.includes(defaultMap) ? defaultMap : mapNames[0]),
    side: saved.side === 'T' ? 'T' : saved.side === 'CT' ? 'CT' : (match && match.starting_side === 'T' ? 'T' : 'CT'),
    strat: saved.strat || null,
  };
  if (mode === 'match') localStorage.setItem('mr.mm.lastMatch', String(matchId));
  const persist = () => localStorage.setItem(stKey, JSON.stringify(ui));

  const pins = match ? match.pins : [];
  const pinnedIds = new Set(pins.map(p => p.id));
  const reminders = match ? match.notes.filter(n => n.kind === 'reminder') : [];

  function stratRow(s) {
    const pinned = pinnedIds.has(s.id);
    return `
      <button class="mm-row ${pinned ? 'pinned' : ''}" data-open-strat="${s.id}">
        <span class="mr-name">${pinned ? `<span class="mm-pin" title="Pinned for this match">${ICONS.pin}</span>` : ''}${esc(s.name)}${s.site ? `<span class="mr-site">${esc(s.site)}</span>` : ''}</span>
        ${s.summary ? `<span class="mr-call">${esc(s.summary)}</span>` : ''}
      </button>`;
  }

  function stratList() {
    const pool = strategies.filter(s => s.status === 'active' && s.map === ui.map && s.side === ui.side);
    if (!pool.length) {
      return emptyState(`No ${ui.side} strategies for ${ui.map}`, 'Add them in the strategy library.');
    }
    // pinned first within each group, then by name
    const order = (a, b) => (pinnedIds.has(b.id) - pinnedIds.has(a.id)) || a.name.localeCompare(b.name);
    const box = (label, items) => `
      <div class="mm-groupbox">
        <div class="mm-group-head">${esc(label)} <span class="h-count">· ${items.length}</span></div>
        ${items.map(s => stratRow(s)).join('')}
      </div>`;

    // left stack: pistol / save / semi / eco (+ anything untyped); right: full buy, wider
    const stackedBoxes = [['pistol', 'Pistol'], ['save', 'Save'], ['semi', 'Semi-buy'], ['eco', 'Eco']]
      .map(([key, label]) => {
        const items = pool.filter(s => s.buy_type === key).sort(order);
        return items.length ? box(label, items) : '';
      }).join('');
    const other = pool.filter(s => !BUY_GROUPS.some(([k]) => k === s.buy_type)).sort(order);
    const fullItems = pool.filter(s => s.buy_type === 'full').sort(order);
    return `
      <div class="mm-strats">
        <div class="mm-stack">
          ${stackedBoxes || `<div class="mm-groupbox"><div class="small muted">No pistol, save, semi-buy, or eco strategies for ${esc(ui.map)} ${esc(ui.side)}.</div></div>`}
          ${other.length ? box('Other', other) : ''}
        </div>
        <div class="mm-groupbox mm-fullbuy">
          <div class="mm-group-head">Full buy <span class="h-count">· ${fullItems.length}</span></div>
          ${fullItems.map(s => stratRow(s)).join('') || `<div class="small muted">No full-buy strategies yet.</div>`}
        </div>
      </div>`;
  }

  function stratDetail(id) {
    const s = strategies.find(x => x.id === id) || pins.find(p => p.id === id);
    if (!s) return emptyState('Strategy not found');
    return `
      <div class="mm-detail ${s.side === 'T' ? 'side-t' : 'side-ct'}">
        <div class="mm-detail-nav">
          <button class="btn" id="mm-back">← Back</button>
          <span class="mm-detail-esc">Press <span class="kbd">Esc</span> to go back</span>
        </div>
        <div class="mm-detail-head">
          <h1>${esc(s.name)}</h1>
          <div class="detail-meta">${badge(s.side + ' side', s.side === 'T' ? 't' : 'ct')} ${badge(s.map)} ${s.buy_type ? badge(buyLabel(s.buy_type)) : ''}</div>
        </div>
        ${strategyDetailHtml(s)}
      </div>`;
  }

  function sideCol() {
    const tds = opponent ? opponent.tendencies.filter(td => !td.map || td.map === ui.map) : [];
    return `
      <div class="panel mm-panel mm-reminders">
        <h2>Reminders</h2>
        ${reminders.length
          ? `<ul class="bullets blue">${reminders.map(n => `<li>${esc(n.text)}</li>`).join('')}</ul>`
          : `<div class="small muted">${match ? 'No reminders for this match.' : solo ? 'Solo session.' : 'No match selected.'}</div>`}
      </div>
      <div class="panel mm-panel mm-tendencies">
        <h2>Tendencies${opponent ? ` — ${esc(opponent.name)}` : ''}</h2>
        ${tds.length
          ? tds.map(td => tendencyHtml(td)).join('')
          : `<div class="small muted">${match ? 'Nothing recorded for this map yet.' : solo ? 'No opponent in solo mode.' : 'No match selected — pick one from Matches for opponent reads.'}</div>`}
      </div>`;
  }

  function render() {
    root.innerHTML = `
      <div class="mm-shell mm-shell2">
        <div class="mm-top2 ${ui.side === 'T' ? 'side-t' : 'side-ct'}">
          <div class="mm-left">
            <div class="mm-mapdd" id="mm-mapdd">
              <button class="mm-mapdd-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="Map">
                ${mapDot(ui.map)}<span class="mm-mapdd-cur">${esc(ui.map)}</span>
                <svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>
              </button>
              <div class="mm-mapdd-menu" role="listbox" aria-label="Map" hidden>
                ${mapNames.map(m => `
                  <button class="mm-mapdd-item ${m === ui.map ? 'active' : ''}" role="option" aria-selected="${m === ui.map}" data-map="${esc(m)}">
                    ${mapDot(m)}${esc(m)}
                  </button>`).join('')}
              </div>
            </div>
            ${state.teamId ? `
              <div class="mm-modes" role="group" aria-label="Strategy source">
                <button class="mm-mode-btn ${solo ? 'active' : ''}" data-mode="solo" aria-pressed="${solo}">Solo</button>
                <button class="mm-mode-btn ${solo ? '' : 'active'}" data-mode="team" aria-pressed="${!solo}">Team</button>
              </div>` : ''}
          </div>
          <div class="mm-sides">
            <button class="mm-side-btn ct ${ui.side === 'CT' ? 'active' : ''}" data-side="CT">CT</button>
            <button class="mm-side-btn t ${ui.side === 'T' ? 'active' : ''}" data-side="T">T</button>
          </div>
          <div class="mm-right">
            <span class="mm-ctx">${match ? `vs ${esc(opponent ? opponent.name : 'TBD')} · ${esc(match.format || '')}` : solo ? 'Your strategies' : 'Team Strats'}</span>
            <a class="btn small" href="#/">Exit</a>
          </div>
        </div>
        <div class="mm-body2">
          <div class="mm-main2">
            ${ui.strat ? stratDetail(ui.strat) : stratList()}
          </div>
          <aside class="mm-aside">
            ${sideCol()}
          </aside>
        </div>
      </div>`;

    const dd = root.querySelector('#mm-mapdd');
    const ddBtn = dd.querySelector('.mm-mapdd-btn');
    const ddMenu = dd.querySelector('.mm-mapdd-menu');
    ddBtn.onclick = () => {
      const open = ddMenu.hidden;
      ddMenu.hidden = !open;
      ddBtn.setAttribute('aria-expanded', String(open));
    };
    ddMenu.querySelectorAll('[data-map]').forEach(b => b.onclick = () => {
      ui.map = b.dataset.map; ui.strat = null; persist(); render();
    });
    root.querySelectorAll('[data-side]').forEach(b => b.onclick = () => {
      ui.side = b.dataset.side; ui.strat = null; persist(); render();
    });
    // switching source reloads the view; 'team' resolves to the upcoming match
    // when there is one, so match mode counts as already being on Team
    root.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
      const want = b.dataset.mode;
      if (want === 'solo' && !solo) enterSoloMode();
      else if (want === 'team' && solo) enterTeamMode();
    });
    root.querySelectorAll('[data-open-strat]').forEach(b => b.onclick = () => {
      ui.strat = Number(b.dataset.openStrat);
      persist(); render();
      trackView('strategy', ui.strat);
      window.scrollTo(0, 0);
    });
    const back = root.querySelector('#mm-back');
    if (back) back.onclick = () => { ui.strat = null; persist(); render(); };
  }

  // closes the map dropdown if open; returns true if it was open
  function closeMapMenu() {
    const menu = root.querySelector('#mm-mapdd .mm-mapdd-menu');
    if (!menu || menu.hidden) return false;
    menu.hidden = true;
    root.querySelector('#mm-mapdd .mm-mapdd-btn').setAttribute('aria-expanded', 'false');
    return true;
  }
  function onDocClick(e) {
    const dd = root.querySelector('#mm-mapdd');
    if (dd && !dd.contains(e.target)) closeMapMenu();
  }
  document.addEventListener('click', onDocClick);

  // optional shortcuts: 1 = CT, 2 = T, Esc = close menu / back
  function onKey(e) {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === '1') { ui.side = 'CT'; ui.strat = null; persist(); render(); }
    else if (e.key === '2') { ui.side = 'T'; ui.strat = null; persist(); render(); }
    else if (e.key === 'Escape') {
      if (closeMapMenu()) return;
      if (ui.strat) { ui.strat = null; persist(); render(); }
    }
  }
  document.addEventListener('keydown', onKey);
  const cleanup = () => {
    if (!location.hash.startsWith('#/match-mode/')) {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('hashchange', cleanup);
    }
  };
  window.addEventListener('hashchange', cleanup);

  persist();
  render();
}
