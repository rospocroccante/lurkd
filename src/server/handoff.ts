import type { Page } from 'playwright';
import type { HandoffInfo } from '../browser/manager.js';
import { LurkdError, type ErrorCode } from '../errors.js';
import { formatStructure, reduceStructure, SAMPLE_LIMITS, type StructNode } from '../extract/sample.js';
import type { SampleOut, SessionStatusOut } from '../fetch/service.js';
import { quotedName } from '../output/quoted.js';
import { isAllowedHost } from '../policy/urls.js';
import { analysableUrl } from '../sources/analyse.js';
import type { AppDeps } from './app.js';

// The UI's side of the browser handoff (D29): the person presses "Log in", "Sign up", "Open window"
// or "Use this page" on the lurkd page, and these helpers drive BrowserManager. The window they open
// is the person's to use; nothing here reads from it except `captureSample`, and only the
// formatStructure outline of the page leaves it.

/** How long `captureSample` waits for the page to load and for the structure walk. */
export const CAPTURE_TIMEOUT_MS = 15_000;

// reduceStructure as a self-contained expression, as FetchService runs it: the page gets no
// function reference from Node, and tsx's name helper cannot leak into it.
const SAMPLE_SCRIPT = `(${reduceStructure.toString()})(${JSON.stringify(SAMPLE_LIMITS)})`;

// Query parameters that carry a session on some forum engines (phpBB `sid`, PHP and Java session
// ids). The sampled URL goes back to the agent, so they are dropped.
const SESSION_PARAMS = new Set(['sid', 'phpsessid', 'sessid', 'sessionid', 'session_id', 'jsessionid', 'token', 'access_token', 'auth']);

const HOST = /^(?:[a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}$|^\[[0-9a-f:.]+\]$/;

function invalid(message: string, details?: Record<string, unknown>): LurkdError {
  return new LurkdError('invalid_request', message, details);
}

function currentHandoff(deps: AppDeps, info: Omit<HandoffInfo, 'startedAt'>): HandoffInfo {
  return deps.browser.handoff ?? { ...info, startedAt: new Date().toISOString() };
}

/**
 * Opens the window for a source: at the blocked URL (purpose `challenge`) after a human check,
 * otherwise at `login_url` (purpose `login`); `invalid_request` when the source has no login page.
 */
export async function startLoginHandoff(deps: AppDeps, sourceId: string): Promise<HandoffInfo> {
  const source = deps.registry.get(sourceId);
  const session = deps.state.getSession(source.id);
  let info: Omit<HandoffInfo, 'startedAt'>;
  if (session.lastBlockKind === 'challenge') {
    // FetchService stores only URLs of the source; anything else falls back to its home page.
    const url = session.lastBlockUrl !== null && isAllowedHost(source, session.lastBlockUrl) ? session.lastBlockUrl : source.base_url;
    info = { sourceId: source.id, url, purpose: 'challenge' };
  } else if (source.login_url !== null) {
    info = { sourceId: source.id, url: source.login_url, purpose: 'login' };
  } else {
    throw invalid(`${quotedName(source.name)} has no login page, so there is nothing to log in to.`, { sourceId: source.id });
  }
  await deps.browser.beginHandoff(info);
  return currentHandoff(deps, info);
}

/**
 * Opens the window at `signup_url` (purpose `signup`, D47): the person registers there by hand,
 * CAPTCHA and email included, and "Done" runs the same session check as after a login.
 * `invalid_request` when the source has no sign-up page.
 */
export async function startSignupHandoff(deps: AppDeps, sourceId: string): Promise<HandoffInfo> {
  const source = deps.registry.get(sourceId);
  if (source.signup_url === null) throw invalid(`${quotedName(source.name)} has no sign-up page, so there is nothing to open.`, { sourceId: source.id });
  const info: Omit<HandoffInfo, 'startedAt'> = { sourceId: source.id, url: source.signup_url, purpose: 'signup' };
  await deps.browser.beginHandoff(info);
  return currentHandoff(deps, info);
}

/** Opens the window at the page the agent asked to sample for `host`; `not_found` when nothing waits for it. */
export async function startSampleHandoff(deps: AppDeps, host: string): Promise<HandoffInfo> {
  const key = host.trim().toLowerCase();
  // The host is not echoed: only a well-formed hostname gets as far as a message.
  if (!HOST.test(key)) throw invalid('host must be a hostname from "Sites waiting for a sample".');
  const pending = deps.samples.get(key);
  if (!pending || pending.structure !== null) throw new LurkdError('not_found', `No page of ${key} is waiting for a sample.`, { host: key });
  // M2: source.sample checks the address before it records it; a request recorded before that
  // check (lurkd 0.1.0) meets the same address rules here, before the window opens.
  analysableUrl(pending.url, { allowLoopback: deps.allowLoopbackForTests === true });
  const info: Omit<HandoffInfo, 'startedAt'> = { sourceId: deps.registry.sourceForHost(key)?.id ?? null, url: pending.url, purpose: 'sample' };
  await deps.browser.beginHandoff(info);
  return currentHandoff(deps, info);
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => LurkdError): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** The page URL as it is stored and handed to the agent: no credentials, no fragment, no session parameters. */
function cleanUrl(u: URL): string {
  const out = new URL(u.href);
  out.username = '';
  out.password = '';
  out.hash = '';
  for (const key of [...out.searchParams.keys()]) if (SESSION_PARAMS.has(key.toLowerCase())) out.searchParams.delete(key);
  return out.href;
}

/**
 * "Use this page": the structure of the page the sample window shows, stored for the requested
 * host, then the window closes. The page must be on the host of the request (`invalid_request`
 * otherwise, and the window stays open). The walk runs in the page with a timeout; whatever it
 * returns goes through `formatStructure` before it is stored or returned.
 */
export async function captureSample(deps: AppDeps, opts: { timeoutMs?: number } = {}): Promise<SampleOut> {
  const timeoutMs = opts.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const info = deps.browser.handoff;
  if (!info || info.purpose !== 'sample')
    throw invalid('No sample window is open. Press "Open window" next to a site under "Sites waiting for a sample" first.');
  const page: Page | null = deps.browser.handoffPage();
  if (!page) throw invalid('The sample window has no open tab. Cancel and open it again.');
  const host = new URL(info.url).hostname;
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  let current: URL | null = null;
  try {
    current = new URL(page.url());
  } catch {
    current = null;
  }
  if (current === null || (current.protocol !== 'http:' && current.protocol !== 'https:') || current.hostname !== host)
    throw invalid(`The window does not show a page of ${host}. Open a thread page of ${host} there, then press "Use this page".`, { host });
  let tree: unknown;
  try {
    tree = await withTimeout(
      page.evaluate(SAMPLE_SCRIPT),
      timeoutMs,
      () => new LurkdError('timeout', `The page of ${host} did not answer within ${Math.round(timeoutMs / 1000)} s. Try again, or open another page.`, { host }),
    );
  } catch (e) {
    if (e instanceof LurkdError) throw e;
    // A raw Playwright error can name the page; it is not passed on.
    throw new LurkdError('extraction_failed', `The page of ${host} changed while lurkd read it. Wait for it to load, then try again.`, { host });
  }
  // Only formatStructure output is stored or returned: the page's scripts could have tampered with the walk.
  const structure = formatStructure(tree as StructNode);
  const url = cleanUrl(current);
  deps.samples.save(host, url, structure);
  await deps.browser.endHandoff();
  const saved = deps.samples.get(host);
  return { status: 'sampled', host, url, structure, sampledAt: saved?.sampledAt ?? new Date().toISOString() };
}

function codeOf(e: unknown): ErrorCode {
  return e instanceof LurkdError ? e.code : 'internal';
}

/**
 * Ends the handoff ("Done" with `check`, "Cancel" without). After a login or sign-up handoff with
 * `check`, one live session check runs; when it finds the source logged in, `lastLoginAt` is set to now.
 * A failed check leaves the status as stored, with `checkError`. "Done" after a challenge clears
 * the challenge mark, since the person says it is solved; the next read records it again if not.
 * Returns the source's status, or null when no handoff was open, for a sample window, or on cancel.
 */
export async function finishHandoff(deps: AppDeps, check: boolean): Promise<SessionStatusOut[] | null> {
  const info = deps.browser.handoff;
  await deps.browser.endHandoff();
  if (!info || !check || info.sourceId === null || info.purpose === 'sample') return null;
  const id = info.sourceId;
  if (info.purpose === 'challenge') {
    const s = deps.state.getSession(id);
    if (s.lastBlockKind === 'challenge') deps.state.setSession(id, { lastBlockKind: null, lastBlockUrl: null });
    return deps.service.sessionStatus(id);
  }
  let out: SessionStatusOut[];
  try {
    out = await deps.service.sessionStatus(id, true);
  } catch (e) {
    const code = codeOf(e);
    return (await deps.service.sessionStatus(id)).map((s) => (s.id === id ? { ...s, checkError: code } : s));
  }
  const mine = out.find((s) => s.id === id);
  if (mine?.state !== 'logged_in') return out;
  const at = new Date().toISOString();
  deps.state.setSession(id, { lastLoginAt: at });
  return out.map((s) => (s.id === id ? { ...s, lastLoginAt: at } : s));
}
