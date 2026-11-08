import crypto from 'node:crypto';

// Names in structural positions (quote headers, mentions, profile links, post link
// titles) are stored between two private-use characters, so the real name can be
// rendered as a pseudonym or kept, at read time. Forum text never carries these
// characters: the converter strips them from its input.
export const NAME_OPEN = '';
export const NAME_CLOSE = '';

const MARKERS = /[]/gu;
const MARKED = /([^]*)/gu;

// D20: `author-` and the first 10 hex characters of SHA-256 over salt, source id and
// the trimmed, lowercased username (Discourse and XenForo names are case-insensitive).
export function pseudonym(sourceId: string, username: string, salt: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${salt}\n${sourceId}\n${username.trim().toLowerCase()}`)
    .digest('hex');
  return `author-${digest.slice(0, 10)}`;
}

export function stripMarkers(text: string): string {
  return text.replace(MARKERS, '');
}

export function markName(username: string): string {
  const clean = stripMarkers(username).trim().replace(/^@/, '').trim();
  return `${NAME_OPEN}${clean}${NAME_CLOSE}`;
}

// Replaces every marked name with nameFor(name) and drops any unpaired marker.
export function renderNames(text: string, nameFor: (username: string) => string): string {
  return stripMarkers(text.replace(MARKED, (_m, name: string) => stripMarkers(nameFor(name))));
}

// The marked names in text, each once, in order of first appearance; empty marks are skipped.
export function namesIn(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(MARKED)) if (m[1]) seen.add(m[1]);
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
