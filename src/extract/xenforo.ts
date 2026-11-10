import { parseHTML } from 'linkedom';
import { errors } from 'playwright';
import type { PageReader } from '../browser/reader.js';
import { LurkdError } from '../errors.js';
import { isAllowedHost, isThreadPath } from '../policy/urls.js';
import { stripMarkers } from '../pseudonym.js';
import type { SourceConfig } from '../sources/schema.js';
import type { AuthorSignals, ExtractedPost, ExtractedThread, SearchHit } from '../types.js';
import type { EngineAdapter, ExtractContext } from './engine.js';
import { makeConverter } from './markdown.js';
import { namesAuthor, withoutAuthor } from './scrub.js';

// XenForo 2, DOM only (ported from the spike): one navigation per thread page, following
// `a.pageNav-jump--next` without clicking anything, up to `pagination.max_pages_per_thread`.
// Every request goes through `ctx.reader` (URL policy, run limits, fetch log, block detection).
// The page HTML comes back through `reader.evaluate` with string code and is parsed here with
// linkedom, so no page script runs the extraction and the parsing is testable without a browser.
//
// The default XenForo 2 classes are the same across installs with the default style: posts are
// `article.message--post` with `data-author`, bodies `.message-body .bbWrapper`, quotes
// `blockquote.bbCodeBlock--quote` with `data-quote` and `data-source` (the converter's rule).
// Search is a POST form (D14) unless the source declares a GET `search_url`.

/** Only reputation-like extras; location, website and similar fields are dropped. */
const EXTRA_KEYS: ReadonlySet<string> = new Set(['joined', 'messages', 'reaction score', 'points', 'solutions']);

const PAGE_HTML = 'document.documentElement.outerHTML';
const SEARCH_FORM = 'form[action*="search/search"]';
const SEARCH_INPUT = 'input[name="keywords"]';
const SEARCH_HITS = '.contentRow-title a[href*="threads/"]';
const LOGOUT_LINK = 'a[href*="logout"]';
/** How long `checkSession` waits for its selector after the page settled: a visitor menu may arrive late. */
const SESSION_WAIT_MS = 3_000;
/** Statuses that mean the thread or member is gone, whatever the page shows. */
const GONE: ReadonlySet<number> = new Set([404, 410]);
const NO_READ_ENDPOINT = 'This XenForo source searches with POST and lists no read_endpoints entry.';

// A trailing page-<n> or post-<n> segment of a thread path or of an index.php? route.
const PAGE_SUFFIX = /\/page-(\d+)\/?$/i;
const POSITION_SUFFIX = /\/(?:page|post)-\d+\/?$/i;
const QUERY_SEPARATORS = /[&;]/;
/** A page navigation claiming more pages than this is not believed: the last page counts as unknown. */
const MAX_PAGE_NUMBER = 100_000;
/** A join date as XenForo prints it: "Mar 1, 2019", "1. Mar 2019", "2019-03-01" or "01/03/2019". */
const JOINED_DATE = /^(?:\p{L}{1,10}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\.?\s+\p{L}{1,10}\.?,?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})$/u;

/** One post as the page shows it, before conversion. */
export interface RawPost {
  author: string;
  /** Absolute URL of `.message-name a.username`, or null. */
  authorHref: string | null;
  /** The `#N` of the post, or null when the page shows none. */
  position: number | null;
  date: string | null;
  userTitle: string;
  banners: string[];
  extras: Array<[string, string]>;
  reactions: number;
  html: string;
}

export interface ThreadPage {
  title: string;
  posts: RawPost[];
  /** Absolute URL of the first `a.pageNav-jump--next`, or null. */
  next: string | null;
  /** The highest page number in the page navigation, or null when there is none. */
  lastPage: number | null;
  /** XenForo marks its error pages (thread or member not found) with `data-template="error"`. */
  isError: boolean;
}

export interface MemberPage {
  header: boolean;
  isError: boolean;
  signals: AuthorSignals;
}

type Doc = Document;

/** Free text from the page for a signal or a title: no name markers, one line. */
const clean = (s: string | null | undefined): string => stripMarkers(s ?? '').replace(/\s+/g, ' ').trim();

function parse(html: string): Doc {
  return parseHTML(html).document as unknown as Doc;
}

function absolute(href: string | null | undefined, base: string): string | null {
  if (href === null || href === undefined || href.trim() === '') return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function iso(v: string | null | undefined): string | null {
  if (!v) return null;
  // XenForo writes offsets as +0000; Date wants +00:00 to be sure.
  const d = new Date(v.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A whole count as XenForo prints it (1,234 or 1.234); null for an abbreviated one (1.2K), never a guess. */
function count(text: string): number | null {
  const t = clean(text);
  if (!/^\d{1,3}(?:[,.\s  ']\d{3})*$|^\d+$/.test(t)) return null;
  return Number(t.replace(/\D/g, ''));
}

/**
 * A URL for an error message without its query and fragment: they may carry a username (`?u=`),
 * and errors reach the agent.
 */
function shownUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** `base_url` without a trailing slash: origin plus the subfolder, if any. */
function baseOf(source: SourceConfig): string {
  const u = new URL(source.base_url);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** The `threads/...` route in the query of a non-friendly URL (`index.php?threads/x.55/`), or null. */
function queryRoute(u: URL): string | null {
  if (!/\/index\.php$/i.test(u.pathname)) return null;
  const first = u.search.slice(1).split(QUERY_SEPARATORS)[0] ?? '';
  return /^threads\//i.test(first) && !first.includes('=') ? first : null;
}

function withSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

/**
 * The URL a thread is read from and stored under: a trailing `page-<n>` (or `post-<n>`) dropped,
 * a trailing slash added, query and fragment dropped. An `index.php?threads/...` route stays in
 * the query, without the page and without other parameters. This only normalises the string;
 * whether it is a thread of a source is `isThreadPath`'s call (src/policy/urls.ts). Throws
 * `invalid_request` for a string that is no absolute URL.
 */
export function canonicalThreadUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new LurkdError('invalid_request', 'Not a XenForo thread URL: the value is not an absolute URL.', {});
  }
  const route = queryRoute(u);
  if (route !== null) return `${u.origin}${u.pathname}?${withSlash(withoutPositions(route))}`;
  return `${u.origin}${withSlash(withoutPositions(u.pathname))}`;
}

/** Strips every trailing `page-<n>` and `post-<n>` segment: `/x.55/page-2/page-3` gives `/x.55/`. */
function withoutPositions(path: string): string {
  let out = path;
  while (POSITION_SUFFIX.test(out)) out = out.replace(POSITION_SUFFIX, '/');
  return out;
}

/** The URL of page `n` of a canonical thread URL: the thread URL itself for page 1, else `<thread>page-<n>`. */
export function pageUrlOf(threadUrl: string, n: number): string {
  return n <= 1 ? threadUrl : `${threadUrl}page-${n}`;
}

/** The page a thread URL points at: 1 without a suffix, null for a `post-<n>` link, `page-0` or a non-URL. */
export function pageNumberOf(url: string): number | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const subject = queryRoute(u) ?? u.pathname;
  if (/\/post-\d+\/?$/i.test(subject)) return null;
  const m = PAGE_SUFFIX.exec(subject);
  if (!m) return 1;
  const n = Number(m[1]);
  // page-0 would be page 1 again; XenForo numbers pages from 1.
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * Where a "next" link leads, or null when lurkd stops: a link off the source's hosts, into another
 * thread, to something that is not a page of the thread, or to a page already read (loop guard).
 * The page is opened at its normalised URL (`pageUrlOf`), never at the link as written.
 */
export function nextPageUrl(
  source: SourceConfig,
  threadUrl: string,
  currentUrl: string,
  href: string | null,
  visited: ReadonlySet<number>,
): { url: string; page: number } | null {
  const url = absolute(href, currentUrl);
  if (url === null || !isAllowedHost(source, url) || !isThreadPath(source, canonicalThreadUrl(url))) return null;
  if (canonicalThreadUrl(url) !== threadUrl) return null;
  const page = pageNumberOf(url);
  if (page === null || visited.has(page)) return null;
  return { url: pageUrlOf(threadUrl, page), page };
}

/** Reads one thread page of XenForo 2's default style. `pageUrl` resolves relative links. */
export function parseThreadPage(html: string, pageUrl: string): ThreadPage {
  const doc = parse(html);
  // Only top-level posts: an article nested in a post body is part of that body, never a post.
  const articles = Array.from(doc.querySelectorAll('article.message--post')).filter((a) => a.parentElement?.closest('article.message--post') == null);
  const posts: RawPost[] = articles.map((a) => {
    const extras: Array<[string, string]> = [];
    for (const dl of Array.from(a.querySelectorAll('.message-userExtras dl'))) {
      const k = clean(dl.querySelector('dt')?.textContent);
      const v = clean(dl.querySelector('dd')?.textContent);
      if (k && v) extras.push([k, v]);
    }
    // Reactions are counted, never named: the bar lists usernames.
    const bar = a.querySelector('.reactionsBar-link');
    let reactions = 0;
    if (bar) {
      reactions = bar.querySelectorAll('bdi').length;
      const more = /and (\d[\d,.]*) others?/.exec(bar.textContent ?? '');
      if (more) reactions += Number(more[1]!.replace(/\D/g, ''));
    }
    const posLink = Array.from(a.querySelectorAll('.message-attribution-opposite a')).find((x) => /^#\s*[\d,.]+$/.test((x.textContent ?? '').trim()));
    const position = posLink ? Number((posLink.textContent ?? '').replace(/\D/g, '')) : NaN;
    return {
      author: clean(a.getAttribute('data-author')),
      authorHref: absolute(a.querySelector('.message-name a.username[href]')?.getAttribute('href'), pageUrl),
      position: Number.isFinite(position) && position > 0 ? position : null,
      date: a.querySelector('.message-attribution-main time[datetime]')?.getAttribute('datetime') ?? null,
      userTitle: clean(a.querySelector('.message-userTitle')?.textContent),
      banners: Array.from(a.querySelectorAll('.message-userBanner'))
        .map((b) => clean(b.textContent))
        .filter(Boolean),
      extras,
      reactions,
      html: a.querySelector('.message-body .bbWrapper')?.innerHTML ?? '',
    };
  });
  const pages = Array.from(doc.querySelectorAll('.pageNav-page a'))
    .map((x) => Number(clean(x.textContent).replace(/[,.]/g, '')))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= MAX_PAGE_NUMBER);
  return {
    title: clean(doc.querySelector('h1.p-title-value')?.textContent) || clean(doc.querySelector('title')?.textContent),
    posts,
    next: absolute(doc.querySelector('a.pageNav-jump--next')?.getAttribute('href'), pageUrl),
    lastPage: pages.length ? Math.max(...pages) : null,
    isError: doc.documentElement?.getAttribute('data-template') === 'error',
  };
}

/** The forms of the author's name a signal must not carry: the username, the member slug, the slug with spaces. */
function authorForms(p: RawPost): string[] {
  const slug = p.authorHref === null ? null : slugOf(p.authorHref);
  return [...new Set([p.author, ...(slug === null ? [] : [slug, slug.replace(/-/g, ' ')])].filter((n) => n.trim() !== ''))];
}

/**
 * The value of a reputation extra when it has the expected shape, else null (dropped): a whole
 * count for messages, reaction score, points and solutions; a short date for joined.
 */
function extraValue(key: string, value: string): string | null {
  if (key === 'joined') return JOINED_DATE.test(value) ? value : null;
  return count(value) === null ? null : value;
}

/**
 * D33 signals from the post's user block: user title, banners and the reputation extras. A title
 * or banner that names the post's author is dropped, and so is an extra whose value is not a count
 * (or, for joined, a date): signals are free text the pseudonyms would not cover.
 */
function signalsOf(p: RawPost): string[] {
  const names = authorForms(p);
  const signals: string[] = [];
  if (p.userTitle && !namesAuthor(p.userTitle, names)) signals.push(`title "${p.userTitle}"`);
  for (const b of p.banners) if (!namesAuthor(b, names)) signals.push(`banner "${b}"`);
  for (const [k, v] of p.extras) {
    const key = k.toLowerCase();
    if (!EXTRA_KEYS.has(key)) continue;
    const value = extraValue(key, v);
    if (value !== null && !namesAuthor(value, names)) signals.push(`${key} ${value}`);
  }
  return signals;
}

/**
 * The posts of one parsed page. A post without a `#N` gets the number after the one before it;
 * `previous` is the last number of the earlier pages.
 */
export function threadPosts(page: ThreadPage, pageNo: number, source: SourceConfig, previous = 0, convert = makeConverter({ baseUrl: source.base_url })): ExtractedPost[] {
  let last = previous;
  return page.posts.map((p) => {
    const number = p.position ?? last + 1;
    last = number;
    return {
      number,
      page: pageNo,
      author: p.author,
      authorUrl: p.authorHref !== null && isAllowedHost(source, p.authorHref) ? p.authorHref : null,
      signals: signalsOf(p),
      notes: [`${p.reactions} reactions`, `page ${pageNo}`],
      postedAt: iso(p.date),
      bodyMd: convert(p.html),
    };
  });
}

/** Thread links of a search results page, on the source's hosts, canonical, each once, in page order. */
export function parseSearchResults(html: string, pageUrl: string, source: SourceConfig): SearchHit[] {
  const doc = parse(html);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(doc.querySelectorAll(SEARCH_HITS))) {
    const href = absolute(a.getAttribute('href'), pageUrl);
    if (href === null || !isAllowedHost(source, href)) continue;
    const url = canonicalThreadUrl(href);
    if (!isThreadPath(source, url) || seen.has(url)) continue;
    seen.add(url);
    hits.push({ url, title: clean(a.textContent) || url, posts: null });
  }
  return hits;
}

/** A member profile: `.memberHeader-stats dl` for messages and the extras, the Joined `time[datetime]`. */
export function parseMemberPage(html: string): MemberPage {
  const doc = parse(html);
  const header = doc.querySelector('.memberHeader');
  let postCount: number | null = null;
  const extra: string[] = [];
  for (const dl of Array.from(doc.querySelectorAll('.memberHeader-stats dl'))) {
    const k = clean(dl.querySelector('dt')?.textContent).toLowerCase();
    const v = clean(dl.querySelector('dd')?.textContent);
    if (!k || !v) continue;
    if (k === 'messages') postCount = count(v);
    else if (k !== 'joined' && EXTRA_KEYS.has(k) && count(v) !== null) extra.push(`${k} ${v}`);
  }
  let joinedAt: string | null = null;
  for (const dl of header ? Array.from(header.querySelectorAll('dl')) : []) {
    if (clean(dl.querySelector('dt')?.textContent).toLowerCase() !== 'joined') continue;
    joinedAt = iso(dl.querySelector('time[datetime]')?.getAttribute('datetime'));
    break;
  }
  return {
    header: header !== null,
    isError: doc.documentElement?.getAttribute('data-template') === 'error',
    signals: { postCount, joinedAt, extra },
  };
}

/** The page's HTML, through the reader: string code, bounded by the page timeout. */
async function pageHtml(reader: PageReader): Promise<string> {
  const html = await reader.evaluate<unknown>(PAGE_HTML);
  return typeof html === 'string' ? html : '';
}

function threadOf(source: SourceConfig, url: string): string {
  if (!isAllowedHost(source, url)) {
    throw new LurkdError('off_domain', `${shownUrl(url)} is not on a domain of ${source.id} (${source.domains.join(', ')}).`, {
      url: shownUrl(url),
      sourceId: source.id,
      domains: source.domains,
    });
  }
  const canonical = canonicalThreadUrl(url);
  if (!isThreadPath(source, canonical)) {
    throw new LurkdError('invalid_request', `Not a XenForo thread URL: ${shownUrl(url)}`, { url: shownUrl(url), sourceId: source.id });
  }
  return canonical;
}

/** True when `url` canonicalises to `thread`; false for anything that is no thread URL at all. */
function sameThread(url: string, thread: string): boolean {
  try {
    return canonicalThreadUrl(url) === thread;
  } catch {
    return false;
  }
}

async function fetchThread(ctx: ExtractContext, url: string): Promise<ExtractedThread> {
  const { reader, source } = ctx;
  let thread = threadOf(source, url);
  const maxPages = source.pagination.max_pages_per_thread;
  const convert = makeConverter({ baseUrl: source.base_url });
  const posts: ExtractedPost[] = [];
  const numbers = new Set<number>();
  const visited = new Set<number>();
  let title = '';
  let lastPage = 0;
  // `opened` counts navigations against the cap; `read` counts pages that gave new posts.
  let opened = 0;
  let read = 0;
  let target: { url: string; page: number } | null = { url: thread, page: 1 };

  while (target !== null && opened < maxPages) {
    visited.add(target.page);
    opened++;
    const nav = await reader.open(target.url);
    if (nav.status !== null && GONE.has(nav.status)) {
      if (read === 0) {
        throw new LurkdError('not_found', `${source.name} has no thread at ${thread} (HTTP ${nav.status}).`, { url: thread, sourceId: source.id, status: nav.status });
      }
      // A later page that is gone ends the read; the pages before it stay.
      break;
    }
    const finalUrl = nav.finalUrl;
    if (read === 0) {
      // A changed slug redirects to the thread's current URL: store and page under that one.
      if (isThreadPath(source, finalUrl)) thread = canonicalThreadUrl(finalUrl);
    } else if (!sameThread(finalUrl, thread)) {
      // A later page that redirected out of the thread (a merged or moved thread, the forum index): stop, never mix threads.
      break;
    }
    const page = parseThreadPage(await pageHtml(reader), finalUrl);
    if (read === 0 && page.posts.length === 0) {
      if (page.isError) {
        throw new LurkdError('not_found', `${source.name} shows an error page instead of the thread at ${thread}.`, { url: thread, sourceId: source.id });
      }
      throw new LurkdError(
        'extraction_failed',
        `${source.name} shows no posts (article.message--post) at ${thread}; the forum may use a style this version cannot read.`,
        { url: thread, sourceId: source.id },
      );
    }
    const previous = posts.length ? posts[posts.length - 1]!.number : 0;
    let added = 0;
    for (const p of threadPosts(page, target.page, source, previous, convert)) {
      if (numbers.has(p.number)) continue;
      numbers.add(p.number);
      posts.push(p);
      added++;
    }
    // A page with no new posts is not counted and ends the read.
    if (added === 0) break;
    read++;
    title ||= page.title;
    lastPage = Math.max(lastPage, page.lastPage ?? 0, target.page);
    ctx.onProgress({ postsFetched: posts.length, page: target.page });
    target = nextPageUrl(source, thread, finalUrl, page.next, visited);
  }

  return {
    url: thread,
    title: title || thread,
    engine: 'xenforo',
    postsExpected: null,
    pages: read,
    extraction: `dom (${read} of ${lastPage || '?'} pages)`,
    quality: 'full',
    posts,
  };
}

/** Search needs a GET `search_url` or a read endpoint for the POST form (D14), as Registry.canSearch says. */
function canSearch(source: SourceConfig): boolean {
  return source.search_url !== null || source.read_endpoints.length > 0;
}

async function search(ctx: ExtractContext, query: string, limit: number): Promise<SearchHit[]> {
  const { reader, source } = ctx;
  if (!canSearch(source)) throw new LurkdError('search_unsupported', NO_READ_ENDPOINT, { sourceId: source.id });
  if (source.search_url !== null) {
    await reader.open(source.search_url.replaceAll('{query}', encodeURIComponent(query)));
  } else {
    await reader.open(`${baseOf(source)}/search/`);
    await reader.submitSearch(
      { formSelector: source.selectors?.search_form ?? SEARCH_FORM, inputSelector: source.selectors?.search_input ?? SEARCH_INPUT },
      query,
    );
  }
  const hits = parseSearchResults(await pageHtml(reader), reader.page.url(), source);
  const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return hits.slice(0, n);
}

/**
 * With the source's `session_check`: open its URL and look for a visible `logged_in_selector`.
 * Without it: open `base_url` and look for a logout link (`a[href*="logout"]`, attached, visible or
 * not, since it usually sits in a closed menu). Both go through a Playwright locator (utility
 * world, out of reach of page scripts) that waits up to `SESSION_WAIT_MS` for a menu inserted
 * after load. The link is read, never followed. A login wall is false.
 */
async function checkSession(ctx: ExtractContext): Promise<boolean> {
  const { reader, source } = ctx;
  const check = source.session_check;
  try {
    await reader.open(check?.url ?? source.base_url);
  } catch (e) {
    if (e instanceof LurkdError && e.code === 'needs_login') return false;
    throw e;
  }
  const target = check
    ? reader.page.locator(check.logged_in_selector).filter({ visible: true }).first()
    : reader.page.locator(LOGOUT_LINK).first();
  try {
    await target.waitFor({ state: check ? 'visible' : 'attached', timeout: SESSION_WAIT_MS });
    return true;
  } catch (e) {
    if (e instanceof errors.TimeoutError) return false;
    const message = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.trim();
    throw new LurkdError('extraction_failed', `The session check on ${source.name} failed in the browser.`, { sourceId: source.id, error: message });
  }
}

/** The profile URL to open: query and fragment dropped, except an `index.php?members/...` route. */
function profileTarget(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new LurkdError('invalid_request', 'The author profile URL is not an absolute URL.', {});
  }
  const first = u.search.slice(1).split(QUERY_SEPARATORS)[0] ?? '';
  if (/\/index\.php$/i.test(u.pathname) && /^members\//i.test(first) && !first.includes('=')) return `${u.origin}${u.pathname}?${first}`;
  return `${u.origin}${u.pathname}`;
}

/** The member slug of a profile URL (`/members/erin-smith.5/` gives `erin-smith`), or null. */
function slugOf(url: string): string | null {
  const m = /members\/([^/?#&;]+?)\.\d+(?:[/?#&;]|$)/i.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/**
 * One navigation to the member profile (D33). In the test fixture (test/fixtures/xenforo/member.html)
 * both `postCount` (Messages) and `joinedAt` (Joined) come back non-null; a style that hides the
 * counters gives null, never a guess. Errors never carry the username or its slug: both become
 * `<author>`, as in the Discourse adapter.
 */
async function authorSignals(ctx: ExtractContext, author: { username: string; profileUrl: string | null }): Promise<AuthorSignals> {
  const username = author.username.trim();
  if (username === '') throw new LurkdError('invalid_request', 'An author lookup needs a username.', { sourceId: ctx.source.id });
  if (author.profileUrl === null) {
    throw new LurkdError('invalid_request', 'An author lookup on a XenForo source needs the profile URL of the author.', { sourceId: ctx.source.id });
  }
  const slug = slugOf(author.profileUrl);
  try {
    return await lookupAuthor(ctx, profileTarget(author.profileUrl));
  } catch (e) {
    const scrubbed = withoutAuthor(e, username);
    throw slug !== null && slug.toLowerCase() !== username.toLowerCase() ? withoutAuthor(scrubbed, slug) : scrubbed;
  }
}

async function lookupAuthor(ctx: ExtractContext, url: string): Promise<AuthorSignals> {
  const { reader, source } = ctx;
  if (!isAllowedHost(source, url)) {
    throw new LurkdError('off_domain', `The profile address is on another host, which is not a domain of ${source.id} (${source.domains.join(', ')}).`, {
      url,
      sourceId: source.id,
      domains: source.domains,
    });
  }
  const nav = await reader.open(url);
  if (nav.status !== null && GONE.has(nav.status)) {
    throw new LurkdError('not_found', `${source.name} has no public profile for this author (HTTP ${nav.status}).`, { sourceId: source.id, status: nav.status });
  }
  const member = parseMemberPage(await pageHtml(reader));
  if (member.header) return member.signals;
  if (member.isError) {
    throw new LurkdError('not_found', `${source.name} has no public profile for this author.`, { sourceId: source.id });
  }
  throw new LurkdError('extraction_failed', `${source.name} did not show a member header (.memberHeader) for this author.`, { sourceId: source.id });
}

export const xenforoAdapter: EngineAdapter = {
  engine: 'xenforo',
  canSearch,
  canonicalUrl: threadOf,
  search,
  fetchThread,
  checkSession,
  authorSignals,
};
