'use strict';

// The page only renders. The host (src/Launcher.cs) owns processes, rotation and files and
// pushes { type: 'state' } messages. Outside the app, a small in-page mock stands in for previews.
// A "manual" session (started from Game Time or Library) is Game Time; an auto rotation is Game Variety.
const bridge = window.chrome && window.chrome.webview ? window.chrome.webview : null;
const CATALOG_URL = bridge ? 'games.json' : '../data/games.json';
const ROW = 40;
const VIEWS = ['variety', 'gametime', 'library', 'history', 'settings'];
const SLIDER_MAX = 120;

const icons = {
  play: '<svg viewBox="0 0 16 16"><path class="fill" d="M5 3.6v8.8c0 .6.6.9 1.1.6l7-4.4c.5-.3.5-.9 0-1.2l-7-4.4C5.6 2.7 5 3 5 3.6z"/></svg>',
  stop: '<svg viewBox="0 0 16 16"><rect class="fill" x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
  skip: '<svg viewBox="0 0 16 16"><path class="fill" d="M3.5 4v8c0 .5.6.8 1 .5l5.6-4c.4-.3.4-.8 0-1l-5.6-4c-.4-.3-1 0-1 .5z"/><rect class="fill" x="11" y="3.5" width="1.8" height="9" rx=".9"/></svg>',
  swap: '<svg viewBox="0 0 16 16"><path d="M4.5 2.5 2 5l2.5 2.5M2 5h10M11.5 13.5 14 11l-2.5-2.5M14 11H4"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  rotate: '<svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 0 1-9.6 3.7"/><path d="M2.5 8a5.5 5.5 0 0 1 9.6-3.7"/><path d="M12.5 1.8v2.7H9.8"/><path d="M3.5 14.2v-2.7h2.7"/></svg>',
  search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>',
  history: '<svg viewBox="0 0 16 16"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v2.5H5"/><path d="M8 5.5V8l1.8 1.2"/></svg>',
  game: '<svg viewBox="0 0 16 16"><path d="M5 7h3M6.5 5.5v3"/><circle class="fill" cx="10.5" cy="7.5" r=".8"/><circle class="fill" cx="12" cy="6" r=".8"/><path d="M11.6 3H4.4a2.6 2.6 0 0 0-2.6 2.3L1.4 9.6a2 2 0 0 0 3.5 1.6L6 10h4l1.1 1.2a2 2 0 0 0 3.5-1.6l-.4-4.3A2.6 2.6 0 0 0 11.6 3z"/></svg>',
  arrow: '<svg viewBox="0 0 16 16"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
  info: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 7.5v3M8 5.5h.01"/></svg>'
};

const $ = (selector) => document.querySelector(selector);
const els = {
  search: $('#search'), clear: $('#clear-search'), count: $('#count'), list: $('#list'), inner: $('#list-inner'),
  empty: $('#list-empty'), inspector: $('#inspector'), now: $('#now'),
  varietyStage: $('#variety-stage'), varietyActions: $('#variety-actions'),
  presets: $('#presets'), minMinutes: $('#min-minutes'), maxMinutes: $('#max-minutes'),
  rangeMin: $('#range-min'), rangeMax: $('#range-max'), rangeFill: $('#dual-fill'),
  durationReadout: $('#duration-readout'), durationDesc: $('#duration-desc'),
  order: $('#order'), pool: $('#pool'), poolAllDesc: $('#pool-all-desc'), poolFilterDesc: $('#pool-filter-desc'),
  historyStrip: $('#history-strip'),
  gtActive: $('#gt-active'), gtPickerTitle: $('#gt-picker-title'), gtSearch: $('#gt-search'), gtClear: $('#gt-clear'),
  gtResults: $('#gt-results'), gtSelection: $('#gt-selection'),
  history: $('#history'), historyReset: $('#history-reset'),
  palette: $('#palette'), paletteInput: $('#palette-input'), paletteList: $('#palette-list'),
  toasts: $('#toasts'), modal: $('#modal'), modalText: $('#modal-text')
};

let games = [];
let byId = new Map();
let catalog = { date: '', count: 0 };
let matches = [];      // games matching the library filter text
let visible = [];      // matches after the All / Not rotated / Rotated tab
let filterMode = 'all';
let selectedId = null;
let selectedExe = 0;
let played = new Set();
let playedOrder = [];
let view = 'variety';
let paletteItems = [];
let paletteIndex = 0;
let gtSelectedId = null;
let gtExe = 0;
let gtList = [];
let recent = loadRecent();
let host = {
  running: null,
  auto: { active: false, completed: false, position: 0, total: 0, next: [] },
  settings: { minMinutes: 10, maxMinutes: 15, order: 'random', onlyMatches: false },
  stats: { varietySeconds: 0, gameTimeSeconds: 0, longestSeconds: 0, sessions: 0, legacyGames: 0, legacySeconds: 0, since: Date.now() }
};

/* ---------- helpers ---------- */

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = (n) => n.toLocaleString('en-US');
const plural = (n, word) => `${number(n)} ${word}${n === 1 ? '' : 's'}`;

function hue(id) {
  let h = 17;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}

function initials(name) {
  const words = String(name).match(/[\p{L}\p{N}]+/gu) || [];
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

function avatar(game, size = '') {
  return `<div class="av ${size}" style="--h:${hue(game.id)}" aria-hidden="true">${escapeHtml(initials(game.name))}</div>`;
}

function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function span(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes / 60) % 24, mins = minutes % 60;
  if (days > 0) return hours ? `${number(days)}d ${hours}h` : `${number(days)}d`;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

const timeOfDay = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const rangeText = (s) => (s.minMinutes === s.maxMinutes ? `${s.minMinutes} min` : `${s.minMinutes}–${s.maxMinutes} min`);

function exeFile(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1];
}

function send(message) {
  if (bridge) bridge.postMessage(message);
  else mock.receive(message);
}

const isRunning = (id) => !!(host.running && host.running.id === id);
const manualSession = () => (host.running && !host.auto.active ? host.running : null);

// Recently used Game Time games are a per-viewer convenience, so browser storage is enough.
function loadRecent() {
  try { return JSON.parse(localStorage.getItem('bb.recent') || '[]').filter((id) => typeof id === 'string').slice(0, 6); }
  catch (e) { return []; }
}

function rememberRecent(id) {
  recent = [id].concat(recent.filter((r) => r !== id)).slice(0, 6);
  try { localStorage.setItem('bb.recent', JSON.stringify(recent)); } catch (e) { /* storage unavailable */ }
}

/* ---------- navigation ---------- */

function go(name) {
  if (!VIEWS.includes(name)) return;
  view = name;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('is-active', a.dataset.view === name));
  $('#open-settings').classList.toggle('is-active', name === 'settings');
  renderView();
}

function renderView() {
  if (view === 'library') { renderList(); renderInspector(); }
  else if (view === 'variety') renderVariety();
  else if (view === 'gametime') renderGameTime();
  else if (view === 'history') renderHistory();
  else if (view === 'settings') renderSettings();
}

function renderNav() {
  const a = host.auto, manual = manualSession();
  $('#nav-count-library').textContent = number(games.length);
  $('#nav-count-history').textContent = played.size ? number(played.size) : '';
  $('#nav-variety').innerHTML = a.active ? `<span class="live-dot"></span>${number(a.position)}/${number(a.total)}` : '';
  $('#nav-gametime').innerHTML = manual ? '<span class="live-dot"></span>' : '';

  const r = host.running;
  if (!r) {
    els.now.innerHTML = '<div class="now-idle"><i></i>Nothing playing</div>';
    return;
  }
  const game = byId.get(r.id) || { id: r.id, name: r.name };
  els.now.innerHTML = `<div class="now-card" id="now-card" role="button" tabindex="0">
      <div class="now-row">${avatar(game, 'av-md')}
        <div class="now-text">
          <div class="now-label"><span class="live-dot"></span>${a.active ? 'Variety · <span data-remaining>--:--</span> left' : 'Game Time'}</div>
          <div class="now-name">${escapeHtml(game.name)}</div>
        </div>
        <button class="btn btn-ghost btn-icon" id="now-stop" data-tip="Stop">${icons.stop}</button>
      </div>
      ${a.active ? '<div class="now-bar"><i data-progress></i></div>' : ''}
    </div>`;
  $('#now-card').addEventListener('click', (e) => { if (!e.target.closest('#now-stop')) go(a.active ? 'variety' : 'gametime'); });
  $('#now-stop').addEventListener('click', () => send({ type: 'stop' }));
  tick();
}

/* ---------- library ---------- */

function applyFilter(keepScroll) {
  const query = els.search.value.trim().toLowerCase();
  els.clear.hidden = query.length === 0;
  matches = query ? games.filter((g) => g.lower.includes(query)) : games;
  visible = filterMode === 'all' ? matches : matches.filter((g) => played.has(g.id) === (filterMode === 'played'));
  els.count.textContent = visible.length === games.length ? plural(games.length, 'game') : `${number(visible.length)} of ${plural(games.length, 'game')}`;
  if (!visible.some((g) => g.id === selectedId)) setSelected(visible.length ? visible[0].id : null);
  if (!keepScroll) els.list.scrollTop = 0;
  els.empty.hidden = visible.length > 0;
  if (!visible.length) {
    const title = query ? 'No games found' : filterMode === 'played' ? 'Nothing rotated yet' : 'Every game has been rotated';
    const text = query ? `Nothing in the catalog matches “${escapeHtml(els.search.value.trim())}”.`
      : filterMode === 'played' ? 'Games played by Game Variety appear here.' : 'Reset the history to rotate through them again.';
    els.empty.innerHTML = `<div class="empty-icon">${icons.search}</div><div class="empty-title">${title}</div><div>${text}</div>` +
      (query || filterMode !== 'all' ? '<button class="btn btn-secondary" id="empty-reset">Clear filters</button>' : '');
    const reset = $('#empty-reset');
    if (reset) reset.addEventListener('click', clearFilters);
  }
  renderList();
  renderInspector();
}

function clearFilters() {
  els.search.value = '';
  setFilterMode('all');
}

function setFilterMode(mode) {
  filterMode = mode;
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('is-active', b.dataset.filter === mode));
  applyFilter(false);
}

function renderList() {
  if (view !== 'library') return;
  els.inner.style.height = `${visible.length * ROW}px`;
  const top = els.list.scrollTop, height = els.list.clientHeight || 600;
  const first = Math.max(0, Math.floor(top / ROW) - 8);
  const last = Math.min(visible.length, Math.ceil((top + height) / ROW) + 8);
  let html = '';
  for (let i = first; i < last; i++) {
    const g = visible[i];
    const isPlayed = played.has(g.id);
    const status = isRunning(g.id) ? '<span class="badge badge-live"><i></i>Playing</span>'
      : isPlayed ? '<span class="badge badge-neutral">Rotated</span>' : '<span class="muted">—</span>';
    const more = g.executables.length > 1 ? `<em>+${g.executables.length - 1}</em>` : '';
    html += `<div class="row${g.id === selectedId ? ' is-selected' : ''}${isPlayed ? ' is-played' : ''}" data-id="${g.id}" style="top:${i * ROW}px">` +
      `<div class="cell-name">${avatar(g)}<span>${escapeHtml(g.name)}</span></div>` +
      `<div class="cell-exe">${escapeHtml(exeFile(g.executables[0].path))}${more}</div>` +
      `<div class="cell-status">${status}</div></div>`;
  }
  els.inner.innerHTML = html;
}

function setSelected(id) {
  selectedId = id;
  selectedExe = host.running && host.running.id === id ? host.running.exeIndex : 0;
}

function select(id, scroll) {
  if (id === selectedId) return;
  setSelected(id);
  renderList();
  renderInspector();
  if (scroll) scrollToSelected();
}

function scrollToSelected() {
  const index = visible.findIndex((g) => g.id === selectedId);
  if (index < 0) return;
  const top = index * ROW, list = els.list;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + ROW > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW - list.clientHeight;
}

function move(delta) {
  if (!visible.length) return;
  const index = visible.findIndex((g) => g.id === selectedId);
  const next = Math.max(0, Math.min(visible.length - 1, index < 0 ? 0 : index + delta));
  select(visible[next].id, true);
}

// Shows a game in the library, clearing filters that would hide it.
function reveal(id) {
  const game = byId.get(id);
  if (!game) return;
  go('library');
  if (!visible.includes(game)) clearFilters();
  select(id, false);
  requestAnimationFrame(scrollToSelected);
}

function playLabel(game, exe) {
  const r = host.running, autoOn = host.auto.active;
  const sameGame = r && r.id === game.id, sameExe = sameGame && r.exeIndex === exe;
  if (sameExe && !autoOn) return { label: 'Playing now', icon: icons.check, disabled: true };
  if (sameExe) return { label: 'Keep playing, end Game Variety', icon: icons.play };
  if (sameGame) return { label: 'Switch to this executable', icon: icons.swap };
  if (r) return { label: autoOn ? 'Play instead of Game Variety' : 'Switch to this game', icon: icons.swap };
  return { label: 'Play', icon: icons.play };
}

function play(id, exe) {
  const game = byId.get(id);
  if (!game) return;
  const r = host.running;
  if (r && r.id === game.id && r.exeIndex === exe && !host.auto.active) return;
  send({ type: 'start', id: game.id, exe });
}

const playSelected = () => play(selectedId, selectedExe);

function renderInspector() {
  if (view !== 'library') return;
  const game = byId.get(selectedId);
  if (!game) {
    els.inspector.innerHTML = `<div class="insp-empty"><div class="empty-icon">${icons.game}</div>Select a game to see its details.</div>`;
    return;
  }
  const running = isRunning(game.id), rotated = played.has(game.id);
  const action = playLabel(game, selectedExe);
  const note = host.auto.active && !running
    ? '<p class="insp-note is-warn">Playing this yourself ends Game Variety.</p>'
    : '<p class="insp-note">A tiny placeholder runs under this executable name. If Discord doesn\'t detect it, stop and try another executable.</p>';

  els.inspector.innerHTML = `
    <div class="insp-head">
      ${avatar(game, 'av-lg')}
      <div class="insp-title">${escapeHtml(game.name)}</div>
      <div class="insp-id">ID ${game.id}</div>
    </div>
    <div class="insp-section">
      <dl class="props">
        <dt>Status</dt><dd>${running ? '<span class="badge badge-live"><i></i>Playing</span>' : '<span class="badge badge-neutral">Idle</span>'}</dd>
        <dt>Rotation</dt><dd>${rotated ? 'Already rotated' : 'Not rotated yet'}</dd>
        <dt>Executables</dt><dd>${game.executables.length}</dd>
      </dl>
    </div>
    <div class="insp-section">
      <div class="insp-label"><span>Executable</span>${game.executables.length > 1 ? `<span>${game.executables.length} options</span>` : ''}</div>
      <div class="variants">${variantList(game, selectedExe, 'variant')}</div>
    </div>
    <div class="insp-actions">
      <button class="btn btn-accent btn-lg btn-block" id="play" ${action.disabled ? 'disabled' : ''}>${action.icon}${action.label}</button>
      ${running ? `<button class="btn btn-secondary btn-block" id="insp-stop">${icons.stop}Stop</button>` : ''}
      ${note}
    </div>`;
  els.inspector.querySelectorAll('input[name="variant"]').forEach((input) =>
    input.addEventListener('change', () => { selectedExe = Number(input.value); renderInspector(); }));
  $('#play').addEventListener('click', playSelected);
  const stop = $('#insp-stop');
  if (stop) stop.addEventListener('click', () => send({ type: 'stop' }));
}

function variantList(game, current, name) {
  return game.executables.map((e, i) => `
    <label class="variant${i === current ? ' is-selected' : ''}">
      <input type="radio" name="${name}" value="${i}" ${i === current ? 'checked' : ''}>
      <span class="radio"></span>
      <span class="variant-path">${escapeHtml(e.path + (e.arguments ? ' ' + e.arguments : ''))}</span>
    </label>`).join('');
}

/* ---------- Game Variety ---------- */

function poolGames() {
  return host.settings.onlyMatches ? matches : games;
}

const unplayedCount = (list) => list.reduce((n, g) => n + (played.has(g.id) ? 0 : 1), 0);

function estimate(count, s) {
  const r = host.running, a = host.auto;
  const current = a.active && r ? Math.max(0, r.duration - (Date.now() - r.startedAt)) / 60000 : 0;
  return (s.minMinutes === s.maxMinutes ? '' : '~') + span(Math.ceil(count * (s.minMinutes + s.maxMinutes) / 2 + current));
}

function renderVariety() {
  if (view !== 'variety') return;
  const s = host.settings, a = host.auto, r = host.running;
  const eligible = unplayedCount(poolGames());

  els.varietyActions.innerHTML = a.active
    ? `<button class="btn btn-secondary" id="v-skip">${icons.skip}Skip game</button><button class="btn btn-primary" id="v-stop">${icons.stop}Stop</button>`
    : '';

  if (a.active && r) {
    const game = byId.get(r.id) || { id: r.id, name: r.name };
    const left = Math.max(0, a.total - a.position);
    const upNext = a.next.length
      ? a.next.map((n, i) => `<div class="upnext-row${i === 0 ? ' is-first' : ''}"><b>${i + 1}</b>${avatar(n)}<span>${escapeHtml(n.name)}</span></div>`).join('')
      : '<div class="upnext-row"><span>This is the last game in this run.</span></div>';
    els.varietyStage.innerHTML = `
      <div class="run">
        <div class="run-top">
          ${avatar(game, 'av-xl')}
          <div style="min-width:0">
            <div class="kicker"><span class="pulse"></span>Now playing · game ${number(a.position)} of ${number(a.total)}</div>
            <div class="run-name">${escapeHtml(game.name)}</div>
            <code>${escapeHtml(r.exe)}</code>
          </div>
          <div class="run-left"><div class="run-left-value" data-remaining>--:--</div><div class="run-left-label">until the next game</div></div>
        </div>
        <div class="run-bar"><i data-progress></i></div>
        <div class="run-meta"><span>Started ${timeOfDay(r.startedAt)} · played <span data-elapsed>00:00</span></span><span>Random stop at ${clock(r.duration)}</span></div>
        <div class="run-bottom">
          <div><div class="run-label">Up next</div>${upNext}</div>
          <div>
            <div class="run-label">This run</div>
            <dl class="run-stats">
              <dt>Played</dt><dd>${number(a.position)}</dd>
              <dt>Remaining</dt><dd>${number(left)}</dd>
              <dt>Time to finish</dt><dd>${estimate(left, s)}</dd>
              <dt>Order</dt><dd>${s.order === 'alpha' ? 'Alphabetical' : 'Random'}</dd>
            </dl>
          </div>
        </div>
      </div>`;
  } else if (a.completed) {
    els.varietyStage.innerHTML = `
      <div class="complete">
        <div class="complete-icon">${icons.check}</div>
        <div class="complete-text">
          <div class="complete-title">Game Variety complete</div>
          <p>Played ${plural(a.total, 'game')} in this run. Every eligible game has now been played once.</p>
        </div>
        <div class="complete-actions">
          <button class="btn btn-secondary" id="v-done">Done</button>
          ${eligible > 0 ? `<button class="btn btn-accent" id="v-start">${icons.play}Start again</button>` : `<button class="btn btn-accent" id="v-reset-start">Reset history</button>`}
        </div>
      </div>`;
  } else {
    const manual = manualSession();
    let meta;
    if (eligible === 0) meta = '<div class="launch-meta is-warn">Every game in this pool has already been played. Reset the history to play them again.</div>';
    else if (manual) meta = `<div class="launch-meta is-warn">Starting stops your Game Time session (${escapeHtml(manual.name)}).</div>`;
    else meta = `<div class="launch-meta">About ${estimate(eligible, s)} to play them all. Games already played are skipped automatically.</div>`;
    els.varietyStage.innerHTML = `
      <div class="launch">
        <div style="min-width:0">
          <div class="kicker">Ready</div>
          <div class="launch-sentence">Play <b>${plural(eligible, 'game')}</b> in <b>${s.order === 'alpha' ? 'alphabetical' : 'random'} order</b>, <b>${rangeText(s)}</b> each.</div>
          ${meta}
        </div>
        <button class="btn btn-accent btn-xl" id="v-start" ${eligible === 0 ? 'disabled' : ''}>${icons.play}Start Game Variety</button>
      </div>`;
  }

  const bindClick = (id, fn) => { const node = $(id); if (node) node.addEventListener('click', fn); };
  bindClick('#v-start', startVariety);
  bindClick('#v-stop', () => send({ type: 'stop' }));
  bindClick('#v-skip', () => send({ type: 'skip' }));
  bindClick('#v-done', () => send({ type: 'dismissCompleted' }));
  bindClick('#v-reset-start', confirmReset);

  renderDuration();
  for (const b of els.order.children) { b.classList.toggle('is-active', b.dataset.order === s.order); b.disabled = a.active; }
  for (const b of els.pool.children) { b.classList.toggle('is-active', (b.dataset.pool === 'filter') === s.onlyMatches); b.disabled = a.active; }
  const query = els.search.value.trim();
  els.poolAllDesc.textContent = `${plural(unplayedCount(games), 'game')} not played yet`;
  els.poolFilterDesc.textContent = query ? `${number(unplayedCount(matches))} matching “${query}”` : 'Set a filter in Library first';

  els.historyStrip.innerHTML = played.size
    ? `${icons.history}<span><b>${number(played.size)}</b> ${played.size === 1 ? 'game has' : 'games have'} already been played and will be skipped.</span>
       <button class="btn btn-ghost" id="v-history">View history</button>
       <button class="btn btn-ghost" id="v-reset" ${a.active ? 'disabled' : ''}>Reset</button>`
    : `${icons.history}<span>No games played yet. Each game Game Variety plays is remembered so it never repeats.</span>`;
  bindClick('#v-history', () => go('history'));
  bindClick('#v-reset', confirmReset);
}

// Updates the duration block from host.settings without rebuilding it, so dragging stays smooth.
function renderDuration() {
  const s = host.settings, a = host.auto;
  const lo = s.minMinutes, hi = s.maxMinutes;
  const at = (v) => (Math.min(v, SLIDER_MAX) - 1) / (SLIDER_MAX - 1) * 100;
  els.durationReadout.innerHTML = lo === hi ? `${lo}<small>min</small>` : `${lo} – ${hi}<small>min</small>`;
  els.durationDesc.textContent = (lo === hi
    ? `Every game runs for exactly ${plural(lo, 'minute')}.`
    : `Each game stops at a random moment between ${lo} and ${hi} minutes.`) + (a.active ? ' Changes apply to the current game too.' : '');
  if (document.activeElement !== els.rangeMin) els.rangeMin.value = Math.min(lo, SLIDER_MAX);
  if (document.activeElement !== els.rangeMax) els.rangeMax.value = Math.min(hi, SLIDER_MAX);
  els.rangeMin.style.zIndex = lo > SLIDER_MAX - 10 ? 3 : 1;
  els.rangeFill.style.left = `${at(lo)}%`;
  els.rangeFill.style.width = `${Math.max(0, at(hi) - at(lo))}%`;
  if (document.activeElement !== els.minMinutes) els.minMinutes.value = lo;
  if (document.activeElement !== els.maxMinutes) els.maxMinutes.value = hi;
  for (const b of els.presets.children) b.classList.toggle('is-active', Number(b.dataset.min) === lo && Number(b.dataset.max) === hi);
}

function startVariety() {
  const s = host.settings;
  const message = { type: 'rotate', minMinutes: s.minMinutes, maxMinutes: s.maxMinutes, order: s.order, onlyMatches: s.onlyMatches };
  if (s.onlyMatches) message.ids = matches.map((g) => g.id);
  send(message);
}

function saveSettings(change) {
  Object.assign(host.settings, change);
  send(Object.assign({ type: 'settings' }, host.settings));
  renderVariety();
}

/* ---------- Game Time ---------- */

function gtMatches(q) {
  const starts = [], contains = [];
  for (const g of games) {
    const at = g.lower.indexOf(q);
    if (at === 0) starts.push(g); else if (at > 0 && contains.length < 50) contains.push(g);
    if (starts.length >= 50) break;
  }
  return starts.concat(contains).slice(0, 50);
}

function renderGameTime() {
  if (view !== 'gametime') return;
  const manual = manualSession(), a = host.auto;

  if (manual) {
    const game = byId.get(manual.id) || { id: manual.id, name: manual.name };
    els.gtActive.innerHTML = `
      <div class="gt-live">
        <div class="kicker"><span class="pulse"></span>Placeholder running</div>
        <div class="gt-live-main">
          ${avatar(game, 'av-xl')}
          <div style="min-width:0">
            <div class="gt-live-name">${escapeHtml(game.name)}</div>
            <div class="gt-live-sub"><code>${escapeHtml(manual.exe)}</code></div>
          </div>
        </div>
        <div class="gt-live-foot">
          <span>Since ${timeOfDay(manual.startedAt)} · stays active until you press Stop</span>
          <button class="btn btn-primary btn-xl" id="gt-stop">${icons.stop}Stop</button>
        </div>
      </div>`;
    $('#gt-stop').addEventListener('click', () => send({ type: 'stop' }));
  } else if (a.active) {
    els.gtActive.innerHTML = `<div class="history-strip">${icons.info}<span>Game Variety is running (game ${number(a.position)} of ${number(a.total)}). Playing a game here stops it.</span><button class="btn btn-ghost" id="gt-open-variety">Open Game Variety</button></div>`;
    $('#gt-open-variety').addEventListener('click', () => go('variety'));
  } else {
    els.gtActive.innerHTML = '';
  }
  els.gtPickerTitle.textContent = manual ? 'Switch to another game' : 'Choose a game';
  renderGtResults();
  renderGtSelection();
}

function renderGtResults() {
  const q = els.gtSearch.value.trim().toLowerCase();
  els.gtClear.hidden = !q;
  let label = '';
  if (q) {
    gtList = gtMatches(q);
    label = gtList.length ? '' : `<div class="gt-empty">No games match “${escapeHtml(els.gtSearch.value.trim())}”.</div>`;
  } else {
    gtList = recent.map((id) => byId.get(id)).filter(Boolean);
    label = gtList.length ? '<div class="gt-results-label">Recently used</div>' : `<div class="gt-empty">Search ${plural(games.length, 'game')} by name.</div>`;
  }
  els.gtResults.innerHTML = label + gtList.map((g) =>
    `<div class="gt-row${g.id === gtSelectedId ? ' is-selected' : ''}" data-id="${g.id}">${avatar(g)}<span>${escapeHtml(g.name)}</span>` +
    (isRunning(g.id) ? '<span class="badge badge-live" style="flex:none"><i></i>Playing</span>' : `<small>${escapeHtml(exeFile(g.executables[0].path))}</small>`) + '</div>').join('');
}

function renderGtSelection() {
  const game = byId.get(gtSelectedId);
  if (!game) { els.gtSelection.innerHTML = ''; return; }
  const action = playLabel(game, gtExe);
  const label = host.auto.active ? 'Stop Game Variety and play' : action.label;
  const note = host.auto.active
    ? '<p class="gt-note is-warn">Game Variety will stop before this game starts.</p>'
    : '<p class="gt-note">Stays active until you press Stop. No timers, no automatic stopping.</p>';
  els.gtSelection.innerHTML = `
    <div class="gt-select">
      <div class="gt-select-head">
        ${avatar(game, 'av-lg')}
        <div style="min-width:0"><div class="gt-select-name">${escapeHtml(game.name)}</div><div class="gt-select-id">ID ${game.id}</div></div>
      </div>
      ${game.executables.length > 1 ? `<div class="variants">${variantList(game, gtExe, 'gt-variant')}</div>` : ''}
      <button class="btn btn-accent btn-xl btn-block" id="gt-play" ${action.disabled ? 'disabled' : ''}>${action.icon}${label}</button>
      ${note}
    </div>`;
  els.gtSelection.querySelectorAll('input[name="gt-variant"]').forEach((input) =>
    input.addEventListener('change', () => { gtExe = Number(input.value); renderGtSelection(); }));
  $('#gt-play').addEventListener('click', () => play(game.id, gtExe));
}

function gtSelect(id) {
  gtSelectedId = id;
  gtExe = host.running && host.running.id === id ? host.running.exeIndex : 0;
  renderGtResults();
  renderGtSelection();
}

function gtMove(delta) {
  if (!gtList.length) return;
  const index = gtList.findIndex((g) => g.id === gtSelectedId);
  const next = Math.max(0, Math.min(gtList.length - 1, index < 0 ? 0 : index + delta));
  gtSelect(gtList[next].id);
  const row = els.gtResults.querySelector('.gt-row.is-selected');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

/* ---------- history + settings ---------- */

// Hours as "12.4h" (or minutes under an hour) for the History cards.
function hours(seconds) {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = seconds / 3600;
  return `${h < 100 ? h.toFixed(1) : number(Math.round(h))}h`;
}

const statCard = (label, value, sub, extra = '') =>
  `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${extra}<div class="stat-sub">${sub}</div></div>`;

function renderHistoryStats() {
  const st = host.stats, r = host.running, s = host.settings;
  const live = r ? Math.max(0, (Date.now() - r.startedAt) / 1000) : 0;
  const variety = st.varietySeconds + (r && host.auto.active ? live : 0);
  const gameTime = st.gameTimeSeconds + (r && !host.auto.active ? live : 0);
  const legacyGames = Math.max(0, st.legacyGames || 0);
  const legacySeconds = Math.max(0, st.legacySeconds || 0);
  const sessions = st.sessions + legacyGames + (r ? 1 : 0);
  const longest = Math.max(st.longestSeconds, live);
  const pct = games.length ? played.size / games.length * 100 : 0;
  const left = Math.max(0, games.length - played.size);
  const since = new Date(st.since).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  $('#history-stats').innerHTML =
    statCard('Games played', number(played.size), `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}% of ${number(games.length)} in the catalog`,
      `<div class="stat-bar"><i style="width:${Math.min(100, pct)}%"></i></div>`) +
    statCard('Hours played', hours(variety + gameTime + legacySeconds), legacyGames ? `Includes ~${hours(legacySeconds)} estimated for ${plural(legacyGames, 'earlier game')}` : `Variety ${hours(variety)} · Game Time ${hours(gameTime)}`) +
    statCard('Sessions', number(sessions), `Longest ${longest ? span(Math.max(1, Math.round(longest / 60))) : '—'}`) +
    statCard('Left to play', number(left), left ? `${estimate(left, s)} at ${rangeText(s)} each` : 'Every game has been played') +
    `<div class="stat-note">Local playtime is tracked since ${since}.${legacyGames ? ' Earlier hours are estimated from the saved rotation range; sessions include earlier games. Longest session uses tracked time only.' : ''} These totals do not measure Discord badge progress.</div>`;
}

function renderHistory() {
  if (view !== 'history') return;
  renderHistoryStats();
  els.historyReset.disabled = host.auto.active || played.size === 0;
  if (!played.size) {
    els.history.innerHTML = `<div class="empty"><div class="empty-icon">${icons.rotate}</div><div class="empty-title">No history yet</div><div>Games show up here once Game Variety has played them.</div></div>`;
    return;
  }
  const order = playedOrder.slice().reverse();
  const shown = order.slice(0, 400);
  els.history.innerHTML = `<div class="section-title">${plural(order.length, 'game')} · most recent first</div>` +
    shown.map((id, i) => {
      const g = byId.get(id) || { id, name: `Unknown game ${id}` };
      return `<div class="history-row" data-id="${id}">${avatar(g)}<span>${escapeHtml(g.name)}</span><small>#${number(order.length - i)}</small></div>`;
    }).join('') +
    (order.length > shown.length ? `<div class="history-more">and ${number(order.length - shown.length)} more</div>` : '');
}

function renderSettings() {
  $('#catalog-props').innerHTML = `
    <dt>Games</dt><dd>${number(catalog.count)}</dd>
    <dt>Snapshot</dt><dd>${catalog.date}</dd>
    <dt>Source</dt><dd><code>cdn.discordapp.com/detectables</code></dd>
    <dt>Rotated</dt><dd>${number(played.size)}</dd>`;
}

/* ---------- live timers (Game Variety only; Game Time has no timers) ---------- */

function tick() {
  const r = host.running;
  if (r && view === 'history') renderHistoryStats();
  if (!r || !host.auto.active || !r.duration) return;
  const elapsed = Date.now() - r.startedAt;
  const fraction = Math.min(1, elapsed / r.duration);
  document.querySelectorAll('[data-elapsed]').forEach((el) => { el.textContent = clock(elapsed); });
  document.querySelectorAll('[data-progress]').forEach((el) => { el.style.width = `${fraction * 100}%`; });
  document.querySelectorAll('[data-remaining]').forEach((el) => { el.textContent = clock(r.duration - elapsed); });
}

/* ---------- command palette ---------- */

const commands = () => [
  { kind: 'command', label: 'Go to Game Variety', run: () => go('variety') },
  { kind: 'command', label: 'Go to Game Time', run: () => go('gametime') },
  { kind: 'command', label: 'Go to Library', run: () => go('library') },
  { kind: 'command', label: 'Go to History', run: () => go('history') },
  { kind: 'command', label: 'Go to Settings', run: () => go('settings') },
  host.auto.active ? { kind: 'command', label: 'Skip to next game', run: () => send({ type: 'skip' }) } : null,
  host.auto.active ? { kind: 'command', label: 'Stop Game Variety', run: () => send({ type: 'stop' }) }
    : { kind: 'command', label: 'Start Game Variety', run: startVariety },
  manualSession() ? { kind: 'command', label: 'Stop Game Time', run: () => send({ type: 'stop' }) } : null,
  { kind: 'command', label: 'Open placeholder folder', run: () => send({ type: 'openFolder' }) }
].filter(Boolean);

function openPalette() {
  els.palette.hidden = false;
  els.paletteInput.value = '';
  paletteIndex = 0;
  renderPalette();
  els.paletteInput.focus();
}

function closePalette() { els.palette.hidden = true; }

function renderPalette() {
  const q = els.paletteInput.value.trim().toLowerCase();
  const cmds = commands().filter((c) => !q || c.label.toLowerCase().includes(q));
  const found = q ? gtMatches(q).slice(0, 40).map((g) => ({ kind: 'game', game: g })) : [];
  paletteItems = q ? found.concat(cmds) : cmds;
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
  if (!paletteItems.length) { els.paletteList.innerHTML = '<div class="palette-empty">No results</div>'; return; }
  let html = '', group = '';
  paletteItems.forEach((item, i) => {
    const g = item.kind === 'game' ? 'Games' : 'Commands';
    if (g !== group) { group = g; html += `<div class="palette-group">${g}</div>`; }
    html += item.kind === 'game'
      ? `<div class="palette-item${i === paletteIndex ? ' is-active' : ''}" data-index="${i}">${avatar(item.game)}<span>${escapeHtml(item.game.name)}</span>${isRunning(item.game.id) ? '<span class="badge badge-live" style="flex:none"><i></i>Playing</span>' : `<small>${escapeHtml(exeFile(item.game.executables[0].path))}</small>`}</div>`
      : `<div class="palette-item${i === paletteIndex ? ' is-active' : ''}" data-index="${i}">${icons.arrow}<span>${escapeHtml(item.label)}</span></div>`;
  });
  els.paletteList.innerHTML = html;
  const active = els.paletteList.querySelector('.is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function runPalette(index, playNow) {
  const item = paletteItems[index];
  if (!item) return;
  closePalette();
  if (item.kind === 'command') { item.run(); return; }
  reveal(item.game.id);
  if (playNow) play(item.game.id, 0);
}

/* ---------- toasts + dialog ---------- */

function toast(text, level = 'info') {
  const node = document.createElement('div');
  node.className = `toast toast-${level}`;
  node.innerHTML = `<span class="toast-dot"></span><span>${escapeHtml(text)}</span>`;
  els.toasts.appendChild(node);
  while (els.toasts.children.length > 3) els.toasts.firstChild.remove();
  setTimeout(() => { node.classList.add('is-leaving'); setTimeout(() => node.remove(), 200); }, level === 'error' ? 7000 : 4500);
}

function confirmReset() {
  if (host.auto.active || !played.size) return;
  els.modalText.textContent = `${plural(played.size, 'game')} will become eligible for Game Variety again. Games you play with Game Time are not affected.`;
  els.modal.hidden = false;
  $('#modal-cancel').focus();
}

/* ---------- host messages ---------- */

function receive(message) {
  if (message.type === 'notice') { toast(message.text, message.level); return; }
  if (message.type !== 'state') return;
  host = { running: message.running, auto: message.auto, settings: message.settings, stats: message.stats || host.stats };
  playedOrder = message.played;
  played = new Set(playedOrder);
  const manual = manualSession();
  if (manual && recent[0] !== manual.id) rememberRecent(manual.id);
  applyFilter(true);
  renderNav();
  renderView();
}

/* ---------- wiring ---------- */

function bind() {
  $('#open-repo').addEventListener('click', (e) => { if (bridge) { e.preventDefault(); send({ type: 'openRepo' }); } });
  document.querySelectorAll('.nav-item').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.view); }));
  $('#open-settings').addEventListener('click', () => go('settings'));
  $('#open-palette').addEventListener('click', openPalette);

  // Library
  els.search.addEventListener('input', () => applyFilter(false));
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { move(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { move(-1); e.preventDefault(); }
    else if (e.key === 'Enter') { playSelected(); e.preventDefault(); }
    else if (e.key === 'Escape') { els.search.value = ''; applyFilter(false); }
  });
  els.clear.addEventListener('click', () => { els.search.value = ''; applyFilter(false); els.search.focus(); });
  document.querySelectorAll('#filters button').forEach((b) => b.addEventListener('click', () => setFilterMode(b.dataset.filter)));
  els.list.addEventListener('scroll', () => requestAnimationFrame(renderList), { passive: true });
  window.addEventListener('resize', () => renderList());
  els.inner.addEventListener('click', (e) => { const row = e.target.closest('.row'); if (row) select(row.dataset.id, false); });
  els.inner.addEventListener('dblclick', (e) => { const row = e.target.closest('.row'); if (row) { select(row.dataset.id, false); playSelected(); } });
  els.list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { move(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { move(-1); e.preventDefault(); }
    else if (e.key === 'Enter') playSelected();
  });

  // Game Variety: duration slider, inputs, presets, order and pool
  const dragRange = (which) => {
    const s = host.settings;
    let lo = Number(els.rangeMin.value), hi = Number(els.rangeMax.value);
    // Keep a typed value above the slider's range unless that handle is the one being dragged.
    if (which === 'min') { if (s.maxMinutes > SLIDER_MAX && hi === SLIDER_MAX) hi = s.maxMinutes; if (lo > hi) { hi = lo; els.rangeMax.value = lo; } }
    else if (hi < lo) { lo = hi; els.rangeMin.value = hi; }
    s.minMinutes = lo; s.maxMinutes = hi;
    renderDuration();
  };
  els.rangeMin.addEventListener('input', () => dragRange('min'));
  els.rangeMax.addEventListener('input', () => dragRange('max'));
  els.rangeMin.addEventListener('change', () => saveSettings({}));
  els.rangeMax.addEventListener('change', () => saveSettings({}));
  els.presets.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) saveSettings({ minMinutes: Number(b.dataset.min), maxMinutes: Number(b.dataset.max) });
  });
  const readRange = () => {
    const clamp = (input, fallback) => Math.max(1, Math.min(1440, Math.round(Number(input.value)) || fallback));
    const low = clamp(els.minMinutes, host.settings.minMinutes), high = clamp(els.maxMinutes, host.settings.maxMinutes);
    saveSettings({ minMinutes: Math.min(low, high), maxMinutes: Math.max(low, high) });
  };
  els.minMinutes.addEventListener('change', readRange);
  els.maxMinutes.addEventListener('change', readRange);
  els.order.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) saveSettings({ order: b.dataset.order }); });
  els.pool.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) saveSettings({ onlyMatches: b.dataset.pool === 'filter' }); });
  document.querySelectorAll('.dual-scale span').forEach((label) => {
    const minutes = { '1m': 1, '30m': 30, '60m': 60, '90m': 90, '2h': 120 }[label.textContent];
    label.style.left = `${(minutes - 1) / (SLIDER_MAX - 1) * 100}%`;
  });

  // Game Time picker
  els.gtSearch.addEventListener('input', () => {
    renderGtResults();
    if (gtList.length && !gtList.some((g) => g.id === gtSelectedId) && els.gtSearch.value.trim()) gtSelect(gtList[0].id);
  });
  els.gtSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { gtMove(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { gtMove(-1); e.preventDefault(); }
    else if (e.key === 'Enter' && gtSelectedId) { play(gtSelectedId, gtExe); e.preventDefault(); }
    else if (e.key === 'Escape') { els.gtSearch.value = ''; renderGtResults(); }
  });
  els.gtClear.addEventListener('click', () => { els.gtSearch.value = ''; renderGtResults(); els.gtSearch.focus(); });
  els.gtResults.addEventListener('click', (e) => { const row = e.target.closest('.gt-row'); if (row) gtSelect(row.dataset.id); });
  els.gtResults.addEventListener('dblclick', (e) => { const row = e.target.closest('.gt-row'); if (row) { gtSelect(row.dataset.id); play(row.dataset.id, gtExe); } });

  // History, settings, dialog
  els.historyReset.addEventListener('click', confirmReset);
  els.history.addEventListener('click', (e) => { const row = e.target.closest('.history-row'); if (row) reveal(row.dataset.id); });
  $('#settings-folder').addEventListener('click', () => send({ type: 'openFolder' }));
  $('#modal-cancel').addEventListener('click', () => { els.modal.hidden = true; });
  $('#modal-confirm').addEventListener('click', () => { els.modal.hidden = true; send({ type: 'resetHistory' }); });
  els.modal.addEventListener('mousedown', (e) => { if (e.target === els.modal) els.modal.hidden = true; });

  // Command palette
  els.paletteInput.addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
  els.paletteInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1); renderPalette(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { paletteIndex = Math.max(0, paletteIndex - 1); renderPalette(); e.preventDefault(); }
    else if (e.key === 'Enter') { runPalette(paletteIndex, e.ctrlKey); e.preventDefault(); }
  });
  els.paletteList.addEventListener('mousemove', (e) => {
    const item = e.target.closest('.palette-item');
    if (item && Number(item.dataset.index) !== paletteIndex) { paletteIndex = Number(item.dataset.index); renderPalette(); }
  });
  els.paletteList.addEventListener('click', (e) => { const item = e.target.closest('.palette-item'); if (item) runPalette(Number(item.dataset.index), e.ctrlKey); });
  els.palette.addEventListener('mousedown', (e) => { if (e.target === els.palette) closePalette(); });

  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
    if (e.key === 'Escape') {
      if (!els.palette.hidden) { closePalette(); return; }
      if (!els.modal.hidden) { els.modal.hidden = true; return; }
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); if (els.palette.hidden) openPalette(); else closePalette(); return; }
    if (e.ctrlKey && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); go(VIEWS[Number(e.key) - 1]); return; }
    if ((e.key === '/' && !typing) || (e.ctrlKey && e.key.toLowerCase() === 'f')) {
      e.preventDefault();
      if (view === 'gametime') { els.gtSearch.focus(); els.gtSearch.select(); }
      else { go('library'); els.search.focus(); els.search.select(); }
    }
  });
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
  setInterval(tick, 250);
}

async function start() {
  bind();
  const response = await fetch(CATALOG_URL);
  const data = await response.json();
  catalog = {
    date: new Date(data.downloadedAtUtc).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    count: data.games.length
  };
  games = data.games.filter((g) => g.executables && g.executables.length);
  for (const g of games) { g.lower = g.name.toLowerCase(); byId.set(g.id, g); }
  $('#library-sub').textContent = `${plural(games.length, 'game')} Discord can detect · catalog from ${catalog.date}`;
  els.gtSearch.placeholder = `Search ${plural(games.length, 'game')}`;
  if (bridge) bridge.addEventListener('message', (e) => receive(e.data));
  applyFilter(false);
  renderNav();
  go('variety');
  send({ type: 'ready' });
}

/* ---------- preview mock (only used when the page is opened outside the app) ---------- */

const mock = {
  state: { running: null, auto: { active: false, completed: false, position: 0, total: 0, next: [] }, settings: { minMinutes: 10, maxMinutes: 15, order: 'random', onlyMatches: false } },
  played: [], queue: [], pos: -1, timer: null,
  stats: { varietySeconds: 41 * 3600 + 1260, gameTimeSeconds: 6 * 3600 + 900, longestSeconds: 3 * 3600 + 720, sessions: 318, legacyGames: 312, legacySeconds: 234000, since: Date.now() - 3 * 86400000 },
  push() {
    const s = this.state;
    s.auto.next = s.auto.active ? this.queue.slice(this.pos + 1, this.pos + 6).map((g) => ({ id: g.id, name: g.name })) : [];
    setTimeout(() => receive({ type: 'state', running: s.running, auto: Object.assign({}, s.auto), settings: Object.assign({}, s.settings), played: this.played.slice(), stats: Object.assign({}, this.stats) }), 30);
  },
  roll() {
    const s = this.state.settings;
    return (s.minMinutes * 60 + Math.floor(Math.random() * ((s.maxMinutes - s.minMinutes) * 60 + 1))) * 1000;
  },
  run(game, exe, startedAt) {
    this.state.running = { id: game.id, name: game.name, exe: game.executables[exe].path, exeIndex: exe,
      startedAt: startedAt || Date.now(), duration: this.state.auto.active ? this.roll() : 0 };
  },
  advance() {
    this.state.running = null;
    while (++this.pos < this.queue.length) {
      const g = this.queue[this.pos];
      if (this.played.includes(g.id)) continue;
      this.played.push(g.id);
      this.run(g, 0);
      this.state.auto.position = this.pos + 1;
      return this.push();
    }
    this.state.auto.active = false;
    this.state.auto.completed = true;
    receive({ type: 'notice', text: 'Game Variety complete. Every game in the pool has been played once.', level: 'success' });
    this.push();
  },
  receive(m) {
    const s = this.state;
    if (m.type === 'ready') {
      const demo = new URLSearchParams(location.search).get('demo');
      if (demo === 'auto') {
        this.queue = games.slice().sort(() => Math.random() - 0.5); this.pos = 2;
        this.queue.slice(0, 3).forEach((g) => this.played.push(g.id));
        s.auto = { active: true, completed: false, position: 3, total: this.queue.length, next: [] };
        this.run(this.queue[2], 0, Date.now() - 372000);
      } else if (demo === 'manual') {
        this.run(games.find((g) => g.name === 'Stardew Valley') || games[0], 0, Date.now() - 1934000);
      } else if (demo === 'complete') {
        this.queue = games.filter((g) => g.lower.includes('hollow')); this.played = this.queue.map((g) => g.id); this.pos = this.queue.length;
        s.auto = { active: false, completed: true, position: this.queue.length, total: this.queue.length, next: [] };
      }
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        if (s.auto.active && s.running && Date.now() - s.running.startedAt >= s.running.duration) this.advance();
      }, 500);
    } else if (m.type === 'start') {
      s.auto.active = false; s.auto.completed = false;
      this.run(byId.get(m.id), m.exe);
    } else if (m.type === 'stop') {
      s.auto.active = false; s.running = null;
    } else if (m.type === 'skip') {
      if (s.auto.active) return this.advance();
    } else if (m.type === 'dismissCompleted') {
      s.auto.completed = false;
    } else if (m.type === 'settings' || m.type === 'rotate') {
      s.settings = { minMinutes: m.minMinutes, maxMinutes: m.maxMinutes, order: m.order, onlyMatches: m.onlyMatches };
      if (s.running && s.auto.active && (s.running.duration < m.minMinutes * 60000 || s.running.duration > m.maxMinutes * 60000)) s.running.duration = this.roll();
      if (m.type === 'rotate') {
        const source = m.ids ? m.ids.map((id) => byId.get(id)) : games;
        this.queue = source.filter((g) => !this.played.includes(g.id));
        if (m.order === 'alpha') this.queue.sort((a, b) => a.name.localeCompare(b.name));
        else this.queue.sort(() => Math.random() - 0.5);
        this.pos = -1;
        s.running = null;
        s.auto = { active: true, completed: false, position: 0, total: this.queue.length, next: [] };
        return this.advance();
      }
    } else if (m.type === 'resetHistory') {
      this.played = [];
      receive({ type: 'notice', text: 'Rotation history cleared.', level: 'success' });
    } else if (m.type === 'openFolder') {
      receive({ type: 'notice', text: 'The placeholder folder opens in Explorer inside the app.', level: 'info' });
    }
    this.push();
  }
};

start().catch((error) => toast(`Could not load the game catalog: ${error.message}`, 'error'));
