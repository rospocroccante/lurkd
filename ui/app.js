// The lurkd page. Plain ES modules, no build step, no framework.
//
// Rules this file keeps (the server's Content-Security-Policy blocks inline script, and the text
// on this page comes from forums and from files the user wrote):
// - every string that came from the server is put on the page with textContent or a text node,
//   through `h()` below; there is no innerHTML, outerHTML or insertAdjacentHTML here;
// - a link gets an href only after safeHttpUrl() accepts it (http or https), and opens with
//   rel="noopener noreferrer";
// - the page never reads, stores or sends the token: the browser holds it as a cookie, and the
//   address the person opened was redirected to / by the server;
// - changes go to the server with same-origin fetch, so the browser sets Origin and the cookie.
// - no control starts a read of a forum (D19); reads come from the agent.

import { describeJob, draftHighlights, filterSources, groupByTopic, policyBadge, safeHttpUrl, sessionBadge, statusBadge } from './view.js';

/**
 * @typedef {import('../src/sources/registry.js').SourceView & { counts7d: { blocked: number; beaconsBlocked: number; challenges: number }; block: 'login' | 'challenge' | null }} SourceRow
 * @typedef {import('../src/fetch/queue.js').JobProgress} JobProgress
 * @typedef {import('../src/sources/drafts.js').DraftView} DraftView
 * @typedef {import('../src/fetch/service.js').ArchiveHitOut} ArchiveHit
 * @typedef {{ sourceId: string | null; url: string; purpose: 'login' | 'challenge' | 'sample'; startedAt: string }} Handoff
 * @typedef {{
 *   version: string;
 *   browser: { state: string; lastError: string | null; handoff: Handoff | null };
 *   jobs: JobProgress[];
 *   sources: SourceRow[];
 *   drafts: DraftView[];
 *   samplesPending: { host: string; url: string; requestedAt: string }[];
 *   registryErrors: string[];
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
  for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) el.append(kid);
  return el;
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
  /** @param {string} code @param {string} message @param {number} status */
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 */
async function api(method, path, body) {
  /** @type {Response} */
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
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
    );
  }
  return data;
}

// ---- state and drawing ----

/** @type {AppState | null} */
let state = null;
let query = '';
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
  drawDirectory();
  part('queue', [s.jobs, s.sources.map((x) => [x.id, x.name])], drawQueue);
  part('samples', [s.samplesPending, !!s.browser.handoff], drawSamples);
  part('drafts', s.drafts, drawDrafts);
  part('errors', s.registryErrors, () => {
    $('errors-section').hidden = s.registryErrors.length === 0;
    $('registry-errors').replaceChildren(...s.registryErrors.map((line) => h('li', { class: 'job', text: line })));
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
    actions.replaceChildren(
      h('button', { type: 'button', text: 'Use this page', on: { click: () => act('POST', '/api/sample-requests/capture', {}) } }),
      h('button', { type: 'button', class: 'button-quiet', text: 'Cancel', on: { click: () => act('POST', '/api/handoff/cancel', {}) } }),
    );
  } else {
    const name = sourceName(info.sourceId) ?? hostOf(info.url);
    text.textContent =
      info.purpose === 'challenge'
        ? `A browser window is open for ${name}. Complete the human check there, then press Done.`
        : `A browser window is open for ${name}. Log in there, then press Done.`;
    actions.replaceChildren(
      h('button', { type: 'button', text: 'Done', on: { click: () => act('POST', '/api/handoff/done', {}) } }),
      h('button', { type: 'button', class: 'button-quiet', text: 'Cancel', on: { click: () => act('POST', '/api/handoff/cancel', {}) } }),
    );
  }
  box.hidden = false;
}

// -- directory --

/**
 * What is on screen now: one entry per source row, by id, and the layout (topics and ids in
 * order) it was built for. A poll patches the counts in place and replaces only the rows whose
 * other fields changed, so a focused control survives the polls of a running job.
 * @type {Map<string, { sig: string; el: any; counts: any }>}
 */
const rowCache = new Map();
let layout = '';

function resetDirectory() {
  rowCache.clear();
  layout = '';
  drawn.delete('directory');
}

/** @param {SourceRow['counts7d'] | undefined} c */
function countsText(c) {
  const k = c ?? { blocked: 0, beaconsBlocked: 0, challenges: 0 };
  return `Last 7 days: ${plural(k.blocked, 'blocked request', 'blocked requests')}, ${plural(k.beaconsBlocked, 'blocked beacon', 'blocked beacons')}, ${plural(k.challenges, 'challenge', 'challenges')}`;
}

function drawDirectory() {
  if (!state) return;
  const s = state;
  const box = $('directory');
  const windowOpen = !!s.browser.handoff;
  const shown = /** @type {SourceRow[]} */ (filterSources(s.sources, query));
  const message = s.sources.length === 0 ? 'empty' : shown.length === 0 ? 'none' : null;
  if (message !== null) {
    part('directory', [message, query], () => {
      rowCache.clear();
      layout = '';
      box.replaceChildren(
        h('p', {
          class: 'muted',
          text: message === 'empty' ? 'No sources are installed. Put a YAML file in ~/.lurkd/sources and it appears here.' : `No source matches "${query.trim()}".`,
        }),
      );
    });
    return;
  }
  drawn.delete('directory');
  const groups = groupByTopic(shown);
  const wanted = JSON.stringify(groups.map((g) => [g.topic, g.sources.map((v) => v.id)]));
  const sigOf = (/** @type {SourceRow} */ v) => JSON.stringify([{ ...v, counts7d: null }, windowOpen]);
  if (wanted !== layout) {
    layout = wanted;
    rowCache.clear();
    box.replaceChildren(
      ...groups.map((g) =>
        h(
          'div',
          { class: 'group' },
          h('h3', { text: g.topic }),
          h(
            'ul',
            { class: 'sources' },
            ...g.sources.map((v) => {
              const row = sourceRow(/** @type {SourceRow} */ (v), windowOpen);
              rowCache.set(v.id, { sig: sigOf(/** @type {SourceRow} */ (v)), ...row });
              return row.el;
            }),
          ),
        ),
      ),
    );
    return;
  }
  for (const v of shown) {
    const cached = rowCache.get(v.id);
    if (!cached) continue;
    const sig = sigOf(v);
    if (cached.sig !== sig) {
      const row = sourceRow(v, windowOpen);
      cached.el.replaceWith(row.el);
      rowCache.set(v.id, { sig, ...row });
    } else {
      const text = countsText(v.counts7d);
      if (cached.counts.textContent !== text) cached.counts.textContent = text;
    }
  }
}

/**
 * @param {SourceRow} v
 * @param {boolean} windowOpen
 */
function sourceRow(v, windowOpen) {
  const sw = h('input', {
    type: 'checkbox',
    role: 'switch',
    checked: v.enabled,
    'aria-label': `Switch ${v.name} on or off`,
    on: { change: (/** @type {Event} */ e) => onSwitch(v, /** @type {HTMLInputElement} */ (e.target)) },
  });
  const real = h('input', {
    type: 'checkbox',
    checked: v.showRealNames,
    'aria-label': `Show real names to the agent (${v.name})`,
    on: { change: (/** @type {Event} */ e) => act('POST', `/api/sources/${enc(v.id)}/real-names`, { show: /** @type {HTMLInputElement} */ (e.target).checked }) },
  });
  const beacons = h('input', {
    type: 'checkbox',
    checked: v.allowBeacons,
    'aria-label': `Let Cloudflare beacons through (${v.name})`,
    on: { change: (/** @type {Event} */ e) => act('POST', `/api/sources/${enc(v.id)}/beacons`, { allow: /** @type {HTMLInputElement} */ (e.target).checked }) },
  });
  const openWindow = () => act('POST', `/api/sources/${enc(v.id)}/login`, {});
  const buttons = [];
  if (safeHttpUrl(v.loginUrl) !== null)
    buttons.push(h('button', { type: 'button', text: 'Log in', 'aria-label': `Log in to ${v.name}`, disabled: windowOpen, on: { click: openWindow } }));
  // Only a challenge the server still holds: the window opens at the page that was blocked.
  if (v.block === 'challenge')
    buttons.push(
      h('button', { type: 'button', text: 'Open window', 'aria-label': `Open window for ${v.name}`, disabled: windowOpen, class: 'button-quiet', on: { click: openWindow } }),
    );
  // A source that is on but not yet acknowledged is refused by the server until the user accepts.
  if (v.needsAcknowledgment)
    buttons.push(h('button', { type: 'button', text: 'Read the warning', 'aria-label': `Read the warning for ${v.name}`, on: { click: () => onReadWarning(v) } }));
  buttons.push(h('button', { type: 'button', class: 'button-quiet', text: 'Delete archive', 'aria-label': `Delete archive of ${v.name}`, on: { click: () => onDeleteArchive(v) } }));
  const rules = link('Forum rules', v.ruleUrl);
  const counts = h('p', { class: 'counts', text: countsText(v.counts7d) });

  const el = h(
    'li',
    { class: 'source' },
    h(
      'div',
      { class: 'source-head' },
      h('span', { class: 'source-name', text: v.name }),
      h('span', { class: 'badges' }, badge(sessionBadge(v)), badge(statusBadge(v)), badge(policyBadge(v))),
    ),
    v.description ? h('p', { class: 'desc', text: v.description }) : null,
    h(
      'div',
      { class: 'source-controls' },
      h('label', { class: 'check' }, sw, h('span', { class: 'switch-label', text: v.enabled ? 'On' : 'Off' })),
      h('label', { class: 'check' }, real, h('span', { text: 'Show real names to the agent' })),
      h('label', { class: 'check' }, beacons, h('span', { text: 'Let Cloudflare beacons through' })),
    ),
    h('div', { class: 'actions spaced' }, ...buttons, rules === null ? null : h('span', { class: 'check' }, rules)),
    counts,
  );
  return { el, counts };
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

// -- archive search --

let searchTimer = 0;
let searchSeq = 0;
/** @type {ArchiveHit[]} */
let hits = [];

function onSearchInput() {
  query = /** @type {HTMLInputElement} */ ($('search')).value;
  drawDirectory();
  clearTimeout(searchTimer);
  const q = query.trim();
  if (q === '') {
    searchSeq++;
    $('archive').hidden = true;
    closeThread();
    return;
  }
  $('archive').hidden = false;
  $('results-status').textContent = 'Searching the archive...';
  $('results').replaceChildren();
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
  $('results').replaceChildren(
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
    box.replaceChildren(h('p', { class: 'muted', text: 'No jobs yet. Reads start from your agent, not from this page.' }));
    return;
  }
  const running = jobs.find((j) => j.state === 'running');
  const waiting = jobs.filter((j) => j.state === 'queued').length;
  const finished = jobs.filter((j) => j.state === 'done' || j.state === 'stopped' || j.state === 'failed').slice(-20).reverse();
  box.replaceChildren(
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
  $('samples').replaceChildren(
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
  $('drafts').replaceChildren(
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

// -- dialog --

/**
 * Opens the modal dialog and settles with true only when the accept button is pressed; Cancel
 * and Escape settle with false.
 * @param {{ title: string; paragraphs?: string[]; quote?: string; link?: { text: string; url: string }; after?: string[]; accept: string }} o
 * @returns {Promise<boolean>}
 */
function askDialog(o) {
  const dialog = /** @type {HTMLDialogElement} */ ($('dialog'));
  if (dialog.open) return Promise.resolve(false);
  const rulesLink = o.link ? link(o.link.text, o.link.url) : null;
  $('dialog-title').textContent = o.title;
  $('dialog-body').replaceChildren(
    ...(o.paragraphs ?? []).map((t) => h('p', { text: t })),
    o.quote ? h('blockquote', { text: o.quote }) : null,
    rulesLink ? h('p', {}, rulesLink) : null,
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
    $('dialog-actions').replaceChildren(
      h('button', { type: 'button', class: 'button-quiet', text: 'Cancel', autofocus: true, on: { click: () => finish(false) } }),
      h('button', { type: 'button', text: o.accept, on: { click: () => finish(true) } }),
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
  try {
    out = await api(method, path, body);
    $('notice').hidden = true;
  } catch (e) {
    notify(e instanceof ApiError ? e.message : 'The request failed.', 'error');
    // A switch the person flipped has to go back to what the server holds.
    drawn.clear();
    resetDirectory();
  }
  await refresh();
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
    } catch (e) {
      const reason =
        e instanceof ApiError && (e.status === 401 || e.status === 403)
          ? 'lurkd did not accept this page. Run lurkd start to open it again.'
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
  $('search').addEventListener('input', onSearchInput);
  $('notice-close').addEventListener('click', () => ($('notice').hidden = true));
  $('thread-close').addEventListener('click', closeThread);
  $('retention').addEventListener('change', onRetention);
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
