import { pseudonym, renderNames, stripMarkers } from '../pseudonym.js';
import type { Engine, ExtractedPost, ExtractedThread } from '../types.js';

// Renders a thread to Markdown with front matter. Engine-neutral.

export interface NameMode {
  nameFor: (username: string) => string;
  label: 'pseudonyms' | 'real names';
}

const UNKNOWN_AUTHOR = 'unknown author';

export function nameResolver(opts: { sourceId: string; salt: string; realNames: boolean }): NameMode {
  if (opts.realNames) {
    return { label: 'real names', nameFor: (u) => (u.trim() ? u.trim() : UNKNOWN_AUTHOR) };
  }
  return { label: 'pseudonyms', nameFor: (u) => (u.trim() ? pseudonym(opts.sourceId, u, opts.salt) : UNKNOWN_AUTHOR) };
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
  return `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

// Header and front matter values stay on one line.
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

// Defence in depth for bodies that did not come through the converter: outside
// fenced code, a line that would parse as a level 1 or 2 heading is escaped, so it
// cannot pose as the thread title or a post header; a fence left open is closed so
// it cannot swallow the next posts. Lines inside fences are code and stay as they
// are (shell and YAML comments start with "# ").
export function guardBody(body: string): string {
  let fence: { char: string; len: number } | null = null;
  const out: string[] = [];
  for (const line of body.split('\n')) {
    if (fence) {
      const close = line.match(/^ {0,3}(`+|~+)\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      out.push(line);
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], len: open[1].length };
      out.push(line);
      continue;
    }
    out.push(line.replace(/^( {0,3})(#{1,2})(?=[ \t]|$)/, '$1\\$2'));
  }
  if (fence) out.push(fence.char.repeat(fence.len));
  return out.join('\n');
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
  mode: NameMode,
  opts: { fromPost?: number; maxChars?: number } = {},
): { markdown: string; truncated: boolean; nextFromPost: number | null } {
  const fromPost = opts.fromPost ?? 1;
  const maxChars = opts.maxChars ?? Number.POSITIVE_INFINITY;
  const total = t.posts.length;
  const head = [
    '---',
    `source: ${t.sourceId}`,
    `url: ${oneLine(t.url)}`,
    `title: ${JSON.stringify(oneLine(t.title))}`,
    `fetched_at: ${t.fetchedAt}`,
    `engine: ${t.engine}`,
    `post_count: ${total}`,
    `posts_expected: ${t.postsExpected ?? 'unknown'}`,
    ...(t.pages !== null ? [`pages: ${t.pages}`] : []),
    `extraction: ${t.extraction}`,
    `quality: ${t.quality}`,
    `authors: ${mode.label}`,
    '---',
    '',
    `# ${oneLine(t.title)}`,
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
