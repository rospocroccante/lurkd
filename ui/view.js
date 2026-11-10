// @ts-check
// The pure part of the lurkd page: badge texts, filtering, grouping and job wording. No DOM, no
// network, so Node can test it. app.js does the drawing.

/**
 * @typedef {import('../src/sources/registry.js').SourceView} SourceView
 * @typedef {import('../src/fetch/queue.js').JobProgress} JobProgress
 * @typedef {import('../src/sources/drafts.js').DraftView} DraftView
 * @typedef {'ok' | 'warn' | 'off' | 'neutral'} Tone
 * @typedef {{ text: string; tone: Tone }} Badge
 */

/**
 * The session badge of a source.
 * @param {Pick<SourceView, 'session' | 'loginUrl'>} v
 * @returns {Badge}
 */
export function sessionBadge(v) {
  switch (v.session) {
    case 'logged_in':
      return { text: 'Logged in', tone: 'ok' };
    case 'expired':
      return { text: 'Session expired', tone: 'warn' };
    case 'disabled':
      return { text: 'Switched off', tone: 'off' };
    default:
      return v.loginUrl ? { text: 'Not logged in', tone: 'neutral' } : { text: 'No login needed', tone: 'neutral' };
  }
}

/**
 * How far the extractor of a source was tried.
 * @param {Pick<SourceView, 'status'>} v
 * @returns {Badge}
 */
export function statusBadge(v) {
  switch (v.status) {
    case 'verified':
      return { text: 'Verified with an account', tone: 'ok' };
    case 'public_read':
      return { text: 'Checked on public pages', tone: 'neutral' };
    default:
      return { text: 'Untested', tone: 'neutral' };
  }
}

/**
 * What the forum's rules say about automation.
 * @param {Pick<SourceView, 'policy'>} v
 * @returns {Badge}
 */
export function policyBadge(v) {
  switch (v.policy) {
    case 'allowed':
      return { text: 'Automation allowed', tone: 'ok' };
    case 'forbidden':
      return { text: 'Automation forbidden', tone: 'off' };
    default:
      return { text: 'Rules silent on automation', tone: 'warn' };
  }
}

const SPLIT = /[^\p{L}\p{N}]+/u;

/** @param {string} text */
function tokensOf(text) {
  return text.toLowerCase().split(SPLIT).filter((t) => t !== '');
}

/**
 * The sources whose id, name, description, topics and domains, joined, contain every word of
 * `query` (the rule of the server's search). A blank query keeps every source. Order is kept.
 * @param {SourceView[]} views
 * @param {string} query
 * @returns {SourceView[]}
 */
export function filterSources(views, query) {
  const tokens = tokensOf(query);
  if (tokens.length === 0) return views;
  return views.filter((v) => {
    const hay = [v.id, v.name, v.description ?? '', ...v.topics, ...v.domains].join(' ').toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

/**
 * Sources grouped by their first topic, in the order the topics first appear; sources without a
 * topic go last under "Other".
 * @param {SourceView[]} views
 * @returns {{ topic: string; sources: SourceView[] }[]}
 */
export function groupByTopic(views) {
  /** @type {Map<string, SourceView[]>} */
  const groups = new Map();
  /** @type {SourceView[]} */
  const other = [];
  for (const v of views) {
    const topic = v.topics[0];
    if (topic === undefined || topic === '') {
      other.push(v);
      continue;
    }
    const list = groups.get(topic);
    if (list) list.push(v);
    else groups.set(topic, [v]);
  }
  const out = [...groups].map(([topic, sources]) => ({ topic, sources }));
  if (other.length > 0) out.push({ topic: 'Other', sources: other });
  return out;
}

/** @param {number} n @param {string} one @param {string} many */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * One line for the queue. `nameOf` turns a source id into its name; without it, or for an id it
 * does not know, the id is printed.
 * @param {JobProgress} j
 * @param {(id: string) => string | undefined} [nameOf]
 * @returns {string}
 */
export function describeJob(j, nameOf) {
  if (j.state === 'queued') return 'Waiting in the queue';
  if (j.state === 'done' || j.state === 'stopped' || j.state === 'failed') {
    const label = j.state === 'done' ? 'Done' : j.state === 'stopped' ? 'Stopped' : 'Failed';
    if (!j.message) return label;
    // The server stores the line it prints for the agent ("Error <code>: ..."). The page tells the person what to do instead.
    const code = /^Error ([a-z_]+):/.exec(j.message)?.[1];
    const name = nameOf?.(j.sourceId) ?? j.sourceId;
    switch (code) {
      case 'needs_login':
        return `${label}: login needed for ${name}`;
      case 'challenge':
        return `${label}: human check needed for ${name}`;
      case 'needs_acknowledgment':
        return `${label}: ${name} needs its warning accepted first`;
      case 'disabled':
        return `${label}: ${name} is switched off`;
      default:
        return `${label}: ${j.message}`;
    }
  }
  switch (j.phase) {
    case 'thread':
      return `Reading thread ${j.threadIndex} of ${j.threadCount}, ${count(j.postsFetched, 'post', 'posts')}, ${j.requestsUsed} of ${j.requestCap} requests`;
    case 'search':
      return `Searching ${nameOf?.(j.sourceId) ?? j.sourceId}`;
    case 'session':
      return 'Checking the session';
    case 'signals':
      return 'Looking up an author';
    case 'sample':
      return 'Sampling a page';
    default:
      return 'Starting';
  }
}

/**
 * Pulls `POST <path>: <note>` lines out of the `read_endpoints` of a draft's YAML, for a server
 * that sent no warning for them. A plain line scan: the YAML stays on screen below for the real check.
 * @param {string} yaml
 * @returns {string[]}
 */
function endpointsIn(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^read_endpoints:\s*$/.test(l));
  if (start < 0) return [];
  /** @type {{ path?: string; note?: string }[]} */
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) break;
    if (/^\s*-\s/.test(line)) entries.push({});
    const cur = entries[entries.length - 1];
    if (cur === undefined) continue;
    const path = /\bpath:\s*(.+?)\s*$/.exec(line);
    const note = /\bnote:\s*(.+?)\s*$/.exec(line);
    if (path) cur.path = unquote(path[1] ?? '');
    if (note) cur.note = unquote(note[1] ?? '');
  }
  const out = entries.filter((e) => e.path).map((e) => (e.note ? `POST ${e.path}: ${e.note}` : `POST ${e.path}`));
  return out;
}

/** @param {string} s */
function unquote(s) {
  return s.replace(/^(["'])(.*)\1$/, '$2');
}

/**
 * What the person should read before approving a draft: every POST endpoint first, then the other
 * warnings the server wrote.
 * @param {DraftView} d
 * @returns {string[]}
 */
export function draftHighlights(d) {
  const isPost = (/** @type {string} */ w) => w.startsWith('POST ');
  const posts = d.warnings.filter(isPost);
  const rest = d.warnings.filter((w) => !isPost(w));
  for (const e of endpointsIn(d.yaml)) {
    const path = e.slice(5).split(':')[0];
    if (!posts.some((w) => w.slice(5).split(':')[0] === path)) posts.push(e);
  }
  return [...posts, ...rest];
}

/**
 * The address when it is an absolute http or https URL without credentials, else null. Every
 * address the page turns into a link goes through this first.
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeHttpUrl(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  return value;
}
