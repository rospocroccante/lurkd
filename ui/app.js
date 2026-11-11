// The lurkd page. Plain ES modules, no build step, no framework.
//
// Rules this file keeps (the server's Content-Security-Policy blocks inline script, and the text
// on this page comes from forums and from files the user wrote):
// - every string that came from the server is put on the page with textContent or a text node,
//   through `h()` below; there is no innerHTML, outerHTML or insertAdjacentHTML here;
// - a link gets an href only after safeHttpUrl() accepts it (http or https), and opens with
//   rel="noopener noreferrer";
// - the page never sees the token (D52). It opens from a one-time link, /?n=<nonce>, which the
//   server answers with the page itself and the page secret in an HttpOnly cookie; the script
//   cannot read that cookie, and start() drops the used link from the address;
// - changes go to the server with same-origin fetch, so the browser sets Origin and the cookie.
// - no control starts a read of a forum (D19); reads come from the agent. The one page lurkd
//   loads from here is the address the person typed or chose under "Add a forum" (D45), and the
//   page sends exactly the address it shows in that field.

import {
  addDraftBody,
  addFormErrors,
  analyseView,
  attentionBadges,
  bulkDialogView,
  checkAddForm,
  checkImportFile,
  DEFAULT_FILTERS,
  describeJob,
  draftHighlights,
  engineLabel,
  engineName,
  enginesOf,
  filterRows,
  forbiddenView,
  formatHash,
  groupRows,
  groupSwitchState,
  importResultView,
  isFilterHash,
  isSwitchable,
  MAX_FORUM_NAME,
  parseTopics,
  lastReadTimes,
  parseHash,
  policyBadge,
  present,
  queueSummary,
  rulesPageChoices,
  safeHttpUrl,
  selectionState,
  sessionBadge,
  signUpOffered,
  sortRows,
  statusBadge,
  termsLinkText,
  todoItems,
  topicsOf,
} from './view.js';

/**
 * @typedef {import('../src/sources/registry.js').SourceView & { counts7d: { blocked: number; beaconsBlocked: number; challenges: number }; block: 'login' | 'challenge' | null; lastReadAt: string | null }} SourceRow
 * @typedef {import('../src/fetch/queue.js').JobProgress} JobProgress
 * @typedef {import('../src/sources/drafts.js').DraftView} DraftView
 * @typedef {import('../src/fetch/service.js').ArchiveHitOut} ArchiveHit
 * @typedef {import('../src/sources/analyse.js').ForumDetection} ForumDetection
 * @typedef {import('./view.js').AddField} AddField
 * @typedef {import('./view.js').Filters} Filters
 * @typedef {import('./view.js').PanelKey} PanelKey
 * @typedef {{ sourceId: string | null; url: string; purpose: 'login' | 'signup' | 'challenge' | 'sample'; startedAt: string }} Handoff
 * @typedef {{
 *   version: string;
 *   browser: { state: string; lastError: string | null; handoff: Handoff | null };
 *   jobs: JobProgress[];
 *   sources: SourceRow[];
 *   drafts: DraftView[];
 *   samplesPending: { host: string; url: string; requestedAt: string }[];
 *   addRequests: { host: string; url: string; requestedAt: string }[];
 *   forbidden: import('./view.js').ForbiddenEntryView[];
 *   registryErrors: string[];
 *   groups: import('./view.js').CustomGroupView[];
 *   retentionDays: number | null;
 *   cookieNotice: string;
 * }} AppState
 */

const POLL_MS = 1500;
const SEARCH_DELAY_MS = 300;
const NOT_RUNNING = 'lurkd is not running. Run lurkd start in a terminal.';

// ---- small helpers ----

/**
 * Builds an element. Strings among `kids` become text nodes; nothing is parsed as markup.
 * Attributes: `class`, `text`, `on` (event listeners), and plain attributes by name.
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...any} kids
 * @returns {any}
 */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, /** @type {EventListener} */ (fn));
    else if (k === 'checked' || k === 'disabled' || k === 'hidden') /** @type {any} */ (el)[k] = true;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of present(kids)) el.append(kid);
  return el;
}

/**
 * Puts `kids` in `el` in place of what it holds. Every child list of the page goes through here
 * or `h()`: a `null`, `undefined` or `false` that a condition leaves is dropped, never shown as text.
 * @param {Element} el
 * @param {...any} kids
 */
function fill(el, ...kids) {
  el.replaceChildren(...present(kids));
}

/** @param {string} id */
function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`lurkd page: #${id} is missing`);
  return el;
}

/**
 * A link to an address from the server, or null when the address is not http or https.
 * @param {string} text
 * @param {unknown} url
 */
function link(text, url) {
  const href = safeHttpUrl(url);
  if (href === null) return null;
  return h('a', { href, rel: 'noopener noreferrer', target: '_blank', text });
}

/** @param {import('./view.js').Badge} b */
function badge(b) {
  return h('span', { class: `badge badge-${b.tone}`, text: b.text });
}

/** @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'the site';
  }
}

/** @param {string | null | undefined} iso */
function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---- talking to the server ----

class ApiError extends Error {
  /** @param {string} code @param {string} message @param {number} status @param {unknown} [details] */
  constructor(code, message, status, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {{ raw?: boolean }} [o] `raw`: `body` is text sent as it is (a saved thread file)
 */
async function api(method, path, body, o = {}) {
  /** @type {Response} */
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : o.raw ? String(body) : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('unreachable', NOT_RUNNING, 0);
  }
  /** @type {any} */
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = data && typeof data === 'object' ? data.error : null;
    throw new ApiError(
      typeof e?.code === 'string' ? e.code : 'internal',
      typeof e?.message === 'string' ? e.message : `lurkd answered with status ${res.status}.`,
      res.status,
      e?.details,
    );
  }
  return data;
}

// ---- state and drawing ----

/** @type {AppState | null} */
let state = null;
/** The filters of the sources table; the address's hash holds them, so a reload keeps them. @type {Filters} */
let filters = parseHash(location.hash);
/** The panel open under the "To do" bar, if any. @type {PanelKey | null} */
let openPanel = null;
/** Last drawn input of each part of the page, so a poll that changed nothing touches nothing. */
const drawn = new Map();

/**
 * @param {string} key
 * @param {unknown} input
 * @param {() => void} draw
 */
function part(key, input, draw) {
  const sig = JSON.stringify(input);
  if (drawn.get(key) === sig) return;
  drawn.set(key, sig);
  draw();
}

const nameOf = (/** @type {string} */ id) => state?.sources.find((s) => s.id === id)?.name;
const sourceName = (/** @type {string | null} */ id) => (id === null ? null : (state?.sources.find((s) => s.id === id)?.name ?? id));

function drawAll() {
  if (!state) return;
  const s = state;
  const stateText = { down: 'Browser is off', starting: 'Browser is starting', ready: 'Browser is ready', handoff: 'A browser window is open', error: 'Browser has a problem' };
  part('header', [s.browser.state, s.browser.lastError, s.cookieNotice, s.version], () => {
    const pill = $('browser-state');
    const tone = s.browser.state === 'ready' ? 'ok' : s.browser.state === 'error' ? 'warn' : 'neutral';
    pill.className = `badge badge-${tone}`;
    pill.textContent = /** @type {Record<string, string>} */ (stateText)[s.browser.state] ?? `Browser: ${s.browser.state}`;
    const err = $('browser-error');
    err.hidden = !s.browser.lastError;
    err.textContent = s.browser.lastError ?? '';
    $('cookie-notice').textContent = s.cookieNotice;
    $('version').textContent = `lurkd ${s.version}`;
  });
  part('handoff', [s.browser.handoff, s.sources.map((x) => [x.id, x.name])], drawHandoff);
  part('todo', [todoItems(s), openPanel, filters.state], drawTodo);
  part('jobs', [s.jobs, s.sources.map((x) => [x.id, x.name]), openPanel], drawJobs);
  part('queue', [s.jobs, s.sources.map((x) => [x.id, x.name])], drawQueue);
  part('toolbar', [topicsOf(s.sources), enginesOf(s.sources), filters, openPanel], drawToolbar);
  drawDirectory();
  part('add-requests', [s.addRequests, addBusy], drawAddRequests);
  part('samples', [s.samplesPending, !!s.browser.handoff], drawSamples);
  part('drafts', s.drafts, drawDrafts);
  part('forbidden', [s.forbidden, s.sources.map((x) => [x.id, x.name])], drawForbidden);
  part('groups', [s.groups, s.sources.map((x) => [x.id, x.name])], drawGroups);
  part('errors', s.registryErrors, () => {
    fill($('registry-errors'),
      ...(s.registryErrors.length === 0 ? [h('li', { class: 'muted', text: 'Every source file loaded.' })] : s.registryErrors.map((line) => h('li', { class: 'job', text: line }))),
    );
  });
  part('retention', s.retentionDays, () => {
    const sel = /** @type {HTMLSelectElement} */ ($('retention'));
    if (document.activeElement !== sel) sel.value = s.retentionDays === null ? '' : String(s.retentionDays);
  });
  $('directory').setAttribute('aria-busy', 'false');
}

function drawHandoff() {
  const box = $('handoff');
  const info = state?.browser.handoff ?? null;
  if (!info) {
    box.hidden = true;
    return;
  }
  const text = $('handoff-text');
  const actions = $('handoff-actions');
  if (info.purpose === 'sample') {
    text.textContent = `Open a thread page of ${hostOf(info.url)} in the window, then press Use this page.`;
    fill(actions,
      h('button', { type: 'button', text: 'Use this page', on: { click: () => act('POST', '/api/sample-requests/capture', {}) } }),
      h('button', { type: 'button', class: 'button-quiet', text: 'Cancel', on: { click: () => act('POST', '/api/handoff/cancel', {}) } }),
    );
  } else {
    const name = sourceName(info.sourceId) ?? hostOf(info.url);
    text.textContent =
      info.purpose === 'challenge'
        ? `A browser window is open for ${name}. Complete the human check there, then press Done.`
        : info.purpose === 'signup'
          ? `A browser window is open for ${name}. Create your account there, then press Done.`
          : `A browser window is open for ${name}. Log in there, then press Done.`;
    fill(actions,
      h('button', { type: 'button', text: 'Done', on: { click: () => act('POST', '/api/handoff/done', {}) } }),
      h('button', { type: 'button', class: 'button-quiet', text: 'Cancel', on: { click: () => act('POST', '/api/handoff/cancel', {}) } }),
    );
  }
  box.hidden = false;
}

// -- "To do" bar, queue strip and panels --

function drawTodo() {
  if (!state) return;
  const items = todoItems(state);
  const box = $('todo-items');
  // The chips stay the same elements from draw to draw, so the focus and a screen reader stay on
  // the chip that was pressed; only their state and counts change.
  const before = /** @type {HTMLElement[]} */ ([...box.querySelectorAll('[data-todo]')]);
  const active = document.activeElement;
  const focusedAt = before.findIndex((b) => b === active);
  const focusedKey = focusedAt < 0 ? undefined : before[focusedAt]?.dataset.todo;
  if (items.length === 0) {
    if (!box.querySelector('.todo-none')) fill(box, h('span', { class: 'todo-none', text: 'Nothing needs you' }));
    if (focusedKey !== undefined) $('h-todo').focus();
    return;
  }
  const byKey = new Map(before.map((b) => [b.dataset.todo, b]));
  const chips = items.map((t) => {
    const b = byKey.get(t.key) ?? todoChip(t.key);
    updateTodoChip(b, t);
    return b;
  });
  const inPlace = box.children.length === chips.length && chips.every((b, i) => box.children[i] === b);
  if (!inPlace) fill(box, ...chips);
  if (focusedKey !== undefined && document.activeElement !== byKey.get(focusedKey)) {
    // The chip that had the focus went: the chip now in its place takes it, or the bar's heading.
    const again = chips.find((b) => b.dataset.todo === focusedKey) ?? chips[Math.min(focusedAt, chips.length - 1)];
    (again ?? $('h-todo')).focus();
  }
}

/** @param {string} key */
function todoChip(key) {
  return h(
    'button',
    { type: 'button', class: 'todo-chip', 'data-todo': key, on: { click: () => onTodo(key) } },
    h('span', { class: 'todo-label' }),
    h('span', { class: 'todo-count' }),
  );
}

/**
 * @param {HTMLElement} b
 * @param {import('./view.js').TodoItem} t
 */
function updateTodoChip(b, t) {
  /** @param {string} name @param {string | null} value */
  const set = (name, value) => {
    if (value === null) b.removeAttribute(name);
    else if (b.getAttribute(name) !== value) b.setAttribute(name, value);
  };
  set('aria-label', `${t.label}: ${t.count}`);
  set('aria-expanded', t.panel ? String(openPanel === t.panel) : null);
  set('aria-controls', t.panel ? panelId(t.panel) : null);
  set('aria-pressed', t.panel ? null : String(filters.state === t.filter));
  const [label, count] = /** @type {HTMLElement[]} */ ([...b.children]);
  if (label && label.textContent !== t.label) label.textContent = t.label;
  if (count && count.textContent !== String(t.count)) count.textContent = String(t.count);
}

/**
 * A "To do" chip: a panel count opens its panel or closes it again, the focus staying on the chip;
 * a source count applies its filter, or clears it when it applies already.
 * @param {string} key
 */
function onTodo(key) {
  const t = state ? todoItems(state).find((x) => x.key === key) : undefined;
  if (!t) return;
  if (t.panel) showPanel(openPanel === t.panel ? null : t.panel, { focus: false });
  else setFilters({ state: filters.state === t.filter ? 'all' : /** @type {Filters['state']} */ (t.filter) });
}

function drawJobs() {
  if (!state) return;
  const q = queueSummary(state.jobs);
  const button = $('queue-state');
  button.textContent = q.text;
  button.setAttribute('aria-expanded', String(openPanel === 'queue'));
  const strip = $('job-strip');
  if (!q.running && q.waiting === 0) {
    strip.hidden = true;
    fill(strip);
    return;
  }
  const r = q.running;
  fill(strip,
    h('span', { class: 'strip-label', text: r ? 'Running' : 'Waiting' }),
    r && r.phase !== 'search' ? h('span', { class: 'job-source', text: sourceName(r.sourceId) ?? r.sourceId }) : null,
    r ? h('span', { class: 'strip-text', text: describeJob(r, nameOf) }) : null,
    r && r.requestCap > 0 ? h('progress', { max: r.requestCap, value: Math.min(r.requestsUsed, r.requestCap), 'aria-label': 'Requests used in this run' }) : null,
    q.waiting > 0 ? h('span', { class: 'muted', text: plural(q.waiting, 'job waiting', 'jobs waiting') }) : null,
    h('button', { type: 'button', class: 'button-quiet button-small', text: 'Show queue', 'aria-controls': 'panel-queue', on: { click: () => showPanel('queue') } }),
  );
  strip.hidden = false;
}

/** @param {PanelKey} key */
const panelId = (key) => (key === 'add' ? 'add' : `panel-${key}`);
/** @type {PanelKey[]} */
const PANELS = ['add', 'drafts', 'samples', 'forbidden', 'errors', 'queue', 'groups'];
/** The control that opened the panel now open, so closing it gives the focus back there (C4). @type {HTMLElement | null} */
let panelOpener = null;
/** Where that control sat (its row and `data-key`), for a row the polls built again meanwhile. @type {ReturnType<typeof focusMark> | null} */
let panelOpenerMark = null;

/**
 * Opens one panel under the "To do" bar and closes the others; `null` closes them all. The
 * heading of the opened panel (the address field for Add a forum) takes the focus. The control
 * that had the focus outside the panels is kept as the panel's opener.
 * @param {PanelKey | null} key
 * @param {{ focus?: boolean }} [o]
 */
function showPanel(key, o = {}) {
  const active = /** @type {HTMLElement | null} */ (document.activeElement);
  if (key !== null && key !== openPanel) {
    panelOpener = active && active !== document.body && !$('panels').contains(active) ? active : null;
    panelOpenerMark = panelOpener ? focusMark() : null;
  }
  if (key === null) {
    panelOpener = null;
    panelOpenerMark = null;
  }
  openPanel = key;
  for (const k of PANELS) $(panelId(k)).hidden = k !== key;
  $('open-add').setAttribute('aria-expanded', String(key === 'add'));
  $('queue-state').setAttribute('aria-expanded', String(key === 'queue'));
  $('open-groups').setAttribute('aria-expanded', String(key === 'groups'));
  drawn.delete('todo');
  drawn.delete('jobs');
  drawAll();
  if (key !== null && o.focus !== false) (key === 'add' ? $('add-url') : $(`h-${key}`)).focus();
}

/** @param {PanelKey} key */
function togglePanel(key) {
  showPanel(openPanel === key ? null : key);
}

/** @param {PanelKey} key */
function closePanel(key) {
  if (openPanel !== key) return;
  const opener = panelOpener;
  const mark = panelOpenerMark;
  showPanel(null);
  // The focus goes back to the control that opened the panel when it is still there (C4: the
  // "Add requests from your agent" chip, a row's menu button), or to the same control of the same
  // row when the row was built again, else to the panel's own button.
  const usual = key === 'add' ? $('open-add') : key === 'queue' ? $('queue-state') : key === 'groups' ? $('open-groups') : document.querySelector(`[data-todo="${key}"]`);
  if (opener && document.contains(opener) && !opener.closest('[hidden]')) return opener.focus();
  if (mark && mark.rowId !== null) {
    restoreFocus(mark);
    if (document.activeElement && document.activeElement !== document.body && !$('panels').contains(document.activeElement)) return;
  }
  /** @type {HTMLElement | null} */ (usual ?? $('h-todo'))?.focus();
}

// -- filters --

/**
 * Changes the filters, writes them to the hash and draws the table again.
 * @param {Partial<Filters>} patch
 */
function setFilters(patch) {
  applyFilters(patch, true);
}

/**
 * Changes the filters and draws the table again; `hash` writes them to the address too.
 * @param {Partial<Filters>} patch
 * @param {boolean} [hash]
 */
function applyFilters(patch, hash = false) {
  const before = filters.q;
  filters = { ...filters, ...patch };
  if (hash) writeHash();
  drawAll();
  if (filters.q !== before) {
    const search = /** @type {HTMLInputElement} */ ($('search'));
    if (search.value !== filters.q) search.value = filters.q;
    searchArchive();
  }
}

function writeHash() {
  const hash = formatHash(filters);
  const url = location.pathname + location.search + (hash === '' ? '' : `#${hash}`);
  if (url !== location.pathname + location.search + location.hash) history.replaceState(null, '', url);
}

/**
 * A hash typed by hand, or Back: the filters follow it. A hash that is no filter is left in the
 * address; when it names a row of the table, the page goes to that row.
 */
function onHashChange() {
  if (!isFilterHash(location.hash)) {
    goToAnchor(location.hash);
    return;
  }
  setFilters(parseHash(location.hash));
}

/**
 * Scrolls to the row that `hash` (`#source-<id>`) names and gives it the focus. Any other anchor,
 * or a row that is not on the page, does nothing.
 * @param {string} hash
 * @returns {boolean} whether the row was there
 */
function goToAnchor(hash) {
  let id;
  try {
    id = decodeURIComponent(hash.replace(/^#/, ''));
  } catch {
    return false;
  }
  if (!id.startsWith('source-')) return false;
  // C3: a row the filters hide, or a collapsed group holds, is brought back first. The anchor
  // stays in the address.
  const row = revealRow(id.slice('source-'.length), false);
  if (!row) return false;
  row.scrollIntoView({ block: 'center' });
  row.focus();
  return true;
}

/**
 * The first row of source `id`, after clearing the filters that hide it and opening the group
 * that holds it. `writeHash` writes the cleared filters to the address; without it the address
 * keeps what it has (an anchor typed by hand). Null for a source the page does not know.
 * @param {string} id
 * @param {boolean} writeHash
 * @returns {HTMLElement | null}
 */
function revealRow(id, writeHash) {
  if (!state || !state.sources.some((v) => v.id === id)) return null;
  const found = () => /** @type {HTMLElement | null} */ (document.getElementById(`source-${id}`));
  if (found()?.matches('tr.source')) return found();
  if (!filterRows(state.sources, filters).some((v) => v.id === id) && anyFilter()) {
    if (writeHash) clearFilters();
    else applyFilters({ ...DEFAULT_FILTERS, sort: filters.sort, group: filters.group });
  }
  if (filters.group !== 'none') {
    const block = groupRows(shownRows(), filters.group, state.groups).find((b) => b.rows.some((v) => v.id === id));
    if (block && collapsedGroups.has(block.key)) {
      collapsedGroups.delete(block.key);
      drawDirectory();
    }
  }
  const row = found();
  return row && row.matches('tr.source') ? row : null;
}

/** The anchor the page was opened with (`#source-lg`), until the first draw of the table. @type {string | null} */
let startAnchor = null;

const STATE_CHIPS = /** @type {const} */ ([
  ['all', 'All'],
  ['on', 'On'],
  ['off', 'Off'],
  ['attention', 'Needs attention'],
  ['logged_in', 'Logged in'],
]);
/** The states the "To do" bar sets; they show as a chip of their own while they apply. */
const TODO_STATES = { warning: 'Warning to read', expired: 'Session expired' };

function drawToolbar() {
  if (!state) return;
  /**
   * @param {string} id
   * @param {string} allText
   * @param {string[]} values
   * @param {(v: string) => string} label
   * @param {string} current
   */
  const fillSelect = (id, allText, values, label, current) => {
    const sel = /** @type {HTMLSelectElement} */ ($(id));
    // A value from the hash that no source has any more stays chosen, so the table says why it is empty.
    const list = current !== '' && !values.includes(current) ? [...values, current] : values;
    fill(sel, h('option', { value: '', text: allText }), ...list.map((v) => h('option', { value: v, text: label(v) })));
    sel.value = current;
  };
  fillSelect('filter-topic', 'All topics', topicsOf(state.sources), (t) => t, filters.topic);
  fillSelect('filter-engine', 'All engines', enginesOf(state.sources), engineName, filters.engine);
  /** @type {HTMLSelectElement} */ ($('filter-policy')).value = filters.policy;
  /** @type {HTMLSelectElement} */ ($('sort')).value = filters.sort;
  /** @type {HTMLSelectElement} */ ($('group-by')).value = filters.group;
  $('open-groups').setAttribute('aria-expanded', String(openPanel === 'groups'));
  const search = /** @type {HTMLInputElement} */ ($('search'));
  if (search.value !== filters.q && document.activeElement !== search) search.value = filters.q;
  /** @type {{ value: string; text: string }[]} */
  const chips = STATE_CHIPS.map(([value, text]) => ({ value, text }));
  if (filters.state === 'warning' || filters.state === 'expired') chips.push({ value: filters.state, text: TODO_STATES[filters.state] });
  const group = $('filter-state');
  const focused = group.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset.value : undefined;
  fill(group,
    ...chips.map((c) =>
      h('button', {
        type: 'button',
        class: 'chip',
        'data-value': c.value,
        'aria-pressed': String(filters.state === c.value),
        text: c.text,
        on: { click: () => setFilters({ state: /** @type {Filters['state']} */ (c.value) }) },
      }),
    ),
  );
  if (focused !== undefined) /** @type {HTMLElement | null} */ (group.querySelector(`[data-value="${focused}"]`) ?? group.querySelector('[data-value="all"]'))?.focus();
}

// -- directory: the sources table, its groups (D51) and the selection --

/**
 * What is on screen now, by row key (`<block key>|<source id>`): a source in several custom groups
 * has one row in each. A poll patches the counts, the last read and the selection box in place and
 * replaces only the rows whose other fields changed; the focus and an open row menu survive it.
 * @type {Map<string, { sig: string; id: string; el: any; counts: any; lastRead: any; select: any }>}
 */
const rowCache = new Map();
/** The group headers on screen, by row key (`h|<block key>`). @type {Map<string, { sig: string; el: any }>} */
const headCache = new Map();
let layout = '';
/** Keys of the rows shown expanded. */
const expandedRows = new Set();
/** Keys of the groups shown collapsed (D51), for this page only. */
const collapsedGroups = new Set();
/** Ids of the selected sources; the selection keeps only sources the table shows. @type {Set<string>} */
const selected = new Set();
/** The row whose menu is open, by row key. @type {string | null} */
let openMenuId = null;
/** The table's own "select every source shown" box. @type {any} */
let selectAllBox = null;

/** Forgets the rows on screen, so the next draw builds the table again from the server's state. */
function resetDirectory() {
  rowCache.clear();
  headCache.clear();
  layout = '';
  selectAllBox = null;
  drawn.delete('directory');
  $('directory').querySelector('table')?.remove();
}

/** @param {SourceRow['counts7d'] | undefined} c */
function countsText(c) {
  const k = c ?? { blocked: 0, beaconsBlocked: 0, challenges: 0 };
  return `Last 7 days: ${plural(k.blocked, 'blocked request', 'blocked requests')}, ${plural(k.beaconsBlocked, 'blocked beacon', 'blocked beacons')}, ${plural(k.challenges, 'challenge', 'challenges')}`;
}

/**
 * @param {string | undefined} iso
 * @param {boolean} imported
 */
function lastReadText(iso, imported) {
  const when = iso ? `${shortDate(iso)}, ${new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : null;
  if (imported) return when ? `Last import ${when}` : 'Nothing imported yet';
  return when ? `Last read ${when}` : 'No thread in the archive yet';
}

/**
 * Where the focus is: the element, and the row and control (`data-key`) it belongs to.
 * @returns {{ active: HTMLElement | null; rowId: string | null; key: string | null }}
 */
function focusMark() {
  const active = /** @type {HTMLElement | null} */ (document.activeElement);
  const rowId = active?.closest?.('[data-row]')?.getAttribute('data-row') ?? null;
  return { active, rowId, key: active?.dataset?.key ?? null };
}

/**
 * Gives the focus back after rows were replaced: to the element when it is still on the page, else
 * to the same control of the same row, else to that row's menu button. With `onlyIfLost`, a focus
 * the person moved elsewhere in the meantime stays where it is.
 * @param {ReturnType<typeof focusMark>} m
 * @param {boolean} [onlyIfLost]
 */
function restoreFocus(m, onlyIfLost = false) {
  const now = document.activeElement;
  if (onlyIfLost && now !== null && now !== document.body && now !== m.active) return;
  if (m.active && document.contains(m.active)) {
    if (now !== m.active) m.active.focus();
    return;
  }
  if (m.rowId === null) return;
  const row = `[data-row="${CSS.escape(m.rowId)}"]`;
  const again = m.key === null ? null : document.querySelector(`${row} [data-key="${CSS.escape(m.key)}"]`);
  /** @type {HTMLElement | null} */ (again ?? document.querySelector(`${row} [data-key="menu"]`) ?? document.querySelector(`${row} [data-key="collapse"]`))?.focus();
}

/**
 * Runs `fn`, which may replace rows, and gives the focus back to the same control of the same
 * row (by `data-key`) when the element that had it left the page.
 * @param {() => void} fn
 */
function keepingFocus(fn) {
  const mark = focusMark();
  fn();
  restoreFocus(mark);
}

/** Whether a filter hides rows; the sort and the grouping are not filters. */
const anyFilter = () => formatHash({ ...filters, sort: DEFAULT_FILTERS.sort, group: DEFAULT_FILTERS.group }) !== '';

/** The rows the filters keep, sorted. */
function shownRows() {
  if (!state) return [];
  return sortRows(filterRows(state.sources, filters), filters.sort, lastReadTimes(state.sources));
}

const COLUMNS = 9;

function drawDirectory() {
  if (!state) return;
  const s = state;
  const box = $('directory');
  const windowOpen = !!s.browser.handoff;
  const lastRead = lastReadTimes(s.sources);
  const shown = shownRows();
  // The selection follows what the table shows, so a bulk change never reaches a row out of view.
  const shownIds = new Set(shown.filter(isSwitchable).map((v) => v.id));
  for (const id of [...selected]) if (!shownIds.has(id)) selected.delete(id);
  $('source-count').textContent = shown.length === s.sources.length ? String(s.sources.length) : `${shown.length} of ${s.sources.length}`;
  const message = s.sources.length === 0 ? 'empty' : shown.length === 0 ? 'none' : null;
  if (message !== null) {
    part('directory', [message, filters], () => {
      rowCache.clear();
      headCache.clear();
      selectAllBox = null;
      layout = '';
      const onlyText = formatHash({ ...filters, q: '', sort: DEFAULT_FILTERS.sort, group: DEFAULT_FILTERS.group }) === '';
      fill(box,
        h(
          'div',
          { class: 'empty' },
          h('p', {
            class: 'muted',
            text:
              message === 'empty'
                ? 'No sources are installed. Put a YAML file in ~/.lurkd/sources and it appears here.'
                : onlyText
                  ? `No source matches "${filters.q.trim()}".`
                  : 'No source matches these filters.',
          }),
          message === 'none' ? h('button', { type: 'button', class: 'button-quiet button-small', text: 'Clear filters', on: { click: clearFilters } }) : null,
        ),
      );
    });
    drawBulkBar();
    return;
  }
  drawn.delete('directory');
  const grouped = filters.group !== 'none';
  const blocks = groupRows(shown, filters.group, s.groups, { includeEmpty: !anyFilter() });
  /** @type {({ type: 'head'; key: string; block: (typeof blocks)[number] } | { type: 'row'; key: string; v: SourceRow; first: boolean; dom: string })[]} */
  const items = [];
  const seen = new Set();
  for (const b of blocks) {
    if (grouped) items.push({ type: 'head', key: `h|${b.key}`, block: b });
    if (grouped && collapsedGroups.has(b.key)) continue;
    for (const v of b.rows) {
      const first = !seen.has(v.id);
      seen.add(v.id);
      // The first row of a source carries the ids anchors point at; a second row of it gets its own.
      items.push({ type: 'row', key: `${b.key}|${v.id}`, v, first, dom: first ? v.id : `${v.id}--${b.key.replace(/[^a-z0-9-]/gi, '-')}` });
    }
  }
  keepingFocus(() => {
    /** @type {any} */
    let table = box.querySelector('table');
    if (!table) {
      selectAllBox = h('input', { type: 'checkbox', class: 'select', id: 'select-all', 'aria-label': 'Select every source shown', on: { change: onSelectAll } });
      table = h(
        'table',
        { class: 'sources-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col', class: 'c-select' }, selectAllBox),
            h('th', { scope: 'col', class: 'c-expand' }, h('span', { class: 'visually-hidden', text: 'Details' })),
            h('th', { scope: 'col', class: 'c-switch', text: 'On' }),
            h('th', { scope: 'col', class: 'c-name', text: 'Forum' }),
            h('th', { scope: 'col', class: 'c-topic', text: 'Topics' }),
            h('th', { scope: 'col', class: 'c-session', text: 'Session' }),
            h('th', { scope: 'col', class: 'c-rules', text: 'Rules' }),
            h('th', { scope: 'col', class: 'c-status', text: 'Status' }),
            h('th', { scope: 'col', class: 'c-menu' }, h('span', { class: 'visually-hidden', text: 'Actions' })),
          ),
        ),
      );
      fill(box, table);
      rowCache.clear();
      headCache.clear();
      layout = '';
    }
    const all = shown.filter(isSwitchable).map((v) => v.id);
    setTriState(selectAllBox, selectionState(all, selected));
    selectAllBox.disabled = all.length === 0;
    /** @type {Set<string>} */
    const keep = new Set();
    for (const it of items) {
      keep.add(it.key);
      if (it.type === 'head') {
        const b = it.block;
        const sw = groupSwitchState(b.rows);
        const ids = b.rows.filter(isSwitchable).map((v) => v.id);
        const filtered = anyFilter();
        const sig = JSON.stringify([b.key, b.label, b.kind, sw, selectionState(ids, selected), collapsedGroups.has(b.key), b.rows.length, filtered]);
        const cached = headCache.get(it.key);
        if (!cached || cached.sig !== sig) {
          const el = groupHead(it.key, b, sw, ids, filtered);
          if (cached) cached.el.replaceWith(el);
          headCache.set(it.key, { sig, el });
        } else {
          // A press the server did not follow (a forbidden source stays off) leaves the state as
          // it was: the boxes show the server's state again, not the press.
          setTriState(cached.el.querySelector('input.group-switch'), sw.state === 'none' ? 'off' : sw.state);
          setTriState(cached.el.querySelector('[data-key="select-all"]'), selectionState(ids, selected));
        }
        continue;
      }
      const v = it.v;
      const cached = rowCache.get(it.key);
      const sig = JSON.stringify([{ ...v, counts7d: null, lastReadAt: null }, windowOpen, it.dom, expandedRows.has(it.key)]);
      if (!cached || cached.sig !== sig) {
        const row = sourceRow(v, windowOpen, it.key, it.dom);
        if (cached) cached.el.replaceWith(row.el);
        rowCache.set(it.key, { sig, id: v.id, ...row });
        if (openMenuId === it.key) setMenuOpen(it.key, true);
      }
      const entry = /** @type {{ counts: any; lastRead: any; select: any }} */ (rowCache.get(it.key));
      const counts = countsText(v.counts7d);
      if (entry.counts.textContent !== counts) entry.counts.textContent = counts;
      const read = lastReadText(lastRead.get(v.id), !isSwitchable(v));
      if (entry.lastRead.textContent !== read) entry.lastRead.textContent = read;
      if (entry.select && entry.select.checked !== selected.has(v.id)) entry.select.checked = selected.has(v.id);
    }
    for (const [key, entry] of rowCache)
      if (!keep.has(key)) {
        entry.el.remove();
        rowCache.delete(key);
        if (openMenuId === key) openMenuId = null;
      }
    for (const [key, entry] of headCache)
      if (!keep.has(key)) {
        entry.el.remove();
        headCache.delete(key);
      }
    const wanted = JSON.stringify(items.map((it) => it.key));
    if (wanted !== layout) {
      layout = wanted;
      // Moves only the parts that are out of place, in the order of the table.
      let at = /** @type {any} */ (table.querySelector('thead'));
      for (const it of items) {
        const el = /** @type {{ el: any }} */ ((it.type === 'head' ? headCache : rowCache).get(it.key)).el;
        if (at.nextSibling !== el) at.after(el);
        at = el;
      }
    }
  });
  drawBulkBar();
}

/**
 * A checkbox for all, some or none.
 * @param {any} box
 * @param {'all' | 'some' | 'none' | 'on' | 'off' | 'mixed'} st
 */
function setTriState(box, st) {
  if (!box) return;
  box.checked = st === 'all' || st === 'on';
  box.indeterminate = st === 'some' || st === 'mixed';
}

function clearFilters() {
  setFilters({ ...DEFAULT_FILTERS, sort: filters.sort, group: filters.group });
}

/** @param {string} key */
function toggleDetail(key) {
  const open = !expandedRows.has(key);
  if (open) expandedRows.add(key);
  else expandedRows.delete(key);
  const el = rowCache.get(key)?.el;
  if (!el) return;
  el.querySelector('.source-detail').hidden = !open;
  el.querySelector('[data-key="expand"]').setAttribute('aria-expanded', String(open));
  // The signature records the open state, so a poll does not build the row again for it.
  const entry = rowCache.get(key);
  if (entry) {
    const sig = JSON.parse(entry.sig);
    sig[3] = open;
    entry.sig = JSON.stringify(sig);
  }
}

/**
 * The header of one group (D51): show or hide its rows, select them all, switch them all, and its
 * name with how many of its sources are on. The switch is on, off or mixed (indeterminate); it
 * acts on the sources the group shows under the current filters, never on the imported threads
 * nor on a member a filter hides (A8 L4), so its label names "the N shown" and, under a filter,
 * the count says "shown" too.
 * @param {string} key
 * @param {{ key: string; label: string; kind: string; rows: SourceRow[] }} b
 * @param {ReturnType<typeof groupSwitchState>} sw
 * @param {string[]} ids the group's switchable sources shown
 * @param {boolean} filtered whether a filter hides rows
 */
function groupHead(key, b, sw, ids, filtered) {
  const collapsed = collapsedGroups.has(b.key);
  const label = b.label;
  const select = h('input', {
    type: 'checkbox',
    class: 'select',
    'data-key': 'select-all',
    'aria-label': `Select the ${ids.length} shown in ${label}`,
    disabled: ids.length === 0,
    on: {
      change: (/** @type {Event} */ e) => {
        const on = /** @type {HTMLInputElement} */ (e.target).checked;
        for (const id of ids) if (on) selected.add(id);
        else selected.delete(id);
        drawDirectory();
      },
    },
  });
  setTriState(select, selectionState(ids, selected));
  const sw2 =
    sw.state === 'none'
      ? null
      : h('input', {
          type: 'checkbox',
          class: 'switch group-switch',
          'data-key': 'group-switch',
          'aria-label': `Switch the ${ids.length} shown in ${label} on or off`,
          on: { change: (/** @type {Event} */ e) => onGroupSwitch(ids, /** @type {HTMLInputElement} */ (e.target)) },
        });
  setTriState(sw2, sw.state === 'none' ? 'off' : sw.state);
  const countText = sw.total === 0 ? plural(b.rows.length, 'source', 'sources') : `${sw.on} of ${sw.total}${filtered ? ' shown' : ''} on`;
  return h(
    'tbody',
    { class: `group-head${b.kind === 'ungrouped' ? ' group-head-rest' : ''}`, 'data-row': key },
    h(
      'tr',
      { class: 'group-row' },
      h('td', { class: 'c-select' }, select),
      h(
        'td',
        { class: 'c-expand' },
        h('button', {
          type: 'button',
          class: 'icon-button expand',
          'data-key': 'collapse',
          'aria-expanded': String(!collapsed),
          'aria-label': `Sources of ${label}`,
          on: { click: () => toggleGroup(b.key) },
        }),
      ),
      h('td', { class: 'c-switch' }, sw2),
      // One cell per column, no colspan: the middle widths hide the topic column, and a cell that
      // spanned it would add a column of its own. The count sits under Session.
      h('td', { class: 'c-name c-group' }, h('span', { class: 'group-name', title: label, text: label })),
      h('td', { class: 'c-topic' }),
      h('td', { class: 'c-session' }, h('span', { class: 'group-count', text: countText })),
      h('td', { class: 'c-rules' }),
      h('td', { class: 'c-status' }),
      h('td', { class: 'c-menu' }),
    ),
  );
}

/** @param {string} blockKey */
function toggleGroup(blockKey) {
  if (collapsedGroups.has(blockKey)) collapsedGroups.delete(blockKey);
  else collapsedGroups.add(blockKey);
  drawDirectory();
}

/** @param {Event} e */
function onSelectAll(e) {
  const on = /** @type {HTMLInputElement} */ (e.target).checked;
  for (const v of shownRows()) if (isSwitchable(v)) on ? selected.add(v.id) : selected.delete(v.id);
  drawDirectory();
}

/**
 * The tri-state switch of a group: on (from off or mixed) goes through the D51 rule, off needs no dialog.
 * @param {string[]} ids
 * @param {HTMLInputElement} input
 */
async function onGroupSwitch(ids, input) {
  if (input.checked) await bulkEnable(ids);
  else await bulkDisable(ids);
}

/**
 * One source: a row of the table and, under it, its details (description, 7-day counts, last
 * read). Every text from the source file goes in as text. The source of imported threads (D50)
 * is read-only: no selection box and no switch (C1).
 * @param {SourceRow} v
 * @param {boolean} windowOpen
 * @param {string} key the row key
 * @param {string} dom the part of the element ids that names this row
 */
function sourceRow(v, windowOpen, key, dom) {
  const expanded = expandedRows.has(key);
  const detailId = `detail-${dom}`;
  const switchable = isSwitchable(v);
  const sw = switchable
    ? h('input', {
        type: 'checkbox',
        role: 'switch',
        class: 'switch',
        'data-key': 'switch',
        checked: v.enabled,
        'aria-label': `Switch ${v.name} on or off`,
        on: { change: (/** @type {Event} */ e) => onSwitch(v, /** @type {HTMLInputElement} */ (e.target)) },
      })
    : h('span', { class: 'visually-hidden', text: 'Read-only: threads imported from saved files' });
  const select = switchable
    ? h('input', {
        type: 'checkbox',
        class: 'select',
        'data-key': 'select',
        checked: selected.has(v.id),
        'aria-label': `Select ${v.name}`,
        on: {
          change: (/** @type {Event} */ e) => {
            if (/** @type {HTMLInputElement} */ (e.target).checked) selected.add(v.id);
            else selected.delete(v.id);
            drawDirectory();
          },
        },
      })
    : null;
  const counts = h('span', { text: countsText(v.counts7d) });
  const lastRead = h('span', { text: '' });
  const domain = v.domains[0] ?? '';
  const detail = h(
    'tr',
    { class: 'source-detail', id: detailId, hidden: !expanded },
    h(
      'td',
      { colspan: String(COLUMNS) },
      h(
        'div',
        { class: 'detail' },
        v.description ? h('p', { class: 'desc', text: v.description }) : null,
        v.topics.length > 0 ? h('p', { class: 'counts detail-topics', text: `Topics: ${v.topics.join(', ')}` }) : null,
        switchable ? h('p', { class: 'counts week-counts' }, counts) : null,
        h('p', { class: 'counts' }, lastRead, `. ${engineName(v.engine)}, ${v.domains.join(', ')}.`),
        // C2: the status chip gives its place in the row to the chips that need the person.
        attentionBadges(v).length > 0 ? h('p', { class: 'counts detail-status', text: `Status: ${statusBadge(v).text}.` }) : null,
      ),
    ),
  );
  const el = h(
    'tbody',
    { class: `source-group${switchable ? '' : ' source-imported'}`, 'data-row': key },
    h(
      'tr',
      // The id is the target of "Already in lurkd as ..." under Add a forum, and of #source-<id>.
      { class: 'source', id: `source-${dom}`, 'data-source': v.id, tabindex: '-1' },
      h('td', { class: 'c-select' }, select),
      h(
        'td',
        { class: 'c-expand' },
        h('button', {
          type: 'button',
          class: 'icon-button expand',
          'data-key': 'expand',
          'aria-expanded': String(expanded),
          'aria-controls': detailId,
          'aria-label': `Details of ${v.name}`,
          on: { click: () => toggleDetail(key) },
        }),
      ),
      h('td', { class: 'c-switch' }, sw),
      // Name and domain share one line; the domain gives way first, then the name ends in an ellipsis.
      h(
        'td',
        { class: 'c-name' },
        h('span', { class: 'name-line' }, h('span', { class: 'source-name', title: v.name, text: v.name }), domain ? h('span', { class: 'source-domain', title: domain, text: domain }) : null),
      ),
      h('td', { class: 'c-topic' }, h('span', { class: 'topic-text', title: v.topics.join(', '), text: v.topics.join(', ') })),
      h('td', { class: 'c-session' }, badge(sessionBadge(v))),
      h('td', { class: 'c-rules' }, badge(policyBadge(v))),
      h('td', { class: 'c-status' }, statusCell(v)),
      h('td', { class: 'c-menu' }, rowMenu(v, windowOpen, key, dom)),
    ),
    detail,
  );
  return { el, counts, lastRead, select };
}

/**
 * The status cell: how far the extractor was tried, then what needs the person. When something
 * needs the person, that takes the cell and the status moves to the details, so a row keeps to
 * one line on a wide screen (C2).
 * @param {SourceRow} v
 */
function statusCell(v) {
  const attention = attentionBadges(v);
  return h('span', { class: 'badges' }, attention.length > 0 ? null : badge(statusBadge(v)), ...attention.map(badge));
}

// -- the row menu: a menu button (aria-haspopup), arrows, Home, End, Escape and Tab --

/**
 * @param {SourceRow} v
 * @param {boolean} windowOpen
 * @param {string} key the row key
 * @param {string} dom the part of the element ids that names this row
 */
function rowMenu(v, windowOpen, key, dom) {
  const menuId = `menu-${dom}`;
  /**
   * @param {string} itemKey
   * @param {string} text
   * @param {() => unknown} run
   * @param {Record<string, any>} [extra]
   */
  const item = (itemKey, text, run, extra = {}) =>
    h('button', {
      type: 'button',
      role: 'menuitem',
      tabindex: '-1',
      'data-key': itemKey,
      text,
      on: {
        click: () => {
          closeMenu(true);
          run();
        },
      },
      ...extra,
    });
  const items = [];
  const imported = !isSwitchable(v);
  if (imported) {
    // C1: the read-only row of imported threads offers the import itself.
    items.push(item('import', 'Import a saved Reddit thread', () => openImport()));
  } else {
    const openWindow = () => act('POST', `/api/sources/${enc(v.id)}/login`, {});
    if (safeHttpUrl(v.loginUrl) !== null) items.push(item('login', 'Log in', openWindow, { disabled: windowOpen }));
    // D47: the sign-up page opens in the same window; the person registers there by hand.
    if (signUpOffered(v)) items.push(item('signup', 'Sign up', () => act('POST', `/api/sources/${enc(v.id)}/signup`, {}), { disabled: windowOpen }));
    // Only a challenge the server still holds: the window opens at the page that was blocked.
    if (v.block === 'challenge') items.push(item('window', 'Open window', openWindow, { disabled: windowOpen }));
    // A source that is not yet acknowledged is refused by the server until the user accepts.
    if (v.needsAcknowledgment) items.push(item('warning', 'Read the warning', () => onReadWarning(v)));
  }
  const rules = safeHttpUrl(v.ruleUrl);
  if (rules !== null)
    items.push(
      h('a', {
        role: 'menuitem',
        tabindex: '-1',
        'data-key': 'rules',
        href: rules,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: imported ? 'Reddit User Agreement' : 'Forum rules',
        on: { click: () => closeMenu(true) },
      }),
    );
  items.push(h('div', { role: 'separator', class: 'menu-sep' }));
  // Imported threads hold real Reddit user names, so the choice of showing them to the agent stays.
  items.push(
    item('real-names', 'Show real names to the agent', () => act('POST', `/api/sources/${enc(v.id)}/real-names`, { show: !v.showRealNames }), {
      role: 'menuitemcheckbox',
      'aria-checked': String(v.showRealNames),
    }),
  );
  // Nothing is read live from an import, so no beacon can be met.
  if (!imported)
    items.push(
      item('beacons', 'Let Cloudflare beacons through', () => act('POST', `/api/sources/${enc(v.id)}/beacons`, { allow: !v.allowBeacons }), {
        role: 'menuitemcheckbox',
        'aria-checked': String(v.allowBeacons),
      }),
    );
  items.push(h('div', { role: 'separator', class: 'menu-sep' }));
  items.push(item('delete', 'Delete archive', () => onDeleteArchive(v)));
  // D46: only a source the user added; a seed source is switched off instead.
  if (!v.seed) items.push(item('remove', 'Remove', () => onRemove(v)));

  const trigger = h('button', {
    type: 'button',
    class: 'menu-button',
    'data-key': 'menu',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-controls': menuId,
    'aria-label': `Actions for ${v.name}`,
    on: {
      click: () => (openMenuId === key ? closeMenu(true) : openMenu(key, 'first')),
      keydown: (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          openMenu(key, e.key === 'ArrowDown' ? 'first' : 'last');
        }
      },
    },
  });
  const menu = h('div', { class: 'menu', role: 'menu', id: menuId, 'aria-label': `Actions for ${v.name}`, hidden: true, on: { keydown: onMenuKey } }, ...items);
  return h('div', { class: 'menu-wrap' }, trigger, menu);
}

/** @param {string} key */
function menuParts(key) {
  const wrap = rowCache.get(key)?.el.querySelector('.menu-wrap');
  return wrap ? { wrap, trigger: wrap.querySelector('.menu-button'), menu: wrap.querySelector('[role=menu]') } : null;
}

/** @param {Element} menu @returns {HTMLElement[]} */
const menuItems = (menu) => /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('[role^=menuitem]')]).filter((el) => !(/** @type {HTMLButtonElement} */ (el).disabled));

/**
 * Shows or hides the menu of row `key`. A menu that would run past the bottom of the window opens
 * upwards.
 * @param {string} key
 * @param {boolean} open
 */
function setMenuOpen(key, open) {
  const p = menuParts(key);
  if (!p) return;
  p.menu.hidden = !open;
  p.trigger.setAttribute('aria-expanded', String(open));
  p.menu.classList.remove('menu-up');
  if (open) {
    const r = p.menu.getBoundingClientRect();
    if (r.bottom > window.innerHeight && r.height < p.trigger.getBoundingClientRect().top) p.menu.classList.add('menu-up');
  }
}

/**
 * @param {string} key
 * @param {'first' | 'last'} focus
 */
function openMenu(key, focus) {
  if (openMenuId !== null && openMenuId !== key) closeMenu(false);
  openMenuId = key;
  setMenuOpen(key, true);
  const p = menuParts(key);
  const list = p ? menuItems(p.menu) : [];
  (focus === 'first' ? list[0] : list[list.length - 1])?.focus();
}

/** @param {boolean} refocus give the focus back to the menu button */
function closeMenu(refocus) {
  const key = openMenuId;
  if (key === null) return;
  openMenuId = null;
  setMenuOpen(key, false);
  if (refocus) menuParts(key)?.trigger.focus();
}

/** @param {KeyboardEvent} e */
function onMenuKey(e) {
  const menu = /** @type {HTMLElement} */ (e.currentTarget);
  const list = menuItems(menu);
  const at = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
  /** @param {number} i */
  const go = (i) => {
    e.preventDefault();
    list[(i + list.length) % list.length]?.focus();
  };
  switch (e.key) {
    case 'ArrowDown':
      return go(at + 1);
    case 'ArrowUp':
      return go(at < 0 ? -1 : at - 1);
    case 'Home':
      return go(0);
    case 'End':
      return go(-1);
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      return closeMenu(true);
    case 'Tab':
      // The focus moves on from the menu button; the menu closes behind it.
      closeMenu(true);
      return;
    default:
  }
}

/** A click anywhere but in the open menu closes it. @param {MouseEvent} e */
function onDocumentClick(e) {
  if (openMenuId === null) return;
  const p = menuParts(openMenuId);
  if (p && !p.wrap.contains(/** @type {Node} */ (e.target))) closeMenu(false);
}

// -- D51: the selection bar, bulk switching and groups --

/** The selected sources the table shows, in table order. */
function selectedIds() {
  return shownRows()
    .filter((v) => isSwitchable(v) && selected.has(v.id))
    .map((v) => v.id);
}

function drawBulkBar() {
  const bar = $('bulk-bar');
  const n = selectedIds().length;
  const wasOpen = !bar.hidden;
  bar.hidden = n === 0;
  $('bulk-count').textContent = `${n} selected`;
  // The bar went while the focus was in it: the focus goes to the table's own selection box, or
  // on a narrow screen, where the table has no header, to the first selection box of a row.
  if (wasOpen && n === 0 && (bar.contains(document.activeElement) || document.activeElement === document.body)) {
    const all = /** @type {HTMLElement | null} */ (document.getElementById('select-all'));
    const target = all && all.offsetParent !== null ? all : /** @type {HTMLElement | null} */ (document.querySelector('#directory input.select:not([disabled])')) ?? $('search');
    target?.focus();
  }
}

/**
 * D51 bulk switch-on: the server switches on at once what the rules allow or the person accepted
 * before. The sources with silent rules come back in one list, shown in one dialog with each rule
 * line and link; "I accept for these N" sends that list's key and exactly its ids. Forbidden
 * sources are named and stay off.
 * @param {string[]} ids
 */
async function bulkEnable(ids) {
  if (ids.length === 0) return;
  /** @type {import('./view.js').BulkEnableOut | null} */
  const out = await act('POST', '/api/bulk/enable', { ids });
  if (!out) return;
  const view = bulkDialogView(out);
  if (!view.dialog) {
    if (view.notice) notify(view.notice, 'info');
    return;
  }
  const ok = await askDialog({
    title: view.title,
    nodes: [
      ...view.before.map((t) => h('p', { text: t })),
      view.forbidden.length > 0 ? h('p', { class: 'dialog-lead', text: view.forbiddenText }) : null,
      view.forbidden.length > 0
        ? h('ul', { class: 'bulk-list bulk-forbidden' }, ...view.forbidden.map((f) => h('li', {}, h('span', { class: 'source-name', text: f.name }), f.ruleUrl ? link(`Rules of ${f.name}`, f.ruleUrl) : null)))
        : null,
      view.needs.length > 0 ? h('p', { class: 'dialog-lead', text: view.needsText }) : null,
      view.needs.length > 0
        ? h(
            'ul',
            { class: 'bulk-list bulk-needs' },
            ...view.needs.map((x) => h('li', {}, h('div', { class: 'source-name', text: x.name }), h('blockquote', { text: x.quote }), x.ruleUrl ? link(`Rules of ${x.name}`, x.ruleUrl) : null)),
          )
        : null,
      view.needs.length > 0 ? h('p', { text: view.afterNeeds }) : null,
    ],
    accept: view.accept,
  });
  if (!ok || view.accept === null || !out.acknowledgment) return;
  const done = await act('POST', '/api/bulk/acknowledge', { token: out.acknowledgment.token, ids: out.acknowledgment.ids });
  if (done) notify(`Switched on ${plural(done.enabled.length, 'source', 'sources')} whose rules you accepted.`, 'info');
}

/** @param {string[]} ids */
async function bulkDisable(ids) {
  if (ids.length === 0) return;
  const out = await act('POST', '/api/bulk/disable', { ids });
  if (out) notify(`Switched off ${plural(out.disabled.length, 'source', 'sources')}.`, 'info');
}

/** "Add to group": an existing group, or a new one named here. */
async function onAddToGroup() {
  if (!state) return;
  const ids = selectedIds();
  if (ids.length === 0) return;
  const groups = state.groups;
  const NEW = 'new';
  const choice = h(
    'select',
    { id: 'dialog-group' },
    ...groups.map((g) => h('option', { value: String(g.id), text: g.name })),
    h('option', { value: NEW, text: 'A new group' }),
  );
  const name = h('input', { id: 'dialog-group-name', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '60', 'aria-describedby': 'dialog-group-error' });
  const nameField = h('div', { class: 'add-field' }, h('label', { for: 'dialog-group-name', text: 'Name of the new group' }), name);
  const error = h('p', { id: 'dialog-group-error', class: 'field-error', role: 'alert', hidden: true });
  const sync = () => (nameField.hidden = choice.value !== NEW);
  choice.addEventListener('change', sync);
  sync();
  const refuse = (/** @type {string} */ text) => {
    error.textContent = text;
    error.hidden = false;
    name.setAttribute('aria-invalid', 'true');
    name.focus();
    return false;
  };
  // A8 L5: a new group is made before the dialog closes, so a name the server refuses keeps the
  // dialog open with the typed name and the server's reason next to the field.
  /** @type {{ group: { id: number; name: string } } | null} */
  let made = null;
  const ok = await askDialog({
    title: `Add ${plural(ids.length, 'source', 'sources')} to a group`,
    nodes: [
      groups.length > 0 ? h('div', { class: 'add-field' }, h('label', { for: 'dialog-group', text: 'Group' }), choice) : null,
      nameField,
      error,
    ],
    accept: 'Add to group',
    check: async () => {
      if (choice.value !== NEW) return true;
      if (name.value.trim() === '') return refuse('Give the group a name.');
      try {
        made = await api('POST', '/api/groups', { name: name.value });
      } catch (e) {
        return refuse(e instanceof ApiError ? e.message : 'The request failed.');
      }
      return true;
    },
  });
  if (!ok) {
    // The group was made, then the dialog was closed while the answer came back: show it.
    if (made) await refresh();
    return;
  }
  let groupId = Number(choice.value);
  let groupName = groups.find((g) => g.id === groupId)?.name ?? '';
  if (choice.value === NEW) {
    if (!made) return;
    groupId = made.group.id;
    groupName = made.group.name;
  }
  const out = await act('POST', `/api/groups/${enc(String(groupId))}/add`, { ids });
  if (out) notify(`Added ${plural(ids.length, 'source', 'sources')} to ${groupName}.`, 'info');
}

/** "Remove from group": one of the groups that holds a selected source. */
async function onRemoveFromGroup() {
  if (!state) return;
  const ids = selectedIds();
  const holding = state.groups.filter((g) => g.sourceIds.some((id) => ids.includes(id)));
  if (holding.length === 0) {
    notify('None of the selected sources is in a group.', 'info');
    return;
  }
  const choice = h('select', { id: 'dialog-group' }, ...holding.map((g) => h('option', { value: String(g.id), text: g.name })));
  const ok = await askDialog({
    title: `Remove ${plural(ids.length, 'source', 'sources')} from a group`,
    nodes: [h('div', { class: 'add-field' }, h('label', { for: 'dialog-group', text: 'Group' }), choice), h('p', { class: 'muted small', text: 'The sources stay in lurkd, with their switches as they are.' })],
    accept: 'Remove from group',
  });
  if (!ok) return;
  const g = holding.find((x) => String(x.id) === choice.value);
  if (!g) return;
  const out = await act('POST', `/api/groups/${enc(String(g.id))}/remove`, { ids });
  if (out) notify(`Removed ${plural(ids.filter((id) => g.sourceIds.includes(id)).length, 'source', 'sources')} from ${g.name}.`, 'info');
}

/** The group editor (D51): new group, rename, delete. Names are the person's text, shown as text. */
function drawGroups() {
  if (!state) return;
  const list = state.groups;
  const byId = new Map(state.sources.map((v) => [v.id, v.name]));
  fill($('groups-list'),
    list.length === 0
      ? h('p', { class: 'muted', text: 'You have no group yet. Make one above, then add sources to it from the table: tick their boxes and press Add to group.' })
      : h(
          'ul',
          { class: 'plain-list' },
          ...list.map((g) => {
            const fieldId = `group-name-${g.id}`;
            const errorId = `${fieldId}-error`;
            const input = h('input', { id: fieldId, type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '60', 'aria-describedby': errorId });
            input.value = g.name;
            const error = h('p', { id: errorId, class: 'field-error', role: 'alert', hidden: true });
            const members = g.sourceIds.map((id) => byId.get(id) ?? id);
            return h(
              'li',
              { class: 'waiting group-entry' },
              h(
                'form',
                { class: 'group-form', novalidate: true, on: { submit: (/** @type {Event} */ e) => onRenameGroup(e, g, input, error) } },
                h('label', { for: fieldId, class: 'visually-hidden', text: `Name of ${g.name}` }),
                h(
                  'div',
                  { class: 'add-row' },
                  input,
                  h('button', { type: 'submit', class: 'button-quiet', text: 'Rename', 'aria-label': `Rename ${g.name}` }),
                  h('button', { type: 'button', class: 'button-quiet', text: 'Delete', 'aria-label': `Delete ${g.name}`, on: { click: () => onDeleteGroup(g) } }),
                ),
                error,
              ),
              h('p', { class: 'muted small group-members', text: members.length === 0 ? 'No source in it yet.' : `${plural(members.length, 'source', 'sources')}: ${members.join(', ')}` }),
            );
          }),
        ),
  );
}

/**
 * @param {HTMLInputElement} input
 * @param {HTMLElement} error
 * @param {string | null} text
 */
function fieldError(input, error, text) {
  error.textContent = text ?? '';
  error.hidden = text === null;
  if (text === null) input.removeAttribute('aria-invalid');
  else input.setAttribute('aria-invalid', 'true');
}

/** @param {Event} e */
async function onNewGroup(e) {
  e.preventDefault();
  const input = /** @type {HTMLInputElement} */ ($('group-new-name'));
  const error = $('group-new-error');
  if (input.value.trim() === '') {
    fieldError(input, error, 'Give the group a name.');
    input.focus();
    return;
  }
  try {
    await api('POST', '/api/groups', { name: input.value });
  } catch (err) {
    fieldError(input, error, err instanceof ApiError ? err.message : 'The request failed.');
    input.focus();
    return;
  }
  fieldError(input, error, null);
  input.value = '';
  await refresh();
}

/**
 * @param {Event} e
 * @param {{ id: number; name: string }} g
 * @param {HTMLInputElement} input
 * @param {HTMLElement} error
 */
async function onRenameGroup(e, g, input, error) {
  e.preventDefault();
  if (input.value.trim() === '') {
    fieldError(input, error, 'Give the group a name.');
    input.focus();
    return;
  }
  try {
    await api('POST', `/api/groups/${enc(String(g.id))}/rename`, { name: input.value });
  } catch (err) {
    fieldError(input, error, err instanceof ApiError ? err.message : 'The request failed.');
    input.focus();
    return;
  }
  fieldError(input, error, null);
  await refresh();
  /** @type {HTMLElement | null} */ (document.getElementById(`group-name-${g.id}`))?.focus();
}

/** @param {{ id: number; name: string; sourceIds: string[] }} g */
async function onDeleteGroup(g) {
  const ok = await askDialog({
    title: `Delete the group ${g.name}?`,
    paragraphs: [`The ${plural(g.sourceIds.length, 'source', 'sources')} in it stay in lurkd, with their switches as they are. Only the group goes.`],
    accept: 'Delete group',
  });
  if (!ok) return;
  const out = await act('DELETE', `/api/groups/${enc(String(g.id))}`);
  if (out) {
    notify(`Deleted the group ${g.name}.`, 'info');
    $('group-new-name').focus();
  }
}

// -- forums that forbid automated access (D49) --

/** What the person typed in each entry's topics field, by host, across redraws. */
const forbiddenTopics = new Map();
/** What the person typed in each entry's name field, by host, across redraws (M1). */
const forbiddenNames = new Map();

function drawForbidden() {
  if (!state) return;
  const list = state.forbidden;
  fill($('forbidden'),
    list.length === 0
      ? h('p', { class: 'muted', text: 'No forum is listed. A forum shows up here when Analyse finds a sentence in its rules that forbids automated access.' })
      : h('ul', { class: 'plain-list' }, ...list.map((e, i) => forbiddenEntry(e, i))),
  );
}

/**
 * @param {import('./view.js').ForbiddenEntryView} e
 * @param {number} i
 */
function forbiddenEntry(e, i) {
  const view = forbiddenView(e, nameOf);
  const rules = view.ruleUrl === null ? null : link('Read the rules page', view.ruleUrl);
  const dismiss = h('button', {
    type: 'button',
    class: 'button-quiet',
    text: 'Dismiss',
    'aria-label': `Dismiss ${e.name}`,
    on: { click: () => act('DELETE', `/api/forbidden/${enc(e.host)}`) },
  });
  /** @type {any[]} */
  let body;
  if (view.kind === 'known') {
    body = [
      h('p', { class: 'add-note' }, 'Already in lurkd as ', h('a', { href: `#source-${view.sourceId}`, text: view.name, on: { click: (/** @type {Event} */ ev) => goToRow(ev, view.sourceId) } })),
      h('div', { class: 'actions spaced' }, dismiss),
    ];
  } else if (view.kind === 'unknown') {
    body = [h('p', { class: 'add-note', text: view.text }), h('div', { class: 'actions spaced' }, dismiss)];
  } else {
    const fieldId = `forbidden-topics-${i}`;
    const errorId = `${fieldId}-error`;
    const topics = h('input', {
      id: fieldId,
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-describedby': `${fieldId}-hint ${errorId}`,
      on: { input: () => forbiddenTopics.set(e.host, topics.value) },
    });
    topics.value = forbiddenTopics.get(e.host) ?? '';
    // M1: the logged name came from the forum's page; it starts the field, which the person can correct.
    const nameId = `forbidden-name-${i}`;
    const nameErrorId = `${nameId}-error`;
    const name = h('input', {
      id: nameId,
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: String(MAX_FORUM_NAME),
      'aria-describedby': `${nameId}-hint ${nameErrorId}`,
      on: { input: () => forbiddenNames.set(e.host, name.value) },
    });
    name.value = forbiddenNames.get(e.host) ?? e.name;
    const nameError = h('p', { id: nameErrorId, class: 'field-error', role: 'alert', hidden: true });
    const error = h('p', { id: errorId, class: 'field-error', role: 'alert', hidden: true });
    const add = h('button', { type: 'submit', text: 'Add anyway', 'aria-label': `Add ${e.name} anyway` });
    body = [
      h(
        'form',
        { class: 'forbidden-form', novalidate: true, on: { submit: (/** @type {Event} */ ev) => onAddAnyway(ev, e, { name, nameError, topics, error }, add) } },
        h(
          'div',
          { class: 'add-field' },
          h('label', { for: nameId, text: 'Name' }),
          name,
          h('p', { id: `${nameId}-hint`, class: 'muted small', text: NAME_HINT }),
          nameError,
        ),
        h(
          'div',
          { class: 'add-field' },
          h('label', { for: fieldId, text: 'Topics' }),
          h('div', { class: 'add-row' }, topics, add, dismiss),
          h('p', { id: `${fieldId}-hint`, class: 'muted small', text: 'Separate them with commas, in lowercase with hyphens, for example: gardening, indoor-plants' }),
          error,
        ),
      ),
    ];
  }
  return h(
    'li',
    { class: 'waiting forbidden-entry' },
    h(
      'div',
      { class: 'entry-head' },
      h('span', { class: 'source-name', text: e.name }),
      h('span', { class: 'muted small', text: `${e.host}, found ${shortDate(e.foundAt)}` }),
    ),
    h('blockquote', { text: e.sentence }),
    rules ? h('p', { class: 'small' }, rules) : null,
    ...body,
  );
}

/**
 * "Add anyway": a draft with policy Forbidden and the logged sentence. Only the topics and the
 * name the person checked go out; the server takes everything else from the log.
 * @param {Event} ev
 * @param {import('./view.js').ForbiddenEntryView} e
 * @param {{ name: HTMLInputElement; nameError: HTMLElement; topics: HTMLInputElement; error: HTMLElement }} f
 * @param {HTMLButtonElement} button
 */
async function onAddAnyway(ev, e, f, button) {
  ev.preventDefault();
  const { name, nameError, topics, error } = f;
  /**
   * @param {HTMLInputElement} field
   * @param {HTMLElement} box
   * @param {string[]} lines
   */
  const show = (field, box, lines) => {
    box.textContent = lines.join(' ');
    box.hidden = lines.length === 0;
    if (lines.length > 0) field.setAttribute('aria-invalid', 'true');
    else field.removeAttribute('aria-invalid');
  };
  /** @param {string[]} nameLines @param {string[]} lines */
  const showErrors = (nameLines, lines) => {
    show(name, nameError, nameLines);
    show(topics, error, lines);
    if (nameLines.length > 0) name.focus();
    else if (lines.length > 0) topics.focus();
  };
  const local = checkAddForm({ policy: 'forbidden', quote: e.sentence, topicsText: topics.value, name: name.value });
  if (local.name || local.topics) {
    showErrors(local.name ? [local.name] : [], local.topics ? [local.topics] : []);
    return;
  }
  showErrors([], []);
  button.disabled = true;
  const shownName = name.value.trim();
  /** @type {any} */
  let out;
  try {
    out = await api('POST', `/api/forbidden/${enc(e.host)}/draft`, { topics: parseTopics(topics.value), name: shownName });
  } catch (err) {
    button.disabled = false;
    if (!(err instanceof ApiError)) return showErrors([], ['The request failed.']);
    if (err.status === 404) {
      notify(err.message, 'error');
      await refresh();
      return;
    }
    const mapped = addFormErrors({ message: err.message, details: err.details });
    const others = Object.entries(mapped.fields).filter(([k]) => k !== 'topics' && k !== 'name');
    showErrors(mapped.fields.name ?? [], [...(mapped.fields.topics ?? []), ...others.flatMap(([, v]) => v ?? []), ...mapped.other]);
    return;
  }
  forbiddenTopics.delete(e.host);
  forbiddenNames.delete(e.host);
  if (out?.status === 'draft_saved') notify(`Draft saved for ${shownName}. It waits under Drafts to approve and stays switched off until you accept the warning.`, 'info');
  else if (out?.status === 'known') notify(`${e.name} is already in lurkd as ${nameOf(out.sourceId) ?? out.sourceId}.`, 'info');
  await refresh();
}

/** @param {string} id */
const enc = (id) => encodeURIComponent(id);

/**
 * @param {SourceRow} v
 * @param {HTMLInputElement} input
 */
async function onSwitch(v, input) {
  if (!input.checked) {
    await act('POST', `/api/sources/${enc(v.id)}/disable`, {});
    return;
  }
  if (v.policy !== 'allowed' || v.needsAcknowledgment) {
    const ok = await warnAboutRules(v);
    if (!ok) {
      input.checked = false;
      return;
    }
    await act('POST', `/api/sources/${enc(v.id)}/enable`, { acknowledge: true });
    return;
  }
  await act('POST', `/api/sources/${enc(v.id)}/enable`, { acknowledge: false });
}

/** @param {SourceRow} v */
async function onReadWarning(v) {
  if (await warnAboutRules(v)) await act('POST', `/api/sources/${enc(v.id)}/enable`, { acknowledge: true });
}

/** @param {SourceRow} v */
function warnAboutRules(v) {
  const forbidden = v.policy === 'forbidden';
  return askDialog({
    title: v.enabled ? `Read the rules of ${v.name}` : `Switch on ${v.name}?`,
    paragraphs: [forbidden ? `The rules of ${v.name} forbid automated access.` : `The rules of ${v.name} do not say whether automated access is allowed.`],
    quote: v.ruleQuote ?? 'The rules page has no line that lurkd could quote.',
    link: { text: 'Read the rules', url: v.ruleUrl },
    after: [
      `${v.enabled ? 'Accepting' : 'Switching this on'} means lurkd reads this site with your login although its rules ${forbidden ? 'forbid automation' : 'do not mention it'}. You take that decision.`,
    ],
    accept: 'I accept',
  });
}

/** @param {SourceRow} v */
async function onDeleteArchive(v) {
  const ok = await askDialog({
    title: `Delete the archive of ${v.name}?`,
    paragraphs: ['This removes every thread lurkd stored for this source. The forum itself is not touched.'],
    accept: 'Delete threads',
  });
  if (!ok) return;
  const out = await act('DELETE', `/api/sources/${enc(v.id)}/archive`);
  if (out) notify(`Deleted ${plural(out.deleted, 'thread', 'threads')} of ${v.name}.`, 'info');
}

/** @param {SourceRow} v */
async function onRemove(v) {
  const ok = await askDialog({
    title: `Remove ${v.name}?`,
    paragraphs: [
      `This deletes ${v.id}.yaml from ~/.lurkd/sources, so your agent can no longer read ${v.name}. The forum and your account there are not touched.`,
      `The threads lurkd archived from ${v.name} stay. To delete them too, press Delete archive before you remove the source.`,
    ],
    accept: 'Remove source',
  });
  if (!ok) return;
  const out = await act('DELETE', `/api/sources/${enc(v.id)}`);
  if (out) notify(`Removed ${v.name}. Its archived threads stay.`, 'info');
}

// -- archive search --

let searchTimer = 0;
let searchSeq = 0;
/** @type {ArchiveHit[]} */
let hits = [];

function onSearchInput() {
  setFilters({ q: /** @type {HTMLInputElement} */ ($('search')).value });
}

/** Searches the archive for the words of the text filter, after a pause. */
function searchArchive() {
  clearTimeout(searchTimer);
  const q = filters.q.trim();
  if (q === '') {
    searchSeq++;
    $('archive').hidden = true;
    closeThread();
    return;
  }
  $('archive').hidden = false;
  $('results-status').textContent = 'Searching the archive...';
  fill($('results'));
  searchTimer = window.setTimeout(() => runSearch(q), SEARCH_DELAY_MS);
}

/** @param {string} q */
async function runSearch(q) {
  const seq = ++searchSeq;
  /** @type {ArchiveHit[]} */
  let found;
  try {
    found = await api('GET', `/api/archive/search?q=${encodeURIComponent(q)}`);
  } catch (e) {
    if (seq !== searchSeq) return;
    $('results-status').textContent = e instanceof ApiError ? e.message : 'The archive search failed.';
    return;
  }
  if (seq !== searchSeq) return;
  hits = found;
  $('results-status').textContent = found.length === 0 ? `No archived posts match "${q}".` : plural(found.length, 'archived post matches', 'archived posts match') + '.';
  fill($('results'),
    ...found.map((hit) =>
      h(
        'li',
        {},
        h(
          'button',
          { type: 'button', class: 'hit-button', on: { click: () => openThread(hit) } },
          h('span', { class: 'hit-title', text: hit.threadTitle }),
          h('span', { class: 'hit-meta' }, `${sourceName(hit.source) ?? hit.source}, post ${hit.postNumber}, ${hit.author}${hit.postedAt ? `, ${shortDate(hit.postedAt)}` : ''}`),
          h('span', { class: 'hit-excerpt', text: hit.excerpt }),
        ),
      ),
    ),
  );
}

/** @param {ArchiveHit} hit */
async function openThread(hit) {
  try {
    const out = await api('GET', `/api/threads/${enc(String(hit.threadId))}`);
    $('thread-title').textContent = hit.threadTitle;
    // The Markdown stays text: a <pre>, set with textContent. The name markers in it are only delimiters.
    $('thread-text').textContent = String(out.markdown);
    $('thread-panel').hidden = false;
    $('thread-panel').scrollIntoView({ block: 'nearest' });
  } catch (e) {
    notify(e instanceof ApiError ? e.message : 'The thread could not be opened.', 'error');
  }
}

function closeThread() {
  $('thread-panel').hidden = true;
  $('thread-text').textContent = '';
}

// -- queue, samples, drafts --

function drawQueue() {
  if (!state) return;
  const jobs = state.jobs;
  const box = $('queue');
  if (jobs.length === 0) {
    fill(box, h('p', { class: 'muted', text: 'No jobs yet. Reads start from your agent, not from this page.' }));
    return;
  }
  const running = jobs.find((j) => j.state === 'running');
  const waiting = jobs.filter((j) => j.state === 'queued').length;
  const finished = jobs.filter((j) => j.state === 'done' || j.state === 'stopped' || j.state === 'failed').slice(-20).reverse();
  fill(box,
    h('h3', { text: 'Running now' }),
    running
      ? h(
          'div',
          { class: 'job' },
          // A search line already names its source.
          running.phase === 'search' ? null : h('span', { class: 'job-source', text: sourceName(running.sourceId) ?? running.sourceId }),
          h('span', { text: describeJob(running, nameOf) }),
          running.requestCap > 0
            ? h('div', {}, h('progress', { max: running.requestCap, value: Math.min(running.requestsUsed, running.requestCap), 'aria-label': 'Requests used in this run' }))
            : null,
        )
      : h('p', { class: 'muted', text: 'Nothing is running.' }),
    waiting > 0 ? h('p', { class: 'muted', text: `${waiting} waiting in the queue.` }) : null,
    h('h3', { text: 'Last 20 jobs' }),
    finished.length === 0
      ? h('p', { class: 'muted', text: 'No job has finished yet.' })
      : h(
          'ul',
          { class: 'plain-list' },
          ...finished.map((j) => h('li', { class: 'job' }, h('span', { class: 'job-source', text: sourceName(j.sourceId) ?? j.sourceId }), h('span', { text: describeJob(j, nameOf) }))),
        ),
  );
}

function drawSamples() {
  if (!state) return;
  const list = state.samplesPending;
  const windowOpen = !!state.browser.handoff;
  fill($('samples'),
    list.length === 0
      ? h('p', { class: 'muted', text: 'No site is waiting for a sample.' })
      : h(
          'ul',
          { class: 'plain-list' },
          ...list.map((p) =>
            h(
              'li',
              { class: 'waiting' },
              h('div', { class: 'source-name', text: p.host }),
              h('p', { class: 'desc small', text: p.url }),
              h('div', { class: 'actions spaced' }, h('button', {
                type: 'button',
                text: 'Open window',
                'aria-label': `Open window for ${p.host}`,
                disabled: windowOpen,
                on: { click: () => act('POST', '/api/sample-requests/open', { host: p.host }) },
              })),
            ),
          ),
        ),
  );
}

function drawDrafts() {
  if (!state) return;
  const list = state.drafts;
  fill($('drafts'),
    list.length === 0
      ? h('p', { class: 'muted', text: 'No draft is waiting for approval.' })
      : h(
          'ul',
          { class: 'plain-list' },
          ...list.map((d) => {
            const notes = draftHighlights(d);
            return h(
              'li',
              { class: 'draft' },
              h('div', { class: 'source-name', text: `${d.sourceId} (${d.host})` }),
              notes.length > 0 ? h('ul', { class: 'highlights' }, ...notes.map((n) => h('li', { text: n }))) : null,
              h('pre', { tabindex: '0', 'aria-label': `Draft YAML for ${d.sourceId}`, text: d.yaml }),
              h(
                'div',
                { class: 'actions spaced' },
                h('button', { type: 'button', text: 'Approve', 'aria-label': `Approve the draft for ${d.sourceId}`, on: { click: () => act('POST', `/api/drafts/${enc(String(d.id))}/approve`, {}) } }),
                h('button', { type: 'button', class: 'button-quiet', text: 'Reject', 'aria-label': `Reject the draft for ${d.sourceId}`, on: { click: () => act('POST', `/api/drafts/${enc(String(d.id))}/reject`, {}) } }),
              ),
            );
          }),
        ),
  );
}

// -- add a forum (D45) --

let addBusy = false;

/** @param {boolean} busy */
function setAddBusy(busy) {
  addBusy = busy;
  const input = /** @type {HTMLInputElement} */ ($('add-url'));
  input.readOnly = busy;
  /** @type {HTMLButtonElement} */ ($('add-analyse')).disabled = busy;
  $('add').setAttribute('aria-busy', String(busy));
  fill($('add-status'));
  drawn.delete('add-requests');
  drawAddRequests();
}

const ADD_URL_ERROR = 'add-url-error';

/**
 * Shows `text` as the error of the address field, in place of the result, and ties it to the
 * field (aria-invalid, aria-describedby) until `clearAddressError` takes it away.
 * @param {string} text
 */
function showAddressError(text) {
  fill($('add-result'), h('p', { id: ADD_URL_ERROR, class: 'add-error', role: 'alert', text }));
  const input = $('add-url');
  const ids = (input.getAttribute('aria-describedby') ?? '').split(' ').filter((t) => t !== '' && t !== ADD_URL_ERROR);
  input.setAttribute('aria-describedby', [...ids, ADD_URL_ERROR].join(' '));
  input.setAttribute('aria-invalid', 'true');
}

/** Takes the address error away, if one shows, and unties it from the field. */
function clearAddressError() {
  document.getElementById(ADD_URL_ERROR)?.remove();
  const input = $('add-url');
  const ids = (input.getAttribute('aria-describedby') ?? '').split(' ').filter((t) => t !== '' && t !== ADD_URL_ERROR);
  input.setAttribute('aria-describedby', ids.join(' '));
  input.removeAttribute('aria-invalid');
}

/** @param {Event} e */
function onAddSubmit(e) {
  e.preventDefault();
  runAnalyse(/** @type {HTMLInputElement} */ ($('add-url')).value);
}

/**
 * Sends `url` to the analysis as it stands in the address field. The answer can take minutes:
 * the job waits for any job ahead of it in the queue, and the page waits with it.
 * @param {string} url
 */
async function runAnalyse(url) {
  if (addBusy) return;
  const result = $('add-result');
  if (url.trim() === '') {
    showAddressError('Type the address of a forum page first, starting with https://.');
    return;
  }
  clearAddressError();
  fill(result);
  setAddBusy(true);
  fill($('add-status'),
    h('span', { text: `Analysing ${url.trim()}. lurkd runs one job at a time, so this waits for any job already in the queue.` }),
    h('progress', { class: 'add-progress', 'aria-label': 'Analysis in progress' }),
  );
  /** @type {any} */
  let out;
  try {
    out = await api('POST', '/api/add/analyse', { url });
  } catch (e) {
    setAddBusy(false);
    const why = e instanceof ApiError ? e.message : 'The request failed.';
    showAddressError(`lurkd could not analyse this address. ${why}`);
    return;
  }
  setAddBusy(false);
  // A known host may have just left the queue of lurkd add; the source names come from the state.
  await refresh();
  drawAnalysis(out);
}

/** @param {any} out an answer of /api/add/analyse, or `known` from /api/add/draft */
function drawAnalysis(out) {
  const view = analyseView(out, nameOf);
  const result = $('add-result');
  clearAddressError();
  switch (view.kind) {
    case 'known':
      fill(result,
        h(
          'p',
          { class: 'add-note', role: 'status' },
          'Already in lurkd as ',
          h('a', { href: `#source-${view.sourceId}`, text: view.name, on: { click: (/** @type {Event} */ e) => goToRow(e, view.sourceId) } }),
        ),
      );
      return;
    case 'blocked':
      fill(result, h('p', { class: 'add-note', role: 'status', text: view.text }));
      return;
    case 'unknown':
      fill(result, h('div', { class: 'add-card' }, ...forumFacts(view.forum), h('p', { class: 'add-note', text: view.text })));
      return;
    case 'form':
      fill(result, draftForm(view.forum, view.note, view.prefill));
      return;
    default:
      showAddressError(view.text);
  }
}

/**
 * Engine, name, domains and the rules links of the analysed page. Every value is page text,
 * inserted as text; each link went through safeHttpUrl. The draft form leaves the name out
 * (`withName` false): it shows the name as a field the person can correct (M1).
 * @param {ForumDetection} forum
 * @param {boolean} [withName]
 */
function forumFacts(forum, withName = true) {
  const links = forum.termsLinks.map((l) => link(termsLinkText(l), l.href)).filter((a) => a !== null);
  return [
    h(
      'dl',
      { class: 'add-facts' },
      h('dt', { text: 'Engine' }),
      h('dd', { text: engineLabel(forum.engine) }),
      ...(withName ? [h('dt', { text: 'Name' }), h('dd', { text: forum.name })] : []),
      h('dt', { text: forum.domains.length === 1 ? 'Domain' : 'Domains' }),
      h('dd', { text: forum.domains.join(', ') }),
    ),
    h('h3', { text: 'Rules pages' }),
    links.length === 0
      ? h('p', { class: 'muted', text: 'lurkd found no link to the rules on this page. Look for them on the forum before you choose below.' })
      : h('ul', { class: 'add-links' }, ...links.map((a) => h('li', {}, a))),
  ];
}

/** @type {AddField[]} */
const ADD_FIELDS = ['name', 'policy', 'quote', 'ruleUrl', 'topics'];
const FIELD_IDS = { name: 'add-name', policy: 'add-policy', quote: 'add-quote', ruleUrl: 'add-rule-url', topics: 'add-topics' };

/** The hint under a name field: the detected name is the forum's own text (M1). */
const NAME_HINT = 'lurkd took this from the forum page. Check it and correct it if needed: your agent sees this name.';

/** @param {AddField} f */
const errorBox = (f) => h('p', { id: `${FIELD_IDS[f]}-error`, class: 'field-error', hidden: true });

/**
 * The form for a Discourse or XenForo forum: name, policy, quote, rules page, topics, Save draft.
 * The name starts as the detected one, which the forum's page chose, so the person sees and can
 * correct it before saving (M1). With `prefill` (D49), it starts at Forbidden with the sentence
 * lurkd found and its page.
 * @param {ForumDetection} forum
 * @param {string | null} note
 * @param {import('./view.js').AddPrefill | null} prefill
 */
function draftForm(forum, note, prefill) {
  const start = prefill?.policy ?? 'unknown';
  const radios = /** @type {const} */ ([
    ['allowed', 'Allowed'],
    ['forbidden', 'Forbidden'],
    ['unknown', 'Unknown'],
  ]).map(([value, text]) => {
    const input = h('input', { type: 'radio', name: 'add-policy', value, checked: value === start, on: { change: onPolicy } });
    return { input, label: h('label', { class: 'check' }, input, h('span', { text })) };
  });
  const quote = h('textarea', { id: 'add-quote', rows: '3', 'aria-describedby': 'add-quote-hint add-quote-error' });
  const rulePage = h(
    'select',
    { id: 'add-rule-url', 'aria-describedby': 'add-rule-url-hint add-rule-url-error' },
    ...rulesPageChoices(forum, prefill?.ruleUrl ?? null).map((c) => h('option', { value: c.value, text: c.text })),
  );
  // The sentence is forum text: set as the field's value, never parsed.
  if (prefill) quote.value = prefill.quote;
  const name = h('input', {
    id: 'add-name',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: String(MAX_FORUM_NAME),
    'aria-describedby': 'add-name-hint add-name-error',
  });
  // The detected name is page text too: set as the field's value.
  name.value = forum.name;
  const topics = h('input', { id: 'add-topics', type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'add-topics-hint add-topics-error' });
  const others = h('ul', { id: 'add-form-errors', class: 'add-errors', role: 'alert', hidden: true });
  const save = h('button', { type: 'submit', text: 'Save draft' });

  function onPolicy() {
    const policy = radios.find((r) => r.input.checked)?.input.value;
    quote.setAttribute('aria-required', String(policy === 'allowed' || policy === 'forbidden'));
  }
  onPolicy();

  /** @param {Partial<Record<AddField, string[]>>} fields @param {string[]} other */
  function showErrors(fields, other) {
    for (const f of ADD_FIELDS) {
      const box = form.querySelector(`#${FIELD_IDS[f]}-error`);
      const list = fields[f] ?? [];
      box.textContent = list.join(' ');
      box.hidden = list.length === 0;
      const target = f === 'policy' ? form.querySelector('fieldset') : form.querySelector(`#${FIELD_IDS[f]}`);
      if (list.length > 0) target.setAttribute('aria-invalid', 'true');
      else target.removeAttribute('aria-invalid');
    }
    fill(others, ...other.map((t) => h('li', { text: t })));
    others.hidden = other.length === 0;
    const first = ADD_FIELDS.find((f) => (fields[f] ?? []).length > 0);
    if (first === 'policy') radios[0]?.input.focus();
    else if (first !== undefined) form.querySelector(`#${FIELD_IDS[first]}`)?.focus();
  }

  /** @param {Event} e */
  async function onSave(e) {
    e.preventDefault();
    const values = {
      name: name.value,
      policy: radios.find((r) => r.input.checked)?.input.value ?? '',
      quote: quote.value,
      topicsText: topics.value,
      ruleUrl: rulePage.value,
    };
    const local = checkAddForm(values);
    const localFields = Object.fromEntries(Object.entries(local).map(([k, v]) => [k, [v]]));
    showErrors(localFields, []);
    if (Object.keys(local).length > 0) return;
    save.disabled = true;
    /** @type {any} */
    let out;
    try {
      out = await api('POST', '/api/add/draft', addDraftBody(forum, values));
    } catch (err) {
      save.disabled = false;
      if (err instanceof ApiError) {
        const mapped = addFormErrors({ message: err.message, details: err.details });
        showErrors(mapped.fields, mapped.other);
      } else showErrors({}, ['The request failed.']);
      return;
    }
    await refresh();
    if (out?.status === 'draft_saved') {
      /** @type {HTMLInputElement} */ ($('add-url')).value = '';
      fill($('add-result'),
        h(
          'p',
          { class: 'add-note', role: 'status' },
          `Draft saved for ${values.name.trim()}. Check it and approve it under `,
          h('a', {
            href: '#h-drafts',
            text: 'Drafts to approve',
            on: {
              click: (/** @type {Event} */ ev) => {
                ev.preventDefault();
                showPanel('drafts');
              },
            },
          }),
          '.',
        ),
      );
      return;
    }
    drawAnalysis(out);
  }

  const form = h(
    'form',
    { class: 'add-card add-draft', novalidate: true, on: { submit: onSave } },
    ...forumFacts(forum, false),
    note ? h('p', { class: 'add-note', text: note }) : null,
    prefill ? h('p', { class: 'add-note', text: prefill.text }) : null,
    h(
      'div',
      { class: 'add-field' },
      h('label', { for: 'add-name', text: 'Name' }),
      name,
      h('p', { id: 'add-name-hint', class: 'muted small', text: NAME_HINT }),
      errorBox('name'),
    ),
    h(
      'fieldset',
      { class: 'add-policy', 'aria-describedby': 'add-policy-error' },
      h('legend', { text: 'What do the forum rules say about automated access?' }),
      h('div', { class: 'add-choices' }, ...radios.map((r) => r.label)),
      errorBox('policy'),
    ),
    h(
      'div',
      { class: 'add-field' },
      h('label', { for: 'add-quote', text: 'Quote from the rules' }),
      quote,
      h('p', { id: 'add-quote-hint', class: 'muted small', text: 'Required for Allowed and Forbidden: paste the exact sentence from the rules.' }),
      errorBox('quote'),
    ),
    h(
      'div',
      { class: 'add-field' },
      h('label', { for: 'add-rule-url', text: 'Rules page' }),
      rulePage,
      h('p', { id: 'add-rule-url-hint', class: 'muted small', text: 'The page the quote comes from.' }),
      errorBox('ruleUrl'),
    ),
    h(
      'div',
      { class: 'add-field' },
      h('label', { for: 'add-topics', text: 'Topics' }),
      topics,
      h('p', { id: 'add-topics-hint', class: 'muted small', text: 'Separate them with commas, in lowercase with hyphens, for example: gardening, indoor-plants' }),
      errorBox('topics'),
    ),
    others,
    h('div', { class: 'actions spaced' }, save),
    h('p', { class: 'muted small', text: 'The draft lands switched off. It waits under Drafts to approve until you approve it.' }),
  );
  return form;
}

/**
 * Shows the row of a source, clearing a search that hides it.
 * @param {Event} e
 * @param {string} id
 */
function goToRow(e, id) {
  e.preventDefault();
  const row = revealRow(id, true);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.focus();
}

function drawAddRequests() {
  if (!state) return;
  const list = state.addRequests;
  const box = $('add-requests');
  if (list.length === 0) {
    fill(box);
    return;
  }
  fill(box,
    h('h3', { text: 'Waiting from your agent' }),
    h('p', { class: 'muted small', text: 'Your agent asked lurkd to add these forums. lurkd opens a page only when you press Analyse.' }),
    h(
      'ul',
      { class: 'plain-list' },
      ...list.map((p) =>
        h(
          'li',
          { class: 'waiting' },
          h('div', { class: 'source-name', text: p.host }),
          h('p', { class: 'desc small', text: p.url }),
          h(
            'div',
            { class: 'actions spaced' },
            h('button', {
              type: 'button',
              text: 'Analyse',
              'aria-label': `Analyse ${p.host}`,
              disabled: addBusy,
              on: {
                click: () => {
                  // The field shows the address before it goes out, and the same text is sent.
                  /** @type {HTMLInputElement} */ ($('add-url')).value = p.url;
                  runAnalyse(p.url);
                },
              },
            }),
            h('button', {
              type: 'button',
              class: 'button-quiet',
              text: 'Dismiss',
              'aria-label': `Dismiss ${p.host}`,
              disabled: addBusy,
              on: { click: () => act('DELETE', `/api/add/${enc(p.host)}`) },
            }),
          ),
        ),
      ),
    ),
  );
}

// -- C1: importing a saved Reddit thread (D50) --

/** Opens Add a forum at its import part, the file field taking the focus. */
function openImport() {
  showPanel('add', { focus: false });
  const field = $('import-file');
  $('import').scrollIntoView({ block: 'nearest' });
  field.focus();
}

/** @param {string | null} text */
function showImportError(text) {
  const box = $('import-error');
  box.textContent = text ?? '';
  box.hidden = text === null;
  const field = $('import-file');
  if (text === null) field.removeAttribute('aria-invalid');
  else field.setAttribute('aria-invalid', 'true');
}

let importBusy = false;

/**
 * Reads the chosen file in the page and sends its text to the page's upload route. lurkd does
 * not contact Reddit; the server parses the file and stores the thread. The answer's title is
 * forum text and goes on the page as text.
 * @param {Event} e
 */
async function onImport(e) {
  e.preventDefault();
  if (importBusy) return;
  const field = /** @type {HTMLInputElement} */ ($('import-file'));
  const file = field.files?.[0] ?? null;
  const problem = checkImportFile(file);
  fill($('import-result'));
  if (problem !== null || file === null) {
    showImportError(problem ?? 'Choose the saved thread file first.');
    field.focus();
    return;
  }
  showImportError(null);
  importBusy = true;
  const button = /** @type {HTMLButtonElement} */ ($('import-submit'));
  button.disabled = true;
  try {
    let text;
    try {
      text = await file.text();
    } catch {
      showImportError('lurkd could not read this file. Choose it again.');
      return;
    }
    /** @type {any} */
    let out;
    try {
      out = await api('POST', '/api/import/reddit/upload', text, { raw: true });
    } catch (err) {
      showImportError(err instanceof ApiError ? err.message : 'The request failed.');
      field.focus();
      return;
    }
    const view = importResultView(out);
    field.value = '';
    fill($('import-result'),
      h(
        'div',
        { class: 'add-card import-card' },
        h('p', { class: 'source-name', text: view.heading }),
        h('p', { class: 'import-title', text: view.title }),
        ...view.lines.map((t) => h('p', { class: 'small', text: t })),
      ),
    );
    await refresh();
  } finally {
    importBusy = false;
    button.disabled = false;
  }
}

// -- dialog --

/**
 * Opens the modal dialog and settles with true only when the accept button is pressed; Cancel
 * and Escape settle with false. `nodes` go in after the paragraphs, quote and link. With
 * `accept: null` the dialog only informs: one Close button, settling with false. `check` runs on
 * accept and keeps the dialog open when it answers false; it may ask the server first, and the
 * accept button waits, disabled, until it answers.
 * @param {{ title: string; paragraphs?: string[]; quote?: string; link?: { text: string; url: string }; nodes?: any[]; after?: string[]; accept: string | null; check?: () => boolean | Promise<boolean> }} o
 * @returns {Promise<boolean>}
 */
function askDialog(o) {
  const dialog = /** @type {HTMLDialogElement} */ ($('dialog'));
  if (dialog.open) return Promise.resolve(false);
  const rulesLink = o.link ? link(o.link.text, o.link.url) : null;
  $('dialog-title').textContent = o.title;
  fill($('dialog-body'),
    ...(o.paragraphs ?? []).map((t) => h('p', { text: t })),
    o.quote ? h('blockquote', { text: o.quote }) : null,
    rulesLink ? h('p', {}, rulesLink) : null,
    ...(o.nodes ?? []),
    ...(o.after ?? []).map((t) => h('p', { text: t })),
  );
  return new Promise((resolve) => {
    let settled = false;
    // Each button settles the promise itself; a close event queued by an earlier dialog must not
    // settle this one, so nothing listens for 'close'. Escape fires 'cancel' first.
    const finish = (/** @type {boolean} */ value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener('cancel', onCancel);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onCancel = () => finish(false);
    dialog.addEventListener('cancel', onCancel);
    const check = o.check;
    /** @type {HTMLButtonElement | null} */
    let acceptButton = null;
    const onAccept = async () => {
      if (check && acceptButton) {
        if (acceptButton.disabled) return;
        acceptButton.disabled = true;
        let ok = false;
        try {
          ok = await check();
        } finally {
          acceptButton.disabled = false;
        }
        if (!ok) return;
      }
      finish(true);
    };
    if (o.accept !== null) acceptButton = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', text: o.accept, on: { click: onAccept } }));
    fill($('dialog-actions'),
      o.accept === null
        ? h('button', { type: 'button', text: 'Close', autofocus: true, on: { click: () => finish(false) } })
        : [h('button', { type: 'button', class: 'button-quiet', text: 'Cancel', autofocus: true, on: { click: () => finish(false) } }), acceptButton],
    );
    dialog.showModal();
  });
}

// -- messages --

/**
 * @param {string} text
 * @param {'info' | 'error'} kind
 */
function notify(text, kind) {
  const box = $('notice');
  box.className = kind === 'error' ? 'banner banner-error' : 'banner';
  box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  $('notice-text').textContent = text;
  box.hidden = false;
}

/**
 * Sends a change, shows an error if there is one, and reads the state again at once.
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<any>} the answer, or null after an error
 */
async function act(method, path, body) {
  let out = null;
  /** @type {ReturnType<typeof focusMark> | null} */
  let mark = null;
  try {
    out = await api(method, path, body);
    $('notice').hidden = true;
  } catch (e) {
    notify(e instanceof ApiError ? e.message : 'The request failed.', 'error');
    // A switch the person flipped has to go back to what the server holds. The table is drawn
    // again, so the focus goes back to the same control of the row, or to its menu button.
    mark = focusMark();
    drawn.clear();
    resetDirectory();
  }
  await refresh();
  if (mark) restoreFocus(mark, true);
  return out;
}

// ---- polling ----

/** @type {Promise<void> | null} */
let inFlight = null;

function refresh() {
  inFlight ??= (async () => {
    try {
      state = await api('GET', '/api/state');
      $('unreachable').hidden = true;
      drawAll();
      if (startAnchor !== null) {
        const anchor = startAnchor;
        startAnchor = null;
        goToAnchor(anchor);
      }
    } catch (e) {
      const reason =
        e instanceof ApiError && (e.status === 401 || e.status === 403)
          ? 'lurkd did not accept this page. Run lurkd open in a terminal to open it again.'
          : e instanceof ApiError && e.code !== 'unreachable'
            ? `lurkd could not report its state: ${e.message}`
            : NOT_RUNNING;
      const box = $('unreachable');
      box.textContent = reason;
      box.hidden = false;
      $('directory').setAttribute('aria-busy', 'false');
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

let pollTimer = 0;

async function poll() {
  await refresh();
  schedule();
}

function schedule() {
  clearTimeout(pollTimer);
  if (document.visibilityState === 'visible') pollTimer = window.setTimeout(poll, POLL_MS);
}

function start() {
  // D52: the page opens from a one-time link, /?n=<nonce>. The link is used up by now, so the
  // address loses it: a reload or a bookmark asks for / with the page's cookie instead.
  if (location.search !== '') history.replaceState(null, '', location.pathname + location.hash);
  $('search').addEventListener('input', onSearchInput);
  /** @param {string} id @param {(v: string) => Partial<Filters>} patch */
  const onSelect = (id, patch) => $(id).addEventListener('change', () => setFilters(patch(/** @type {HTMLSelectElement} */ ($(id)).value)));
  onSelect('filter-topic', (topic) => ({ topic }));
  onSelect('filter-policy', (policy) => ({ policy }));
  onSelect('filter-engine', (engine) => ({ engine }));
  onSelect('sort', (sort) => ({ sort: /** @type {Filters['sort']} */ (sort) }));
  onSelect('group-by', (group) => ({ group: /** @type {Filters['group']} */ (group) }));
  $('open-groups').addEventListener('click', () => togglePanel('groups'));
  $('group-new').addEventListener('submit', onNewGroup);
  $('bulk-on').addEventListener('click', () => bulkEnable(selectedIds()));
  $('bulk-off').addEventListener('click', () => bulkDisable(selectedIds()));
  $('bulk-add').addEventListener('click', onAddToGroup);
  $('bulk-remove').addEventListener('click', onRemoveFromGroup);
  $('bulk-clear').addEventListener('click', () => {
    selected.clear();
    drawDirectory();
  });
  $('import-form').addEventListener('submit', onImport);
  window.addEventListener('hashchange', onHashChange);
  $('open-add').addEventListener('click', () => togglePanel('add'));
  $('queue-state').addEventListener('click', () => togglePanel('queue'));
  for (const b of document.querySelectorAll('.panel-close'))
    b.addEventListener('click', () => closePanel(/** @type {PanelKey} */ (/** @type {HTMLElement} */ (b).dataset.panel)));
  // Escape in an open panel closes it, unless a menu or the dialog takes the key first.
  $('panels').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openPanel !== null && !(/** @type {HTMLDialogElement} */ ($('dialog')).open)) closePanel(openPanel);
  });
  document.addEventListener('click', onDocumentClick);
  /** @type {HTMLInputElement} */ ($('search')).value = filters.q;
  // Filters in the hash are written back in their usual form; an anchor such as #source-lg stays,
  // and the first draw of the table goes to its row.
  if (isFilterHash(location.hash)) writeHash();
  else startAnchor = location.hash;
  if (filters.q.trim() !== '') searchArchive();
  $('notice-close').addEventListener('click', () => ($('notice').hidden = true));
  $('thread-close').addEventListener('click', closeThread);
  $('retention').addEventListener('change', onRetention);
  $('add-form').addEventListener('submit', onAddSubmit);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
    else clearTimeout(pollTimer);
  });
  poll();
}

async function onRetention() {
  const sel = /** @type {HTMLSelectElement} */ ($('retention'));
  const days = sel.value === '' ? null : Number(sel.value);
  const current = state?.retentionDays ?? null;
  if (days === current) return;
  // A shorter limit deletes older threads at once, so it asks first.
  if (days !== null && (current === null || days < current)) {
    const ok = await askDialog({
      title: `Keep archived threads for ${days} days?`,
      paragraphs: [`Threads lurkd read more than ${days} days ago are deleted now, and again whenever they pass that age.`],
      accept: 'Apply',
    });
    if (!ok) {
      sel.value = current === null ? '' : String(current);
      return;
    }
  }
  const out = await act('POST', '/api/settings/retention', { days });
  if (out) notify(days === null ? 'lurkd keeps every thread.' : `lurkd keeps threads for ${days} days. Deleted ${plural(out.deleted, 'thread', 'threads')}.`, 'info');
}

start();
