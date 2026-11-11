import { isIPv4, isIPv6 } from 'node:net';
import YAML from 'yaml';
import { LurkdError } from '../errors.js';
import { DRAFT_LIMITS } from './drafts.js';
import { parseSource, type SourceConfig } from './schema.js';

// D45, "Add a forum": the user gives an address on the lurkd page and presses "Analyse". lurkd
// opens it once, headless and behind the read-only guard (FetchService.analyse), reads a few
// signals from the page and guesses the engine with `detectForum`. D49: it then reads at most two
// rules pages of the same host (`rulesPageUrls`) and looks for a sentence that forbids automated
// access (`findAutomationClause`), which prefills the form's policy. The form the page then shows
// is turned into a draft by `parseAddDraft` and goes through `DraftStore.submit` like any agent
// draft. An agent can only queue an address (`lurkd add`); it never makes lurkd load one.
//
// Everything the page hands back is forum text and could be forged by its scripts: it is only
// data for the draft the user reviews, cut to size here and validated again by the source schema.

/** Signals read from the page; `url` is the page's address as Playwright reports it. */
export interface ForumSignals {
  url: string;
  title: string;
  /** `og:site_name`, which both engines emit; it names the forum better than a page title. */
  siteName: string;
  generator: string;
  htmlId: string;
  links: { href: string; text: string }[];
}

export interface ForumDetection {
  engine: 'discourse' | 'xenforo' | null;
  name: string;
  base_url: string;
  domains: string[];
  login_url: string | null;
  search_url: string | null;
  signup_url: string | null;
  termsLinks: { href: string; text: string }[];
}

/** What the page script hands back, before `readSignals` checks it. */
export interface RawSignals {
  title: string;
  siteName: string;
  generator: string;
  htmlId: string;
  links: { href: string; text: string }[];
}

/** How much of the page `collectSignals` and `readSignals` keep. */
export const SIGNAL_LIMITS = { maxLinks: 500, maxText: 200 } as const;

/** At most this many rules links are offered (D45). */
export const MAX_TERMS_LINKS = 8;

/** The longest address lurkd accepts to analyse or to queue. */
export const MAX_ADDRESS_LENGTH = 2048;

const MAX_NAME = 100;
const MAX_LINK_TEXT = 100;

// The loopback names a test may let lurkd open (`allowLoopback`), over http too, as the source
// schema allows (src/sources/schema.ts, browserUrl). The URL parser has already turned 127.1,
// 0x7f.0.0.1 and 2130706433 into 127.0.0.1.
const TEST_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);
// Names that only resolve on the user's own network.
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.home', '.corp', '.intranet'];
const LOCAL_ADDRESS_MESSAGE = 'lurkd opens public forums only, not addresses on your own network.';

const TERMS_WORDS = ['tos', 'terms', 'rules', 'guidelines', 'faq', 'regolamento', 'norme'];
// Rules words that also match as the start of a longer word (`termsofservice`, `faqs`); `tos`
// stays a whole word, or `tossed` and `toscana` would match.
const TERMS_PREFIXES = TERMS_WORDS.filter((t) => t !== 'tos');

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function invalid(message: string, details?: Obj): LurkdError {
  return new LurkdError('invalid_request', message, details);
}

/** One line: control and format characters dropped, white space collapsed. */
function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function parseAbsolute(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Collects the raw signals in `doc` (the page's own `document` when omitted). Self-contained: it
 * runs in the page as the string `(${collectSignals})(limits)`, so it imports nothing, calls no
 * helper and declares no inner function (tsx and vitest wrap named ones in a `__name` call the
 * page lacks). Link `href`s are the attribute values; `readSignals` resolves them.
 */
export function collectSignals(limits: { maxLinks: number; maxText: number }, doc?: Document): RawSignals {
  const d: Document = doc ?? document;
  const maxLinks = Math.max(0, Math.min(2000, Math.floor(Number(limits?.maxLinks)) || 0));
  const maxText = Math.max(1, Math.min(1000, Math.floor(Number(limits?.maxText)) || 1));
  const out: RawSignals = { title: '', siteName: '', generator: '', htmlId: '', links: [] };
  out.title = String(d.title ?? '').slice(0, maxText * 4);
  out.htmlId = String(d.documentElement?.id ?? '').slice(0, maxText);
  const metas = d.getElementsByTagName('meta');
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i]!;
    const name = String(m.getAttribute('name') ?? '').toLowerCase();
    const property = String(m.getAttribute('property') ?? '').toLowerCase();
    const content = String(m.getAttribute('content') ?? '').slice(0, maxText * 4);
    if (name === 'generator' && out.generator === '') out.generator = content;
    if (property === 'og:site_name' && out.siteName === '') out.siteName = content;
  }
  const anchors = d.querySelectorAll('a[href]');
  for (let i = 0; i < anchors.length && out.links.length < maxLinks; i++) {
    const a = anchors[i]!;
    out.links.push({
      href: String(a.getAttribute('href') ?? '').slice(0, 4096),
      text: String(a.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, maxText),
    });
  }
  return out;
}

/** The in-page form of `collectSignals`. */
export const SIGNALS_SCRIPT = `(${collectSignals.toString()})(${JSON.stringify(SIGNAL_LIMITS)})`;

/** An absolute http(s) link without user name, password or fragment, or null. */
function cleanLink(href: string, pageUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(href, pageUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.username = '';
  u.password = '';
  u.hash = '';
  return u.href.length > MAX_ADDRESS_LENGTH ? null : u.href;
}

/**
 * The page's answer as signals: strings only (anything else reads as empty), one line each, cut
 * to `SIGNAL_LIMITS`; links resolved against `pageUrl`, http(s) only, without credentials or
 * fragment, at most `SIGNAL_LIMITS.maxLinks`.
 */
export function readSignals(raw: unknown, pageUrl: string): ForumSignals {
  const r = isObj(raw) ? raw : {};
  const str = (v: unknown) => (typeof v === 'string' ? oneLine(v).slice(0, SIGNAL_LIMITS.maxText) : '');
  const links: ForumSignals['links'] = [];
  for (const l of Array.isArray(r.links) ? r.links : []) {
    if (links.length >= SIGNAL_LIMITS.maxLinks) break;
    if (!isObj(l) || typeof l.href !== 'string') continue;
    const href = cleanLink(l.href, pageUrl);
    if (href !== null) links.push({ href, text: str(l.text) });
  }
  return { url: pageUrl, title: str(r.title), siteName: str(r.siteName), generator: str(r.generator), htmlId: str(r.htmlId), links };
}

// Routes that sit right under the forum's base path. A path is cut at the first of them, so what
// comes before is the prefix the forum is installed under (`/community`, `/forums`).
const DISCOURSE_ROUTE =
  /^\/(?:t|c|u|g|tag|tags|latest|top|new|unread|hot|categories|search|login|signup|about|faq|guidelines|tos|privacy|badges|users|groups|my|session|admin|posted|bookmarks|review|chat|filter)(?:\/|$)/;
// XenForo content routes end in `<slug>.<id>`; a bare `/forums/` is the forum list or a prefix.
const XENFORO_ROUTE =
  /^\/(?:(?:threads|forums|members|posts|categories|pages|tags|media|resources)\/[^/]*\.\d+(?:\/|$)|(?:login|register|search|whats-new|help|account|conversations|online|find-threads|lost-password|misc|index\.php)(?:\/|$))/;
// Links whose path names the base path for certain: `<base>/login` and the like.
const DISCOURSE_ANCHOR = /^(.*)\/(?:login|signup|latest|categories)\/?$/;
const XENFORO_ANCHOR = /^(.*)\/(?:login|register|whats-new)\/?$/;

/** The path prefix the forum is installed under, without a trailing slash ('' at the root). */
function basePath(engine: 'discourse' | 'xenforo', page: URL, links: ForumSignals['links']): string {
  const segments = page.pathname.split('/').filter((s) => s !== '');
  const under = (prefix: string) => prefix === '' || page.pathname === prefix || page.pathname.startsWith(`${prefix}/`);
  // A login or register link of the forum itself is the best evidence; the longest one on the
  // page's own path wins, so a site-wide login link at the root does not hide a forum under it.
  const anchor = engine === 'discourse' ? DISCOURSE_ANCHOR : XENFORO_ANCHOR;
  let confirmed: string | null = null;
  for (const l of links) {
    const u = parseAbsolute(l.href);
    if (!u || u.host !== page.host) continue;
    const m = anchor.exec(u.pathname);
    if (!m) continue;
    const prefix = m[1]!.replace(/\/+$/, '');
    if (under(prefix) && (confirmed === null || prefix.length > confirmed.length)) confirmed = prefix;
  }
  if (confirmed !== null) return confirmed;
  const route = engine === 'discourse' ? DISCOURSE_ROUTE : XENFORO_ROUTE;
  for (let i = 0; i < segments.length; i++) {
    const rest = `/${segments.slice(i).join('/')}${page.pathname.endsWith('/') ? '/' : ''}`;
    if (route.test(rest)) return segments.slice(0, i).map((s) => `/${s}`).join('');
  }
  // No route on the path: the page is the forum's home, minus a file name such as index.html.
  const kept = segments.length > 0 && segments.at(-1)!.includes('.') ? segments.slice(0, -1) : segments;
  return kept.map((s) => `/${s}`).join('');
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
}

/** True when one of the words is a rules word, or starts with one other than tos (`termsofservice`, `faqs`). */
function looksLikeRules(words: readonly string[]): boolean {
  return words.some((w) => TERMS_WORDS.includes(w) || TERMS_PREFIXES.some((t) => w.startsWith(t)));
}

/** The path of `u` (with its query when `withQuery`), percent-decoded when it decodes. */
function decodedPath(u: URL, withQuery = false): string {
  const path = withQuery ? u.pathname + u.search : u.pathname;
  try {
    return decodeURIComponent(path);
  } catch {
    // the raw path is still worth a look
    return path;
  }
}

function termsLinks(page: URL, links: ForumSignals['links']): ForumDetection['termsLinks'] {
  const out: ForumDetection['termsLinks'] = [];
  const seen = new Set<string>();
  for (const l of links) {
    if (out.length >= MAX_TERMS_LINKS) break;
    const u = parseAbsolute(l.href);
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.hostname !== page.hostname) continue;
    u.hash = '';
    if (seen.has(u.href)) continue;
    if (!looksLikeRules(wordsOf(decodedPath(u, true))) && !looksLikeRules(wordsOf(l.text))) continue;
    seen.add(u.href);
    out.push({ href: u.href, text: oneLine(l.text).slice(0, MAX_LINK_TEXT) });
  }
  return out;
}

function engineOf(s: ForumSignals): ForumDetection['engine'] {
  const generator = s.generator.trim();
  if (/^discourse\b/i.test(generator)) return 'discourse';
  if (s.htmlId === 'XF' || /xenforo/i.test(generator)) return 'xenforo';
  return null;
}

/**
 * D45: the engine, name and default URLs of the forum the signals come from. Discourse when the
 * generator starts with "Discourse"; XenForo for `html#XF` or a generator naming XenForo. The name
 * is `og:site_name`, else the title, else the host. `base_url` is the page's origin plus the path
 * prefix the forum lives under. Unknown engines get no default URLs. `termsLinks` are links on the
 * page's host whose path or text has a rules word (tos, terms, rules, guidelines, faq,
 * regolamento, norme), deduplicated, at most `MAX_TERMS_LINKS`.
 */
export function detectForum(signals: ForumSignals): ForumDetection {
  const page = new URL(signals.url);
  const engine = engineOf(signals);
  const name = (oneLine(signals.siteName) || oneLine(signals.title) || page.hostname).slice(0, MAX_NAME);
  const base = engine === null ? page.origin : `${page.origin}${basePath(engine, page, signals.links)}`;
  const out: ForumDetection = {
    engine,
    name,
    base_url: base,
    domains: [page.hostname],
    login_url: null,
    search_url: null,
    signup_url: null,
    termsLinks: termsLinks(page, signals.links),
  };
  if (engine === 'discourse') {
    // Discourse searches through its JSON API, so it needs no search_url.
    out.login_url = `${base}/login`;
    out.signup_url = `${base}/signup`;
  } else if (engine === 'xenforo') {
    out.login_url = `${base}/login/`;
    out.signup_url = `${base}/register/`;
    out.search_url = `${base}/search/?q={query}&o=date`;
  }
  return out;
}

// ---- D49: the rules pages and the clause that forbids automated access ----

/** At most this many rules pages are read after the analysed page (D49). */
export const MAX_RULES_PAGES = 2;

/** How much text `collectPageText` hands back from one rules page. */
export const PAGE_TEXT_LIMIT = 300_000;

/** A sentence longer than this is a block of text without punctuation, not a clause. */
export const MAX_CLAUSE_LENGTH = 1000;

/**
 * The visible text of `doc` (the page's own `document` when omitted), one line per block, plus
 * the copy Discourse serves inside `<noscript>`: with scripts on, that copy is raw HTML text, so
 * it is parsed apart from the page (scripts in it never run) and its blocks get a line each.
 * Self-contained for the same reason as `collectSignals`: no imports, helpers or inner functions.
 */
export function collectPageText(maxChars: number, doc?: Document): string {
  const d: Document = doc ?? document;
  const max = Math.max(1, Math.min(1_000_000, Math.floor(Number(maxChars)) || 1));
  const body = d.body;
  let text = '';
  if (body) {
    const inner: unknown = (body as HTMLElement).innerText;
    text = typeof inner === 'string' ? inner : String(body.textContent ?? '');
  }
  const blocks = 'p,li,div,h1,h2,h3,h4,h5,h6,br,tr,dt,dd,blockquote,section,article,header,footer,pre,ul,ol,table';
  const copies = d.getElementsByTagName('noscript');
  for (let i = 0; i < copies.length && text.length < max; i++) {
    const n = copies[i]!;
    // Parsed as elements (scripts off): its text is in the body's text already.
    if (n.children.length > 0) continue;
    const raw = String(n.textContent ?? '');
    if (raw.trim() === '' || typeof DOMParser === 'undefined') continue;
    const parsed = new DOMParser().parseFromString(raw, 'text/html');
    const dropped = parsed.querySelectorAll('script,style,template,noscript');
    for (let j = 0; j < dropped.length; j++) dropped[j]!.remove();
    const ends = parsed.querySelectorAll(blocks);
    for (let j = 0; j < ends.length; j++) ends[j]!.appendChild(parsed.createTextNode('\n'));
    text += `\n\n${String(parsed.body?.textContent ?? '')}`;
  }
  return text.slice(0, max);
}

/** The in-page form of `collectPageText`. */
export const PAGE_TEXT_SCRIPT = `(${collectPageText.toString()})(${PAGE_TEXT_LIMIT})`;

/**
 * The rules pages to read after the analysed page at `pageUrl` (D49), at most `MAX_RULES_PAGES`:
 * Discourse `<base>/tos` and `<base>/guidelines`, which exist even when the page does not link
 * them; XenForo `<base>/help/terms/`; any other engine the first of its rules links whose path
 * (not only its query or link text) has a rules word. Only addresses on the page's own scheme, host
 * and port, over https unless `rules` lets 127.0.0.1 and localhost through for tests as
 * `analysableUrl` does, that `allowed` lets through: the service passes the deny rules of the
 * throwaway source. The list of rules links shown to the user (`termsLinks`) stays wider.
 */
export function rulesPageUrls(forum: ForumDetection, pageUrl: string, allowed: (url: string) => boolean, rules: AddressRules = {}): string[] {
  const page = parseAbsolute(pageUrl);
  if (!page) return [];
  const loopback = rules.allowLoopback === true && TEST_LOOPBACK_HOSTS.has(page.hostname);
  if (page.protocol !== 'https:' && !(loopback && page.protocol === 'http:')) return [];
  const sameHost = (u: URL | null): u is URL => u !== null && u.protocol === page.protocol && u.host === page.host;
  let candidates: string[];
  if (forum.engine === 'discourse' || forum.engine === 'xenforo') {
    const base = parseAbsolute(forum.base_url);
    if (!sameHost(base)) return [];
    const root = base.href.replace(/\/+$/, '');
    candidates = forum.engine === 'discourse' ? [`${root}/tos`, `${root}/guidelines`] : [`${root}/help/terms/`];
  } else {
    candidates = forum.termsLinks.map((l) => l.href);
  }
  const limit = forum.engine === null ? 1 : MAX_RULES_PAGES;
  const out: string[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    const u = parseAbsolute(c);
    if (!sameHost(u) || u.username !== '' || u.password !== '') continue;
    if (forum.engine === null && !looksLikeRules(wordsOf(decodedPath(u)))) continue;
    u.hash = '';
    if (out.includes(u.href) || !allowed(u.href)) continue;
    out.push(u.href);
  }
  return out;
}

// The clause is matched on the words of one sentence: lower case, curly apostrophes made straight,
// with the marks , ; : kept as words of their own. Every list below holds whole words.
const wordSet = (s: string): ReadonlySet<string> => new Set(s.split(' '));

// Words that name automated access. "automatic" and "automatically" are left out on purpose:
// "your subscription will automatically renew" says nothing about readers.
const AUTOMATION = wordSet(
  'automate automates automated automating automation scrape scrapes scraped scraper scrapers scraping crawl crawls crawled crawler crawlers crawling bot bots robot robots spider spiders spidering',
);
// Automation words that are the forbidden act themselves: "may not automate access", "must not
// crawl", "we forbid scraping". The base forms count unless an article or a topic word makes them
// a noun ("a crawl"); the -ing forms unless a topic word does ("post about scraping").
const AUTOMATION_VERBS = wordSet('automate scrape crawl');
const AUTOMATION_GERUNDS = wordSet('automating scraping crawling spidering');
// After "be": "the forum may not be scraped".
const AUTOMATION_PARTICIPLES = wordSet('scraped crawled spidered');
// Acts of access, use or collection, as verbs, -ing forms, participles and nouns. One counts when
// an automation word is its object ("use any robot") or its means ("access the forum by automated
// means", "collect posts with a script").
const ACCESS = wordSet(
  'access accesses accessed accessing use uses used using usage employ employing employed deploy deploying deployed run running operate operating utilise utilize utilising utilizing utilised utilized collect collecting collected collection harvest harvesting harvested gather gathering gathered monitor monitoring monitored copy copying copied download downloading downloaded mine mining mined extract extracting extracted extraction index indexing indexed query querying queried read reading browse browsing browsed visit visiting visited retrieve retrieving retrieved archive archiving archived capture capturing captured reproduce reproducing reproduced save saving saved',
);
// Words that bring the means: "with a bot", "by automated means", "using scrapers", "via a script".
const MEANS = wordSet('with by using via through employing utilising utilizing');
// A script is automation only as a means: "Scripts are not allowed" may be about posts.
const MEANS_ONLY = wordSet('script scripts');
// Words that may stand between an act or a means and its automation word: "use any other web
// crawler", "by means of a bot", "any kind of scraper".
const FILLER = wordSet(
  'a an the any other some such all web third party own your their its of means way use automatic unauthorised unauthorized unapproved software computer similar additional custom kind kinds type types form forms sort sorts',
);
const ARTICLE = wordSet('the any all a an');
// What follows a topic word is talked about, not done: "Do not post about robots."
const TOPIC = wordSet('about regarding concerning discussing on');
const NOT_A_VERB = new Set([...TOPIC, ...wordSet('the a an this that any your our their its his her web of')]);
// What may follow an automation word in a subject or after "No": more automation words, tools and
// list words ("Bots, scrapers and other automated tools", "Automated access").
const AUTOMATION_PHRASE = new Set([
  ...AUTOMATION,
  ...FILLER,
  ...wordSet(
    ', and or nor tools tool programs program scripts script systems system devices device agents agent technology technologies methods method processes process access requests request traffic extraction collection harvesting querying downloading copying mining browsing data applications apps services clients',
  ),
]);
// Where such a phrase may end and other words begin: "Automated access to the site", "No bots
// allowed", "Bots on this forum". "No robot vacuum discussions" stops at "vacuum": no such phrase.
const PHRASE_END = wordSet('to of on from against for in within across at into over without unless except by allowed permitted here please whatsoever');
// Words that open another clause; a prohibition does not reach past them.
const CLAUSE_BREAK = wordSet('but while whereas which who whom whose because although though unless if when where since so however');
// "and" or "or" before one of these opens another clause: "You may not post spam, and our filters ...".
const CLAUSE_SUBJECT = wordSet('we our you they it i us he she there');
const COPULA = wordSet('is are was were be been being remain remains');
const MODAL = wordSet('will would can could may might must shall should');
const CLAUSE_VERB = new Set([...COPULA, ...MODAL, ...wordSet('do does did cannot')]);
// Words between a subject and "prohibited": "is strictly prohibited", "will not be allowed".
const AUXILIARY = new Set([...COPULA, ...MODAL, ...wordSet('strictly expressly absolutely also hereby generally entirely completely explicitly specifically always not')]);
const ADVERB = wordSet('strictly expressly absolutely also hereby generally entirely completely explicitly specifically always');
// What may open a sentence before a comma and the real subject: "On this forum, scraping is prohibited."
const PREAMBLE = wordSet('on in at for within across under without here also please additionally furthermore moreover therefore generally finally note');
const PERSON = wordSet('you user users member members visitor visitors guest guests anyone');
const PERMITTED = wordSet('permitted allowed authorised authorized tolerated');

/** How many words a prohibition reaches: the automated act must be among them. */
const CLAUSE_WINDOW = 20;
/** How many words an act reaches for its means: "access the forum, or monitor the forum, such as with a web crawler". */
const MEANS_WINDOW = 12;
/** The longest subject read before "is prohibited". */
const SUBJECT_WINDOW = 25;
/** How many places a subject may start at are tried, nearest first. */
const SUBJECT_TRIES = 4;

/** The words of `sentence`, in one pass: lower case, curly apostrophes straight, "e.g." and "i.e." dropped. */
function wordsOfSentence(sentence: string): string[] {
  const s = sentence.toLowerCase().replace(/[’‘]/g, "'").replace(/\b(?:e\.g|i\.e)\./g, ' ');
  const out: string[] = [];
  for (const m of s.matchAll(/[\p{L}\p{N}']+|[,;:]/gu)) {
    const w = m[0];
    let a = 0;
    let b = w.length;
    while (a < b && w[a] === "'") a++;
    while (b > a && w[b - 1] === "'") b--;
    if (a < b) out.push(a === 0 && b === w.length ? w : w.slice(a, b));
  }
  return out;
}

type BanKind = 'act' | 'passive' | 'forbid' | 'no';
interface Ban {
  start: number;
  /** The first word after the prohibition. */
  end: number;
  kind: BanKind;
}

/**
 * One sentence, read once. Every check below looks at a bounded number of words around one
 * position, with the indexes built here in one pass each, so a sentence costs time linear in its
 * length.
 */
class Clause {
  readonly w: string[];
  /** The first index at or after i that is not a filler word (`w.length` when none). */
  private readonly solid: Int32Array;
  /** The first index at or after i of a means word whose next solid word is an automation word or a script. */
  private readonly means: Int32Array;
  /** The last index before i of a clause verb, or -1. */
  private readonly verb: Int32Array;

  constructor(words: string[]) {
    const w = words;
    const n = w.length;
    this.w = w;
    this.solid = new Int32Array(n + 1);
    this.means = new Int32Array(n + 1);
    this.verb = new Int32Array(n + 1);
    this.solid[n] = n;
    this.means[n] = n;
    for (let i = n - 1; i >= 0; i--) {
      this.solid[i] = FILLER.has(w[i]!) ? this.solid[i + 1]! : i;
      const next = this.solid[i + 1]!;
      const hit = MEANS.has(w[i]!) && next < n && (AUTOMATION.has(w[next]!) || MEANS_ONLY.has(w[next]!));
      this.means[i] = hit ? i : this.means[i + 1]!;
    }
    this.verb[0] = -1;
    for (let i = 0; i < n; i++) this.verb[i + 1] = CLAUSE_VERB.has(w[i]!) ? i : this.verb[i]!;
  }

  /** True when `w[at]`, past filler words, is an automation word before `to`. */
  private objectAt(at: number, to: number): boolean {
    const j = this.solid[Math.min(at, this.w.length)]!;
    return j < to && AUTOMATION.has(this.w[j]!);
  }

  /** True when a means word with its automation word lies in [from, until), its automation word before `to`. */
  private meansIn(from: number, until: number, to: number): boolean {
    const m = this.means[Math.min(from, this.w.length)]!;
    return m < until && this.solid[m + 1]! < to;
  }

  /** The prohibition that starts at word `i`, or null. */
  banAt(i: number): Ban | null {
    const w = this.w;
    const x = w[i];
    const y = w[i + 1];
    const atStart = i === 0 || w[i - 1] === ';' || w[i - 1] === ':' || (w[i - 1] === 'please' && (i === 1 || w[i - 2] === ';' || w[i - 2] === ':'));
    if ((x === 'may' || x === 'must' || x === 'shall' || x === 'should') && y === 'not') return { start: i, end: i + 2, kind: 'act' };
    if (x === "mustn't" || x === "shouldn't" || x === "mayn't" || x === "shan't") return { start: i, end: i + 1, kind: 'act' };
    // "cannot" and "will not" only after a person: "our filter cannot catch every bot" is no rule.
    if (PERSON.has(x!) || (x === 'no' && y === 'one')) {
      const k = x === 'no' ? i + 2 : i + 1;
      const [a, b, c] = [w[k], w[k + 1], w[k + 2]];
      if (a === 'cannot' || a === "can't" || a === "won't") return { start: i, end: k + 1, kind: 'act' };
      if ((a === 'can' || a === 'will') && b === 'not') return { start: i, end: k + 2, kind: 'act' };
      if ((a === 'are' || a === 'is') && b === 'not' && c === 'to') return { start: i, end: k + 3, kind: 'act' };
    }
    if ((x === 'agree' || x === 'agrees') && y === 'not' && w[i + 2] === 'to') return { start: i, end: i + 3, kind: 'act' };
    if (x === 'not') {
      const k = y === 'be' ? i + 2 : i + 1;
      if (PERMITTED.has(w[k]!)) return { start: i, end: k + 1, kind: 'passive' };
    }
    if (x === 'prohibited' || x === 'forbidden' || x === 'disallowed' || x === 'banned') {
      // "Scraping is not prohibited" grants, it does not forbid.
      let k = i - 1;
      while (k >= 0 && k >= i - 4 && ADVERB.has(w[k]!)) k--;
      return k >= 0 && w[k] === 'not' ? null : { start: i, end: i + 1, kind: 'passive' };
    }
    if (x === 'prohibit' || x === 'prohibits' || x === 'forbid' || x === 'forbids') return { start: i, end: i + 1, kind: 'forbid' };
    if (atStart) {
      if (x === "don't" || x === 'never') return { start: i, end: i + 1, kind: 'act' };
      if (x === 'do' && y === 'not') return { start: i, end: i + 2, kind: 'act' };
      if (x === 'no') return { start: i, end: i + 1, kind: 'no' };
    }
    return null;
  }

  /** Where the reach of a prohibition ending at `from` stops: `CLAUSE_WINDOW` words, or the end of its clause. */
  reach(from: number): number {
    const w = this.w;
    let j = from;
    for (let count = 0; j < w.length && count < CLAUSE_WINDOW && j - from < 2 * CLAUSE_WINDOW; j++) {
      const x = w[j]!;
      if (x === ';' || x === ':' || CLAUSE_BREAK.has(x)) break;
      if ((x === 'and' || x === 'or') && CLAUSE_SUBJECT.has(w[j + 1] ?? '')) break;
      if (x !== ',') count++;
    }
    return j;
  }

  /**
   * True when [from, to) holds an automated act: an automation verb ("automate access", "crawl
   * the forum", "be scraped"), or an act of access whose object ("use any robot") or means ("access
   * the forum by automated means") is an automation word.
   */
  automatedAct(from: number, to: number): boolean {
    const w = this.w;
    for (let j = from; j < to; j++) {
      const x = w[j]!;
      const prev = j > 0 ? w[j - 1]! : '';
      if (AUTOMATION_VERBS.has(x) && !NOT_A_VERB.has(prev)) return true;
      if (AUTOMATION_GERUNDS.has(x) && !TOPIC.has(prev)) return true;
      if (AUTOMATION_PARTICIPLES.has(x) && (prev === 'be' || prev === 'being' || prev === 'been')) return true;
      if (ACCESS.has(x) && !TOPIC.has(prev) && (this.objectAt(j + 1, to) || this.meansIn(j + 1, Math.min(to, j + 1 + MEANS_WINDOW), to))) return true;
    }
    return false;
  }

  /**
   * True when [from, to) is a phrase about automation: it opens (past fillers) with an automation
   * -ing form ("Scraping this forum"), or with an automation word followed only by automation,
   * tool and list words up to its end or a preposition ("Bots, scrapers and other automated tools",
   * "Automated access to the site").
   */
  automationPhrase(from: number, to: number): boolean {
    const w = this.w;
    let k = from;
    while (k < to && FILLER.has(w[k]!)) k++;
    if (k >= to) return false;
    if (AUTOMATION_GERUNDS.has(w[k]!)) return true;
    if (!AUTOMATION.has(w[k]!)) return false;
    for (k++; k < to && AUTOMATION_PHRASE.has(w[k]!); k++);
    return k === to || PHRASE_END.has(w[k]!);
  }

  /** True when [from, to) opens with an act of access whose object or means is automation: "Accessing the forum with a bot", "The use of bots". */
  accessPhrase(from: number, to: number): boolean {
    const w = this.w;
    let k = from;
    while (k < to && ARTICLE.has(w[k]!)) k++;
    if (k >= to || !ACCESS.has(w[k]!)) return false;
    return this.objectAt(k + 1, to) || this.meansIn(k + 1, to, to);
  }

  /**
   * True when the subject of the passive prohibition at `at` ("... is prohibited", "... are not
   * allowed") is automated access. The subject ends at the verb and starts at the sentence start,
   * a ; or :, a comma after an opening phrase ("On this forum, scraping is prohibited") or a whole
   * clause, or an "and"/"or" after a whole clause ("Bots are blocked and scraping is prohibited").
   * A comma or "and" inside a list is no start: "Posting about scrapers, crawlers and bots is
   * prohibited" is about posting.
   */
  subjectAutomated(at: number): boolean {
    const w = this.w;
    let e = at;
    while (e > 0 && e > at - 6 && AUXILIARY.has(w[e - 1]!)) e--;
    const lo = Math.max(0, e - SUBJECT_WINDOW);
    let b = lo;
    for (let i = e - 1; i >= lo; i--) {
      if (w[i] === ';' || w[i] === ':') {
        b = i + 1;
        break;
      }
    }
    let tries = 0;
    for (let s = e - 1; s >= b && tries < SUBJECT_TRIES; s--) {
      const before = s > 0 ? w[s - 1]! : '';
      let start: boolean;
      if (s === b) start = s === 0 || before === ';' || before === ':';
      else if (before === ',') start = PREAMBLE.has(w[b]!) || this.verb[s - 1]! >= b;
      else if (before === 'and' || before === 'or') start = this.verb[s - 1]! >= b;
      else start = false;
      if (!start) continue;
      tries++;
      if (this.automationPhrase(s, e) || this.accessPhrase(s, e)) return true;
    }
    return false;
  }

  /** True when the sentence has a prohibition at all, whatever it forbids (a list lead-in). */
  hasBan(): boolean {
    for (let i = 0; i < this.w.length; i++) if (this.banAt(i) !== null) return true;
    return false;
  }

  /** True when a prohibition of the sentence governs automated access. */
  forbidsAutomation(): boolean {
    for (let i = 0; i < this.w.length; i++) {
      const ban = this.banAt(i);
      if (ban === null) continue;
      const to = this.reach(ban.end);
      if (this.automatedAct(ban.end, to)) return true;
      if ((ban.kind === 'no' || ban.kind === 'forbid') && this.automationPhrase(ban.end, to)) return true;
      if (ban.kind === 'passive' && this.subjectAutomated(ban.start)) return true;
    }
    return false;
  }

  /** True when a list item under a lead-in that forbids is automated access: "use any robot ...", "Bots, scrapers and crawlers." */
  itemIsAutomation(): boolean {
    const to = this.reach(0);
    return this.automatedAct(0, to) || this.automationPhrase(0, to);
  }
}

// A sentence ends at . ! or ? followed by space and a capital, a digit or an opening mark; "e.g. a
// crawler" stays one sentence.
const SENTENCE_END = /(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'“‘(\[])/u;
const LIST_MARKER = /^(?:[-*•·–]|\(?[a-z0-9ivx]{1,4}[.)])\s+/iu;
/** The longest list marker `LIST_MARKER` takes off a line, with its one space. */
const MAX_LIST_MARKER = 8;
/** How many lines under a lead-in are read as its items. */
const MAX_LIST_LINES = 15;

/**
 * D49: the sentence of `text` that forbids automated access, or null. A prohibition ("may not",
 * "must not", "is prohibited", "agree not to", "not allowed", a leading "Do not" or "No", and the
 * like) counts only when what it forbids is automated access: an automation verb ("may not automate
 * access", "must not crawl"), an act of access, use or collection whose object or means is a bot,
 * crawler, scraper, spider, robot, script or automated means ("use any robot, spider, scraper or
 * other automated means to access", "access the forum by automated means"), or a subject that is
 * one ("Automated access is not permitted", "Scraping is prohibited", "No bots"). "Posting spam is
 * prohibited" next to "our automated filters" is not one.
 *
 * A sentence that ends in a colon after a prohibition ("You agree not to:") forbids each line under
 * it, with or without a list marker and in any case (Chrome's innerText of an <li> has no bullet):
 * the clause is then the lead-in and the item. The list starts after any blank lines and ends at a
 * blank line after its first item or after `MAX_LIST_LINES` lines. Each line of `text` is a block
 * of the page and sentences never cross one. The sentence comes back with its white space
 * collapsed and nothing else changed.
 *
 * Time is linear in the length of `text`: a line or sentence over `MAX_CLAUSE_LENGTH` is skipped
 * before any other work, and each sentence is read word by word once.
 *
 * Nothing here ever reads as a permission: "You may crawl the forum to index it for a publicly
 * available search engine, if you run one." is neither a prohibition nor a licence for lurkd, and
 * a forum without a clause stays `unknown`.
 */
export function findAutomationClause(text: string): string | null {
  if (typeof text !== 'string' || text === '') return null;
  let leadIn: string | null = null;
  let listLines = 0;
  for (const rawLine of text.split(/\r?\n|\r|\u2028|\u2029/)) {
    const line = oneLine(rawLine);
    if (line === '') {
      if (listLines > 0) leadIn = null;
      continue;
    }
    if (leadIn !== null) {
      listLines++;
      if (line.length <= MAX_CLAUSE_LENGTH + MAX_LIST_MARKER) {
        const item = line.replace(LIST_MARKER, '');
        if (item.length <= MAX_CLAUSE_LENGTH && new Clause(wordsOfSentence(item)).itemIsAutomation()) return `${leadIn} ${item}`;
      }
      if (listLines >= MAX_LIST_LINES) leadIn = null;
    }
    const sentences = line.split(SENTENCE_END);
    let last: Clause | null = null;
    for (const sentence of sentences) {
      last = null;
      if (sentence.length > MAX_CLAUSE_LENGTH) continue;
      last = new Clause(wordsOfSentence(sentence));
      if (last.forbidsAutomation()) return sentence;
    }
    const lastSentence = sentences.at(-1)!;
    if (last !== null && lastSentence.endsWith(':') && last.hasBan()) {
      leadIn = lastSentence;
      listLines = 0;
    }
  }
  return null;
}

/**
 * True for an IPv4 address lurkd must not open: private, loopback, link-local, shared, multicast,
 * reserved, and the documentation blocks 192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24.
 */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * The eight 16-bit words of an IPv6 address (zone id dropped, a trailing dotted IPv4 part turned
 * into two words), or null when `text` is not one.
 */
function ipv6Words(text: string): number[] | null {
  let s = text.replace(/%.*$/, '').toLowerCase();
  if (!isIPv6(s)) return null;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  const part = (x: string) => (x === '' ? [] : x.split(':'));
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const words = [...head, ...Array<string>(halves.length === 2 ? 8 - head.length - tail.length : 0).fill('0'), ...tail].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

/** The IPv4 address in two IPv6 words. */
const ipv4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * True for an address on the public internet. IPv4 goes through the private-range check of
 * `analysableUrl`. IPv6 must be global unicast (2000::/3) and outside the documentation and
 * protocol blocks (2001:db8::/32, 3fff::/20, 2001::/23); an address that carries an IPv4 one
 * (IPv4-mapped ::ffff:0:0/96, NAT64 64:ff9b::/96, 6to4 2002::/16) is judged by that IPv4 address.
 * Everything else is refused: ::, ::1, fc00::/7, fe80::/10, fec0::/10, ff00::/8, ::/96, 100::/64
 * and anything that is not an IP address.
 */
export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) return !isPrivateIpv4(address);
  const w = ipv6Words(address);
  if (w === null) return false;
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return !isPrivateIpv4(ipv4Of(w[6]!, w[7]!));
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return !isPrivateIpv4(ipv4Of(w[6]!, w[7]!));
  if (w[0] === 0x2002) return !isPrivateIpv4(ipv4Of(w[1]!, w[2]!));
  if ((w[0]! & 0xe000) !== 0x2000) return false;
  if (w[0] === 0x2001 && (w[1] === 0x0db8 || w[1]! < 0x0200)) return false;
  if (w[0] === 0x3fff && w[1]! < 0x1000) return false;
  return true;
}

/** One address of a host name, as node:dns `lookup(host, { all: true })` gives it. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Every address a host name resolves to. FetchService uses node:dns `lookup`; tests pass their own. */
export type ResolveHost = (host: string) => Promise<readonly ResolvedAddress[]>;

/**
 * The DNS half of `analysableUrl`: resolves the host of `u` with `resolve` and refuses it, with
 * the same message as a local address, when any answer is not public (`isPublicAddress`), so a
 * public name such as 127.0.0.1.nip.io or localtest.me does not reach the user's own machine or
 * network. A name that does not resolve, or a resolver answer that is not a list of addresses,
 * is `invalid_request` too. With the test-only
 * `rules.allowLoopback`, 127.0.0.1 and localhost are not looked up; every other name is.
 *
 * Known residual gap: the browser resolves the name again when it navigates, so a DNS server
 * that answers with a public address here and a private one a moment later (DNS rebinding) is
 * not caught.
 */
export async function checkResolvesPublic(u: URL, resolve: ResolveHost, rules: AddressRules = {}): Promise<void> {
  const host = u.hostname;
  if (rules.allowLoopback === true && TEST_LOOPBACK_HOSTS.has(host.replace(/\.+$/, ''))) return;
  let answer: unknown;
  try {
    answer = await resolve(host);
  } catch {
    answer = [];
  }
  // A resolver answer that is not a list of { address: string } reads as no answer.
  const wellFormed = Array.isArray(answer) && answer.every((a: unknown) => isObj(a) && typeof a.address === 'string');
  const addresses: readonly ResolvedAddress[] = wellFormed ? (answer as ResolvedAddress[]) : [];
  if (addresses.length === 0) throw invalid(`lurkd could not look up ${host}. Check the spelling of the address and that this computer is online.`);
  if (addresses.some((a) => !isPublicAddress(a.address))) throw invalid(LOCAL_ADDRESS_MESSAGE);
}

/** Where `analysableUrl` may open more than public forums. */
export interface AddressRules {
  /**
   * Tests only: let 127.0.0.1 and localhost through, over http too, so fixture forums on the
   * test machine can be analysed. Set where a test builds the service or the app; lurkd itself
   * never sets it, and no environment variable or flag turns it on.
   */
  allowLoopback?: boolean;
}

/**
 * The address the user (or `lurkd add`) gave, ready to open: http(s) only (no scheme reads as
 * https), https only, no user name or password, no host on a private, loopback or local network
 * (127.0.0.1, localhost, [::1] and every other spelling, any port), no fragment. `rules` can let
 * 127.0.0.1 and localhost through for tests. Every refusal is `invalid_request` with a fixed
 * message: the input is never echoed, since it could carry credentials. A host name that only
 * resolves to a private address is not caught here: `checkResolvesPublic` does that.
 */
export function analysableUrl(raw: string, rules: AddressRules = {}): URL {
  const text = raw.trim();
  const ask = 'Give the address of a forum page, starting with https://.';
  if (text === '' || text.length > MAX_ADDRESS_LENGTH) throw invalid(ask);
  const u = parseAbsolute(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.hostname === '') throw invalid(ask);
  if (u.username !== '' || u.password !== '') throw invalid('lurkd does not open addresses that carry a user name or password.');
  // `localhost.` and `nas.local.` name the same hosts as without the final dot.
  const host = u.hostname.replace(/\.+$/, '');
  if (!(rules.allowLoopback === true && TEST_LOOPBACK_HOSTS.has(host))) {
    const local =
      host === 'localhost' ||
      host.startsWith('[') ||
      isPrivateIpv4(host) ||
      !host.includes('.') ||
      LOCAL_SUFFIXES.some((s) => host.endsWith(s));
    if (local) throw invalid(LOCAL_ADDRESS_MESSAGE);
    if (u.protocol !== 'https:') throw invalid('lurkd opens forums over https only. Give the https address of the forum.');
  }
  u.hash = '';
  return u;
}

/** A source id from a host: `www.` dropped, every other character run turned into one hyphen, 63 characters at most. */
export function idForHost(host: string): string {
  const id = host
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '');
  return id.length >= 2 ? id : `forum-${id}`.replace(/-+$/, '');
}

/**
 * The source the analysis reads with (D45): engine `generic`, the host of `u` only, the draft
 * limits, no deny rules of its own (the built-in ones always apply), switched off and never
 * registered. `invalid_request` when the host is not one a source may list.
 */
export function analyseSource(u: URL, checkedAt: string): SourceConfig {
  const id = idForHost(u.hostname);
  const raw = {
    id,
    name: u.hostname,
    topics: ['add-a-forum'],
    engine: 'generic',
    base_url: u.origin,
    domains: [u.hostname],
    automation: { policy: 'unknown', rule_url: u.origin, rule_quote: null, checked_at: checkedAt },
    rate_limit: {
      min_delay_s: DRAFT_LIMITS.min_delay_s,
      max_requests_per_run: DRAFT_LIMITS.max_requests_per_run,
      max_requests_per_day: DRAFT_LIMITS.max_requests_per_day,
    },
    pagination: { max_pages_per_thread: DRAFT_LIMITS.max_pages_per_thread },
    enabled: false,
  };
  const r = parseSource(YAML.stringify(raw), { file: `${id}.yaml` });
  if (!r.ok) throw invalid('lurkd cannot read this address: its host name is not one a source can list.');
  return r.source;
}

/** What `POST /api/add/analyse` answers. */
export type AnalyseOut =
  | { status: 'known'; host: string; sourceId: string }
  | { status: 'blocked'; host: string; block: { kind: 'challenge'; message: string } }
  | {
      status: 'analysed';
      host: string;
      forum: ForumDetection;
      block: { kind: 'login'; message: string } | null;
      /** D49: the rules pages read after the analysed page, and the clause found on one of them. */
      rules: RulesCheck;
      /** D49: what the form starts with: `forbidden` with the clause and its page when one was found. */
      automation: AutomationPrefill;
    };

/**
 * What became of one rules page: `read` (its text was searched), `unavailable` (an HTTP error
 * status), `login` (a login wall), `off_domain` (it ended on another host), `challenge` (a human
 * check: lurkd reads no further page) or `failed` (a timeout, a request cap or another error).
 */
export type RulesPageOutcome = 'read' | 'unavailable' | 'login' | 'off_domain' | 'challenge' | 'failed';

export interface RulesCheck {
  pages: { url: string; outcome: RulesPageOutcome }[];
  /** The exact sentence that forbids automated access and the page it is on, or null. */
  clause: { url: string; sentence: string } | null;
}

export type AutomationPrefill =
  | { policy: 'forbidden'; rule_url: string; rule_quote: string }
  | { policy: 'unknown'; rule_url: null; rule_quote: null };

/** The form's starting policy for what the rules pages showed. */
export function automationPrefill(rules: RulesCheck): AutomationPrefill {
  return rules.clause === null
    ? { policy: 'unknown', rule_url: null, rule_quote: null }
    : { policy: 'forbidden', rule_url: rules.clause.url, rule_quote: rules.clause.sentence };
}

/**
 * What `POST /api/add` (the agent's `lurkd add`) answers. `url` is the address waiting on the
 * page; `already_queued` when the host was already waiting with another address, which it keeps.
 */
export type AddOut =
  | { status: 'queued'; host: string; url: string }
  | { status: 'already_queued'; host: string; url: string }
  | { status: 'known'; host: string; sourceId: string };

/** What `POST /api/add/draft` (the lurkd page's form) answers. */
export type AddDraftOut =
  | { status: 'known'; host: string; sourceId: string }
  | { status: 'draft_saved'; host: string; draftId: number; sourceId: string; warnings: string[] };

const optionalUrl = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : v);

/**
 * `invalid_request` for `field` when `v` is an address with a user name or password, as
 * `analysableUrl` refuses one; the value is not echoed. Anything that is not such an address is
 * left to the schema.
 */
function refuseCredentials(v: unknown, field: string): void {
  if (typeof v !== 'string') return;
  const u = parseAbsolute(v.trim().replaceAll('{query}', 'q'));
  if (u && (u.username !== '' || u.password !== '')) throw invalid(`${field} must not carry a user name or password.`, { field });
}

/**
 * The "Add a forum" form as source YAML for `DraftStore.submit`, with the host of `base_url`.
 * Only the form's fields are read: `id` (default from the host), `name`, `engine` (discourse or
 * xenforo), `base_url`, `domains` (default the host of `base_url`), `login_url`, `signup_url`,
 * `search_url`, `topics` (a list or comma-separated text) and `automation` with `policy` (default
 * unknown), `rule_url` (default `base_url`) and `rule_quote`. Anything else in the body is
 * dropped; `status` is written as untested, `enabled` as false and `checked_at` as `today`. An
 * address with a user name or password is refused, as `analysableUrl` refuses one, and so is a
 * name longer than `MAX_NAME` characters. The schema
 * checks the values when the draft is submitted, field by field.
 */
export function parseAddDraft(body: Obj, today: string): { yaml: string; host: string; id: string } {
  const engine = body.engine;
  if (engine !== 'discourse' && engine !== 'xenforo')
    throw invalid('engine must be discourse or xenforo. For other forums, ask your agent to add the site.', { field: 'engine' });
  const baseUrl = body.base_url;
  const base = typeof baseUrl === 'string' ? parseAbsolute(baseUrl.trim()) : null;
  if (!base || (base.protocol !== 'http:' && base.protocol !== 'https:') || base.hostname === '')
    throw invalid('base_url must be the absolute https address of the forum.', { field: 'base_url' });
  const automation = body.automation ?? {};
  if (!isObj(automation)) throw invalid('automation must be an object with policy, rule_url and rule_quote.', { field: 'automation' });
  for (const field of ['base_url', 'login_url', 'signup_url', 'search_url'] as const) refuseCredentials(body[field], field);
  refuseCredentials(automation.rule_url, 'automation.rule_url');
  const host = base.hostname;
  const id = typeof body.id === 'string' && body.id.trim() !== '' ? body.id.trim() : idForHost(host);
  const topics = typeof body.topics === 'string' ? body.topics.split(',').map((t) => t.trim()).filter((t) => t !== '') : body.topics;
  const quote = automation.rule_quote;
  // M1: the name the person checked in the form, on one line and no longer than a detected one.
  const name = typeof body.name === 'string' ? oneLine(body.name) : body.name;
  if (typeof name === 'string' && [...name].length > MAX_NAME) throw invalid(`name has at most ${MAX_NAME} characters.`, { field: 'name' });
  const draft: Obj = {
    id,
    name,
    status: 'untested',
    topics,
    engine,
    base_url: (baseUrl as string).trim(),
    domains: body.domains ?? [host],
    login_url: optionalUrl(body.login_url),
    signup_url: optionalUrl(body.signup_url),
    search_url: optionalUrl(body.search_url),
    automation: {
      policy: automation.policy ?? 'unknown',
      rule_url: optionalUrl(automation.rule_url) ?? (baseUrl as string).trim(),
      rule_quote: quote === undefined || (typeof quote === 'string' && quote.trim() === '') ? null : quote,
      checked_at: today,
    },
    enabled: false,
  };
  // aliasDuplicateObjects off: the draft check refuses anchors and aliases.
  return { yaml: YAML.stringify(draft, { aliasDuplicateObjects: false }), host, id };
}
