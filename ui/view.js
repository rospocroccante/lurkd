// @ts-check
// The pure part of the lurkd page: badge texts, filtering, grouping and job wording. No DOM, no
// network, so Node can test it. app.js does the drawing.

/**
 * @typedef {import('../src/sources/registry.js').SourceView} SourceView
 * @typedef {import('../src/fetch/queue.js').JobProgress} JobProgress
 * @typedef {import('../src/sources/drafts.js').DraftView} DraftView
 * @typedef {import('../src/sources/analyse.js').ForumDetection} ForumDetection
 * @typedef {import('../src/sources/analyse.js').AnalyseOut} AnalyseOut
 * @typedef {'ok' | 'warn' | 'off' | 'neutral'} Tone
 * @typedef {{ text: string; tone: Tone }} Badge
 */

/**
 * The session badge of a source. The source of imported threads (D50) has no session: it says
 * "Imported" in place of a switch state (C1).
 * @param {Pick<SourceView, 'session' | 'loginUrl'> & Partial<Pick<SourceView, 'engine'>>} v
 * @returns {Badge}
 */
export function sessionBadge(v) {
  if (v.engine === 'import') return { text: 'Imported', tone: 'neutral' };
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
 * Whether the row offers "Sign up" (D47): the source names a sign-up page and lurkd holds no
 * session for it. A switched-off source shows `disabled` instead of its session; it is offered
 * then too, as "Log in" is.
 * @param {Pick<SourceView, 'session' | 'signupUrl'>} v
 * @returns {boolean}
 */
export function signUpOffered(v) {
  return safeHttpUrl(v.signupUrl) !== null && (v.session === 'never' || v.session === 'disabled');
}

/**
 * How far the extractor of a source was tried; imported threads come from files the user saved.
 * @param {Pick<SourceView, 'status'> & Partial<Pick<SourceView, 'engine'>>} v
 * @returns {Badge}
 */
export function statusBadge(v) {
  if (v.engine === 'import') return { text: 'From saved files', tone: 'neutral' };
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
    case 'analyse':
      return 'Analysing a forum address';
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

// ---- "Add a forum" (D45) ----

/** What the page says for a forum engine lurkd has no reader for. */
export const UNKNOWN_ENGINE_TEXT = 'lurkd cannot read this engine by itself. Ask your agent to add this site: it will draft the selectors.';

const QUOTE_NEEDED = 'Paste the sentence from the rules that says this. lurkd needs it for Allowed and Forbidden.';
const TOPIC_NEEDED = 'Give at least one topic, for example gardening.';
const TOPIC_SHAPE = 'Use lowercase letters, digits and hyphens, for example indoor-plants.';
const POLICIES = ['allowed', 'forbidden', 'unknown'];

/**
 * The engine as the page names it.
 * @param {unknown} engine
 * @returns {string}
 */
export function engineLabel(engine) {
  if (engine === 'discourse') return 'Discourse';
  if (engine === 'xenforo') return 'XenForo';
  return 'Not recognised';
}

/**
 * The topics of the form: split on commas, trimmed, empty and repeated ones dropped. They are not
 * rewritten; the server says which one is not kebab-case.
 * @param {string} text
 * @returns {string[]}
 */
export function parseTopics(text) {
  /** @type {string[]} */
  const out = [];
  for (const t of String(text).split(',').map((x) => x.trim())) if (t !== '' && !out.includes(t)) out.push(t);
  return out;
}

/**
 * `name` is the forum's name as the person checked it in the form (M1); without it, the detected
 * name goes out unchanged.
 * @typedef {{ policy: string; quote: string; topicsText: string; name?: string }} AddFormCheck
 * @typedef {AddFormCheck & { ruleUrl: string }} AddFormValues
 * @typedef {'name' | 'topics' | 'policy' | 'quote' | 'ruleUrl'} AddField
 */

/** The longest forum name the form takes, as the server does (`MAX_NAME` in src/sources/analyse.ts). */
export const MAX_FORUM_NAME = 100;

/**
 * The checks the page runs before it sends the form: a name when the form shows one, a policy
 * among the three, the quote for Allowed and Forbidden (the schema's rule), at least one topic.
 * The server checks everything again.
 * @param {AddFormCheck} f
 * @returns {Partial<Record<AddField, string>>}
 */
export function checkAddForm(f) {
  /** @type {Partial<Record<AddField, string>>} */
  const out = {};
  if (f.name !== undefined) {
    const name = f.name.trim();
    if (name === '') out.name = 'Give the forum a name.';
    else if ([...name].length > MAX_FORUM_NAME) out.name = `Keep the name to ${MAX_FORUM_NAME} characters or fewer.`;
  }
  if (!POLICIES.includes(f.policy)) {
    out.policy = 'Choose what the rules say about automated access.';
    return out;
  }
  if (f.policy !== 'unknown' && f.quote.trim() === '') out.quote = QUOTE_NEEDED;
  if (parseTopics(f.topicsText).length === 0) out.topics = TOPIC_NEEDED;
  return out;
}

/**
 * The text of a rules link: the link's own text, or its address when it has none.
 * @param {{ href: string; text: string }} l
 * @returns {string}
 */
export function termsLinkText(l) {
  return l.text.trim() === '' ? l.href : l.text.trim();
}

/**
 * The pages the quote may come from: the page a found clause is on (D49), the rules links the
 * analysis found (http and https only), then the forum's home page.
 * @param {ForumDetection} forum
 * @param {string | null} [ruleUrl] the page of the clause the analysis found
 * @returns {{ value: string; text: string }[]}
 */
export function rulesPageChoices(forum, ruleUrl = null) {
  /** @type {{ value: string; text: string }[]} */
  const out = [];
  const first = safeHttpUrl(ruleUrl);
  if (first !== null) {
    const linked = forum.termsLinks.find((l) => safeHttpUrl(l.href) === first);
    out.push({ value: first, text: linked ? termsLinkText(linked) : first });
  }
  for (const l of forum.termsLinks) {
    const href = safeHttpUrl(l.href);
    if (href !== null && !out.some((c) => c.value === href)) out.push({ value: href, text: termsLinkText(l) });
  }
  out.push({ value: forum.base_url, text: 'The forum home page' });
  return out;
}

/**
 * The body of POST /api/add/draft: the fields the analysis detected and the person's choices.
 * Nothing else goes out; the server forces status, enabled and the rest of the draft rules.
 * @param {ForumDetection} forum
 * @param {AddFormValues} f
 */
export function addDraftBody(forum, f) {
  const quote = f.quote.trim();
  return {
    engine: forum.engine,
    name: f.name === undefined ? forum.name : f.name.trim(),
    base_url: forum.base_url,
    domains: forum.domains,
    login_url: forum.login_url,
    signup_url: forum.signup_url,
    search_url: forum.search_url,
    topics: parseTopics(f.topicsText),
    automation: { policy: f.policy, rule_url: safeHttpUrl(f.ruleUrl) ?? forum.base_url, rule_quote: quote === '' ? null : quote },
  };
}

/** @type {[RegExp, AddField][]} */
const FIELD_PATHS = [
  [/^name(?=\s|$)/, 'name'],
  [/^topics(?:\[\d+\])?(?=\s|$)/, 'topics'],
  [/^automation\.policy(?=\s|$)/, 'policy'],
  [/^automation\.rule_quote(?=\s|$)/, 'quote'],
  [/^automation\.rule_url(?=\s|$)/, 'ruleUrl'],
];

/**
 * A schema line in the words the form uses, for the two rules a person meets most.
 * @param {AddField} field
 * @param {string} line
 */
function friendly(field, line) {
  if (field === 'quote' && /\bis required\b/.test(line)) return QUOTE_NEEDED;
  if (field === 'topics' && /kebab-case/.test(line)) return TOPIC_SHAPE;
  if (field === 'topics' && /at least one/.test(line)) return TOPIC_NEEDED;
  return line;
}

/**
 * The errors of a refused draft, by form field. `details.errors` holds the schema's lines
 * (`<file>: <field> <message>`); a single refusal names its field in `details.field`. Lines about
 * fields the form does not show stay together in `other`, without the file name.
 * @param {{ message: string; details?: unknown }} e
 * @returns {{ fields: Partial<Record<AddField, string[]>>; other: string[] }}
 */
export function addFormErrors(e) {
  /** @type {Partial<Record<AddField, string[]>>} */
  const fields = {};
  /** @type {string[]} */
  const other = [];
  const d = typeof e.details === 'object' && e.details !== null ? /** @type {Record<string, unknown>} */ (e.details) : {};
  const listed = Array.isArray(d.errors) ? d.errors.filter((x) => typeof x === 'string') : [];
  const lines = listed.length > 0 ? listed : [typeof d.field === 'string' && !e.message.startsWith(d.field) ? `${d.field} ${e.message}` : e.message];
  for (const raw of lines) {
    const line = raw.replace(/^[^\s:]+\.yaml: /, '');
    const hit = FIELD_PATHS.find(([re]) => re.test(line));
    if (!hit) {
      other.push(line);
      continue;
    }
    const field = hit[1];
    const text = friendly(field, line);
    const list = (fields[field] ??= []);
    if (!list.includes(text)) list.push(text);
  }
  return { fields, other };
}

/**
 * What the form starts with when the analysis found a clause that forbids automated access (D49).
 * @typedef {{ policy: 'forbidden'; quote: string; ruleUrl: string; text: string }} AddPrefill
 */

/**
 * @typedef {{ kind: 'known'; sourceId: string; name: string; text: string }
 *   | { kind: 'blocked'; text: string }
 *   | { kind: 'unknown'; forum: ForumDetection; text: string }
 *   | { kind: 'form'; forum: ForumDetection; note: string | null; prefill: AddPrefill | null }
 *   | { kind: 'error'; text: string }} AnalyseView
 */

/**
 * The form's starting point for the analysis's `automation`: Forbidden with the sentence and its
 * page, or null (the form starts at Unknown). A page address that is not http(s) drops it.
 * @param {unknown} a
 * @returns {AddPrefill | null}
 */
function prefillOf(a) {
  if (typeof a !== 'object' || a === null) return null;
  const { policy, rule_url: ruleUrl, rule_quote: quote } = /** @type {Record<string, unknown>} */ (a);
  const url = safeHttpUrl(ruleUrl);
  if (policy !== 'forbidden' || url === null || typeof quote !== 'string' || quote.trim() === '') return null;
  return { policy, quote, ruleUrl: url, text: `lurkd found this sentence on ${url}, so Forbidden is chosen. Change the choice if the sentence does not apply.` };
}

/**
 * What the page shows for an answer of POST /api/add/analyse or /api/add/draft (`known`).
 * `nameOf` turns a source id into its name.
 * @param {AnalyseOut} out
 * @param {(id: string) => string | undefined} nameOf
 * @returns {AnalyseView}
 */
export function analyseView(out, nameOf) {
  if (out?.status === 'known') {
    const name = nameOf(out.sourceId) ?? out.sourceId;
    return { kind: 'known', sourceId: out.sourceId, name, text: `Already in lurkd as ${name}` };
  }
  if (out?.status === 'blocked') return { kind: 'blocked', text: out.block.message };
  if (out?.status === 'analysed') {
    if (out.forum.engine === 'discourse' || out.forum.engine === 'xenforo')
      return { kind: 'form', forum: out.forum, note: out.block?.message ?? null, prefill: prefillOf(out.automation) };
    return { kind: 'unknown', forum: out.forum, text: UNKNOWN_ENGINE_TEXT };
  }
  return { kind: 'error', text: 'lurkd sent an answer this page cannot read. Reload the page and try again.' };
}

// ---- the sources table, its filters and the "To do" bar (A7) ----

/**
 * @typedef {SourceView & { block?: 'login' | 'challenge' | null }} SourceRowView
 * @typedef {'all' | 'on' | 'off' | 'attention' | 'logged_in' | 'warning' | 'expired'} StateFilter
 * @typedef {'name' | 'topic' | 'last_read'} SortKey
 * @typedef {'none' | 'topic' | 'custom'} GroupBy
 * @typedef {{ q: string; topic: string; state: StateFilter; policy: string; engine: string; sort: SortKey; group: GroupBy }} Filters
 */

/** The state chips; `warning` and `expired` come from the "To do" bar. @type {readonly StateFilter[]} */
export const STATE_FILTERS = ['all', 'on', 'off', 'attention', 'logged_in', 'warning', 'expired'];
/** @type {readonly SortKey[]} */
export const SORTS = ['name', 'topic', 'last_read'];
/** D51: how the table groups its rows. @type {readonly GroupBy[]} */
export const GROUP_BYS = ['none', 'topic', 'custom'];
const POLICY_FILTERS = ['allowed', 'unknown', 'forbidden'];
const HASH_KEYS = /** @type {const} */ (['q', 'topic', 'state', 'policy', 'engine', 'sort', 'group']);
const MAX_HASH_VALUE = 200;

/** @type {Readonly<Filters>} */
export const DEFAULT_FILTERS = Object.freeze({ q: '', topic: '', state: 'all', policy: '', engine: '', sort: 'name', group: 'none' });

/**
 * A source that is on but refused until its warning is accepted. A source that is off shows the
 * warning when it is switched on, so it is not work waiting for the person.
 * @param {Pick<SourceView, 'enabled' | 'needsAcknowledgment'>} v
 */
const warningToRead = (v) => v.enabled && v.needsAcknowledgment;

/**
 * Whether the row needs the person: a warning to read, an expired session, a human check waiting.
 * @param {SourceRowView} v
 * @returns {boolean}
 */
export function needsAttention(v) {
  return warningToRead(v) || v.session === 'expired' || v.block === 'challenge';
}

/**
 * The warning chips of a row, next to its status. An expired session has its own session chip.
 * @param {SourceRowView} v
 * @returns {Badge[]}
 */
export function attentionBadges(v) {
  /** @type {Badge[]} */
  const out = [];
  if (warningToRead(v)) out.push({ text: 'Warning to read', tone: 'warn' });
  if (v.block === 'challenge') out.push({ text: 'Human check waiting', tone: 'warn' });
  return out;
}

/** @type {Record<StateFilter, (v: SourceRowView) => boolean>} */
const STATE_TEST = {
  all: () => true,
  on: (v) => v.enabled,
  off: (v) => !v.enabled,
  attention: needsAttention,
  logged_in: (v) => v.session === 'logged_in',
  warning: warningToRead,
  expired: (v) => v.session === 'expired',
};

/**
 * The rows the filters keep, in input order: the words of `q` (the rule of filterSources), any
 * topic of the source, the state, the policy and the engine. An empty value keeps every row.
 * @template {SourceRowView} T
 * @param {T[]} views
 * @param {Filters} f
 * @returns {T[]}
 */
export function filterRows(views, f) {
  const test = STATE_TEST[f.state] ?? STATE_TEST.all;
  return /** @type {T[]} */ (filterSources(views, f.q)).filter(
    (v) => (f.topic === '' || v.topics.includes(f.topic)) && test(v) && (f.policy === '' || v.policy === f.policy) && (f.engine === '' || v.engine === f.engine),
  );
}

/**
 * When each source was last read: its `lastReadAt`, the latest archived thread (D51). Sources
 * never read are left out.
 * @param {(SourceRowView & { lastReadAt?: string | null })[]} views
 * @returns {Map<string, string>}
 */
export function lastReadTimes(views) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const v of views) if (typeof v.lastReadAt === 'string' && v.lastReadAt !== '') out.set(v.id, v.lastReadAt);
  return out;
}

/** @param {string} a @param {string} b */
const byText = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });

/**
 * A sorted copy: by name, by first topic (sources without one last), or by last read (latest
 * first, never read last). Ties go by name.
 * @template {SourceRowView} T
 * @param {T[]} views
 * @param {SortKey} sort
 * @param {Map<string, string>} lastRead
 * @returns {T[]}
 */
export function sortRows(views, sort, lastRead) {
  const byName = (/** @type {T} */ a, /** @type {T} */ b) => byText(a.name, b.name) || byText(a.id, b.id);
  /** @type {(a: T, b: T) => number} */
  let cmp = byName;
  if (sort === 'topic')
    cmp = (a, b) => {
      const ta = a.topics[0] ?? '';
      const tb = b.topics[0] ?? '';
      if (ta === '' || tb === '') return (ta === '' ? 1 : 0) - (tb === '' ? 1 : 0) || byName(a, b);
      return byText(ta, tb) || byName(a, b);
    };
  else if (sort === 'last_read')
    cmp = (a, b) => {
      const ra = lastRead.get(a.id) ?? '';
      const rb = lastRead.get(b.id) ?? '';
      return ra === rb ? byName(a, b) : ra < rb ? 1 : -1;
    };
  return [...views].sort(cmp);
}

/**
 * Whether the address's hash holds filters: empty, or `key=value` pairs. Any other hash is an
 * anchor (`#source-lg`) that the page leaves in the address.
 * @param {string} hash
 * @returns {boolean}
 */
export function isFilterHash(hash) {
  const h = String(hash).replace(/^#/, '');
  return h === '' || h.includes('=');
}

/**
 * The filters in the address's hash: `#q=...&state=on`. A key or value the page does not know
 * gives the default, so an old or hand-edited address still opens.
 * @param {string} hash
 * @returns {Filters}
 */
export function parseHash(hash) {
  const params = new URLSearchParams(String(hash).replace(/^#/, ''));
  /** @type {Filters} */
  const f = { ...DEFAULT_FILTERS };
  const get = (/** @type {string} */ k) => {
    const value = params.get(k);
    return value === null || value.length > MAX_HASH_VALUE ? null : value;
  };
  const q = get('q');
  if (q !== null) f.q = q;
  const topic = get('topic');
  if (topic !== null) f.topic = topic;
  const engine = get('engine');
  if (engine !== null) f.engine = engine;
  const state = get('state');
  if (state !== null && STATE_FILTERS.includes(/** @type {StateFilter} */ (state))) f.state = /** @type {StateFilter} */ (state);
  const policy = get('policy');
  if (policy !== null && POLICY_FILTERS.includes(policy)) f.policy = policy;
  const sort = get('sort');
  if (sort !== null && SORTS.includes(/** @type {SortKey} */ (sort))) f.sort = /** @type {SortKey} */ (sort);
  const group = get('group');
  if (group !== null && GROUP_BYS.includes(/** @type {GroupBy} */ (group))) f.group = /** @type {GroupBy} */ (group);
  return f;
}

/**
 * The hash for `f`, without "#": only the filters that differ from the default, in a fixed order.
 * The default filters give an empty string.
 * @param {Filters} f
 * @returns {string}
 */
export function formatHash(f) {
  const params = new URLSearchParams();
  for (const k of HASH_KEYS) if (f[k] !== DEFAULT_FILTERS[k]) params.set(k, f[k]);
  return params.toString();
}

/**
 * Each topic of the sources once, sorted.
 * @param {SourceView[]} views
 * @returns {string[]}
 */
export function topicsOf(views) {
  return [...new Set(views.flatMap((v) => v.topics).filter((t) => t !== ''))].sort(byText);
}

/**
 * Each engine of the sources once, sorted.
 * @param {SourceView[]} views
 * @returns {string[]}
 */
export function enginesOf(views) {
  return [...new Set(views.map((v) => v.engine))].sort(byText);
}

/** @type {Record<string, string>} */
const ENGINE_NAMES = { discourse: 'Discourse', xenforo: 'XenForo', phpbb: 'phpBB', vbulletin: 'vBulletin', generic: 'Generic', custom: 'Custom', import: 'Saved files' };

/**
 * The engine of a source as the filter names it; an engine the page does not know keeps its id.
 * @param {string} engine
 * @returns {string}
 */
export function engineName(engine) {
  return Object.hasOwn(ENGINE_NAMES, engine) ? /** @type {string} */ (ENGINE_NAMES[engine]) : engine;
}

/**
 * @typedef {'add' | 'drafts' | 'samples' | 'forbidden' | 'errors' | 'queue' | 'groups'} PanelKey
 * @typedef {{ key: string; label: string; count: number; panel?: PanelKey; filter?: StateFilter }} TodoItem
 * @typedef {{
 *   sources: SourceRowView[];
 *   drafts: unknown[];
 *   samplesPending: unknown[];
 *   addRequests: unknown[];
 *   forbidden: unknown[];
 *   registryErrors: unknown[];
 * }} TodoInput
 */

/**
 * How many files the registry's error lines name. Each line starts with `<file>: `; a line
 * without that shape counts on its own.
 * @param {unknown[]} lines
 */
function filesIn(lines) {
  return new Set(lines.map((l) => String(l)).map((l) => (/^[^\s:]+: /.test(l) ? l.slice(0, l.indexOf(': ')) : `line:${l}`))).size;
}

/**
 * The "To do" bar: one entry per kind of work that waits for the person, with its count and the
 * panel it opens or the filter it applies. Kinds with nothing waiting are left out.
 * @param {TodoInput} s
 * @returns {TodoItem[]}
 */
export function todoItems(s) {
  /** @type {TodoItem[]} */
  const all = [
    { key: 'drafts', label: 'Drafts to approve', count: s.drafts.length, panel: 'drafts' },
    { key: 'warnings', label: 'Warnings to read', count: s.sources.filter(warningToRead).length, filter: 'warning' },
    { key: 'expired', label: 'Sessions expired', count: s.sources.filter((v) => v.session === 'expired').length, filter: 'expired' },
    { key: 'samples', label: 'Sites waiting for a sample', count: s.samplesPending.length, panel: 'samples' },
    { key: 'add', label: 'Add requests from your agent', count: s.addRequests.length, panel: 'add' },
    { key: 'forbidden', label: 'Forums that forbid automated access', count: s.forbidden.length, panel: 'forbidden' },
    { key: 'errors', label: 'Source files with problems', count: filesIn(s.registryErrors), panel: 'errors' },
  ];
  return all.filter((t) => t.count > 0);
}

/**
 * The queue in a few words, for the header: the running job and how many wait.
 * @param {JobProgress[]} jobs
 * @returns {{ running: JobProgress | null; waiting: number; text: string }}
 */
export function queueSummary(jobs) {
  const running = jobs.find((j) => j.state === 'running') ?? null;
  const waiting = jobs.filter((j) => j.state === 'queued').length;
  const text = running
    ? waiting > 0
      ? `1 job running, ${waiting} waiting`
      : '1 job running'
    : waiting > 0
      ? `${count(waiting, 'job', 'jobs')} waiting`
      : 'Queue empty';
  return { running, waiting, text };
}

/**
 * @typedef {{ host: string; name: string; engine: string | null; baseUrl: string; ruleUrl: string; sentence: string; foundAt: string; sourceId: string | null }} ForbiddenEntryView
 */

/**
 * What an entry of the forbidden log offers (D49): "Add anyway" for an engine lurkd reads, a
 * pointer to the source that claims the host by now, or the unknown-engine line. `ruleUrl` is
 * the rules page when it is safe to link.
 * @param {Pick<ForbiddenEntryView, 'engine' | 'ruleUrl' | 'sourceId'>} e
 * @param {(id: string) => string | undefined} nameOf
 * @returns {{ kind: 'form'; ruleUrl: string | null } | { kind: 'known'; sourceId: string; name: string; ruleUrl: string | null } | { kind: 'unknown'; text: string; ruleUrl: string | null }}
 */
export function forbiddenView(e, nameOf) {
  const ruleUrl = safeHttpUrl(e.ruleUrl);
  if (typeof e.sourceId === 'string' && e.sourceId !== '') return { kind: 'known', sourceId: e.sourceId, name: nameOf(e.sourceId) ?? e.sourceId, ruleUrl };
  if (e.engine !== 'discourse' && e.engine !== 'xenforo') return { kind: 'unknown', text: UNKNOWN_ENGINE_TEXT, ruleUrl };
  return { kind: 'form', ruleUrl };
}

/**
 * The children to put in an element: one level of arrays flattened, and the `null`, `undefined`
 * and `false` that a condition leaves dropped, so none of them reaches the page as text.
 * @template T
 * @param {readonly (T | readonly (T | null | undefined | false)[] | null | undefined | false)[]} kids
 * @returns {T[]}
 */
export function present(kids) {
  /** @type {T[]} */
  const out = [];
  for (const k of kids) {
    if (Array.isArray(k)) {
      for (const x of k) if (x !== null && x !== undefined && x !== false) out.push(/** @type {T} */ (x));
    } else if (k !== null && k !== undefined && k !== false) out.push(/** @type {T} */ (k));
  }
  return out;
}

// ---- D51: groups of rows, the group switch, the selection and the bulk dialog ----

/**
 * @typedef {{ id: number; name: string; sourceIds: string[] }} CustomGroupView
 * @typedef {'all' | 'topic' | 'custom' | 'ungrouped'} GroupKind
 */

/**
 * The blocks of the table. Without grouping, one block of every row. By topic, one block per
 * first topic (D51: a source shows once, under its first topic), sorted by topic, rows without a
 * topic last. By custom group, one block per group in the order given, a source in several groups
 * under each, then "Not in a group". A group none of whose members is in `views` shows only with
 * `includeEmpty`. Rows keep their order inside a block.
 * @template {{ id: string; topics: string[] }} T
 * @param {T[]} views
 * @param {GroupBy} by
 * @param {CustomGroupView[]} groups
 * @param {{ includeEmpty?: boolean }} [o]
 * @returns {{ key: string; label: string; kind: GroupKind; groupId: number | null; rows: T[] }[]}
 */
export function groupRows(views, by, groups, o = {}) {
  if (by === 'topic') {
    /** @type {Map<string, T[]>} */
    const topics = new Map();
    /** @type {T[]} */
    const none = [];
    for (const v of views) {
      const t = v.topics[0] ?? '';
      if (t === '') none.push(v);
      else {
        const list = topics.get(t);
        if (list) list.push(v);
        else topics.set(t, [v]);
      }
    }
    const out = [...topics]
      .sort(([a], [b]) => byText(a, b))
      .map(([t, rows]) => ({ key: `topic:${t}`, label: t, kind: /** @type {GroupKind} */ ('topic'), groupId: /** @type {number | null} */ (null), rows }));
    if (none.length > 0) out.push({ key: 'topic:', label: 'No topic', kind: 'ungrouped', groupId: null, rows: none });
    return out;
  }
  if (by === 'custom') {
    /** @type {{ key: string; label: string; kind: GroupKind; groupId: number | null; rows: T[] }[]} */
    const out = [];
    /** @type {Set<string>} */
    const placed = new Set();
    for (const g of groups) {
      const members = new Set(g.sourceIds);
      const rows = views.filter((v) => members.has(v.id));
      for (const v of rows) placed.add(v.id);
      if (rows.length > 0 || o.includeEmpty === true) out.push({ key: `group:${g.id}`, label: g.name, kind: 'custom', groupId: g.id, rows });
    }
    const rest = views.filter((v) => !placed.has(v.id));
    if (rest.length > 0) out.push({ key: 'group:none', label: 'Not in a group', kind: 'ungrouped', groupId: null, rows: rest });
    return out;
  }
  return [{ key: 'all', label: '', kind: 'all', groupId: null, rows: views }];
}

/**
 * Whether a row has an on/off switch and a selection box: every source but the one of imported
 * threads (D50), which is never switched on.
 * @param {Pick<SourceView, 'engine'>} v
 */
export function isSwitchable(v) {
  return v.engine !== 'import';
}

/**
 * The tri-state switch of a group header: how many of its switchable sources are on, of how
 * many, and whether that is all of them, none, some, or there is nothing to switch.
 * @param {Pick<SourceView, 'engine' | 'enabled'>[]} views
 * @returns {{ on: number; total: number; state: 'on' | 'off' | 'mixed' | 'none' }}
 */
export function groupSwitchState(views) {
  const list = views.filter(isSwitchable);
  const on = list.filter((v) => v.enabled).length;
  const total = list.length;
  return { on, total, state: total === 0 ? 'none' : on === 0 ? 'off' : on === total ? 'on' : 'mixed' };
}

/**
 * How much of `ids` the selection holds.
 * @param {string[]} ids
 * @param {Set<string>} selected
 * @returns {'all' | 'some' | 'none'}
 */
export function selectionState(ids, selected) {
  const n = ids.filter((id) => selected.has(id)).length;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
}

/** What the bulk dialog says for a source whose rules page has no line to quote. */
const NO_QUOTE = 'The rules page has no line that lurkd could quote.';

/**
 * @typedef {{ id: string; name: string; policy?: string; ruleUrl: string; ruleQuote: string | null }} BulkRuleLine
 * @typedef {{
 *   enabled: string[]; alreadyOn: string[]; needsAcknowledgment: BulkRuleLine[]; forbidden: BulkRuleLine[];
 *   notSwitchable: string[]; acknowledgment: { token: string; ids: string[] } | null;
 * }} BulkEnableOut
 */

/**
 * What the page shows after POST /api/bulk/enable (D51). The sources the rules allow, or that the
 * person accepted before, are on already. The ones with silent rules are listed, each with its
 * rule line and its rules page when that is safe to link, under one accept button for exactly
 * that many. The forbidden ones are named and offered no accept button. Without either list
 * there is no dialog, only a notice.
 * @param {BulkEnableOut} out
 */
export function bulkDialogView(out) {
  const needs = (out.needsAcknowledgment ?? []).map((x) => ({
    id: x.id,
    name: x.name,
    quote: typeof x.ruleQuote === 'string' && x.ruleQuote.trim() !== '' ? x.ruleQuote : NO_QUOTE,
    ruleUrl: safeHttpUrl(x.ruleUrl),
  }));
  const forbidden = (out.forbidden ?? []).map((x) => ({ id: x.id, name: x.name, ruleUrl: safeHttpUrl(x.ruleUrl) }));
  const enabled = (out.enabled ?? []).length;
  const n = needs.length;
  const f = forbidden.length;
  const one = (/** @type {number} */ k, /** @type {string} */ a, /** @type {string} */ b) => (k === 1 ? a : b);
  /** @type {string[]} */
  const before = [];
  if (enabled > 0)
    before.push(`Switched on ${count(enabled, 'source', 'sources')} now: ${one(enabled, 'its rules allow automated access, or you accepted it before.', 'their rules allow automated access, or you accepted them before.')}`);
  const dialog = n > 0 || f > 0;
  const notice = dialog ? null : enabled > 0 ? `Switched on ${count(enabled, 'source', 'sources')}.` : (out.alreadyOn ?? []).length > 0 ? 'Every source you chose was on already.' : null;
  const title =
    n > 0
      ? `Switch on ${count(n, 'source', 'sources')} whose rules say nothing about automation?`
      : f === 1
        ? `${forbidden[0]?.name ?? 'A source'} stays off`
        : `${f} sources stay off`;
  return {
    dialog,
    notice,
    title,
    before,
    needs,
    needsText: `The rules of ${one(n, 'this forum do', 'these forums do')} not say whether automated access is allowed. Read each line, then decide for ${one(n, 'it', 'all of them at once')}.`,
    afterNeeds: `Accepting means lurkd reads ${one(n, 'this site', 'these sites')} with your login although ${one(n, 'its rules do', 'their rules do')} not mention automation. You take that decision.`,
    forbidden,
    forbiddenText: `${one(f, 'This source stays off: its rules forbid', 'These sources stay off: their rules forbid')} automated access, so lurkd never switches ${one(f, 'it', 'them')} on together with others. Switch ${one(f, 'it', 'each one')} on from its own row, after reading its warning.`,
    // Only a list the server sent can be accepted, and only as a whole.
    accept: n > 0 && out.acknowledgment ? (n === 1 ? 'I accept for this one' : `I accept for these ${n}`) : null,
  };
}

// ---- C1: importing a saved Reddit thread from the page (D50) ----

/** The largest saved thread file the page sends; the server refuses larger bodies too. */
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

const COUNT_FORMAT = new Intl.NumberFormat('en-GB');
/** @param {number} n @param {string} one @param {string} many */
const counted = (n, one, many) => `${COUNT_FORMAT.format(n)} ${n === 1 ? one : many}`;

/**
 * The check the page runs on the chosen file before it reads it.
 * @param {{ size: number } | null | undefined} file
 * @returns {string | null}
 */
export function checkImportFile(file) {
  if (!file) return 'Choose the saved thread file first.';
  if (file.size === 0) return 'This file is empty.';
  if (file.size > IMPORT_MAX_BYTES) return 'This file is larger than 20 MB. A saved Reddit thread is much smaller: check that you chose the right file.';
  return null;
}

/**
 * What the page says after an import: the thread title (forum text, shown as text), what was
 * kept, what the file did not hold, what was not kept, and the import it replaced.
 * @param {import('../src/fetch/service.js').RedditImportOut} out
 * @returns {{ heading: string; title: string; lines: string[] }}
 */
export function importResultView(out) {
  const lines = [`${counted(out.posts, 'post', 'posts')}: the post and ${counted(out.comments, 'comment', 'comments')}.`];
  if (out.notInFile > 0) lines.push(`${counted(out.notInFile, 'more comment was', 'more comments were')} not in the saved file.`);
  if (typeof out.notKept === 'number' && out.notKept > 0)
    lines.push(`${counted(out.notKept, 'more comment', 'more comments')} in the file ${out.notKept === 1 ? 'was' : 'were'} not kept: lurkd keeps the first 20,000 comments of a thread.`);
  if (out.replaced) {
    const at = out.replacedImportAt ? new Date(out.replacedImportAt) : null;
    lines.push(
      at && !Number.isNaN(at.getTime())
        ? `It replaced the import of ${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}, ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC.`
        : 'It replaced an earlier import of this thread.',
    );
  }
  lines.push('Your agent finds it with archive.search, or reads it with source.fetch and the thread address.');
  return { heading: out.replaced ? 'Thread imported again' : 'Thread imported', title: String(out.title), lines };
}

/**
 * D53: the banner for a newer lurkd, or null when there is none, when the person dismissed this
 * version (the server keeps the dismissed version, M2), or when the version is not a plain semver.
 * @param {{ current: string; latest: string; checkedAt: string } | null | undefined} update
 * @param {string | null} dismissed the version the person dismissed last, if any
 * @returns {{ version: string; text: string } | null}
 */
export function updateBanner(update, dismissed) {
  if (!update || typeof update.latest !== 'string' || !/^\d{1,15}\.\d{1,15}\.\d{1,15}$/.test(update.latest)) return null;
  if (dismissed === update.latest) return null;
  return { version: update.latest, text: `lurkd ${update.latest} is available. Run lurkd update in a terminal to install it.` };
}
