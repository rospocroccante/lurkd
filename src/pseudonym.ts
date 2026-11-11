import crypto from 'node:crypto';
import { codeUnits, fromCodeUnits, UNIT_LOOP_MIN } from './units.js';

// Names in structural positions (quote headers, mentions, profile links, post link
// titles) are stored between two private-use characters, so the real name can be
// rendered as a pseudonym or kept, at read time. Forum text never carries these
// characters: the converter strips them from its input.
export const NAME_OPEN = '';
export const NAME_CLOSE = '';

const MARKERS = /[]/gu;

// D20: `author-` and the first 10 hex characters of SHA-256 over salt, source id and
// the trimmed, lowercased username (Discourse and XenForo names are case-insensitive).
export function pseudonym(sourceId: string, username: string, salt: string): string {
  const digest = crypto.hash('sha256', `${salt}\n${sourceId}\n${username.trim().toLowerCase()}`, 'hex');
  return `author-${digest.slice(0, 10)}`;
}

/** How many names a memoised name function keeps; past this it works each new name out again. */
export const MAX_MEMO_NAMES = 200_000;
const MEMOISED = new WeakSet<(username: string) => string>();

/**
 * `nameFor` with what it worked out kept, so a name mentioned a million times is hashed once. The
 * map is bounded by MAX_MEMO_NAMES; a function memoised already is returned as it is.
 */
export function memoNames(nameFor: (username: string) => string): (username: string) => string {
  if (MEMOISED.has(nameFor)) return nameFor;
  const kept = new Map<string, string>();
  const memo = (username: string): string => {
    let name = kept.get(username);
    if (name === undefined) {
      name = nameFor(username);
      if (kept.size < MAX_MEMO_NAMES) kept.set(username, name);
    }
    return name;
  };
  MEMOISED.add(memo);
  return memo;
}

export function stripMarkers(text: string): string {
  return text.replace(MARKERS, '');
}

export function markName(username: string): string {
  const clean = stripMarkers(username).trim().replace(/^@/, '').trim();
  return `${NAME_OPEN}${clean}${NAME_CLOSE}`;
}

/**
 * Calls `visit` with each marked name in text, in order, empty marks included, until it returns
 * false. A mark is an open marker followed by a close marker with no marker between; the scan is
 * linear in the length of the text, however the markers are placed.
 */
function scanMarks(text: string, visit: (name: string, open: number, close: number) => boolean): void {
  let open = text.indexOf(NAME_OPEN);
  let close = open < 0 ? -1 : text.indexOf(NAME_CLOSE, open + 1);
  while (open >= 0 && close >= 0) {
    const next = text.indexOf(NAME_OPEN, open + 1);
    if (next < 0 || close < next) {
      if (!visit(text.slice(open + 1, close), open, close)) return;
      open = next;
      if (open >= 0 && close < open) close = text.indexOf(NAME_CLOSE, open + 1);
    } else {
      open = next;
    }
  }
}

const OPEN_UNIT = 0xe000;
const CLOSE_UNIT = 0xe001;

/** A replacement without markers, tested before it is stripped: the strip is a replace. */
const unmarked = (s: string): string => (s.indexOf(NAME_OPEN) < 0 && s.indexOf(NAME_CLOSE) < 0 ? s : stripMarkers(s));

// Replaces every marked name with nameFor(name) and drops any unpaired marker. Callers that render
// many names pass a memoised nameFor (memoNames). A long text is rewritten through its code units,
// and a mark that repeats the name before it reuses that name's replacement without a lookup.
export function renderNames(text: string, nameFor: (username: string) => string): string {
  if (text.indexOf(NAME_OPEN) < 0 && text.indexOf(NAME_CLOSE) < 0) return text;
  if (text.length >= UNIT_LOOP_MIN) return renderNamesInUnits(text, nameFor);
  const parts: string[] = [];
  let last = 0;
  scanMarks(text, (name, open, close) => {
    parts.push(text.slice(last, open), unmarked(nameFor(name)));
    last = close + 1;
    return true;
  });
  parts.push(text.slice(last));
  return stripMarkers(parts.join(''));
}

function renderNamesInUnits(text: string, nameFor: (username: string) => string): string {
  const u = codeUnits(text);
  const n = u.length;
  let out = new Uint16Array(n + 1024);
  let w = 0;
  let prevStart = -1;
  let prevLen = -1;
  let prev = '';
  for (let r = 0; r < n; ) {
    const c = u[r]!;
    if (c === CLOSE_UNIT) {
      r += 1; // an unpaired close marker is dropped
      continue;
    }
    if (c !== OPEN_UNIT) {
      out[w++] = c;
      r += 1;
      continue;
    }
    let k = r + 1;
    while (k < n && u[k] !== OPEN_UNIT && u[k] !== CLOSE_UNIT) k += 1;
    if (k >= n || u[k] !== CLOSE_UNIT) {
      r += 1; // an unpaired open marker is dropped; the text after it is copied
      continue;
    }
    const len = k - r - 1;
    let same = len === prevLen;
    for (let i = 0; same && i < len; i++) same = u[prevStart + i] === u[r + 1 + i];
    const rep = same ? prev : unmarked(nameFor(text.slice(r + 1, k)));
    // u is only read, never written, so the previous name's units are still there to compare.
    prevStart = r + 1;
    prevLen = len;
    prev = rep;
    if (w + rep.length > out.length - (n - k)) {
      const grown = new Uint16Array(Math.max(out.length * 2, w + rep.length + (n - k) + 1024));
      grown.set(out.subarray(0, w));
      out = grown;
    }
    for (let i = 0; i < rep.length; i++) out[w++] = rep.charCodeAt(i);
    r = k + 1;
  }
  return fromCodeUnits(out, w);
}

/** Calls `visit` with each non-empty marked name in text, in order, until it returns false. */
export function eachName(text: string, visit: (name: string) => boolean): void {
  scanMarks(text, (name) => name === '' || visit(name));
}

/**
 * The marked names in text, each once, in order of first appearance; empty marks are skipped.
 * With `limit`, the scan stops once that many names are found.
 */
export function namesIn(text: string, limit = Number.POSITIVE_INFINITY): string[] {
  const seen = new Set<string>();
  if (limit <= 0) return [];
  scanMarks(text, (name) => {
    if (name) seen.add(name);
    return seen.size < limit;
  });
  return [...seen];
}

// Counts whole-word, case-insensitive occurrences of real names in the output.
export function findLeaks(markdown: string, names: Iterable<string>): Map<string, number> {
  const hits = new Map<string, number>();
  for (const name of names) {
    if (name.length < 3) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'giu');
    const count = [...markdown.matchAll(re)].length;
    if (count > 0) hits.set(name, count);
  }
  return hits;
}
