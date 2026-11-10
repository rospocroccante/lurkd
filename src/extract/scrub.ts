import { LurkdError } from '../errors.js';

// Keeping real usernames away from the agent: in free-text signals (`namesAuthor`) and in the
// error text of an author lookup (`withoutAuthor`). Shared by every adapter.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** NFKD, combining marks dropped, lowercased: "Álice" and fullwidth letters compare as "alice". */
function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * True when a free-text value (a user title like "alice's lab") names the author. Both sides are
 * folded; the text is split into words on every non-alphanumeric, and a name matches a run of
 * consecutive whole words whose letters joined equal the name's letters. So "a.l.i.c.e", "a l i c e"
 * and "Álice" name alice, and "alicesmith" names "alice smith", while author "al" never matches
 * inside "local hero".
 */
export function namesAuthor(text: string, names: readonly string[]): boolean {
  const words = fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return names.some((name) => {
    const target = fold(name).replace(/[^\p{L}\p{N}]+/gu, '');
    if (target === '') return false;
    for (let i = 0; i < words.length; i++) {
      let run = '';
      for (let k = i; k < words.length; k++) {
        run += words[k];
        if (run === target) return true;
        if (!target.startsWith(run)) break;
      }
    }
    return false;
  });
}

const AUTHOR_PLACEHOLDER = '<author>';
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The error of an author lookup with the username taken out of the message and every string in
 * the details: errors reach the agent, and the agent only ever sees pseudonyms. The username is
 * replaced wherever it stands as a token, raw or percent-encoded once or twice, in any case, so
 * `/u/erin.json` and `?return=%2Fu%2Ferin.json` become `/u/<author>.json`. The code stays the same;
 * an error that is no LurkdError becomes `extraction_failed`.
 */
export function withoutAuthor(e: unknown, username: string): LurkdError {
  const forms = [...new Set([encodeURIComponent(encodeURIComponent(username)), encodeURIComponent(username), username])];
  const patterns = forms.map((f) => new RegExp(`(?<=^|[^\\p{L}\\p{N}]|%(?:25)?[0-9A-Fa-f]{2})${escapeRe(f)}(?=$|[^\\p{L}\\p{N}])`, 'giu'));
  const scrub = (text: string): string => patterns.reduce((acc, re) => acc.replace(re, AUTHOR_PLACEHOLDER), text);
  const deep = (v: unknown): unknown => {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(deep);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), deep(x)]));
    return v;
  };
  if (e instanceof LurkdError) {
    return new LurkdError(e.code, scrub(e.message), e.details === undefined ? undefined : (deep(e.details) as Record<string, unknown>));
  }
  const message = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.trim();
  return new LurkdError('extraction_failed', scrub(`The author lookup failed: ${message}`));
}
