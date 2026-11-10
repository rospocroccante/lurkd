import { errors, type Page, type Request, type Response } from 'playwright';
import type { FetchKind, FetchLogEntry } from '../archive/state.js';
import { detectBlock, type Detection } from '../detect.js';
import { LurkdError } from '../errors.js';
import { PAGE_TIMEOUT_MS, type RunLimiter } from '../policy/limiter.js';
import { checkNavigable, isAllowedHost, matchesReadEndpoint, redactForumAddress, redactOrigin, redactUrl } from '../policy/urls.js';
import type { SourceConfig } from '../sources/schema.js';
import type { ArmFn } from './manager.js';

// Every request lurkd itself makes for a source goes through here: URL policy, run limits, the
// fetch log and block detection. Nobody waits for a human (D29): a login wall or a challenge stops
// the read with `needs_login` or `challenge`, and the caller offers the handoff in the UI.
//
// The page's own scripts run in the same JavaScript world as `page.evaluate`, so anything the page
// hands back can be forged (a replaced `fetch`, patched `Response` getters). What the reader
// trusts comes from Playwright's view of the network (Request and Response objects) or from its
// utility world (`page.content()`, locators); an answer from the main world is only a signal that
// the page is done.
//
// Text the forum controls (a thrown page error, an address, a path) never goes into a message
// lurkd prints on its own line (prompt-injection boundary). An address the caller asked for shows
// origin and path (`redactUrl`): the address the agent gave (`ask`) and the source's own configured
// URLs. Every other address, whether the forum chose it (a redirect target, the final URL, a form
// action) or a page supplied it (search hits, next-page and profile links), shows its origin only. The raw text and
// the full addresses stay in `details`, which no formatter prints. A `net::` code is printed only
// when Chromium really has it, and only for a failure Playwright reported, never for an error the
// page threw.
//
// Code that runs in the page is either a string or an anonymous function with no named inner
// functions: tsx keeps names by wrapping them in a `__name` helper the page does not have.

export interface NavResult {
  status: number | null;
  finalUrl: string;
  detection: Detection | null;
}

export interface JsonResult {
  status: number;
  contentType: string;
  json: unknown | null;
  text: string;
}

export interface ReaderDeps {
  limiter: RunLimiter;
  log: (e: FetchLogEntry) => void;
  jobId: string | null;
  /** Lets one POST to a read endpoint through the guard (D14) and returns the disarm; from `BrowserManager.withPage`. */
  arm: ArmFn;
  timeoutMs?: number;
}

/** How long `navigate` waits for the client-side app to settle after DOMContentLoaded. */
const NETWORK_IDLE_MS = 6_000;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * The in-page GET. It only sends the request and reads the body to the end; its answer says
 * whether it finished, never what came back. `keepalive` stays off: the guard's init script
 * rejects keepalive requests.
 */
function jsonFetchScript(url: string, timeoutMs: number): string {
  return `(async () => {
  try {
    const res = await fetch(${JSON.stringify(url)}, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(${timeoutMs}),
    });
    await res.arrayBuffer();
    return { done: true, timedOut: false };
  } catch (e) {
    return { done: false, timedOut: !!e && e.name === 'TimeoutError' };
  }
})()`;
}

/** What the network showed of one `getJson` request, for the log row. */
interface Seen {
  sent: boolean;
  status: number | null;
}

interface PageAnswer {
  done: boolean;
  timedOut: boolean;
}

/** The request chain of one GET, as Playwright saw it on the network. */
interface Observed {
  first: Request;
  last: Request;
  /** The last hop's response; null when the request failed. */
  response: Response | null;
  /** Chromium's error text when the last hop failed, e.g. `net::ERR_CONNECTION_REFUSED`. */
  failure: string | null;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

function isPlaywrightTimeout(e: unknown): boolean {
  return e instanceof errors.TimeoutError;
}

function withoutHash(url: string): string {
  const u = new URL(url);
  u.hash = '';
  return u.href;
}

function netCode(text: string): string | null {
  return /net::(ERR_[A-Z0-9_]+)/.exec(text)?.[1] ?? null;
}

/** Chromium network error names lurkd prints. Any other code is shown as "a network error". */
const KNOWN_NET_ERRORS: ReadonlySet<string> = new Set([
  'ERR_ABORTED',
  'ERR_ACCESS_DENIED',
  'ERR_ADDRESS_INVALID',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_BLOCKED_BY_CLIENT',
  'ERR_BLOCKED_BY_RESPONSE',
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID',
  'ERR_CERT_DATE_INVALID',
  'ERR_CERT_INVALID',
  'ERR_CONNECTION_ABORTED',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_FAILED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_CONTENT_LENGTH_MISMATCH',
  'ERR_DNS_TIMED_OUT',
  'ERR_EMPTY_RESPONSE',
  'ERR_FAILED',
  'ERR_HTTP2_PROTOCOL_ERROR',
  'ERR_INCOMPLETE_CHUNKED_ENCODING',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_INVALID_HTTP_RESPONSE',
  'ERR_INVALID_RESPONSE',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NAME_RESOLUTION_FAILED',
  'ERR_NETWORK_ACCESS_DENIED',
  'ERR_NETWORK_CHANGED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_QUIC_PROTOCOL_ERROR',
  'ERR_SOCKET_NOT_CONNECTED',
  'ERR_SSL_PROTOCOL_ERROR',
  'ERR_SSL_VERSION_OR_CIPHER_MISMATCH',
  'ERR_TIMED_OUT',
  'ERR_TOO_MANY_REDIRECTS',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_UNSAFE_PORT',
]);

const netLabel = (code: string): string => (KNOWN_NET_ERRORS.has(code) ? `net::${code}` : 'a network error');

/** What `ask` and `shown` compare: origin and path, no query or fragment. */
function addressKey(url: string): string {
  return redactUrl(url);
}

/** A URL inside a message: runs to the next space or quote; trailing punctuation is not part of it. */
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;

function isRedirect(resp: Response): boolean {
  return REDIRECT_STATUSES.has(resp.status()) && resp.headers()['location'] !== undefined;
}

function frameOf(req: Request): unknown {
  try {
    return req.frame();
  } catch {
    // service worker requests have no frame
    return null;
  }
}

export class PageReader {
  readonly page: Page;
  readonly source: SourceConfig;
  private readonly limiter: RunLimiter;
  private readonly logEntry: (e: FetchLogEntry) => void;
  private readonly jobId: string | null;
  private readonly arm: ArmFn;
  private readonly timeoutMs: number;
  /** Addresses a message may show with their path: the agent's, and the source's own URLs. Everything else shows its origin only. */
  private readonly asked = new Set<string>();

  constructor(page: Page, source: SourceConfig, deps: ReaderDeps) {
    this.page = page;
    this.source = source;
    this.limiter = deps.limiter;
    this.logEntry = deps.log;
    this.jobId = deps.jobId;
    this.arm = deps.arm;
    this.timeoutMs = deps.timeoutMs ?? PAGE_TIMEOUT_MS;
    for (const u of [source.base_url, source.login_url, source.search_url?.replaceAll('{query}', 'q'), source.session_check?.url]) {
      if (typeof u === 'string') this.ask(u);
    }
  }

  /** Marks an address the agent gave: messages may show its origin and path. Call it for the agent's own URLs only, never for one a page supplied. */
  ask(url: string): void {
    this.asked.add(addressKey(url));
  }

  /** `url` as a lurkd message may show it: origin and path when it was asked for, origin only otherwise. */
  shown(url: string): string {
    const origin = redactForumAddress(this.source, url);
    const full = redactUrl(url);
    // The bare root is its origin: no trailing slash, so scrubbing a message twice changes nothing.
    return this.asked.has(addressKey(url)) && full !== `${redactOrigin(url)}/` ? full : origin;
  }

  /**
   * `e` with every address inside its message passed through `shown`. Adapters build their own
   * messages from addresses a page supplied (a search hit, a redirect target); this is the one
   * place that makes them safe. Code and details are kept: details are never printed.
   */
  scrubbed(e: LurkdError): LurkdError {
    const message = e.message.replace(URL_IN_TEXT, (m) => {
      const tail = /[.,;:!?)\]]+$/.exec(m)?.[0] ?? '';
      return this.shown(tail === '' ? m : m.slice(0, -tail.length)) + tail;
    });
    return message === e.message ? e : new LurkdError(e.code, message, e.details);
  }

  /**
   * Opens `url` in the page and reports what it found. Throws `off_domain` when the page ended on
   * a host of another site, `timeout` when it did not load in time, `server_unavailable` on a
   * network error; a detection is returned, not thrown.
   */
  async navigate(url: string): Promise<NavResult> {
    await this.admit(url);
    let status: number | null = null;
    try {
      const resp = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      status = resp?.status() ?? null;
    } catch (e) {
      if (isPlaywrightTimeout(e)) throw this.timeout(`${this.shown(url)} did not load within ${seconds(this.timeoutMs)}.`, url);
      throw this.unexpected(e, url, true);
    } finally {
      this.log('GET', url, 'navigate', status);
    }
    try {
      return await this.inspect(url, status);
    } catch (e) {
      throw this.unexpected(e, url, false);
    }
  }

  /**
   * `navigate`, then stops with `needs_login` or `challenge` when the page asks for a human.
   * Returns what `navigate` found (status, final URL), with `detection` always null.
   */
  async open(url: string): Promise<NavResult> {
    const nav = await this.navigate(url);
    if (nav.detection) throw this.blocked('GET', url, nav.finalUrl, nav.status, nav.detection);
    return nav;
  }

  /**
   * A GET sent by the page, so the browser session, cookies and CSRF context apply. Status,
   * content type, final URL and body are read from the network, not from the page. When the page
   * is not on the URL's origin yet (a fresh page is about:blank, and its fetch would be
   * cross-origin), it opens `base_url` first, or the origin's root for another host of the source.
   * A redirect to another host is `off_domain`; a non-200 answer with a detection, or a redirect
   * that lands on one, stops like `open`.
   */
  async getJson(url: string): Promise<JsonResult> {
    checkNavigable(this.source, url);
    await this.landOn(url);
    await this.admit(url);
    let status: number | null = null;
    const seen: Seen = { sent: false, status: null };
    let obs: Observed;
    try {
      obs = await this.observedGet(url, seen);
      status = obs.response?.status() ?? null;
    } finally {
      // Only a request that reached the network counts; a forged page answer sent nothing.
      if (seen.sent) this.log('GET', url, 'fetch', status ?? seen.status);
    }
    const finalUrl = obs.last.url();
    if (!isAllowedHost(this.source, finalUrl)) throw this.offDomain(url, finalUrl);
    if (obs.response === null) throw this.networkError(new Error(obs.failure ?? 'net::ERR_FAILED'), url, finalUrl);
    const resp = obs.response;
    const contentType = resp.headers()['content-type'] ?? '';
    // A final 3xx (304, 300, no Location) has no body Playwright can hand out.
    const bodyless = resp.status() >= 300 && resp.status() < 400;
    const text = bodyless
      ? ''
      : await this.race(resp.text(), () => this.timeout(`The answer of ${this.shown(url)} could not be read within ${seconds(this.timeoutMs)}.`, url));
    const detection = detectBlock({
      url: finalUrl,
      requestedUrl: url,
      source: this.source,
      status: resp.status(),
      html: contentType.includes('html') ? text : '',
    });
    const redirected = obs.last !== obs.first;
    if (detection && (resp.status() !== 200 || redirected)) throw this.blocked('GET', url, finalUrl, resp.status(), detection);
    let json: unknown | null = null;
    if (contentType.includes('json')) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: resp.status(), contentType, json, text };
  }

  /**
   * Fills the first visible `inputSelector` inside `formSelector` on the current page and submits
   * its form. A POST form must post to one of the source's `read_endpoints` (D14): the guard lets
   * it through once after `arm()` and logs it as `form` (P12), so the reader does not log it, and
   * the arm is taken back when the call ends, also when the page cancelled the submit. A GET form
   * is an ordinary navigation, logged with the URL the browser actually requested. The page it
   * lands on is checked like `open`.
   */
  async submitSearch(form: { formSelector: string; inputSelector: string }, query: string): Promise<void> {
    const url = this.page.url();
    try {
      await this.search(form, query);
    } catch (e) {
      throw this.unexpected(e, url, false);
    }
  }

  /**
   * `page.evaluate` bounded by the page timeout: Playwright gives it none (D31). Takes a string
   * expression (no argument) or a function with its argument.
   */
  evaluate<R>(expression: string): Promise<R>;
  evaluate<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  evaluate<A, R>(fn: string | ((arg: A) => R | Promise<R>), arg?: A): Promise<R> {
    const call = this.page.evaluate as (f: unknown, a?: unknown) => Promise<R>;
    const run = typeof fn === 'string' ? call.call(this.page, fn) : call.call(this.page, fn, arg);
    const url = this.page.url();
    // What the page threw is forum text: it never reaches a message.
    return this.race(run, () => this.timeout(`A script in ${this.shown(url)} did not finish within ${seconds(this.timeoutMs)}.`, url)).catch((e: unknown) => {
      throw this.unexpected(e, url, false);
    });
  }

  // ---- internals ----


  private async search(form: { formSelector: string; inputSelector: string }, query: string): Promise<void> {
    const input = this.page.locator(form.formSelector).locator(form.inputSelector).filter({ visible: true }).first();
    if ((await input.count()) === 0) {
      throw new LurkdError('extraction_failed', `No visible search field matches ${form.inputSelector} inside ${form.formSelector} on ${this.shown(this.page.url())}.`, {
        url: this.page.url(),
        formSelector: form.formSelector,
        inputSelector: form.inputSelector,
      });
    }
    await input.fill(query, { timeout: this.timeoutMs });
    // The form's own attributes: `form.action` and `form.method` can be shadowed by inputs of that name.
    // This is a pre-check only; what the browser then requests is read from the network below.
    const target = await input.evaluate((el) => {
      const f = (el as HTMLInputElement).form;
      if (!f) return null;
      const method = (f.getAttribute('method') ?? 'get').trim().toLowerCase();
      const action = new URL(f.getAttribute('action') ?? '', f.baseURI);
      if (method === 'get') action.search = new URLSearchParams(new FormData(f) as unknown as Record<string, string>).toString();
      action.hash = '';
      return { method, url: action.href };
    });
    if (!target) {
      throw new LurkdError('extraction_failed', `The search field ${form.inputSelector} on ${this.shown(this.page.url())} belongs to no form.`, { url: this.page.url() });
    }
    const method = target.method === 'post' ? 'POST' : target.method === 'get' ? 'GET' : null;
    if (method === null) {
      throw new LurkdError('search_unsupported', `The search form on ${this.shown(this.page.url())} uses a method lurkd does not send.`, {
        url: target.url,
      });
    }
    checkNavigable(this.source, target.url, true);
    if (method === 'POST' && !matchesReadEndpoint(this.source, 'POST', target.url)) {
      throw new LurkdError(
        'search_unsupported',
        `The search form posts to ${this.shown(target.url)}, which is not a read endpoint of ${this.source.id}. Add it to read_endpoints to search this way.`,
        { url: target.url, sourceId: this.source.id },
      );
    }
    await this.limiter.acquire(new URL(target.url).host);

    // The first main-frame navigation request after the submit: the URL the browser really asked for.
    let sent: Request | null = null;
    const onRequest = (req: Request) => {
      if (sent === null && req.isNavigationRequest() && req.redirectedFrom() === null && frameOf(req) === this.page.mainFrame()) sent = req;
    };
    this.page.on('request', onRequest);
    const disarm = method === 'POST' ? this.arm() : null;
    let status: number | null = null;
    let blockedByGuard = false;
    let submitted = false;
    try {
      const navigation = this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      // Awaited below; this only keeps an early rejection from going unhandled.
      navigation.catch(() => {});
      await input.evaluate((el) => (el as HTMLInputElement).form!.requestSubmit(), undefined, { timeout: this.timeoutMs });
      submitted = true;
      const resp = await navigation;
      status = resp?.status() ?? null;
    } catch (e) {
      const requested: string = (sent as Request | null)?.url() ?? target.url;
      if (isPlaywrightTimeout(e)) throw this.timeout(`The search on ${this.shown(target.url)} did not load within ${seconds(this.timeoutMs)}.`, target.url);
      // Until the submit went out, anything thrown came from the page's own scripts: never a network failure.
      if (!submitted) throw e;
      blockedByGuard = netCode(e instanceof Error ? e.message : String(e)) === 'ERR_BLOCKED_BY_CLIENT';
      throw this.networkError(e, target.url, requested);
    } finally {
      this.page.off('request', onRequest);
      disarm?.();
      // The guard logs the armed POST (P12) and every request it blocked; a GET that left is ours to log.
      const req = sent as Request | null;
      if (method === 'GET' && req !== null && !blockedByGuard) this.log('GET', req.url(), 'navigate', status);
    }
    const requestedUrl = (sent as Request | null)?.url() ?? target.url;
    const nav = await this.inspect(requestedUrl, status);
    if (nav.detection) throw this.blocked(method, requestedUrl, nav.finalUrl, nav.status, nav.detection);
  }

  /** URL policy, then the run limits. Nothing is sent when either refuses. */
  private async admit(url: string): Promise<void> {
    checkNavigable(this.source, url);
    await this.limiter.acquire(new URL(url).host);
  }

  private async landOn(url: string): Promise<void> {
    const target = new URL(url).origin;
    let current: string;
    try {
      current = new URL(this.page.url()).origin;
    } catch {
      current = 'null';
    }
    if (current === target) return;
    const base = new URL(this.source.base_url);
    await this.open(base.origin === target ? base.href : `${target}/`);
  }

  /**
   * Sends the GET from the page and follows it on the network: the first request for exactly this
   * URL (GET, not a navigation) that starts after the call, then its redirect hops to the last one.
   * A page answer with no such request means a page script answered in place of the network, and
   * is refused. No network answer within the timeout is `timeout`.
   */
  private async observedGet(url: string, seen: Seen): Promise<Observed> {
    const target = withoutHash(url);
    const chain = new Set<Request>();
    let first: Request | null = null;
    let settle!: (o: Observed) => void;
    const ended = new Promise<Observed>((resolve) => (settle = resolve));
    const end = (last: Request, response: Response | null, failure: string | null) => {
      if (first === null) return;
      seen.status = response?.status() ?? null;
      settle({ first, last, response, failure });
    };
    const onRequest = (req: Request) => {
      const from = req.redirectedFrom();
      if (from !== null) {
        if (chain.has(from)) chain.add(req);
        return;
      }
      // resourceType 'fetch': an <img> or <script> the page points at the same URL is never ours.
      if (first === null && req.method() === 'GET' && req.resourceType() === 'fetch' && !req.isNavigationRequest() && req.url() === target) {
        first = req;
        seen.sent = true;
        chain.add(req);
      }
    };
    const onFinished = (req: Request) => {
      if (!chain.has(req)) return;
      req.response().then(
        (resp) => {
          // A redirect hop: its next request continues the chain.
          if (resp !== null && isRedirect(resp)) return;
          end(req, resp, resp === null ? 'net::ERR_FAILED' : null);
        },
        () => end(req, null, 'net::ERR_FAILED'),
      );
    };
    const onFailed = (req: Request) => {
      if (chain.has(req)) end(req, null, req.failure()?.errorText ?? 'net::ERR_FAILED');
    };
    this.page.on('request', onRequest);
    this.page.on('requestfinished', onFinished);
    this.page.on('requestfailed', onFailed);
    const late = () => this.timeout(`${this.shown(url)} did not answer within ${seconds(this.timeoutMs)}.`, url);
    try {
      return await this.race(
        (async () => {
          const answer = (await this.page.evaluate(jsonFetchScript(url, this.timeoutMs)).catch((e: unknown) => {
            throw this.unexpected(e, url, false);
          })) as PageAnswer;
          if (answer.timedOut) throw late();
          if (first === null) {
            throw new LurkdError(
              'extraction_failed',
              `The page answered the request for ${this.shown(url)} without sending it, so lurkd does not use the answer. A script on the page may have replaced fetch.`,
              { url },
            );
          }
          return ended;
        })(),
        late,
      );
    } finally {
      this.page.off('request', onRequest);
      this.page.off('requestfinished', onFinished);
      this.page.off('requestfailed', onFailed);
    }
  }

  /** After a navigation: the host check, then detection on the live page. */
  private async inspect(requestedUrl: string, status: number | null): Promise<NavResult> {
    // Let the client-side app render; blocked POST polling cannot keep it busy.
    await this.page.waitForLoadState('networkidle', { timeout: Math.min(NETWORK_IDLE_MS, this.timeoutMs) }).catch(() => undefined);
    const finalUrl = this.page.url();
    if (!isAllowedHost(this.source, finalUrl)) throw this.offDomain(requestedUrl, finalUrl);
    const unreadable = () => this.timeout(`${this.shown(finalUrl)} could not be read within ${seconds(this.timeoutMs)}.`, finalUrl);
    // Both run in Playwright's utility world, out of reach of the page's scripts.
    const html = await this.race(this.page.content(), unreadable);
    const visiblePasswordInputs = await this.race(this.page.locator('input[type=password]').filter({ visible: true }).count(), unreadable);
    const detection = detectBlock({ url: finalUrl, requestedUrl, source: this.source, status, html, visiblePasswordInputs });
    return { status, finalUrl, detection };
  }

  private offDomain(url: string, finalUrl: string): LurkdError {
    return new LurkdError('off_domain', `${this.shown(url)} ended on ${this.shown(finalUrl)}, which is not on a domain of ${this.source.id} (${this.source.domains.join(', ')}).`, {
      url,
      finalUrl,
      sourceId: this.source.id,
      domains: this.source.domains,
    });
  }

  /**
   * Any error as a LurkdError: a LurkdError as it is, a Playwright timeout as `timeout`, a `net::`
   * error through `networkError`, and anything else (a page script throwing inside requestSubmit,
   * "Execution context was destroyed", a download, anything a page threw) as `extraction_failed`
   * with a fixed message. The raw first line goes in `details.error`, never into the message.
   */
  private unexpected(e: unknown, url: string, network: boolean): unknown {
    if (e instanceof LurkdError) return e;
    if (isPlaywrightTimeout(e)) return this.timeout(`${this.shown(url)} did not finish within ${seconds(this.timeoutMs)}.`, url);
    // Only a failure Playwright reported (the navigation) can be a network error; what a page threw cannot.
    if (network) {
      const mapped = this.networkError(e, url, url);
      if (mapped !== e) return mapped;
    }
    const message = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.trim();
    return new LurkdError('extraction_failed', `Reading ${this.shown(url)} failed in the browser.`, { url, sourceId: this.source.id, error: message });
  }

  /**
   * A Playwright or Chromium network error as a LurkdError. `net::ERR_BLOCKED_BY_CLIENT` is the
   * guard refusing `blockedUrl`: `off_domain` or `denied_path` (the manager's own failure, when it
   * recorded one, replaces this after the call). Any other `net::` error, DNS included, is
   * `server_unavailable`. Anything else is passed on as it is.
   */
  private networkError(e: unknown, url: string, blockedUrl: string): unknown {
    const text = e instanceof Error ? e.message : String(e);
    const code = netCode(text);
    if (code === null) return e;
    if (code === 'ERR_BLOCKED_BY_CLIENT') {
      try {
        checkNavigable(this.source, blockedUrl, !this.asked.has(addressKey(blockedUrl)));
      } catch (refusal) {
        return refusal;
      }
      return new LurkdError('denied_path', `The read-only guard blocked ${this.shown(blockedUrl)}, so lurkd stopped the read.`, {
        url: blockedUrl,
        sourceId: this.source.id,
        rule: null,
      });
    }
    return new LurkdError('server_unavailable', `${this.source.name} could not be reached at ${this.shown(url)} (${netLabel(code)}).`, {
      url,
      sourceId: this.source.id,
      error: `net::${code}`,
    });
  }

  /** Logs the detection and builds the error that ends the read. */
  private blocked(method: string, url: string, finalUrl: string, status: number | null, detection: Detection): LurkdError {
    this.log(method, finalUrl, 'detection', status, detection.kind);
    const why = detection.reasons.join('; ');
    const details = { url, finalUrl, reasons: detection.reasons };
    if (detection.kind === 'login') {
      return new LurkdError(
        'needs_login',
        `${this.source.name} asks for a login at ${this.shown(finalUrl)} (${why}). Log in from the lurkd page, then try again.`,
        details,
      );
    }
    return new LurkdError(
      'challenge',
      `${this.source.name} shows a human check at ${this.shown(finalUrl)} (${why}). lurkd does not try to get past it; solve it from the lurkd page, then try again.`,
      details,
    );
  }

  private timeout(message: string, url: string): LurkdError {
    return new LurkdError('timeout', message, { url, timeoutMs: this.timeoutMs });
  }

  /** Settles with `p`, or rejects with `onTimeout()` after `timeoutMs`; the timer never outlives the race. */
  private race<T>(p: Promise<T>, onTimeout: () => LurkdError): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), this.timeoutMs);
    });
    return Promise.race([p, expired]).finally(() => clearTimeout(timer));
  }

  private log(method: string, url: string, kind: FetchKind, status: number | null, note?: string): void {
    const e: FetchLogEntry = { sourceId: this.source.id, jobId: this.jobId, url, method, kind, status };
    if (note !== undefined) e.note = note;
    this.logEntry(e);
  }
}
