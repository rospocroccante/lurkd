import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../archive/db.js';
import { isNewerVersion, parseStableVersion } from './version.js';

// D53: the server asks the npm registry, at most once a day, which lurkd version is the latest.
// No automatic update: the answer only shows on the page, in `lurkd status` and on one stderr line
// of the CLI. The request is a direct Node request, never through lurkd's browser: no cookie, no
// token, nothing of the user's, only the user agent `lurkd/<version>`. It has a 5 s timeout and
// a size cap, and only a stable semver in the answer counts. A failure is logged once and tried
// again at the next interval. The last good answer and the time of the last attempt live in the
// archive's settings table, next to the page switch, so a restarted server does not ask again the
// same day. No schema step: the archive stays at version 6, and lurkd 0.2.0 still opens it.
// `LURKD_NO_UPDATE_CHECK=1` or the page's "Check for new versions" switch turns it all off.

export const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/lurkd/latest';
export const REGISTRY_TIMEOUT_MS = 5_000;
/** The version document of one release is a few kilobytes; anything far larger is not it. */
export const MAX_REGISTRY_BYTES = 256 * 1024;
export const CHECK_INTERVAL_MS = 24 * 3_600_000;
/** How long after the server starts the first check waits, when the last one is a day old. */
export const FIRST_CHECK_DELAY_MS = 30_000;
/** How often the server looks whether a check is due. */
const TICK_MS = 3_600_000;
/** The settings key of the page switch: "off" when the user turned the check off. */
export const UPDATE_SETTING = 'update_check';
/** The settings keys of the last good answer, its time, and the time of the last attempt. */
export const UPDATE_LATEST_SETTING = 'update_check_latest';
export const UPDATE_CHECKED_AT_SETTING = 'update_check_checked_at';
export const UPDATE_ATTEMPTED_AT_SETTING = 'update_check_attempted_at';
/** The settings key of the version whose banner the user dismissed on the page. */
export const UPDATE_DISMISSED_SETTING = 'update_check_dismissed';

/** A newer version than the running one, and when the registry said so. */
export interface UpdateInfo {
  current: string;
  latest: string;
  checkedAt: string;
}

/** One request: the status and the body, read up to `maxBytes`. Tests pass their own. */
export type RegistryFetch = (
  url: string,
  init: { headers: Record<string, string>; timeoutMs: number; maxBytes: number },
) => Promise<{ status: number; body: string }>;

/** The default request: Node's own fetch, no redirect followed, the body read up to the cap. */
export const nodeRegistryFetch: RegistryFetch = async (url, init) => {
  const signal = AbortSignal.timeout(init.timeoutMs);
  const late = () => new Error(`The registry did not answer within ${Math.round(init.timeoutMs / 1000)} s.`);
  let res: Response;
  try {
    res = await fetch(url, { headers: init.headers, redirect: 'error', credentials: 'omit', signal });
  } catch (e) {
    if (signal.aborted) throw late();
    throw new Error(`The registry could not be reached (${e instanceof Error ? e.message : String(e)}).`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > init.maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`The registry answer is larger than ${init.maxBytes} bytes.`);
        }
        chunks.push(value);
      }
    }
  } catch (e) {
    if (signal.aborted) throw late();
    throw e;
  }
  return { status: res.status, body: Buffer.concat(chunks).toString('utf8') };
};

/** The latest stable version on the registry; throws with a short reason otherwise. */
export async function fetchLatestVersion(opts: { version: string; fetch?: RegistryFetch }): Promise<string> {
  const doFetch = opts.fetch ?? nodeRegistryFetch;
  const r = await doFetch(REGISTRY_LATEST_URL, {
    headers: { accept: 'application/json', 'user-agent': `lurkd/${opts.version}` },
    timeoutMs: REGISTRY_TIMEOUT_MS,
    maxBytes: MAX_REGISTRY_BYTES,
  });
  if (r.status !== 200) throw new Error(`The registry answered with HTTP ${r.status}.`);
  let doc: unknown;
  try {
    doc = JSON.parse(r.body);
  } catch {
    throw new Error('The registry answer is not JSON.');
  }
  const version = typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? (doc as { version?: unknown }).version : undefined;
  if (parseStableVersion(version) === null) throw new Error('The registry answer holds no valid version.');
  return version as string;
}

/** What the archive holds about the update check, and whether it is on. */
export class UpdateStore {
  /** True when `LURKD_NO_UPDATE_CHECK=1`: the page switch cannot turn it on then. */
  readonly offByEnv: boolean;
  private readonly version: string;

  constructor(
    private readonly db: Database.Database,
    opts: { version: string; env?: NodeJS.ProcessEnv },
  ) {
    this.version = opts.version;
    this.offByEnv = (opts.env ?? process.env).LURKD_NO_UPDATE_CHECK === '1';
  }

  /** The page switch "Check for new versions"; on unless the user turned it off. */
  userEnabled(): boolean {
    return getSetting(this.db, UPDATE_SETTING) !== 'off';
  }

  setUserEnabled(on: boolean): void {
    setSetting(this.db, UPDATE_SETTING, on ? null : 'off');
  }

  enabled(): boolean {
    return !this.offByEnv && this.userEnabled();
  }

  stored(): { latest: string | null; checkedAt: string | null; attemptedAt: string | null } {
    return {
      latest: getSetting(this.db, UPDATE_LATEST_SETTING),
      checkedAt: getSetting(this.db, UPDATE_CHECKED_AT_SETTING),
      attemptedAt: getSetting(this.db, UPDATE_ATTEMPTED_AT_SETTING),
    };
  }

  /** The version whose banner the user dismissed on the page, or null. */
  dismissed(): string | null {
    return getSetting(this.db, UPDATE_DISMISSED_SETTING);
  }

  /** Stores the dismissed version; null forgets it. */
  setDismissed(version: string | null): void {
    setSetting(this.db, UPDATE_DISMISSED_SETTING, version);
  }

  /** The newer version, or null when there is none, none is known, or the check is off. */
  info(): UpdateInfo | null {
    if (!this.enabled()) return null;
    const s = this.stored();
    if (s.latest === null || s.checkedAt === null || parseStableVersion(s.latest) === null) return null;
    return isNewerVersion(s.latest, this.version) ? { current: this.version, latest: s.latest, checkedAt: s.checkedAt } : null;
  }

  /** A good answer: the version, and the time, which is also the time of the last attempt. */
  recordSuccess(latest: string, at: string): void {
    this.db.transaction(() => {
      setSetting(this.db, UPDATE_LATEST_SETTING, latest);
      setSetting(this.db, UPDATE_CHECKED_AT_SETTING, at);
      setSetting(this.db, UPDATE_ATTEMPTED_AT_SETTING, at);
    })();
  }

  /** A failed attempt: the last good answer stays. */
  recordAttempt(at: string): void {
    setSetting(this.db, UPDATE_ATTEMPTED_AT_SETTING, at);
  }
}

/** Runs the check in the server: one at a time, at most once per CHECK_INTERVAL_MS. */
export class UpdateChecker {
  private readonly store: UpdateStore;
  private readonly fetchLatest: () => Promise<string>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private running: Promise<'checked' | 'failed'> | null = null;
  /** True after a failure was logged, until the next success: an outage is logged once. */
  private failureLogged = false;
  private timers: NodeJS.Timeout[] = [];
  private ticker: NodeJS.Timeout | null = null;
  private readonly firstDelayMs: number;

  constructor(opts: {
    store: UpdateStore;
    fetchLatest: () => Promise<string>;
    now?: () => number;
    log?: (line: string) => void;
    /** Tests only: the wait before the first look (default FIRST_CHECK_DELAY_MS). */
    firstDelayMs?: number;
  }) {
    this.store = opts.store;
    this.fetchLatest = opts.fetchLatest;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.error(line));
    this.firstDelayMs = opts.firstDelayMs ?? FIRST_CHECK_DELAY_MS;
  }

  /** True when the check is on and the last attempt is CHECK_INTERVAL_MS old, or there was none. */
  due(): boolean {
    if (!this.store.enabled()) return false;
    const last = this.store.stored().attemptedAt;
    const at = last === null ? Number.NaN : Date.parse(last);
    return !Number.isFinite(at) || this.now() - at >= CHECK_INTERVAL_MS || at > this.now() + CHECK_INTERVAL_MS;
  }

  /** One check when one is due and none is running. Never throws. */
  async maybeCheck(): Promise<'checked' | 'failed' | 'skipped'> {
    if (this.running !== null || !this.due()) return 'skipped';
    this.running = this.checkOnce();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  private async checkOnce(): Promise<'checked' | 'failed'> {
    const at = new Date(this.now()).toISOString();
    try {
      const latest = await this.fetchLatest();
      this.store.recordSuccess(latest, at);
      this.failureLogged = false;
      return 'checked';
    } catch (e) {
      try {
        this.store.recordAttempt(at);
      } catch {
        // the archive is closing; the next start tries again
      }
      if (!this.failureLogged) {
        this.failureLogged = true;
        const reason = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200);
        this.log(`lurkd: update check failed, lurkd tries again in 24 hours: ${reason}`);
      }
      return 'failed';
    }
  }

  /** A first look FIRST_CHECK_DELAY_MS after start, then one every hour. */
  start(): void {
    this.stop();
    this.later(this.firstDelayMs);
    this.ticker = setInterval(() => void this.maybeCheck(), TICK_MS);
    this.ticker.unref();
  }

  /** A look soon, for when the page switches the check back on. */
  nudge(): void {
    this.later(this.firstDelayMs);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private later(ms: number): void {
    const t = setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== t);
      void this.maybeCheck();
    }, ms);
    t.unref();
    this.timers.push(t);
  }
}
