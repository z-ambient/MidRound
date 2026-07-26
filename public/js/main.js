// MidRound — app shell, router, auth
import { api } from './api.js';
import { esc, toast, debounce, ICONS, initSelectDropdowns } from './ui.js';
import * as manage from './manage.js';
import * as match from './match.js';

export const state = {
  me: null,        // { user, orgs, teams }
  teamId: null,
  role: null,      // my role in current team's org
};

export const CAN = {
  strategies: ['owner', 'edit'],
  scouting: ['owner', 'edit'],
  matches: ['owner', 'edit'],
  team: ['owner'],
};
export const can = (domain) => CAN[domain].includes(state.role);

const app = document.getElementById('app');

// ---------- routing ----------
const routes = [
  { re: /^\/login$/, view: viewLogin, public: true, bare: true },
  { re: /^\/register$/, view: viewRegister, public: true, bare: true },
  { re: /^\/$/, view: manage.viewDashboard },
  { re: /^\/strategies$/, view: manage.viewStrategies },
  { re: /^\/strategies\/new$/, view: manage.viewStrategyEdit },
  { re: /^\/strategies\/(\d+)$/, view: manage.viewStrategyDetail },
  { re: /^\/strategies\/(\d+)\/edit$/, view: manage.viewStrategyEdit },
  { re: /^\/opponents$/, view: () => nav('/matches') }, // merged into the Matches tab
  { re: /^\/opponents\/(\d+)$/, view: manage.viewOpponentDetail },
  { re: /^\/matches$/, view: manage.viewMatches },
  { re: /^\/matches\/(\d+)$/, view: manage.viewMatchDetail },
  { re: /^\/team$/, view: manage.viewTeam },
  { re: /^\/players\/(\d+)$/, view: manage.viewPlayerProfile },
  { re: /^\/lookup$/, view: manage.viewPlayerLookup },
  { re: /^\/match-mode\/(solo|\d+)$/, view: match.viewMatchMode, bare: true },
];

export function nav(path) { location.hash = '#' + path; }

function currentPath() {
  let h = location.hash.replace(/^#/, '');
  if (!h) h = '/';
  return h.split('?')[0];
}

export function query() {
  const q = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}

async function route() {
  const path = currentPath();
  const found = routes.find(r => r.re.test(path));
  if (!found) { nav('/'); return; }

  if (!found.public && !state.me) {
    const ok = await loadMe();
    if (!ok) {
      sessionStorage.setItem('mr.afterLogin', path + (location.hash.split('?')[1] ? '?' + location.hash.split('?')[1] : ''));
      nav('/login');
      return;
    }
  }
  if (found.public && state.me) { nav('/'); return; }

  if (!found.public) {
    localStorage.setItem('mr.route', location.hash);
  }

  const params = path.match(found.re).slice(1).map(decodeURIComponent);
  window.scrollTo(0, 0);
  // page-scoped ambient backgrounds (e.g. strategy library map filter) reset each route
  const mainEl = app.querySelector('.main');
  if (mainEl) {
    mainEl.classList.remove('map-ambient', 'map-blur');
    mainEl.style.removeProperty('--map-img');
  }
  try {
    if (found.bare) {
      await found.view(app, ...params);
    } else {
      renderShell(path);
      await found.view(document.getElementById('view'), ...params);
    }
  } catch (e) {
    const target = document.getElementById('view') || app;
    target.innerHTML = `<div class="empty"><b>Could not load this page</b>${esc(e.message)}</div>`;
  }
}

async function loadMe() {
  try {
    state.me = await api.get('/api/me');
  } catch { state.me = null; return false; }
  const savedTeam = Number(localStorage.getItem('mr.teamId'));
  const team = state.me.teams.find(t => t.id === savedTeam) || state.me.teams[0];
  if (team) {
    state.teamId = team.id;
    const org = state.me.orgs.find(o => o.id === team.org_id);
    state.role = org ? org.role : null;
    localStorage.setItem('mr.teamId', String(team.id));
  }
  return true;
}

window.addEventListener('mr:unauthed', () => {
  state.me = null;
  nav('/login');
});

// ---------- shell ----------
function navLink(path, label, icon, active, also = '') {
  return `<a class="nav-link ${active ? 'active' : ''}" ${also ? `data-also="${also}"` : ''} href="#${path}">${ICONS[icon] || ''}<span>${esc(label)}</span></a>`;
}

function renderShell(path) {
  if (document.getElementById('view') && app.dataset.shell === '1') {
    // update active nav only
    app.querySelectorAll('.nav-link').forEach(a => {
      const href = a.getAttribute('href').slice(1);
      const also = a.dataset.also;
      const active = (href === '/' ? path === '/' : path.startsWith(href)) || (!!also && path.startsWith(also));
      a.classList.toggle('active', active);
    });
    app.querySelector('.sidebar')?.classList.remove('open');
    return;
  }
  const team = state.me.teams.find(t => t.id === state.teamId);
  const org = team ? state.me.orgs.find(o => o.id === team.org_id) : null;
  const isActive = (p) => p === '/' ? path === '/' : path.startsWith(p);
  app.dataset.shell = '1';
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="side-logo">
          <span class="side-logo-badge">${ICONS.logo}</span>
          <span class="side-logo-sub">Be Prepared.<br>Be Better.</span>
        </div>
        ${navLink('/', 'Dashboard', 'dashboard', isActive('/'))}
        ${navLink('/strategies', 'Strategies', 'strategies', isActive('/strategies'))}
        ${navLink('/matches', 'Matches', 'matches', isActive('/matches') || isActive('/opponents'), '/opponents')}
        ${navLink('/lookup', 'Player Lookup', 'search', isActive('/lookup'))}
        <div class="nav-section">Organization</div>
        ${navLink('/team', 'Team & access', 'team', isActive('/team'))}
      </aside>
      <main class="main">
        <div class="topbar">
          <button class="btn small menu-toggle" id="menu-toggle">☰ Menu</button>
          <div class="tb-brand">MidRound</div>
          <button class="matchmode-btn shine-cta" id="btn-matchmode"><span>${ICONS.play} Match Mode</span></button>
          <div class="tb-spacer"></div>
          <div class="global-search">
            <span class="gs-icon">${ICONS.search}</span>
            <input id="gs-input" placeholder="Search…" autocomplete="off" aria-label="Search everything">
            <div class="gs-panel" id="gs-panel"></div>
          </div>
          <div class="dd tb-profile">
            <button class="tb-profile-btn" id="btn-profile" aria-haspopup="menu" aria-expanded="false">
              <span class="tb-user-name">${esc(state.me.user.name)}</span>
              <svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>
            </button>
            <div class="dd-menu tb-profile-menu" hidden>
              <div class="tb-who">
                <b>${esc(state.me.user.name)}</b>
                <div class="small muted">${esc(team ? team.name : '')} · ${esc(roleLabel(state.role))}</div>
              </div>
              <a class="dd-item" id="pm-profile" hidden>My player profile</a>
              <div id="pm-teams"></div>
              <div id="pm-invites"></div>
              <button class="dd-item" id="btn-logout">Sign out</button>
            </div>
          </div>
        </div>
        <div id="view"></div>
      </main>
    </div>`;

  document.getElementById('btn-logout').onclick = async () => {
    try { await api.post('/api/auth/logout'); } catch {}
    state.me = null;
    app.dataset.shell = '';
    localStorage.removeItem('mr.route');
    nav('/login');
  };
  document.getElementById('btn-matchmode').onclick = () => match.enterMatchMode();
  document.getElementById('menu-toggle').onclick = () => document.getElementById('sidebar').classList.toggle('open');
  const profBtn = document.getElementById('btn-profile');
  const profMenu = app.querySelector('.tb-profile-menu');
  profBtn.onclick = () => {
    const open = profMenu.hidden;
    profMenu.hidden = !open;
    profBtn.setAttribute('aria-expanded', String(open));
  };
  populateProfileMenu();
  wireGlobalSearch();
}

// fills the profile menu: my player-profile link, team switcher, pending invites
async function populateProfileMenu() {
  const profileLink = document.getElementById('pm-profile');
  if (profileLink && state.teamId) {
    try {
      const players = await api.get(`/api/teams/${state.teamId}/players`);
      const mine = players.find(p => p.user_id === state.me.user.id);
      if (mine) { profileLink.hidden = false; profileLink.href = `#/players/${mine.id}`; }
    } catch { /* fine — no roster access */ }
  }

  const tEl = document.getElementById('pm-teams');
  if (tEl && state.me.teams.length > 1) {
    tEl.innerHTML = `<div class="pm-label">Switch team</div>` + state.me.teams.map(t =>
      `<button class="dd-item ${t.id === state.teamId ? 'active' : ''}" data-team="${t.id}">${esc(t.name)}</button>`).join('');
    tEl.querySelectorAll('[data-team]').forEach(b => b.onclick = () => {
      localStorage.setItem('mr.teamId', b.dataset.team);
      localStorage.removeItem('mr.route');
      location.hash = '#/';
      location.reload();
    });
  }

  try {
    const invites = await api.get('/api/me/invites');
    const iEl = document.getElementById('pm-invites');
    if (!iEl || !invites.length) return;
    document.getElementById('btn-profile')?.classList.add('has-invites');
    iEl.innerHTML = `<div class="pm-label">Team invites</div>` + invites.map(i => `
      <div class="pm-invite">
        <div class="small">
          <b>${esc(i.team_name || i.org_name)}</b> · ${esc(roleLabel(i.role))}
          <div class="muted">invited by ${esc(i.invited_by || 'a team owner')}</div>
        </div>
        <div class="pm-invite-actions">
          <button class="btn primary small" data-acc="${i.id}">Join</button>
          <button class="btn ghost small" data-dec="${i.id}">Decline</button>
        </div>
      </div>`).join('');
    iEl.querySelectorAll('[data-acc]').forEach(b => b.onclick = async () => {
      try {
        const r = await api.post(`/api/invites/${b.dataset.acc}/accept`);
        if (r.team_id) localStorage.setItem('mr.teamId', String(r.team_id));
        localStorage.removeItem('mr.route');
        location.hash = '#/';
        location.reload();
      } catch (e) { toast(e.message, 'err'); }
    });
    iEl.querySelectorAll('[data-dec]').forEach(b => b.onclick = async () => {
      try { await api.post(`/api/invites/${b.dataset.dec}/decline`); b.closest('.pm-invite').remove(); }
      catch (e) { toast(e.message, 'err'); }
    });
  } catch { /* invites are optional sugar */ }
}

function wireGlobalSearch() {
  const input = document.getElementById('gs-input');
  const panel = document.getElementById('gs-panel');
  const close = () => panel.classList.remove('open');

  const gsRow = (href, main, side = '') =>
    `<a class="gs-row" href="${href}">${main}${side ? `<span class="gs-side">${side}</span>` : ''}</a>`;

  const run = debounce(async () => {
    const q = input.value.trim();
    if (!q) { close(); return; }
    let r;
    try { r = await api.get(`/api/teams/${state.teamId}/search?q=${encodeURIComponent(q)}`); }
    catch { return; }
    if (input.value.trim() !== q) return;
    const total = r.strategies.length + r.opponents.length + r.players.length + r.tendencies.length + r.matches.length;
    panel.innerHTML = !total
      ? `<div class="gs-empty">No results for “${esc(q)}”</div>`
      : `
      ${r.strategies.length ? `<div class="gs-group">Strategies</div>` + r.strategies.map(s =>
        gsRow(`#/strategies/${s.id}`, `${manage.sideTag(s.side)}<b>${esc(s.name)}</b>`, esc(s.map))).join('') : ''}
      ${r.opponents.length ? `<div class="gs-group">Opponents</div>` + r.opponents.map(o =>
        gsRow(`#/opponents/${o.id}`, `<b>${esc(o.name)}</b>`)).join('') : ''}
      ${r.players.length ? `<div class="gs-group">Opponent players</div>` + r.players.map(p =>
        gsRow(`#/opponents/${p.opponent_id}`, `<b>${esc(p.name)}</b> <span class="muted">${esc(p.role || '')}</span>`, esc(p.opponent_name))).join('') : ''}
      ${r.tendencies.length ? `<div class="gs-group">Tendencies</div>` + r.tendencies.map(td =>
        gsRow(`#/opponents/${td.opponent_id}`, `<span class="gs-text">${esc(td.text.length > 90 ? td.text.slice(0, 90) + '…' : td.text)}</span>`, esc(td.opponent_name))).join('') : ''}
      ${r.matches.length ? `<div class="gs-group">Matches</div>` + r.matches.map(m =>
        gsRow(`#/matches/${m.id}`, `<b>vs ${esc(m.opponent_name || 'TBD')}</b>`, esc(m.scheduled_at ? new Date(m.scheduled_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''))).join('') : ''}`;
    panel.classList.add('open');
    panel.querySelectorAll('a').forEach(a => a.addEventListener('click', () => { close(); input.blur(); }));
  }, 260);

  input.addEventListener('input', run);
  input.addEventListener('focus', () => { if (input.value.trim() && panel.innerHTML) panel.classList.add('open'); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); input.blur(); }
  });
  if (!window.__gsDocWired) {
    window.__gsDocWired = true;
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.global-search')) document.getElementById('gs-panel')?.classList.remove('open');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !e.target.matches('input, textarea, select') && document.getElementById('gs-input')) {
        e.preventDefault();
        document.getElementById('gs-input').focus();
      }
    });
  }
}

export function roleLabel(role) {
  return ({ owner: 'Owner', edit: 'Edit access', view: 'View only' })[role] || role || '';
}

// ---------- auth views ----------
function authFrame(inner) {
  app.dataset.shell = '';
  app.innerHTML = `
    <div class="auth-wrap"><div class="auth-card">
      <div class="auth-logo">${ICONS.logo}<span class="wm-name">MidRound</span></div>
      <div class="auth-tagline">The tactical command center for Counter-Strike teams</div>
      <div class="panel">${inner}</div>
      <div id="auth-extra"></div>
    </div></div>`;
}

function viewLogin() {
  authFrame(`
    <div id="auth-err"></div>
    <form id="login-form">
      <div class="field"><label>Email</label><input type="email" name="email" required autocomplete="username" autofocus></div>
      <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password"></div>
      <button class="btn primary" type="submit" style="width:100%">Sign in</button>
    </form>
    <div class="auth-switch">New team? <a href="#/register">Create an account</a></div>
    <div class="demo-box">
      <b>Demo workspace</b> — sign in as the IGL: <code>morgan@northlight.gg</code> / <code>demo1234</code><br>
      Also seeded: coach <code>dana@…</code>, analyst <code>priya@…</code>, players <code>riley@…</code>, <code>alex@…</code>, <code>sam@…</code>, <code>jordan@…</code>, owner <code>casey@northlight.gg</code> (same password).
    </div>`);
  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api.post('/api/auth/login', { email: f.get('email'), password: f.get('password') });
      await loadMe();
      const after = sessionStorage.getItem('mr.afterLogin') || localStorage.getItem('mr.route')?.replace(/^#/, '') || '/';
      sessionStorage.removeItem('mr.afterLogin');
      app.dataset.shell = '';
      nav(after);
    } catch (err) {
      document.getElementById('auth-err').innerHTML = `<div class="auth-err">${esc(err.message)}</div>`;
    }
  };
}

function viewRegister() {
  authFrame(`
    <div id="auth-err"></div>
    <form id="reg-form">
      <div class="field"><label>Name</label><input name="name" required placeholder='e.g. Morgan "Vector" Hale'></div>
      <div class="field"><label>Email</label><input type="email" name="email" required autocomplete="username"></div>
      <div class="field"><label>Password (8+ characters)</label><input type="password" name="password" required minlength="8" autocomplete="new-password"></div>
      <div class="field"><label>Invite code (if joining an existing team)</label><input name="invite" placeholder="Paste invite code"></div>
      <div class="field" id="org-fields">
        <label>…or create a new organization</label>
        <input name="orgName" placeholder="Organization name">
        <div style="height:8px"></div>
        <input name="teamName" placeholder="Team name (default: Main Team)">
      </div>
      <button class="btn primary" type="submit" style="width:100%">Create account</button>
    </form>
    <div class="auth-switch">Already have an account? <a href="#/login">Sign in</a></div>`);
  document.getElementById('reg-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api.post('/api/auth/register', {
        name: f.get('name'), email: f.get('email'), password: f.get('password'),
        invite: f.get('invite')?.trim() || undefined,
        orgName: f.get('orgName')?.trim() || undefined,
        teamName: f.get('teamName')?.trim() || undefined,
      });
      await loadMe();
      app.dataset.shell = '';
      nav('/');
    } catch (err) {
      document.getElementById('auth-err').innerHTML = `<div class="auth-err">${esc(err.message)}</div>`;
    }
  };
}

// ---------- recents helper ----------
export function trackView(type, id) {
  api.post('/api/recents', { item_type: type, item_id: id }).catch(() => {});
}

// ---------- boot ----------
window.addEventListener('hashchange', route);
initSelectDropdowns();

(async function boot() {
  const ok = await loadMe();
  if (ok && (!location.hash || location.hash === '#/')) {
    const saved = localStorage.getItem('mr.route');
    if (saved && saved !== location.hash) { location.hash = saved; return; }
  }
  if (!ok && !['#/login', '#/register'].includes(location.hash)) {
    nav('/login');
    if (location.hash === '#/login') route();
    return;
  }
  route();
})();
