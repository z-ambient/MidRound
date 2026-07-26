// Shared UI helpers: escaping, badges, toasts, confirm dialogs, formatting.

export function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function sideBadge(side) {
  if (side === 'T') return '<span class="badge t">T SIDE</span>';
  if (side === 'CT') return '<span class="badge ct">CT SIDE</span>';
  return '';
}

export function statusBadge(status) {
  if (status === 'draft') return '<span class="badge draft">DRAFT</span>';
  if (status === 'archived') return '<span class="badge archived">ARCHIVED</span>';
  return '';
}

export function badge(text, cls = 'neutral') {
  return text ? `<span class="badge ${cls}">${esc(text)}</span>` : '';
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function fmtRel(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function toast(msg, cls = '') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <h3>${esc(title)}</h3>
          <p>${esc(message)}</p>
          <div class="modal-actions">
            <button class="btn" data-act="cancel">Cancel</button>
            <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(confirmText)}</button>
          </div>
        </div>
      </div>`;
    const done = (v) => { root.innerHTML = ''; resolve(v); };
    root.querySelector('[data-act="cancel"]').onclick = () => done(false);
    root.querySelector('[data-act="ok"]').onclick = () => done(true);
    root.querySelector('.modal-backdrop').onclick = (e) => { if (e.target.classList.contains('modal-backdrop')) done(false); };
    root.querySelector('[data-act="ok"]').focus();
  });
}

export function inputDialog({ title, label, placeholder = '', confirmText = 'Create', initial = '', options = [], hint = '' }) {
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <h3>${esc(title)}</h3>
          <form id="modal-form">
            <div class="field">
              <label>${esc(label)}</label>
              <input name="value" required placeholder="${esc(placeholder)}" value="${esc(initial)}" autocomplete="off" ${options.length ? 'list="modal-datalist"' : ''}>
              ${options.length ? `<datalist id="modal-datalist">${options.map(o => `<option value="${esc(o)}"></option>`).join('')}</datalist>` : ''}
            </div>
            ${hint ? `<p class="small muted" style="margin:-6px 0 12px">${esc(hint)}</p>` : ''}
            <div class="modal-actions">
              <button class="btn" type="button" data-act="cancel">Cancel</button>
              <button class="btn primary" type="submit">${esc(confirmText)}</button>
            </div>
          </form>
        </div>
      </div>`;
    const done = (v) => { root.innerHTML = ''; resolve(v); };
    const input = root.querySelector('input');
    input.focus();
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    root.querySelector('[data-act="cancel"]').onclick = () => done(null);
    root.querySelector('.modal-backdrop').onclick = (e) => { if (e.target.classList.contains('modal-backdrop')) done(null); };
    root.querySelector('#modal-form').onsubmit = (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (v) done(v);
    };
  });
}

export function emptyState(title, hint) {
  return `<div class="empty"><b>${esc(title)}</b>${hint ? esc(hint) : ''}</div>`;
}

export function spinner(label = 'Loading…') {
  return `<div class="empty" aria-busy="true">${esc(label)}</div>`;
}

export function tagsHtml(tags) {
  return (tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
}

export function opt(value, label, selected) {
  return `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(label)}</option>`;
}

export const ICONS = {
  dashboard: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1"/><rect x="9" y="9" width="5.5" height="5.5" rx="1"/></svg>',
  strategies: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h12M2 8h12M2 13h8"/></svg>',
  maps: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 3.5l4-1.5 5 1.5 4-1.5v10l-4 1.5-5-1.5-4 1.5z"/><path d="M5.5 2v10.5M10.5 3.5V14"/></svg>',
  opponents: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.5"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2"/></svg>',
  matches: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>',
  team: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5.5" cy="5" r="2.5"/><circle cx="11" cy="6" r="2"/><path d="M1.5 13.5c0-2.2 1.8-4 4-4s4 1.8 4 4M9.5 13.5c0-1.8 1.2-3.3 2.8-3.8 1.4.4 2.2 1.8 2.2 3.8"/></svg>',
  search: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
  play: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>',
  star: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6z"/></svg>',
  starFill: '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6z"/></svg>',
  pin: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9.5 1.5l5 5-3 1-3.5 3.5-.5 3.5-2.5-2.5L1.5 15M5 11l-3.5 3.5M8.5 5l-4 1 3 3"/></svg>',
  logo: '<svg width="26" height="26" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#16222f" stroke="#2e4155"/><circle cx="16" cy="16" r="9" fill="none" stroke="#fafbfc" stroke-width="2"/><circle cx="16" cy="16" r="2.6" fill="#fafbfc"/><path d="M16 7v4M16 21v4M7 16h4M21 16h4" stroke="#fafbfc" stroke-width="1.6"/></svg>',
};

// Turns textarea content (one item per line) into a clean string array.
export function linesToArr(text) {
  return String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
}
export function arrToLines(arr) {
  return (arr || []).join('\n');
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---- themed dropdowns: auto-replace native <select> elements ----
// The real select stays (hidden) inside the wrapper so forms (FormData), value
// reads, and change handlers keep working; we sync it and dispatch 'change'.
const DD_CHEV = '<svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>';

function ddClose(wrap) {
  const menu = wrap.querySelector('.dd-menu');
  if (menu && !menu.hidden) {
    menu.hidden = true;
    // works for enhanced selects (.dd-btn) and custom .dd widgets (e.g. profile)
    wrap.querySelector('[aria-haspopup]')?.setAttribute('aria-expanded', 'false');
  }
}
function ddCloseAll(except) {
  document.querySelectorAll('.dd').forEach(w => { if (w !== except) ddClose(w); });
}

export function enhanceSelect(sel) {
  if (sel.dataset.dd || sel.multiple || sel.size > 1) return;
  sel.dataset.dd = '1';
  const wrap = document.createElement('div');
  wrap.className = 'dd';
  if (sel.classList.contains('grow')) wrap.classList.add('grow');
  if (sel.style.width === 'auto') wrap.classList.add('dd-auto');
  sel.parentNode.insertBefore(wrap, sel);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (sel.getAttribute('aria-label')) btn.setAttribute('aria-label', sel.getAttribute('aria-label'));
  const menu = document.createElement('div');
  menu.className = 'dd-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  wrap.append(sel, btn, menu);

  const renderBtn = () => {
    const o = sel.options[sel.selectedIndex];
    btn.innerHTML = `<span class="dd-cur">${o ? (esc(o.textContent.trim()) || '&nbsp;') : '&nbsp;'}</span>${DD_CHEV}`;
    btn.disabled = sel.disabled;
  };
  const renderMenu = () => {
    menu.innerHTML = [...sel.options].map((o, i) => `
      <button type="button" class="dd-item ${i === sel.selectedIndex ? 'active' : ''}" role="option"
        aria-selected="${i === sel.selectedIndex}" data-i="${i}" ${o.disabled ? 'disabled' : ''}>
        ${esc(o.textContent.trim()) || '&nbsp;'}
      </button>`).join('');
  };
  btn.addEventListener('click', () => {
    const open = menu.hidden;
    ddCloseAll(wrap);
    if (open) renderMenu();
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  menu.addEventListener('click', (e) => {
    const it = e.target.closest('[data-i]');
    if (!it) return;
    const i = Number(it.dataset.i);
    if (sel.selectedIndex !== i) {
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    renderBtn();
    ddClose(wrap);
  });
  sel.addEventListener('change', renderBtn);
  renderBtn();
}

// gives a primary button the animated shine treatment: adds the class and
// wraps its content in a span so the text stays above the shimmer layer
function enhanceShine(btn) {
  if (btn.dataset.shine) return;
  btn.dataset.shine = '1';
  btn.classList.add('shine-cta');
  const span = document.createElement('span');
  span.className = 'shine-in';
  while (btn.firstChild) span.appendChild(btn.firstChild);
  btn.appendChild(span);
}

export function initSelectDropdowns() {
  const enhanceAll = (root) => {
    root.querySelectorAll('select').forEach(enhanceSelect);
    root.querySelectorAll('.btn.primary').forEach(enhanceShine);
  };
  enhanceAll(document);
  new MutationObserver((muts) => {
    for (const mu of muts) for (const n of mu.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.tagName === 'SELECT') enhanceSelect(n);
      else if (n.matches && n.matches('.btn.primary')) enhanceShine(n);
      if (n.querySelectorAll) enhanceAll(n);
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', (e) => {
    // a click can re-render the node it hit (menu item selection); a detached
    // target can't tell us which dropdown it was in, so never treat it as outside
    if (!e.target.isConnected) return;
    ddCloseAll(e.target.closest('.dd'));
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ddCloseAll(); });
}
