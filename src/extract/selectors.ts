import crypto from 'node:crypto';
import { parseHTML } from 'linkedom';
import { errors } from 'playwright';
import type { PageReader } from '../browser/reader.js';
import { LurkdError } from '../errors.js';
import { deniedBy, hasThreadPattern, isAllowedHost, isThreadPath } from '../policy/urls.js';
import { NAME_CLOSE, NAME_OPEN, stripMarkers } from '../pseudonym.js';
import type { Selectors, SourceConfig } from '../sources/schema.js';
import type { AuthorSignals, ExtractedPost, ExtractedThread, SearchHit } from '../types.js';
import type { EngineAdapter, ExtractContext } from './engine.js';
import { makeConverter } from './markdown.js';
import { boundedDocument, costlySelector } from './bounds.js';
import { takeQuoteHeader } from './quote-header.js';
import { PAGE_DEADLINE_MS, runPageTask, type ThreadPageResult } from './page-worker.js';
import { namesAuthor } from './scrub.js';

// Declarative selectors (D15): a source names the CSS selectors of its pages and lurkd reads them,
// with no code from the source. Every request goes through `ctx.reader` (URL policy, run limits,
// fetch log, block detection). One `reader.evaluate` per page reads the HTML with string code; the
// selectors then run in Node on a linkedom copy of it, so no page script runs the extraction.
//
// Selectors may come from a YAML file an agent drafted (Task 13), so they are untrusted input:
// every one runs through `select`/`selectAll`, which turn an invalid or overlong selector into
// `extraction_failed` naming the selector key, the posts per page and the text per field are
// capped, and the author text is a real username that only ever goes to `author`. Pages over the
// bounds of src/extract/bounds.ts, and selectors it calls costly, are refused before they run.
// The adapters read each page in a page worker with a 3 s deadline (src/extract/page-worker.ts),
// since no static rule bounds css-select; the exported parse functions themselves stay synchronous.
//
// The search, session check and author lookup here serve both the custom and the generic adapter.

/** Posts read from one page at most; the rest of the page is ignored. */
export const MAX_POSTS_PER_PAGE = 500;
/** Search hits read from one results page at most. */
const MAX_HITS = 500;
/** A selector longer than this is refused before it runs. */
const MAX_SELECTOR = 1_000;
const MAX_AUTHOR = 100;
const MAX_SIGNAL = 200;
const MAX_DATE = 100;
const MAX_TITLE = 300;
/** A post body longer than this, in Markdown, is cut. */
export const MAX_BODY_MD = 100_000;

const PAGE_HTML = 'document.documentElement.outerHTML';
/** How long `checkSession` waits for its selector after the page settled: a menu may arrive late. */
const SESSION_WAIT_MS = 3_000;
/** Statuses that mean the thread is gone, whatever the page shows. */
const GONE: ReadonlySet<number> = new Set([404, 410]);
const LINK = 'a[href]';

/** Where a selector comes from in the source file, as error messages name it. */
type SelectorKey = `selectors.${keyof Selectors}` | 'session_check.logged_in_selector';

/** The selectors a thread page uses, in the order they are checked. */
const THREAD_KEYS = ['title', 'post', 'author', 'author_signals', 'date', 'body', 'quote', 'next_page'] as const satisfies readonly (keyof Selectors)[];

/** One post as the page shows it, before conversion. */
export interface RawSelectorPost {
  /** The real username: the trimmed text of the `author` match, at most 100 characters. */
  author: string;
  /** Absolute URL of the link around or inside the `author` match, or null. */
  authorHref: string | null;
  /** The `author_signals` text, collapsed to one line of at most 200 characters, or null. */
  signal: string | null;
  /** The `datetime` attribute of the `date` match (or of an element inside it), else its text. */
  date: string | null;
  /** The body HTML: quotes turned into `<blockquote>`, the author, signals and date taken out. */
  html: string;
}

export interface SelectorPage {
  title: string;
  posts: RawSelectorPost[];
  /** Absolute URL of the `next_page` link, or null. */
  next: string | null;
}

type Doc = Document;
type Root = Document | Element;

/** Free text from the page: no name markers, one line, at most `max` characters. */
function clean(s: string | null | undefined, max: number): string {
  return stripMarkers(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

const collapse = (s: string | null | undefined): string => stripMarkers(s ?? '').replace(/\s+/g, ' ').trim();

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

/** The key a page is remembered under: without fragment, query parameters sorted (`?b=1&a=2` is `?a=2&b=1`). */
export function pageKey(url: string): string {
  const u = new URL(url);
  u.hash = '';
  u.searchParams.sort();
  return u.href;
}

function withoutHash(url: string): string {
  const u = new URL(url);
  u.hash = '';
  return u.href;
}

function iso(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * A URL for an error message without its query and fragment: they may carry a username, and
 * errors reach the agent.
 */
export function shownUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(not a URL)';
  }
}

function selectorError(source: SourceConfig, key: SelectorKey, selector: string, why: string): LurkdError {
  const shown = JSON.stringify(selector.length > 80 ? `${selector.slice(0, 77)}...` : selector);
  return new LurkdError('extraction_failed', `The selector ${key} of ${source.id} (${shown}) ${why}. Fix it in the source file.`, {
    sourceId: source.id,
    selector: key,
  });
}

/** Throws `extraction_failed` naming `key` unless `selector` is a CSS selector lurkd can run. */
export function checkSelector(source: SourceConfig, key: SelectorKey, selector: string): void {
  selectAll(source, parse('<p></p>'), key, selector, 1);
  const costly = costlySelector(selector);
  if (costly !== null) throw selectorError(source, key, selector, `${costly}, which can take minutes on a large page`);
}

function selectAll(source: SourceConfig, root: Root, key: SelectorKey, selector: string, cap: number): Element[] {
  if (selector.length > MAX_SELECTOR) throw selectorError(source, key, selector, `is longer than ${MAX_SELECTOR} characters`);
  let found: Element[];
  try {
    found = Array.from(root.querySelectorAll(selector));
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.trim();
    throw selectorError(source, key, selector, `is not a CSS selector lurkd can run (${why})`);
  }
  return found.length > cap ? found.slice(0, cap) : found;
}

function select(source: SourceConfig, root: Root, key: SelectorKey, selector: string | undefined): Element | null {
  return selector === undefined ? null : (selectAll(source, root, key, selector, 1)[0] ?? null);
}

/** The link an element stands for: itself, a link inside it, or the link around it. */
function linkOf(el: Element): Element | null {
  if (el.matches(LINK)) return el;
  return el.querySelector(LINK) ?? el.closest(LINK);
}

/** The child indexes from `ancestor` down to `el`, or null when `el` is not inside `ancestor`. */
function pathFrom(ancestor: Element, el: Element): number[] | null {
  const path: number[] = [];
  let node: Element | null = el;
  while (node !== null && node !== ancestor) {
    const parent: Element | null = node.parentElement;
    if (parent === null) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  return node === ancestor && path.length > 0 ? path : null;
}

function follow(root: Element, path: readonly number[]): Element | null {
  let node: Element | null = root;
  for (const i of path) node = node?.children[i] ?? null;
  return node;
}

/** Text of `el` with its text nodes joined by spaces, so `<b>alice</b><i>Moderator</i>` reads "alice Moderator". */
function spacedText(el: Element): string {
  const parts: string[] = [];
  const stack: Node[] = [el];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.nodeType === 3) parts.push((n as Text).data);
    else if (n.nodeType === 1) for (const c of Array.from(n.childNodes).reverse()) stack.push(c);
  }
  return parts.join(' ');
}

/** A copy of `root` without the elements in `drop` that lie inside it. */
function copyWithout(root: Element, drop: readonly (Element | null)[]): Element {
  const paths = drop.flatMap((el) => (el === null ? [] : [pathFrom(root, el)])).filter((p): p is number[] => p !== null);
  const copy = root.cloneNode(true) as Element;
  for (const el of paths.map((p) => follow(copy, p))) el?.remove();
  return copy;
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The forms of the author's name a signal, an avatar or a body must not carry: the author text,
 * and the last path segment of the profile URL with its dash-to-space form, also without a
 * leading or trailing numeric id (`/user/alice-smith.77`, `/members/3-bob`). A segment that is
 * only digits or a script name (`memberlist.php`) names nobody.
 */
export function authorForms(author: string, profileUrl: string | null): string[] {
  const forms = [author];
  if (profileUrl !== null) {
    try {
      const seg = decodeSegment(new URL(profileUrl).pathname.replace(/\/+$/, '').split('/').pop() ?? '');
      if (seg !== '' && !/^\d+$/.test(seg) && !/\.(?:php|html?|aspx?|jsp|cgi|pl)$/i.test(seg)) {
        const bare = seg.replace(/^\d+[-.]/, '').replace(/[-.]\d+$/, '');
        for (const f of [seg, bare]) if (f !== '') forms.push(f, f.replace(/-/g, ' '));
      }
    } catch {
      // not a URL: the author text is the only form
    }
  }
  return [...new Set(forms.map((f) => f.trim()).filter((f) => f !== ''))];
}

/**
 * True when `href` points at the author's profile or a page under it: the same host and path, or
 * a path below it. A profile that a query identifies (`memberlist.php?mode=viewprofile&u=3`)
 * matches only a link with the same path and the same values for those parameters, so other
 * members' profile links stay.
 */
function isProfileLink(href: string, profile: URL): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.host !== profile.host) return false;
  const path = u.pathname.replace(/\/+$/, '');
  const base = profile.pathname.replace(/\/+$/, '');
  if ([...profile.searchParams.keys()].length > 0) {
    return path === base && [...profile.searchParams].every(([k, v]) => u.searchParams.get(k) === v);
  }
  if (base === '') return path === base && u.search === profile.search;
  return path === base || path.startsWith(`${base}/`);
}

interface ReadPost {
  raw: RawSelectorPost;
  /** The author element and the profile link around it (`nameEl`), as far as they exist. */
  nameEls: Element[];
}

function readPost(source: SourceConfig, post: Element, pageUrl: string, sel: Selectors): ReadPost {
  const authorEl = select(source, post, 'selectors.author', sel.author);
  const signalEl = select(source, post, 'selectors.author_signals', sel.author_signals);
  const dateEl = select(source, post, 'selectors.date', sel.date);
  let link = authorEl === null ? null : linkOf(authorEl);
  if (link !== null && link !== post && !post.contains(link)) link = null;
  const author = clean(authorEl?.textContent, MAX_AUTHOR);
  const authorHref = absolute(link?.getAttribute('href'), pageUrl);
  const forms = author === '' ? [] : authorForms(author, authorHref);
  // The author's name with the profile link around it, unless that link is the whole post.
  const nameEl = link !== null && authorEl !== null && link !== post && link.contains(authorEl) ? link : authorEl;
  const inName = (el: Element | null) => el !== null && nameEl !== null && (el === nameEl || nameEl.contains(el));

  // Signals: the element without the name, its link and the date; dropped when it names the author.
  let signal: string | null = null;
  if (signalEl !== null && !inName(signalEl) && !(authorEl !== null && (signalEl === authorEl || authorEl.contains(signalEl)))) {
    const text = clean(spacedText(copyWithout(signalEl, [nameEl, dateEl])), MAX_SIGNAL);
    signal = text !== '' && !(forms.length > 0 && namesAuthor(text, forms)) ? text : null;
  }

  // A text date counts only with a four-digit year: "2 Oct" or a name is no date.
  const datetime = dateEl?.getAttribute('datetime') ?? dateEl?.querySelector('[datetime]')?.getAttribute('datetime') ?? null;
  const dateText = clean(dateEl?.textContent, MAX_DATE);
  const date = datetime !== null ? clean(datetime, MAX_DATE) || null : /\b\d{4}\b/.test(dateText) ? dateText : null;

  const bodyEl = sel.body === undefined ? post : select(source, post, 'selectors.body', sel.body);
  // A body that is the author's name (or its link), or lies inside it, would be the username; a
  // body around the author is fine, the name is taken out of it below.
  if (bodyEl !== null && sel.body !== undefined && [authorEl, nameEl].some((el) => el !== null && (bodyEl === el || el.contains(bodyEl)))) {
    throw selectorError(source, 'selectors.body', sel.body, "matches the author element or its link, or an element inside them, so the body would be the username");
  }
  let html = '';
  if (bodyEl !== null) {
    // The author's name, its profile link, the signals and the date are no post text: they are
    // taken out of the copy, so the default body (the whole post) does not repeat the username.
    const copy = copyWithout(bodyEl, [nameEl, signalEl, dateEl]);
    // The author's avatar (alt, title or file name) and other links to the author's profile
    // would repeat the username unmarked, since no converter rule knows this forum's profile URLs.
    if (forms.length > 0) {
      for (const img of Array.from(copy.querySelectorAll('img'))) {
        if (['alt', 'title', 'src'].some((a) => namesAuthor(img.getAttribute(a) ?? '', forms))) img.remove();
      }
    }
    if (authorHref !== null) {
      const profile = new URL(authorHref);
      for (const a of Array.from(copy.querySelectorAll(LINK))) {
        const href = absolute(a.getAttribute('href'), pageUrl);
        if (href !== null && isProfileLink(href, profile)) a.remove();
      }
    }
    if (sel.quote !== undefined) {
      const quoteSel = sel.quote;
      const doc = copy.ownerDocument;
      const isQuote = (el: Element) => el.matches(quoteSel);
      // In document order: an outer quote is rebuilt before the quotes inside it.
      for (const q of selectAll(source, copy, 'selectors.quote', quoteSel, Number.MAX_SAFE_INTEGER)) {
        const quotedName = takeQuoteHeader(q, isQuote);
        const bq = doc.createElement('blockquote');
        let target: Element = bq;
        if (quotedName !== null && collapse(q.textContent) === '' && q.querySelector('img, video, audio, picture') === null) {
          // Only the header was there: an empty quote would vanish, so it keeps one line naming
          // the author through the converter's mention rule, which marks the name.
          const line = doc.createElement('p');
          const mention = doc.createElement('span');
          mention.setAttribute('class', 'mention');
          mention.setAttribute('data-username', quotedName);
          // Text too: Turndown skips an empty element before any rule sees it.
          mention.textContent = quotedName;
          line.appendChild(mention);
          line.appendChild(doc.createTextNode(' wrote:'));
          q.appendChild(line);
        } else if (quotedName !== null) {
          // The converter's quote rule (data-quote) writes the marked header "<name> wrote:" (D34).
          bq.setAttribute('class', 'bbCodeBlock--quote');
          bq.setAttribute('data-quote', quotedName);
          target = doc.createElement('div');
          target.setAttribute('class', 'bbCodeBlock-content');
          bq.appendChild(target);
        }
        while (q.firstChild) target.appendChild(q.firstChild);
        q.replaceWith(bq);
      }
    }
    html = copy.innerHTML;
  }
  return { raw: { author, authorHref, signal, date, html }, nameEls: [authorEl, nameEl].filter((el): el is Element => el !== null) };
}

/** Top-level matches only (a post quoted inside another is part of its body), at most `cap`, without re-running the selector per match. */
function topLevel(matches: readonly Element[], cap: number): Element[] {
  const all = new Set(matches);
  const top: Element[] = [];
  for (const el of matches) {
    if (top.length >= cap) break;
    let up = el.parentElement;
    while (up !== null && !all.has(up)) up = up.parentElement;
    if (up === null) top.push(el);
  }
  return top;
}

/**
 * Reads one thread page with the source's selectors. Only top-level `post` matches count, at
 * most `MAX_POSTS_PER_PAGE`. `pageUrl` resolves relative links. Throws `extraction_failed` for a
 * page over the bounds of src/extract/bounds.ts, naming the key of a selector that cannot run or
 * that points at the author (a `body` or `title` equal to or inside the author element).
 */
export function parseSelectorPage(html: string, pageUrl: string, sel: Selectors, source: SourceConfig): SelectorPage {
  if (sel.post === undefined) {
    throw new LurkdError('extraction_failed', `${source.name} has no selectors.post, so lurkd cannot tell the posts on its pages.`, { sourceId: source.id });
  }
  for (const key of THREAD_KEYS) {
    const s = sel[key];
    if (s !== undefined) checkSelector(source, `selectors.${key}`, s);
  }
  const doc = boundedDocument(html, `The page at ${shownUrl(pageUrl)}`, { url: shownUrl(pageUrl), sourceId: source.id });
  const top = topLevel(selectAll(source, doc, 'selectors.post', sel.post, Number.MAX_SAFE_INTEGER), MAX_POSTS_PER_PAGE);
  const read = top.map((p) => readPost(source, p, pageUrl, sel));
  const titleEl = select(source, doc, 'selectors.title', sel.title);
  // A title equal to, inside or around an author's name (or its link) would show a username.
  if (titleEl !== null && sel.title !== undefined && read.some((r) => r.nameEls.some((el) => el === titleEl || el.contains(titleEl) || titleEl.contains(el)))) {
    throw selectorError(source, 'selectors.title', sel.title, 'matches an author element or its link, or an element inside or around one, so the title would show a username');
  }
  const nextEl = select(source, doc, 'selectors.next_page', sel.next_page);
  const nextLink = nextEl === null ? null : linkOf(nextEl);
  return {
    title: clean(titleEl?.textContent, MAX_TITLE) || clean(doc.querySelector('title')?.textContent, MAX_TITLE),
    posts: read.map((r) => r.raw),
    next: absolute(nextLink?.getAttribute('href'), pageUrl),
  };
}

/**
 * A Markdown body cut to `MAX_BODY_MD` characters, at a line end when one is near, and never
 * inside a marked name (an unpaired marker would leave the real name in the text). The renderer
 * closes a code fence the cut left open (`guardBody`).
 */
export function capMarkdown(md: string): string {
  if (md.length <= MAX_BODY_MD) return md;
  let cut = md.slice(0, MAX_BODY_MD);
  const nl = cut.lastIndexOf('\n');
  if (nl > MAX_BODY_MD / 2) cut = cut.slice(0, nl);
  const open = cut.lastIndexOf(NAME_OPEN);
  if (open > cut.lastIndexOf(NAME_CLOSE)) cut = cut.slice(0, open);
  return `${cut.trimEnd()}\n\n_(post cut at ${MAX_BODY_MD} characters by lurkd)_`;
}

/**
 * The posts of one parsed page, numbered on from `previous` (the last number of the earlier
 * pages), with `page <n>` in the notes. The `author_signals` text is the one signal, dropped when
 * it names the post's own author; an author link off the source's hosts is dropped.
 */
export function selectorPosts(page: SelectorPage, pageNo: number, source: SourceConfig, previous = 0, convert = makeConverter({ baseUrl: source.base_url })): ExtractedPost[] {
  return page.posts.map((p, i) => ({
    number: previous + i + 1,
    page: pageNo,
    author: p.author,
    authorUrl: p.authorHref !== null && isAllowedHost(source, p.authorHref) ? p.authorHref : null,
    signals: p.signal !== null && !(p.author !== '' && namesAuthor(p.signal, authorForms(p.author, p.authorHref))) ? [p.signal] : [],
    notes: [`page ${pageNo}`],
    postedAt: iso(p.date),
    bodyMd: capMarkdown(convert(p.html)),
  }));
}

/**
 * True when `next` stays in the thread that starts at `first`, for an engine whose thread paths
 * lurkd does not know: the same path (only the query differs), or the path plus exactly one
 * trailing segment (`/thread/42` to `/thread/42/2` or `/thread/42/page-2`). From the site root
 * (`/`) only the query may change.
 */
export function samePathOrOneSegment(first: string, next: string): boolean {
  const a = new URL(first).pathname.replace(/\/+$/, '');
  const b = new URL(next).pathname.replace(/\/+$/, '');
  if (a === b) return true;
  // A thread read from the site root may only change its query: any one-segment path is "below" it.
  if (a === '' || !b.startsWith(`${a}/`)) return false;
  const extra = b.slice(a.length + 1);
  return extra !== '' && !extra.includes('/');
}

/**
 * Where a `next_page` link leads, without its fragment, or null when lurkd stops: a link that is
 * not http(s), off the source's hosts, to a page already read (loop guard, by `pageKey`), matching a deny rule,
 * out of the thread paths of an engine whose thread paths lurkd knows, or, for any other engine,
 * away from the first page's path (`samePathOrOneSegment`). `firstUrl` is the thread's first page.
 */
export function nextSelectorPage(
  source: SourceConfig,
  firstUrl: string,
  currentUrl: string,
  href: string | null,
  visited: ReadonlySet<string>,
): string | null {
  const url = absolute(href, currentUrl);
  if (url === null || !isAllowedHost(source, url)) return null;
  const next = withoutHash(url);
  if (visited.has(pageKey(next))) return null;
  if (hasThreadPattern(source.engine) ? !isThreadPath(source, next) : !samePathOrOneSegment(firstUrl, next)) return null;
  try {
    if (deniedBy(source, next) !== null) return null;
  } catch {
    return null;
  }
  return next;
}

/** Thread links of a search results page from `thread_list`: on the source's hosts, without fragment, each once, in page order. */
export function parseThreadList(html: string, pageUrl: string, sel: Selectors, source: SourceConfig): SearchHit[] {
  if (sel.thread_list === undefined) {
    throw new LurkdError('extraction_failed', `${source.name} has no selectors.thread_list, so lurkd cannot tell the thread links on its search results.`, {
      sourceId: source.id,
    });
  }
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const doc = boundedDocument(html, `The search results at ${shownUrl(pageUrl)}`, { url: shownUrl(pageUrl), sourceId: source.id });
  for (const el of selectAll(source, doc, 'selectors.thread_list', sel.thread_list, MAX_HITS)) {
    const link = linkOf(el);
    const href = absolute(link?.getAttribute('href'), pageUrl);
    if (href === null || !isAllowedHost(source, href)) continue;
    const url = withoutHash(href);
    if (seen.has(url) || (hasThreadPattern(source.engine) && !isThreadPath(source, url))) continue;
    try {
      if (deniedBy(source, url) !== null) continue;
    } catch {
      continue;
    }
    seen.add(url);
    hits.push({ url, title: clean(el.textContent, MAX_TITLE) || url, posts: null });
  }
  return hits;
}

/** The page's HTML, through the reader: string code, bounded by the page timeout. */
export async function pageHtml(reader: PageReader): Promise<string> {
  const html = await reader.evaluate<unknown>(PAGE_HTML);
  return typeof html === 'string' ? html : '';
}

/**
 * The URL a page of a generic or custom source is read from and stored under: the URL without
 * its fragment (the query stays: it may name the thread). Throws `off_domain` for another host or
 * a scheme other than http(s), and `invalid_request` for a page outside the thread paths of an
 * engine whose thread paths lurkd knows.
 */
export function pageThreadUrl(source: SourceConfig, url: string): string {
  if (!isAllowedHost(source, url)) {
    throw new LurkdError('off_domain', `${shownUrl(url)} is not on a domain of ${source.id} (${source.domains.join(', ')}).`, {
      url: shownUrl(url),
      sourceId: source.id,
      domains: source.domains,
    });
  }
  const canonical = withoutHash(url);
  if (hasThreadPattern(source.engine) && !isThreadPath(source, canonical)) {
    throw new LurkdError('invalid_request', `Not a thread URL of ${source.id}: ${shownUrl(url)}`, { url: shownUrl(url), sourceId: source.id });
  }
  return canonical;
}

/** The URL to store a thread under after the first page loaded: the final URL when it still qualifies, else `thread`. */
export function landedUrl(source: SourceConfig, thread: string, finalUrl: string): string {
  try {
    return pageThreadUrl(source, finalUrl);
  } catch {
    return thread;
  }
}

/** A fingerprint of a page's posts: a page that repeats one already read ends the read. */
export function pageFingerprint(posts: readonly RawSelectorPost[]): string {
  const h = crypto.createHash('sha256');
  for (const p of posts) h.update(`${p.author}\n${p.date ?? ''}\n${p.html}\n\u0000`);
  return h.digest('hex');
}

/** The selector keys a page read uses, for the message when it takes too long. */
function keysOf(sel: Selectors, keys: readonly (keyof Selectors)[]): string[] {
  return keys.filter((k) => sel[k] !== undefined).map((k) => `selectors.${k}`);
}

function tooLong(source: SourceConfig, pageUrl: string, keys: readonly string[]): LurkdError {
  return new LurkdError(
    'extraction_failed',
    `Reading ${shownUrl(pageUrl)} with ${keys.join(', ')} of ${source.id} took too long (over ${PAGE_DEADLINE_MS / 1000} s), so lurkd stopped it; one of these selectors may be too costly for this page.`,
    { url: shownUrl(pageUrl), sourceId: source.id, selectors: [...keys] },
  );
}

/**
 * `parseSelectorPage` and `selectorPosts` for one page, in a page worker with the
 * `PAGE_DEADLINE_MS` deadline (src/extract/page-worker.ts).
 */
export function readThreadPage(source: SourceConfig, html: string, pageUrl: string, sel: Selectors, pageNo: number, previous: number): Promise<ThreadPageResult> {
  return runPageTask({ kind: 'thread', html, pageUrl, sel, source, pageNo, previous }, () => tooLong(source, pageUrl, keysOf(sel, THREAD_KEYS)));
}

/** `parseThreadList` in a page worker with the `PAGE_DEADLINE_MS` deadline. */
export function readThreadList(source: SourceConfig, html: string, pageUrl: string, sel: Selectors): Promise<SearchHit[]> {
  return runPageTask({ kind: 'list', html, pageUrl, sel, source }, () => tooLong(source, pageUrl, keysOf(sel, ['thread_list'])));
}

/**
 * Reads a thread with `sel`: one navigation and one `evaluate` per page, following `next_page`
 * up to `pagination.max_pages_per_thread`, never to another host, never to a page already read.
 * Posts are numbered 1..n across pages and carry `page <n>` in their notes.
 */
export async function extractWithSelectors(ctx: ExtractContext, url: string, sel: Selectors): Promise<ExtractedThread> {
  const { reader, source } = ctx;
  let thread = pageThreadUrl(source, url);
  if (sel.post === undefined) {
    throw new LurkdError('extraction_failed', `${source.name} has no selectors.post, so lurkd cannot tell the posts on its pages.`, { sourceId: source.id });
  }
  // A selector that cannot run fails before the first request.
  for (const key of THREAD_KEYS) {
    const s = sel[key];
    if (s !== undefined) checkSelector(source, `selectors.${key}`, s);
  }
  const maxPages = source.pagination.max_pages_per_thread;
  const posts: ExtractedPost[] = [];
  const visited = new Set<string>();
  const seenPages = new Set<string>();
  let title = '';
  let read = 0;
  let target: string | null = thread;

  while (target !== null && read < maxPages) {
    visited.add(pageKey(target));
    const nav = await reader.open(target);
    if (nav.status !== null && GONE.has(nav.status)) {
      if (read === 0) {
        throw new LurkdError('not_found', `${source.name} has no thread at ${shownUrl(thread)} (HTTP ${nav.status}).`, { url: shownUrl(thread), sourceId: source.id, status: nav.status });
      }
      break;
    }
    const finalUrl = withoutHash(nav.finalUrl);
    if (read === 0) thread = landedUrl(source, thread, finalUrl);
    // A later page that redirected out of the thread (another thread, the forum index): stop,
    // keep the pages read, never mix threads.
    else if (hasThreadPattern(source.engine) ? !isThreadPath(source, finalUrl) : !samePathOrOneSegment(thread, finalUrl)) break;
    visited.add(pageKey(finalUrl));
    const page = await readThreadPage(source, await pageHtml(reader), finalUrl, sel, read + 1, posts.length);
    if (page.posts.length === 0) {
      if (read === 0) {
        throw new LurkdError(
          'extraction_failed',
          `${source.name} shows no posts matching selectors.post (${JSON.stringify(sel.post.slice(0, 80))}) at ${shownUrl(thread)}; the selectors may not fit this page.`,
          { url: shownUrl(thread), sourceId: source.id, selector: 'selectors.post' },
        );
      }
      break;
    }
    if (seenPages.has(page.fingerprint)) break;
    seenPages.add(page.fingerprint);
    read++;
    posts.push(...page.posts);
    title ||= page.title;
    ctx.onProgress({ postsFetched: posts.length, page: read });
    target = nextSelectorPage(source, thread, finalUrl, page.next, visited);
  }

  return {
    url: thread,
    title: title || thread,
    engine: source.engine,
    postsExpected: null,
    pages: read,
    extraction: `selectors (${read} ${read === 1 ? 'page' : 'pages'})`,
    quality: 'full',
    posts,
  };
}

/**
 * Search reads its hits through `selectors.thread_list`, so it needs `thread_list` together with
 * a GET `search_url` or with the D14 form (`search_form`, `search_input` and a read endpoint), as
 * Registry.canSearch says.
 */
export function canSearchWithSelectors(source: SourceConfig): boolean {
  const sel = source.selectors;
  if (sel?.thread_list === undefined) return false;
  if (source.search_url !== null) return true;
  return sel.search_form !== undefined && sel.search_input !== undefined && source.read_endpoints.length > 0;
}

/**
 * GET `search_url` with `{query}` URL-encoded, or open `base_url` and submit the D14 form there;
 * then the links of `thread_list`, the first `limit`.
 */
export async function selectorSearch(ctx: ExtractContext, query: string, limit: number): Promise<SearchHit[]> {
  const { reader, source } = ctx;
  if (!canSearchWithSelectors(source)) {
    const why =
      source.selectors?.thread_list === undefined
        ? 'has no selectors.thread_list to read the result links with'
        : 'has no search_url and no search form with a read endpoint (selectors.search_form, selectors.search_input and read_endpoints)';
    throw new LurkdError('search_unsupported', `${source.name} ${why}, so lurkd cannot search it.`, { sourceId: source.id });
  }
  const sel = source.selectors!;
  const list = sel.thread_list!;
  checkSelector(source, 'selectors.thread_list', list);
  if (source.search_url !== null) {
    await reader.open(source.search_url.replaceAll('{query}', encodeURIComponent(query)));
  } else {
    const form = sel.search_form!;
    const input = sel.search_input!;
    checkSelector(source, 'selectors.search_form', form);
    checkSelector(source, 'selectors.search_input', input);
    await reader.open(source.base_url);
    // `css=` keeps Playwright to its CSS engine whatever the source file says.
    await reader.submitSearch({ formSelector: `css=${form}`, inputSelector: `css=${input}` }, query);
  }
  const hits = await readThreadList(source, await pageHtml(reader), reader.page.url(), sel);
  const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return hits.slice(0, n);
}

/**
 * Opens `session_check.url` and looks for a visible `logged_in_selector` through a Playwright
 * locator (utility world, out of reach of page scripts), waiting up to `SESSION_WAIT_MS` for a
 * menu inserted after load. False without a `session_check`, with no request; a login wall is false.
 */
export async function selectorSession(ctx: ExtractContext): Promise<boolean> {
  const { reader, source } = ctx;
  const check = source.session_check;
  if (check === null) return false;
  checkSelector(source, 'session_check.logged_in_selector', check.logged_in_selector);
  try {
    await reader.open(check.url);
  } catch (e) {
    if (e instanceof LurkdError && e.code === 'needs_login') return false;
    throw e;
  }
  const target = reader.page.locator(`css=${check.logged_in_selector}`).filter({ visible: true }).first();
  try {
    await target.waitFor({ state: 'visible', timeout: SESSION_WAIT_MS });
    return true;
  } catch (e) {
    if (e instanceof errors.TimeoutError) return false;
    const message = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.trim();
    throw new LurkdError('extraction_failed', `The session check on ${source.name} (session_check.logged_in_selector) failed in the browser.`, {
      sourceId: source.id,
      selector: 'session_check.logged_in_selector',
      error: message,
    });
  }
}

/** Sources without a known engine have no profile pages lurkd can read (D33). */
export async function noAuthorLookup(ctx: ExtractContext): Promise<AuthorSignals> {
  throw new LurkdError('invalid_request', `Author lookup is not available for ${ctx.source.engine} sources.`, { sourceId: ctx.source.id });
}

export const customAdapter: EngineAdapter = {
  engine: 'custom',
  canSearch: canSearchWithSelectors,
  canonicalUrl: pageThreadUrl,
  search: selectorSearch,
  fetchThread: (ctx, url) => extractWithSelectors(ctx, url, ctx.source.selectors ?? {}),
  checkSession: selectorSession,
  authorSignals: noAuthorLookup,
};
