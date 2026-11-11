import { memoNames, pseudonym, renderNames, stripMarkers } from '../pseudonym.js';
import type { Engine, ExtractedPost, ExtractedThread, ImportProvenance, ImportVia } from '../types.js';
import { codeUnits, fromCodeUnits } from '../units.js';

// Renders a thread to Markdown with front matter. Engine-neutral.

export interface NameMode {
  nameFor: (username: string) => string;
  label: 'pseudonyms' | 'real names';
}

const UNKNOWN_AUTHOR = 'unknown author';
/**
 * D50: the front matter line of a thread imported from a saved file. It says only what lurkd
 * knows: the content came as a file, and lurkd sent no request. Who saved the file it cannot tell.
 */
export const IMPORTED_NOTE = 'from a saved file; lurkd did not contact the site';

/** D50: the `imported_by` value of each import route. The CLI and agents share the Bearer route. */
export const IMPORTED_BY: Readonly<Record<ImportVia, string>> = { page: 'page upload', api: 'lurkd import / API' };

export function nameResolver(opts: { sourceId: string; salt: string; realNames: boolean }): NameMode {
  if (opts.realNames) {
    return { label: 'real names', nameFor: (u) => (u.trim() ? u.trim() : UNKNOWN_AUTHOR) };
  }
  // Memoised: a body may mention one name millions of times, and each pseudonym is a SHA-256.
  return { label: 'pseudonyms', nameFor: memoNames((u) => (u.trim() ? pseudonym(opts.sourceId, u, opts.salt) : UNKNOWN_AUTHOR)) };
}

export interface RenderInput {
  sourceId: string;
  url: string;
  title: string;
  engine: Engine;
  fetchedAt: string;
  postsExpected: number | null;
  pages: number | null;
  extraction: string;
  quality: 'full' | 'low';
  posts: ExtractedPost[];
  /**
   * How lurkd read the thread, when that is worth telling the reader: "read without login: the
   * session expired" (D48). Set by the fetch service for live reads only; absent or null writes no line.
   */
  note?: string | null;
  /** D50: how a thread from a saved file came in; written for engine `import` only. */
  imported?: ImportProvenance | null;
}

export function toRenderInput(sourceId: string, t: ExtractedThread, fetchedAt: string): RenderInput {
  return {
    sourceId,
    url: t.url,
    title: t.title,
    engine: t.engine,
    fetchedAt,
    postsExpected: t.postsExpected,
    pages: t.pages,
    extraction: t.extraction,
    quality: t.quality,
    posts: t.posts,
  };
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown date';
  // Cut at the T, not at a fixed width: a year beyond 9999 is written with six digits and a sign.
  const at = d.toISOString();
  const t = at.indexOf('T');
  return `${at.slice(0, t)} ${at.slice(t + 1, t + 6)} UTC`;
}

// Header and front matter values stay on one line.
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

// Defence in depth for bodies that did not come through the converter: outside
// fenced code, a line that would parse as a level 1 or 2 heading is escaped, so it
// cannot pose as the thread title or a post header; a fence left open is closed so
// it cannot swallow the next posts. Lines inside fences are code and stay as they
// are (shell and YAML comments start with "# ").
//
// One pass over the lines with indexOf and character tests, copying unchanged runs whole:
// a body of millions of short lines (headings, fences, blank lines) costs tens of milliseconds,
// where a split and a regular expression per line cost a second. Only a line whose first
// character after at most three spaces is #, ` or ~ is looked at further.
const SPACE = 0x20;
const TAB = 0x09;
const HASH = 0x23;
const BACKTICK = 0x60;
const TILDE = 0x7e;
const ONLY_SPACE = /^\s*$/;
const LINE_BREAK = /[\r\u2028\u2029]/;

export function guardBody(body: string): string {
  let fence: { char: number; len: number } | null = null;
  // Where a backslash goes, in order.
  const escapes: number[] = [];
  const n = body.length;
  for (let start = 0; start <= n; ) {
    let end = body.indexOf('\n', start);
    if (end < 0) end = n;
    let i = start;
    while (i < end && i - start < 3 && body.charCodeAt(i) === SPACE) i += 1;
    const c = i < end ? body.charCodeAt(i) : -1;
    if (c === BACKTICK || c === TILDE) {
      let k = i + 1;
      while (k < end && body.charCodeAt(k) === c) k += 1;
      const run = k - i;
      if (fence) {
        // A closing fence: the same character, at least as many, then only white space.
        if (c === fence.char && run >= fence.len && (k === end || ONLY_SPACE.test(body.slice(k, end)))) fence = null;
      } else if (run >= 3) {
        // An opening fence: three or more; after backticks, no backtick in the info string.
        const info = k === end ? '' : body.slice(k, end);
        if (!LINE_BREAK.test(info) && !(c === BACKTICK && info.includes('`'))) fence = { char: c, len: run };
      }
    } else if (c === HASH && !fence) {
      let k = i + 1;
      if (k < end && body.charCodeAt(k) === HASH) k += 1;
      const after = k < end ? body.charCodeAt(k) : -1;
      if (after === -1 || after === SPACE || after === TAB) escapes.push(i);
    }
    start = end + 1;
  }
  const close = fence ? `\n${String.fromCharCode(fence.char).repeat(fence.len)}` : '';
  return withEscapes(body, escapes) + close;
}

/** body with a backslash before each of the given positions, which are in order. */
function withEscapes(body: string, at: number[]): string {
  if (at.length === 0) return body;
  if (at.length < 1024) {
    const parts: string[] = [];
    let copied = 0;
    for (const i of at) {
      parts.push(body.slice(copied, i), '\\');
      copied = i;
    }
    parts.push(body.slice(copied));
    return parts.join('');
  }
  const u = codeUnits(body);
  const out = new Uint16Array(u.length + at.length);
  let w = 0;
  let r = 0;
  for (const i of at) {
    while (r < i) out[w++] = u[r++]!;
    out[w++] = 0x5c;
  }
  while (r < u.length) out[w++] = u[r++]!;
  return fromCodeUnits(out, out.length);
}

function importLines(imported: ImportProvenance | null): string[] {
  return [
    `imported: ${JSON.stringify(IMPORTED_NOTE)}`,
    ...(imported ? [`imported_by: ${JSON.stringify(IMPORTED_BY[imported.via])}`] : []),
    ...(imported?.replacedImportAt ? [`replaced: ${JSON.stringify(oneLine(imported.replacedImportAt))}`] : []),
  ];
}

function renderPost(p: ExtractedPost, mode: NameMode): string {
  const author = oneLine(stripMarkers(p.author));
  const name = author ? oneLine(stripMarkers(mode.nameFor(author))) : UNKNOWN_AUTHOR;
  const line = (text: string): string => oneLine(renderNames(text, mode.nameFor));
  const signals = p.signals.length ? ` (${p.signals.map(line).join(', ')})` : '';
  const head = `## #${p.number}, ${name}${signals}, ${formatDate(p.postedAt)}`;
  const notes = p.notes.length ? `\n\n_${p.notes.map(line).join('. ')}._` : '';
  const body = guardBody(renderNames(p.bodyMd, mode.nameFor).trim());
  return `${head}${notes}\n\n${body || '_(empty post)_'}\n`;
}

export function renderThread(
  t: RenderInput,
  nameMode: NameMode,
  opts: { fromPost?: number; maxChars?: number } = {},
): { markdown: string; truncated: boolean; nextFromPost: number | null } {
  const fromPost = opts.fromPost ?? 1;
  const maxChars = opts.maxChars ?? Number.POSITIVE_INFINITY;
  const total = t.posts.length;
  // One pseudonym per distinct name for the whole render, however often the name appears.
  const mode: NameMode = { label: nameMode.label, nameFor: memoNames(nameMode.nameFor) };
  // Titles carry marked names only where an engine marks them (Reddit mentions, D40).
  const title = oneLine(renderNames(t.title, mode.nameFor));
  const head = [
    '---',
    `source: ${t.sourceId}`,
    `url: ${oneLine(t.url)}`,
    `title: ${JSON.stringify(title)}`,
    `fetched_at: ${t.fetchedAt}`,
    `engine: ${t.engine}`,
    `post_count: ${total}`,
    `posts_expected: ${t.postsExpected ?? 'unknown'}`,
    ...(t.pages !== null ? [`pages: ${t.pages}`] : []),
    `extraction: ${t.extraction}`,
    `quality: ${t.quality}`,
    `authors: ${mode.label}`,
    ...(t.note ? [`note: ${JSON.stringify(oneLine(t.note))}`] : []),
    ...(t.engine === 'import' ? importLines(t.imported ?? null) : []),
    '---',
    '',
    `# ${title}`,
    '',
    '',
  ].join('\n');

  let markdown = head;
  let kept = 0;
  let last: number | null = null;
  let truncated = false;
  for (const p of t.posts) {
    if (p.number < fromPost) continue;
    const chunk = (kept > 0 ? '\n' : '') + renderPost(p, mode);
    if (kept > 0 && markdown.length + chunk.length > maxChars) {
      truncated = true;
      break;
    }
    markdown += chunk;
    kept += 1;
    last = p.number;
  }
  if (truncated && last !== null) {
    markdown += `\n_Truncated after post #${last} of ${total}. Ask for from_post ${last + 1} to read on._\n`;
    return { markdown, truncated, nextFromPost: last + 1 };
  }
  return { markdown, truncated: false, nextFromPost: null };
}

// Callers pass rendered text (renderNames applied): marked names would otherwise
// reach the excerpt as real names.
// A window of about maxChars around the first match of any query word, with "..."
// where text was cut. Whitespace is collapsed; no match starts at the top.
export function excerpt(text: string, query: string, maxChars = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const lower = flat.toLowerCase();
  const words = query
    .split(/[\s"()*:^]+/)
    .filter((w) => w.length > 0 && !['AND', 'OR', 'NOT', 'NEAR'].includes(w))
    .map((w) => w.toLowerCase());
  let at = -1;
  let len = 0;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = w.length;
    }
  }
  let start = at < 0 ? 0 : Math.max(0, at - Math.floor((maxChars - len) / 2));
  const end = Math.min(flat.length, start + maxChars);
  start = Math.max(0, end - maxChars);
  return `${start > 0 ? '...' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '...' : ''}`;
}
