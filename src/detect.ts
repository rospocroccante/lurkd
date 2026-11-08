// Heuristics for "a human is needed": login pages and anti-bot challenges (D30).
// lurkd never tries to get past either one; the caller stops and hands over.

import { isThreadPath } from './policy/urls.js';
import type { SourceConfig } from './sources/schema.js';

export interface PageSignals {
  /** The final URL, after redirects. */
  url: string;
  /**
   * The URL that was asked for. The login-path signal counts only when the final URL is a login
   * path and differs from this one after parsing (a redirect, P23), whatever the requested path
   * was. When absent, any login path counts.
   */
  requestedUrl?: string;
  /**
   * The source being read. With it, a final URL that is a thread path of the source's engine
   * (`isThreadPath`) never fires on the path alone: Discourse redirects `/t/<id>` to
   * `/t/<slug>/<id>`, and a slug may start with "login". Without it, thread paths are not exempt.
   */
  source?: SourceConfig;
  status: number | null;
  html: string;
  /** Visible password fields counted in the live page; when absent the HTML is scanned. */
  visiblePasswordInputs?: number;
}

export interface Detection {
  kind: 'login' | 'challenge';
  reasons: string[];
}

const LOGIN_PATH = /\/(login|log-in|signin|sign-in|session|sessions)(?=$|[/\-_?#.])/i;

const CHALLENGE_MARKERS: Array<[RegExp, string]> = [
  [/<title>\s*Just a moment\.\.\.\s*<\/title>/i, 'Cloudflare "Just a moment" title'],
  [/challenges\.cloudflare\.com/i, 'challenges.cloudflare.com script'],
  [/id=["']?challenge-form/i, 'Cloudflare challenge form'],
  [/class=["'][^"']*cf-turnstile/i, 'Cloudflare Turnstile widget'],
  [/window\._cf_chl_opt/i, 'Cloudflare _cf_chl_opt'],
  [/<title>\s*Attention Required! \| Cloudflare/i, 'Cloudflare block page'],
  // Cloudflare injects this script into ordinary pages too (spike, community.home-assistant.io).
  [/\/cdn-cgi\/challenge-platform\//i, 'Cloudflare challenge-platform script with error status'],
];

// Cloudflare markers count only together with one of these (D30).
const CHALLENGE_STATUSES: ReadonlySet<number> = new Set([403, 429, 503]);

// The two checks below scan tags by hand instead of with one regex: a pattern like
// /<input\b[^>]*\btype=.../ backtracks quadratically on pages full of tags that never close
// (1 MB of "<input " took 82 s). A tag runs from its "<input" or "<form" to the next ">", as
// [^>]* did. One difference for <form: the old pattern let a quoted style value run past a ">",
// and now that ">" ends the tag, so such a form is not seen as hidden (fail-closed: its
// password field counts). Once a tag is tested, later tags that start inside it are skipped:
// their text is a suffix of the one tested, and an unanchored pattern that fails on a string
// fails on its suffixes. Every index comes from the original string, never from a lowercased
// copy: some characters (U+0130) change length when lowercased.
const INPUT_OPEN = /<input\b/gi;
const PASSWORD_TYPE = /\btype\s*=\s*["']?password\b/i;
// Discourse ships a hidden login form on every page for password managers;
// any form hidden with display:none is ignored.
const FORM_OPEN = /<form\b/gi;
const HIDDEN_ATTR = /id=["']hidden-login-form["']|style=["'][^"']*display:\s*none/i;
const FORM_CLOSE = /<\/form>/gi;

function withoutHiddenForms(html: string): string {
  const close = new RegExp(FORM_CLOSE);
  let out = '';
  let last = 0;
  let scanned = 0;
  for (const m of html.matchAll(FORM_OPEN)) {
    if (m.index < last || m.index < scanned) continue;
    const gt = html.indexOf('>', m.index);
    // An open tag without ">" is no form, and no later one has a ">" either.
    if (gt === -1) break;
    scanned = gt;
    if (!HIDDEN_ATTR.test(html.slice(m.index, gt))) continue;
    close.lastIndex = gt + 1;
    const end = close.exec(html);
    // No </form> after this form means none after any later form either.
    if (end === null) break;
    out += html.slice(last, m.index);
    last = end.index + end[0].length;
  }
  return out + html.slice(last);
}

function hasPasswordField(html: string): boolean {
  let scanned = 0;
  for (const m of html.matchAll(INPUT_OPEN)) {
    if (m.index < scanned) continue;
    const gt = html.indexOf('>', m.index);
    const end = gt === -1 ? html.length : gt;
    if (PASSWORD_TYPE.test(html.slice(m.index, end))) return true;
    if (gt === -1) return false;
    scanned = gt;
  }
  return false;
}

/** True when the saved HTML has a password field outside the forms hidden with display:none. */
export function hasPasswordInput(html: string): boolean {
  return hasPasswordField(withoutHiddenForms(html));
}

function normalized(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Returns why a human is needed on this page, or null for a page lurkd may read. A 404 is no signal. */
export function detectBlock(signals: PageSignals): Detection | null {
  const reasons: string[] = [];
  let challenge = false;
  const status = signals.status;

  if (status !== null && CHALLENGE_STATUSES.has(status)) {
    for (const [re, label] of CHALLENGE_MARKERS) {
      if (re.test(signals.html)) {
        reasons.push(label);
        challenge = true;
      }
    }
  }
  if (status === 401 || status === 403) reasons.push(`HTTP ${status}`);
  if (status === 429 || status === 503) {
    reasons.push(`HTTP ${status}`);
    challenge = true;
  }

  const pathname = pathnameOf(signals.url);
  const redirected = signals.requestedUrl === undefined || normalized(signals.requestedUrl) !== normalized(signals.url);
  const thread = signals.source !== undefined && isThreadPath(signals.source, signals.url);
  if (redirected && !thread && LOGIN_PATH.test(pathname)) reasons.push(`login-like path ${pathname}`);

  const password =
    signals.visiblePasswordInputs !== undefined ? signals.visiblePasswordInputs > 0 : hasPasswordInput(signals.html);
  if (password) reasons.push('visible password input');

  if (reasons.length === 0) return null;
  return { kind: challenge ? 'challenge' : 'login', reasons };
}
