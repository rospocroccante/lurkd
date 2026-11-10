import { LurkdError } from '../errors.js';
import type { SourceConfig } from '../sources/schema.js';
import type { Engine } from '../types.js';

// URL policy for one source: which hosts the browser may reach, which paths it must never open,
// and which POSTs count as read-only searches (D5, D14). Every check fails closed.
//
// The subject of a path rule is `pathname + search` of the URL, never the fragment.
// A rule without "/" is a segment word: the subject is split on / \ ? & = ; and each segment is
// percent-decoded (and split again), then compared case-insensitively for equality, both as it is
// and with one trailing letters-only extension dropped (`ucp.php` also gives `ucp`, `x.55` stays).
// A `*` inside a word matches any run of characters within the segment.
// A rule starting with "/" is a glob over the whole subject: `*` within a segment, `**` across segments.

/**
 * Words that name a state-changing action. They are deny rules for every source (`BUILTIN_DENY`)
 * and may not appear as a segment of a read endpoint (`WRITE_WORDS` in the schema is this list).
 */
export const BUILTIN_DENY: readonly string[] = Object.freeze([
  'logout', 'log-out', 'signout', 'sign-out', 'delete', 'destroy', 'subscribe', 'unsubscribe', 'vote', 'report',
  'flag', 'like', 'react', 'reply', 'edit', 'bookmark', 'watch', 'follow', 'mute', 'ignore', 'upload', 'compose',
]);

const SEPARATORS = /[/\\?&=;]/;
const QUERY_SEPARATORS = /[&;]/;

// Thread paths per engine, relative to the base path of `base_url`. The built-in write words never
// apply to them (ruling C9), so `/t/report/77` stays readable; the source's own deny rules still do.
// `queryRoute`: the same route may sit in the query after `/index.php?` (XenForo without friendly URLs).
// A path counts only when it still fits after percent-decoding, so a slug cannot hide "%2F".
const THREAD_PATHS: Partial<Record<Engine, { pattern: RegExp; queryRoute: boolean }>> = {
  // /t/<slug>/<id>, with an optional post number and an optional .json
  discourse: { pattern: /^\/t\/[^/\\]+\/\d+(?:\/\d+)?(?:\.json)?\/?$/, queryRoute: false },
  // /threads/<slug>.<id>/, with an optional page-<n>
  xenforo: { pattern: /^\/threads\/[^/\\]+\.\d+(?:\/(?:page-\d+\/?)?)?$/, queryRoute: true },
};

function parseAbsolute(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // One invalid escape must not switch decoding off: reveal every single-byte pair (%2F, %5C, %6C...)
    // and leave the bytes of broken multi-byte sequences as they are.
    return s.replace(/%[0-7][0-9A-Fa-f]/g, (pair) => String.fromCharCode(parseInt(pair.slice(1), 16)));
  }
}

/** The comparable segments of one or more subject pieces, each with its extension-less form. */
function segmentsOf(pieces: readonly string[]): string[] {
  const out: string[] = [];
  const push = (form: string) => {
    if (form === '') return;
    out.push(form);
    const bare = form.replace(/\.[A-Za-z]+$/, '');
    if (bare !== form && bare !== '') out.push(bare);
  };
  const add = (seg: string) => {
    push(seg);
    // Escapes that decode() had to leave in place do not hide a word: `logout%E0` also gives `logout`.
    const clean = seg.replace(/%[0-9A-Fa-f]{2}/g, '');
    if (clean !== seg) push(clean);
  };
  for (const piece of pieces)
    for (const raw of piece.split(SEPARATORS)) {
      const decoded = decode(raw);
      if (decoded === raw) add(raw);
      else for (const seg of decoded.split(SEPARATORS)) add(seg);
    }
  return out;
}

// Patterns compile to tokens and match in O(tokens x subject length), with no backtracking:
// rules can come from an agent's draft YAML, and a regex with many wildcards can hang the server.
// A string token is one literal UTF-16 code unit. STAR is any run without "/", ANY is any run,
// SLASH_ANY is empty or "/" followed by any run.
const STAR = 1;
const ANY = 2;
const SLASH_ANY = 3;
type Token = string | typeof STAR | typeof ANY | typeof SLASH_ANY;

function matchTokens(tokens: readonly Token[], subject: string): boolean {
  const n = subject.length;
  let reach = new Array<boolean>(n + 1).fill(false);
  reach[0] = true;
  for (const t of tokens) {
    const next = new Array<boolean>(n + 1).fill(false);
    if (t === STAR || t === ANY) {
      for (let i = 0; i <= n; i++) next[i] = reach[i]! || (i > 0 && next[i - 1]! && (t === ANY || subject[i - 1] !== '/'));
    } else if (t === SLASH_ANY) {
      let started = false;
      for (let i = 0; i <= n; i++) {
        next[i] = reach[i]! || started;
        if (reach[i] && subject[i] === '/') started = true;
      }
    } else {
      for (let i = 0; i < n; i++) if (reach[i] && subject[i] === t) next[i + 1] = true;
    }
    reach = next;
  }
  return reach[n]!;
}

/** `*` in a word matches any run of characters (a segment holds no "/" anyway). */
function wordTokens(word: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== '*') tokens.push(word[i]!);
    else if (tokens.at(-1) !== ANY) tokens.push(ANY);
  }
  return tokens;
}

/** `*` matches within a segment, `**` across segments; `/admin/**` also covers `/admin`. */
function globTokens(glob: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith('/**', i) && (i + 3 === glob.length || glob[i + 3] === '/')) {
      tokens.push(SLASH_ANY);
      i += 3;
    } else if (glob.startsWith('**', i)) {
      tokens.push(ANY);
      i += 2;
    } else if (glob[i] === '*') {
      tokens.push(STAR);
      i += 1;
    } else {
      tokens.push(glob[i]!);
      i += 1;
    }
  }
  return tokens;
}

function wordMatcher(word: string): (segment: string) => boolean {
  const w = word.toLowerCase();
  if (!w.includes('*')) return (segment) => segment.toLowerCase() === w;
  const tokens = wordTokens(w);
  return (segment) => matchTokens(tokens, segment.toLowerCase());
}

function denyGlobMatches(rule: string, u: URL): boolean {
  // Deny rules read the URL as the server will: decoded, any case, with or without the query.
  const tokens = globTokens(rule.toLowerCase());
  const subject = u.pathname + u.search;
  return [subject, u.pathname, decode(subject), decode(u.pathname)].some((v) => matchTokens(tokens, v.toLowerCase()));
}

/** The pathname relative to the base path of `base_url`, or null when it lies outside it. */
function underBase(source: SourceConfig, pathname: string): string | null {
  const basePath = (parseAbsolute(source.base_url)?.pathname ?? '/').replace(/\/+$/, '');
  if (basePath === '') return pathname;
  if (pathname === basePath) return '/';
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : null;
}

function threadRoute(source: SourceConfig, u: URL): 'path' | 'query' | null {
  const rule = THREAD_PATHS[source.engine];
  if (!rule) return null;
  const rel = underBase(source, u.pathname);
  if (rel === null) return null;
  const fits = (path: string) => rule.pattern.test(path) && rule.pattern.test(decode(path));
  if (fits(rel)) return 'path';
  if (rule.queryRoute && rel === '/index.php' && u.search.length > 1) {
    const first = u.search.slice(1).split(QUERY_SEPARATORS)[0]!;
    if (!first.includes('=') && fits(`/${first}`)) return 'query';
  }
  return null;
}

/** True when lurkd knows the thread paths of this engine, so `isThreadPath` can tell a thread from any other page. */
export function hasThreadPattern(engine: Engine): boolean {
  return THREAD_PATHS[engine] !== undefined;
}

/** True when `url` is on the source's hosts and is a thread path of its engine. */
export function isThreadPath(source: SourceConfig, url: string): boolean {
  const u = parseAbsolute(url);
  return u !== null && isAllowedHost(source, url) && threadRoute(source, u) !== null;
}

type SearchSlot =
  | { kind: 'param'; pathname: string; param: string }
  | { kind: 'segment'; segments: string[]; index: number; tokens: Token[] };

function searchSlot(source: SourceConfig): SearchSlot | null {
  if (source.search_url === null) return null;
  const mark = 'lurkdquerymark';
  const u = parseAbsolute(source.search_url.replaceAll('{query}', mark));
  if (!u) return null;
  for (const [param, value] of u.searchParams) if (value.includes(mark)) return { kind: 'param', pathname: u.pathname, param };
  const segments = u.pathname.split('/');
  const index = segments.findIndex((s) => s.includes(mark));
  if (index < 0) return null;
  return { kind: 'segment', segments, index, tokens: wordTokens(segments[index]!.toLowerCase().replaceAll('*', '').replaceAll(mark, '*')) };
}

/** Index of the path segment that holds the search terms, or -1. */
function slotSegment(slot: SearchSlot | null, pathname: string): number {
  if (slot?.kind !== 'segment') return -1;
  const segs = pathname.split('/');
  if (segs.length !== slot.segments.length) return -1;
  const fits = segs.every((s, i) => (i === slot.index ? matchTokens(slot.tokens, s.toLowerCase()) : s.toLowerCase() === slot.segments[i]!.toLowerCase()));
  return fits ? slot.index : -1;
}

function queryKey(raw: string): string {
  return decode(raw.replace(/\+/g, ' '));
}

/** The pieces of the URL the built-in write words are compared with (ruling C9). */
function writeWordPieces(source: SourceConfig, u: URL): string[] {
  const route = threadRoute(source, u);
  const slot = searchSlot(source);
  const pieces: string[] = [];
  if (route !== 'path') {
    const skip = slotSegment(slot, u.pathname);
    if (skip < 0) pieces.push(u.pathname);
    else pieces.push(...u.pathname.split('/').filter((_, i) => i !== skip));
  }
  const query = u.search.slice(1);
  if (query === '') return pieces;
  query.split(QUERY_SEPARATORS).forEach((part, i) => {
    if (i === 0 && route === 'query') return;
    const eq = part.indexOf('=');
    if (eq < 0) {
      pieces.push(part);
      return;
    }
    const key = part.slice(0, eq);
    pieces.push(key);
    const k = queryKey(key);
    const isSearchValue = k === 'q' || (slot?.kind === 'param' && k === slot.param && u.pathname === slot.pathname);
    if (!isSearchValue) pieces.push(part.slice(eq + 1));
  });
  return pieces;
}

/**
 * The first write word that a segment of `path` equals, or could match through a `*` in the segment.
 * The schema uses it to refuse read endpoints that look like writes. No exemptions apply here.
 */
export function writeWordIn(path: string): string | null {
  const segments = segmentsOf([path]);
  for (const word of BUILTIN_DENY) {
    const matches = wordMatcher(word);
    if (segments.some((seg) => matches(seg) || (/[^*]/.test(seg) && seg.includes('*') && wordMatcher(seg)(word)))) return word;
  }
  return null;
}

/** True for an absolute http(s) URL whose hostname is exactly one of the source's domains. */
export function isAllowedHost(source: SourceConfig, url: string): boolean {
  const u = parseAbsolute(url);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false;
  return source.domains.includes(u.hostname);
}

/**
 * The deny rule that refuses `url`, or null. The source's `deny_paths` come first, then `BUILTIN_DENY`.
 * Throws `invalid_request` when `url` is not an absolute URL.
 */
export function deniedBy(source: SourceConfig, url: string): string | null {
  const u = parseAbsolute(url);
  if (!u) throw new LurkdError('invalid_request', 'Not an absolute URL.');
  const all = segmentsOf([u.pathname + u.search]);
  for (const rule of source.deny_paths) {
    if (rule.startsWith('/') ? denyGlobMatches(rule, u) : all.some(wordMatcher(rule))) return rule;
  }
  const pieces = segmentsOf(writeWordPieces(source, u));
  for (const word of BUILTIN_DENY) if (pieces.some(wordMatcher(word))) return word;
  return null;
}

/**
 * True when a request is a POST to one of the source's `read_endpoints` (D14): own hosts only,
 * the endpoint glob matched case-sensitively against path plus query, and no deny rule hit.
 */
export function matchesReadEndpoint(source: SourceConfig, method: string, url: string): boolean {
  if (method !== 'POST' || !isAllowedHost(source, url)) return false;
  const u = parseAbsolute(url)!;
  const subject = u.pathname + u.search;
  const hit = source.read_endpoints.some((e) => e.method === 'POST' && matchTokens(globTokens(e.path), subject));
  return hit && deniedBy(source, url) === null;
}

/**
 * `url` as an error may show it: origin and path only, so a user name, password, query or fragment
 * the caller put in never comes back in a message or in `details`. A string that is not an http(s)
 * URL is not shown at all.
 */
export function redactUrl(url: string): string {
  const u = parseAbsolute(url);
  if (!u) return 'that address';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `a ${u.protocol} address`;
  return `${u.origin}${u.pathname}`;
}

/**
 * `url` as a message may show an address the forum chose (a redirect target, a form action, the
 * page's own address after it moved): the origin only, so no path or query text of the forum
 * reaches a line lurkd prints. The full address belongs in `details`.
 */
export function redactOrigin(url: string): string {
  const u = parseAbsolute(url);
  if (!u) return 'that address';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `a ${u.protocol} address`;
  return u.origin;
}

/**
 * An address the forum chose, for a message: the origin when its host is one of the source's own
 * (the forum can only pick a path there), "another host" otherwise, since a host name is text the
 * forum picked. The full address belongs in `details`.
 */
export function redactForumAddress(source: SourceConfig, url: string): string {
  const origin = redactOrigin(url);
  return origin.startsWith('http') && !isAllowedHost(source, url) ? 'another host' : origin;
}

/**
 * Throws `off_domain` or `denied_path` unless the browser may open `url` for this source, and
 * `invalid_request` for a URL that carries a user name or password (the browser would send them).
 * Errors name the URL through `redactUrl`, or through `redactOrigin` when `forumChosen` says the
 * forum picked the address (a form action, a request the page made): `details.url` keeps the path.
 */
export function checkNavigable(source: SourceConfig, url: string, forumChosen = false): void {
  const full = redactUrl(url);
  const shown = forumChosen ? redactForumAddress(source, url) : full;
  if (!isAllowedHost(source, url)) {
    throw new LurkdError('off_domain', `${forumChosen ? 'An address on another host' : shown} is not on a domain of ${source.id} (${source.domains.join(', ')}).`, {
      url: full,
      sourceId: source.id,
      domains: source.domains,
    });
  }
  const u = parseAbsolute(url)!;
  if (u.username !== '' || u.password !== '')
    throw new LurkdError('invalid_request', `lurkd does not open URLs that carry a user name or password (${shown}).`, { url: full, sourceId: source.id });
  const rule = deniedBy(source, url);
  if (rule !== null) {
    const which = source.deny_paths.includes(rule) ? `the deny rule "${rule}" of ${source.id}` : `the built-in deny rule "${rule}"`;
    throw new LurkdError('denied_path', `${shown} matches ${which}, so lurkd will not open it.`, { url: full, sourceId: source.id, rule });
  }
}
