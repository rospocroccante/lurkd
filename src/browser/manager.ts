import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Dialog, type Frame, type Page } from 'playwright';
import type { FetchLogEntry } from '../archive/state.js';
import { LurkdError } from '../errors.js';
import { PAGE_TIMEOUT_MS } from '../policy/limiter.js';
import type { SourceConfig } from '../sources/schema.js';
import { installGuard, type GuardScope, type RedirectViolation } from './guard.js';

// One long-lived headless Chromium on the persistent profile (D29). Every headless launch gets the
// read-only guard. The headed window exists only during a handoff: the person drives it (the login
// POST included), so it has no guard and never serves `withPage`. Every way a handoff ends brings
// the headless browser back.

export type LaunchFn = (profileDir: string, opts: { headless: boolean }) => Promise<BrowserContext>;

/**
 * Creates the profile folder at 0700 and forces 0700 on every launch (D28: Playwright's mock
 * keychain leaves the cookies protected by the folder mode alone), then opens the persistent
 * context. No user agent, no extra arguments, no stealth (D8).
 */
type LaunchPersistentContextOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

/** The part of Playwright's API `playwrightLaunch` uses; tests pass a recorder instead. */
export type PersistentLauncher = (profileDir: string, options: LaunchPersistentContextOptions) => Promise<BrowserContext>;

/**
 * Builds the launch function. The lurkd feature switches go to the headless browser only: the
 * headed handoff window has no guard and keeps Chromium's defaults, IsolateSandboxedIframes
 * included. The preference rewrite runs on every launch, headed or not, so "Preload pages" switched
 * on during a handoff never carries into the next headless run.
 */
export function createPlaywrightLaunch(launchPersistent: PersistentLauncher = (dir, o) => chromium.launchPersistentContext(dir, o)): LaunchFn {
  return async (profileDir, { headless }) => {
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(profileDir, 0o700);
    disablePreloading(profileDir);
    const options: LaunchPersistentContextOptions = {
      channel: 'chromium',
      headless,
      viewport: null,
      serviceWorkers: 'block',
      acceptDownloads: false,
    };
    if (headless) options.args = [`--enable-features=${ENABLED_FEATURES.join(',')}`, `--disable-features=${DISABLED_FEATURES.join(',')}`];
    return launchPersistent(profileDir, options);
  };
}

export const playwrightLaunch: LaunchFn = createPlaywrightLaunch();

// Preloading (speculation-rules prefetch and prerender, <link rel="prerender">) is fetched by the
// browser process, so no route sees it: a prefetch rule could open /session/logout or another host.
// Probed on Chromium 158 (Playwright 1.65.0): --disable-features=Prerender2,
// SpeculationRulesPrefetchFuture,SpeculationRulesPrefetchProxy and Page.setPrerenderingAllowed
// change nothing. What works: the "Preload pages: off" preference stops speculation rules, and the
// NoStatePrefetchHoldback feature stops <link rel="prerender">. Switching a browser feature off is
// not evasion (D8).

/** Playwright 1.65.0's own `--enable-features` list; Chromium keeps only the last switch, so ours repeats it. */
export const PLAYWRIGHT_ENABLED_FEATURES: readonly string[] = Object.freeze(['CDPScreenshotNewSurface', 'SkipListAccountsWithoutGaiaCookies']);
export const ENABLED_FEATURES: readonly string[] = Object.freeze([...PLAYWRIGHT_ENABLED_FEATURES, 'NoStatePrefetchHoldback']);
// IsolateSandboxedIframes puts a sandboxed frame without allow-same-origin (a srcdoc iframe, say)
// in its own renderer target. Playwright attaches to that target after the frame's inline script
// has run, so the frame kept sendBeacon, Worker and the native fetch, and its POSTs, keepalive
// fetches and WebSocket upgrades reached the server without passing the route (review, fix round
// 3). With the feature off the frame stays in the page's target: the init script and the routes
// reach it first.

/** Playwright 1.65.0's own `--disable-features` list; Chromium keeps only the last switch, so ours repeats it. */
export const PLAYWRIGHT_DISABLED_FEATURES: readonly string[] = Object.freeze([
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'HttpsUpgrades',
  'HttpsFirstBalancedModeAutoEnable',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'AvoidCorsURLLoaderRestartOnRedirect',
  'TcpPortRandomizationWin',
  'OptimizationHints',
  'NetworkTimeServiceQuerying',
  'AimEnabled',
  'PreconnectToSearch',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
]);
export const DISABLED_FEATURES: readonly string[] = Object.freeze([...PLAYWRIGHT_DISABLED_FEATURES, 'IsolateSandboxedIframes']);

/** `net.network_prediction_options` value for "Preload pages: off". */
export const NO_PRELOADING = 2;

/**
 * Sets "Preload pages: off" in the profile before every launch, keeping the rest of the file. The
 * person may switch it back on during a handoff; the next launch switches it off again.
 */
export function disablePreloading(profileDir: string): void {
  const dir = path.join(profileDir, 'Default');
  const file = path.join(dir, 'Preferences');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let prefs: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prefs = parsed as Record<string, unknown>;
  } catch {
    // missing or unreadable: Chromium would start from defaults anyway
  }
  const net = prefs.net && typeof prefs.net === 'object' && !Array.isArray(prefs.net) ? (prefs.net as Record<string, unknown>) : {};
  if (net.network_prediction_options === NO_PRELOADING) return;
  prefs.net = { ...net, network_prediction_options: NO_PRELOADING };
  const tmp = `${file}.lurkd-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(prefs), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export type BrowserState = 'down' | 'starting' | 'ready' | 'handoff' | 'error';

export interface HandoffInfo {
  sourceId: string | null;
  url: string;
  purpose: 'login' | 'challenge' | 'sample';
  startedAt: string;
}

const DEFAULT_HANDOFF_TIMEOUT_MS = 900_000;

// Main-frame schemes a guarded page may show. about:blank is the empty page, chrome-error: the
// page Chromium shows for a request the guard aborted. A blob:, data: or any other document was
// made inside the browser, not served by the source, and closes the page.
const PAGE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'about:', 'chrome-error:']);
const LOGGED_URL_MAX = 2048;

const idleScope = (): GuardScope => ({ source: null, jobId: null, armed: false });

function firstLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.split('\n')[0]!.trim() || 'unknown error';
}

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return 'invalid:';
  }
}

export class BrowserManager {
  private readonly profileDir: string;
  private readonly log: (e: FetchLogEntry) => void;
  private readonly launch: LaunchFn;
  private readonly handoffTimeoutMs: number;

  private _state: BrowserState = 'down';
  private _lastError: string | null = null;
  private _handoff: HandoffInfo | null = null;

  /** The guarded headless context, or null when it is down, crashed or replaced by a handoff. */
  private ctx: BrowserContext | null = null;
  private handoffCtx: BrowserContext | null = null;
  /** Open tabs of the headed window, the most recently opened or navigated last. */
  private handoffTabs: Page[] = [];
  private handoffLastUrl: string | null = null;
  private handoffTimer: NodeJS.Timeout | null = null;
  private handoffStarting = false;
  private handoffEnding: Promise<{ finalUrl: string | null }> | null = null;
  private closing = false;

  /** The scope the guard reads on every request. Only `withPage` sets a source in it. */
  private scope: GuardScope = idleScope();
  /** `withPage` calls running or waiting for their turn. */
  private busy = 0;
  /** The page the running `withPage` call owns. Any other page in the headless context is closed. */
  private currentPage: Page | null = null;
  /** The first thing that fails a `withPage` call after the fact, keyed by the call's scope. */
  private readonly failures = new WeakMap<GuardScope, LurkdError>();
  /** Settles once a `newPage` call of ours has returned, so the page listener can tell ours apart. */
  private pageCreation: Promise<void> | null = null;
  /** Serialises launches, closes and pages: one transition or one page at a time. */
  private lock: Promise<void> = Promise.resolve();

  constructor(opts: { profileDir: string; log: (e: FetchLogEntry) => void; launch?: LaunchFn; handoffTimeoutMs?: number }) {
    this.profileDir = opts.profileDir;
    this.log = opts.log;
    this.launch = opts.launch ?? playwrightLaunch;
    this.handoffTimeoutMs = opts.handoffTimeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;
  }

  get state(): BrowserState {
    return this._state;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get handoff(): HandoffInfo | null {
    return this._handoff;
  }

  /**
   * Launches the headless browser unless it already runs. A failed launch does not throw: it
   * leaves state `error` with `lastError`, and the next `withPage` tries once more.
   */
  async start(): Promise<void> {
    await this.exclusive(async () => {
      if (this.ctx || this._handoff) return;
      await this.launchHeadless().catch(() => {});
    });
  }

  /**
   * Runs `fn` on a fresh guarded page for `scope.source`, then closes the page. Calls run one at a
   * time. `arm()` lets one POST to a read endpoint of the source through (D14), until the call ends.
   * Refuses with `handoff_in_progress` during a handoff; relaunches the browser once when it has
   * closed, and throws `browser_unavailable` when that fails (P1).
   */
  async withPage<T>(scope: { source: SourceConfig; jobId: string | null }, fn: (page: Page, arm: () => void) => Promise<T>): Promise<T> {
    this.refuseDuringHandoff();
    this.busy++;
    try {
      return await this.exclusive(() => {
        this.refuseDuringHandoff();
        return this.runPage(scope, fn);
      });
    } finally {
      this.busy--;
    }
  }

  /**
   * Replaces the headless browser with a headed window on the same profile and opens `info.url`
   * in it. Refuses with `handoff_in_progress` while a `withPage` call runs or another handoff is
   * open. The handoff ends on `endHandoff`, when the person closes the window, or after
   * `handoffTimeoutMs`.
   */
  async beginHandoff(info: Omit<HandoffInfo, 'startedAt'>): Promise<void> {
    if (this._handoff || this.handoffStarting) {
      throw new LurkdError('handoff_in_progress', 'A browser window is already open for a handoff. Finish it on the lurkd page first.', {
        handoff: this._handoff,
      });
    }
    if (this.busy > 0) {
      throw new LurkdError('handoff_in_progress', 'A read is using the browser right now. Try again when it has finished.');
    }
    const scheme = schemeOf(info.url);
    if (scheme !== 'http:' && scheme !== 'https:') {
      throw new LurkdError('invalid_request', `A handoff needs an absolute http or https URL, not ${info.url}.`, { url: info.url });
    }
    this.handoffStarting = true;
    try {
      await this.exclusive(() => this.openHandoff(info));
    } finally {
      this.handoffStarting = false;
    }
  }

  /** The page of the headed window while a handoff runs. */
  handoffPage(): Page | null {
    return this._handoff ? (this.handoffTabs.at(-1) ?? null) : null;
  }

  /** Closes the headed window and relaunches headless. `finalUrl` is the window's last address. */
  endHandoff(): Promise<{ finalUrl: string | null }> {
    if (this.handoffEnding) return this.handoffEnding;
    if (!this._handoff) return Promise.resolve({ finalUrl: null });
    const ending = this.exclusive(async () => {
      if (!this._handoff) return { finalUrl: null };
      const headed = this.handoffCtx;
      const page = this.handoffTabs.at(-1);
      const finalUrl = page && !page.isClosed() ? page.url() : this.handoffLastUrl;
      this.clearHandoffTimer();
      this.handoffCtx = null;
      this.handoffTabs = [];
      if (headed) await headed.close().catch(() => {});
      this._handoff = null;
      if (this.closing) this._state = 'down';
      else await this.launchHeadless().catch(() => {});
      return { finalUrl };
    });
    this.handoffEnding = ending.finally(() => {
      this.handoffEnding = null;
    });
    return this.handoffEnding;
  }

  /** Closes every browser this manager opened, a handoff window included, without relaunching. */
  async close(): Promise<void> {
    this.closing = true;
    try {
      this.clearHandoffTimer();
      // Close right away, so a running page fails fast instead of holding the shutdown.
      await this.closeAll();
      await this.exclusive(() => this.closeAll());
    } finally {
      this.closing = false;
    }
  }

  // ---- internals ----

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private refuseDuringHandoff(): void {
    if (this._handoff || this.handoffStarting) {
      throw new LurkdError('handoff_in_progress', 'A browser window is open for a handoff. Finish it on the lurkd page, then try again.', {
        handoff: this._handoff,
      });
    }
  }

  private async closeAll(): Promise<void> {
    const contexts = [this.ctx, this.handoffCtx];
    this.ctx = null;
    this.handoffCtx = null;
    this.handoffTabs = [];
    this._handoff = null;
    this.scope = idleScope();
    for (const c of contexts) if (c) await c.close().catch(() => {});
    this._state = 'down';
  }

  private clearHandoffTimer(): void {
    if (this.handoffTimer) clearTimeout(this.handoffTimer);
    this.handoffTimer = null;
  }

  /** Call inside the lock. Throws `browser_unavailable` and leaves state `error` on failure. */
  private async launchHeadless(): Promise<BrowserContext> {
    this._state = 'starting';
    let ctx: BrowserContext | null = null;
    try {
      ctx = await this.launch(this.profileDir, { headless: true });
      await installGuard(ctx, () => this.scope, this.log, (v) => this.failOnRedirect(v));
      // Every page that exists now predates the guard: the initial about:blank page and any tab
      // Chromium restored from an earlier session. withPage always opens a fresh page, so close them.
      for (const p of ctx.pages()) await p.close().catch(() => {});
    } catch (e) {
      if (ctx) await ctx.close().catch(() => {});
      this._state = 'error';
      this._lastError = firstLine(e);
      throw new LurkdError('browser_unavailable', `The browser could not start: ${this._lastError}`);
    }
    const c = ctx;
    // Pages the site opens by itself (window.open, target=_blank), also late ones that appear
    // after their opener's call ended, are closed: only the page of the running call stays.
    c.on('page', (p: Page) => void this.closeUnlessCurrent(p));
    c.on('close', () => {
      if (this.ctx !== c) return; // closed on purpose: the reference was dropped first
      this.ctx = null;
      this._state = 'error';
      this._lastError = 'The browser closed unexpectedly. lurkd starts it again on the next read.';
    });
    this.ctx = c;
    this._state = 'ready';
    this._lastError = null;
    return c;
  }

  /** A redirect hop the guard would have blocked fails the call whose scope it ran under. */
  private failOnRedirect(v: RedirectViolation): void {
    const source = v.scope.source;
    if (!source || this.failures.has(v.scope)) return;
    const url = v.url.slice(0, LOGGED_URL_MAX);
    const offDomain = ['off_domain', 'no_source', 'invalid_url'].includes(v.note) || v.note.startsWith('scheme:');
    const sent = `The request had already left the browser, so lurkd stopped the read.`;
    this.failures.set(
      v.scope,
      offDomain
        ? new LurkdError('off_domain', `${source.name} redirected to ${url}, which is not on a domain of ${source.id}. ${sent}`, {
            url,
            sourceId: source.id,
            domains: source.domains,
            redirect: true,
          })
        : new LurkdError('denied_path', `${source.name} redirected a ${v.method} request to ${url} (${v.note}), which lurkd never sends. ${sent}`, {
            url,
            sourceId: source.id,
            rule: v.note.startsWith('deny:') ? v.note.slice('deny:'.length) : null,
            note: v.note,
            redirect: true,
          }),
    );
  }

  private dropContext(ctx: BrowserContext): void {
    if (this.ctx === ctx) this.ctx = null;
    void ctx.close().catch(() => {});
  }

  private async closeUnlessCurrent(p: Page): Promise<void> {
    const creation = this.pageCreation;
    if (creation) await creation;
    if (p !== this.currentPage) await p.close().catch(() => {});
  }

  private async newOwnPage(ctx: BrowserContext): Promise<Page> {
    let settle!: () => void;
    this.pageCreation = new Promise<void>((r) => (settle = r));
    try {
      const page = await ctx.newPage();
      this.currentPage = page;
      return page;
    } finally {
      settle();
      this.pageCreation = null;
    }
  }

  /** A fresh page, relaunching the browser at most once for this call. */
  private async freshPage(): Promise<{ ctx: BrowserContext; page: Page }> {
    let relaunched = false;
    let ctx = this.ctx;
    if (!ctx) {
      ctx = await this.launchHeadless();
      relaunched = true;
    }
    try {
      return { ctx, page: await this.newOwnPage(ctx) };
    } catch (e) {
      this.dropContext(ctx);
      if (relaunched) return this.unavailable(e);
    }
    ctx = await this.launchHeadless();
    try {
      return { ctx, page: await this.newOwnPage(ctx) };
    } catch (e) {
      this.dropContext(ctx);
      return this.unavailable(e);
    }
  }

  private unavailable(e: unknown): never {
    this._state = 'error';
    this._lastError = firstLine(e);
    throw new LurkdError('browser_unavailable', `The browser could not open a page: ${this._lastError}`);
  }

  private async runPage<T>(scope: { source: SourceConfig; jobId: string | null }, fn: (page: Page, arm: () => void) => Promise<T>): Promise<T> {
    const { page } = await this.freshPage();
    const own: GuardScope = { source: scope.source, jobId: scope.jobId, armed: false };
    this.scope = own;
    const arm = () => {
      if (this.scope === own) own.armed = true;
    };

    let refusedUrl: string | null = null;
    const failure = () => this.failures.get(own) ?? null;
    const onDialog = (d: Dialog) => {
      d.dismiss().catch(() => {});
    };
    const onNavigated = (frame: Frame) => {
      if (refusedUrl !== null || frame !== page.mainFrame()) return;
      const url = frame.url();
      const scheme = schemeOf(url);
      if (PAGE_SCHEMES.has(scheme)) return;
      refusedUrl = url;
      if (!this.failures.has(own)) this.failures.set(own, refused(url));
      try {
        this.log({
          sourceId: own.source?.id ?? null,
          jobId: own.jobId,
          url: url.slice(0, LOGGED_URL_MAX),
          method: 'GET',
          kind: 'blocked',
          status: null,
          note: `scheme:${scheme.replace(/:$/, '')}`,
        });
      } catch {
        // the page closes whether or not the row was written
      }
      page.close().catch(() => {});
    };
    function refused(url: string): LurkdError {
      return new LurkdError('off_domain', `The page went to a ${schemeOf(url)} address that ${scope.source.id} did not serve, so lurkd closed it.`, {
        url: url.slice(0, LOGGED_URL_MAX),
        sourceId: scope.source.id,
      });
    }

    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    page.on('dialog', onDialog);
    page.on('framenavigated', onNavigated);
    try {
      const result = await fn(page, arm);
      const failed = failure();
      if (failed) throw failed;
      return result;
    } catch (e) {
      throw failure() ?? e;
    } finally {
      if (this.currentPage === page) this.currentPage = null;
      own.armed = false;
      if (this.scope === own) this.scope = idleScope();
      await page.close().catch(() => {});
    }
  }

  private async openHandoff(info: Omit<HandoffInfo, 'startedAt'>): Promise<void> {
    const old = this.ctx;
    this.ctx = null;
    if (old) await old.close().catch(() => {});
    this._state = 'starting';
    let headed: BrowserContext | null = null;
    let page: Page;
    try {
      headed = await this.launch(this.profileDir, { headless: false });
      page = headed.pages()[0] ?? (await headed.newPage());
    } catch (e) {
      if (headed) await headed.close().catch(() => {});
      await this.launchHeadless().catch(() => {});
      throw new LurkdError('browser_unavailable', `The browser window could not open: ${firstLine(e)}`);
    }
    const h = headed;
    this.handoffCtx = h;
    this.handoffTabs = [];
    this.handoffLastUrl = info.url;
    this._handoff = { ...info, startedAt: new Date().toISOString() };
    this._state = 'handoff';
    // Every tab of the window counts: the one opened or navigated last is the current one, and
    // the handoff ends when the person closes the last of them or quits Chromium.
    const touch = (tab: Page) => {
      if (this.handoffCtx !== h) return;
      this.handoffTabs = [...this.handoffTabs.filter((t) => t !== tab), tab];
      this.handoffLastUrl = tab.url();
    };
    const track = (tab: Page) => {
      if (this.handoffCtx !== h || this.handoffTabs.includes(tab)) return;
      touch(tab);
      tab.on('framenavigated', (frame: Frame) => {
        if (frame === tab.mainFrame() && !tab.isClosed()) touch(tab);
      });
      tab.on('close', () => {
        if (this.handoffCtx !== h) return;
        this.handoffTabs = this.handoffTabs.filter((t) => t !== tab);
        const current = this.handoffTabs.at(-1);
        if (current) this.handoffLastUrl = current.url();
        else void this.endHandoff();
      });
    };
    for (const tab of h.pages()) if (tab !== page) track(tab);
    track(page);
    h.on('page', track);
    h.on('close', () => {
      if (this.handoffCtx === h) void this.endHandoff();
    });
    this.handoffTimer = setTimeout(() => void this.endHandoff(), this.handoffTimeoutMs);
    this.handoffTimer.unref();
    page.goto(info.url).catch(() => {});
  }
}
