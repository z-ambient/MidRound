// MidRound — Match Mode: the minimal in-match view for the Steam browser.
// One data load on entry, then instant client-side switching. Works with a team
// match (pins/reminders/tendencies on the right) or solo (map + strats only).
import { api } from './api.js';
import { esc, badge, toast, emptyState, spinner, ICONS } from './ui.js';
import { state, nav, trackView } from './main.js';
import { strategyDetailHtml, tendencyHtml, buyLabel, mapDot } from './manage.js';

const BUY_GROUPS = [['pistol', 'Pistol'], ['save', 'Save'], ['semi', 'Semi-buy'], ['eco', 'Eco'], ['full', 'Full buy']];

export async function enterMatchMode() {
  try {
    const matches = await api.get(`/api/teams/${state.teamId}/matches`);
    const upcoming = matches.filter(m => m.status === 'upcoming')
      .sort((a, b) => (a.scheduled_at || '9999').localeCompare(b.scheduled_at || '9999'));
    const last = Number(localStorage.getItem('mr.mm.lastMatch'));
    const target = upcoming.find(m => m.id === last) || upcoming[0];
    nav(target ? `/match-mode/${target.id}` : '/match-mode/solo');
  } catch (e) { toast(e.message, 'err'); }
}

export async function viewMatchMode(root, idStr) {
  const solo = idStr === 'solo';
  const matchId = solo ? null : Number(idStr);
  root.dataset.shell = '';
  root.innerHTML = `<div class="mm-shell mm-shell2"><div class="mm-main2">${spinner('Loading…')}</div></div>`;

  let match = null, opponent = null, maps = [], strategies = [];
  try {
    [maps, strategies] = await Promise.all([
      api.get('/api/maps'),
      api.get(`/api/teams/${state.teamId}/strategies`),
    ]);
    if (!solo) {
      match = await api.get(`/api/matches/${matchId}`);
      if (match.opponent_id) opponent = await api.get(`/api/opponents/${match.opponent_id}`);
    }
  } catch (e) {
    root.innerHTML = `<div class="mm-shell mm-shell2"><div class="mm-main2">${emptyState('Could not load Match Mode', e.message)}</div></div>`;
    return;
  }

  const mapNames = maps.map(m => m.name);
  const stKey = `mr.mm.${solo ? 'solo' : matchId}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(stKey)) || {}; } catch { /* fresh */ }
  const defaultMap = (match && match.expected_maps && match.expected_maps[0]) || mapNames[0];
  const ui = {
    map: mapNames.includes(saved.map) ? saved.map : (mapNames.includes(defaultMap) ? defaultMap : mapNames[0]),
    side: saved.side === 'T' ? 'T' : saved.side === 'CT' ? 'CT' : (match && match.starting_side === 'T' ? 'T' : 'CT'),
    strat: saved.strat || null,
  };
  if (!solo) localStorage.setItem('mr.mm.lastMatch', String(matchId));
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
          : `<div class="small muted">${solo ? 'Solo session.' : 'No reminders for this match.'}</div>`}
      </div>
      <div class="panel mm-panel mm-tendencies">
        <h2>Tendencies${opponent ? ` — ${esc(opponent.name)}` : ''}</h2>
        ${tds.length
          ? tds.map(td => tendencyHtml(td)).join('')
          : `<div class="small muted">${solo ? 'No opponent in solo mode.' : 'Nothing recorded for this map yet.'}</div>`}
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
          </div>
          <div class="mm-sides">
            <button class="mm-side-btn ct ${ui.side === 'CT' ? 'active' : ''}" data-side="CT">CT</button>
            <button class="mm-side-btn t ${ui.side === 'T' ? 'active' : ''}" data-side="T">T</button>
          </div>
          <div class="mm-right">
            <span class="mm-ctx">${match ? `vs ${esc(opponent ? opponent.name : 'TBD')} · ${esc(match.format || '')}` : 'Solo'}</span>
            <a class="btn small" href="${match ? `#/matches/${matchId}` : '#/'}">Exit</a>
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
