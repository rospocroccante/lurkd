import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright';
import { LurkdError } from '../errors.js';
import { ensureHome, PACKAGE_ROOT, type LurkdPaths } from '../paths.js';
import { readRunFile, removeRunFile, type RunInfo } from './runfile.js';

// Starts the detached server once per machine and finds it again. Two callers that race end with
// one server: the one that takes `run/start.lock` spawns, the other polls the run file until the
// new server answers /health with its token (Review Focus 5). A run file left by a crashed server
// is replaced; its pid is never signalled unless `ps` shows the command line of our own server.

const DEFAULT_HEALTH_MS = 1_500;
const DEFAULT_WAIT_MS = 20_000;
const POLL_MS = 200;
const STALE_LOCK_MS = 30_000;
/** The lock holder refreshes the lock's mtime this often, so a long browser download keeps it. */
const LOCK_REFRESH_MS = 5_000;
const SHUTDOWN_WAIT_MS = 5_000;
/** After SIGTERM: the server's own close() is bounded at 5 + 10 + 2 s. */
const SIGTERM_WAIT_MS = 20_000;
const EXIT_WAIT_MS = 5_000;
const KILL_WAIT_MS = 2_000;
/** How long a live lurkd server that does not answer gets before the launcher gives up on it. */
const STALLED_RETRY_MS = 5_000;

/** The server entry points whose command line `isOurServer` accepts: the built one, and the source one for development. */
export const SERVER_ENTRIES: readonly string[] = Object.freeze([
  path.join(PACKAGE_ROOT, 'dist', 'server', 'main.js'),
  path.join(PACKAGE_ROOT, 'src', 'server', 'main.ts'),
]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The page's address, with no credential in it: opening it needs a one-time link (`openPage`). */
export function serverUrl(info: RunInfo): string {
  return `http://127.0.0.1:${info.port}/`;
}

/**
 * True when the server on the run file's port answers /health with the run file's token and
 * names the run file's pid: another program on a reused port that happens to answer 200 is not
 * our server.
 */
export async function checkHealth(info: RunInfo, timeoutMs: number = DEFAULT_HEALTH_MS): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return false;
    }
    const body = (await res.json()) as { ok?: unknown; pid?: unknown; version?: unknown } | null;
    return body !== null && typeof body === 'object' && body.ok === true && body.pid === info.pid && typeof body.version === 'string';
  } catch {
    return false;
  }
}

/** The run file's server when it answers, else null. */
async function healthyServer(paths: LurkdPaths): Promise<RunInfo | null> {
  const info = readRunFile(paths);
  if (info === null) return null;
  return (await checkHealth(info)) ? info : null;
}

const sameServer = (a: RunInfo | null, b: RunInfo): boolean => a !== null && a.pid === b.pid && a.port === b.port && a.token === b.token;

// ---- the start lock ----

interface Lock {
  release(): void;
}

/** The pid written in a lock, or null when the lock holds none (yet). */
function lockPid(content: string): number | null {
  const m = /^(\d+) /.exec(content);
  const pid = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Removes the lock when it is older than 30 s, or at once when the pid written in it is dead (a
 * launcher that crashed while starting the server). Two callers can judge the same lock stale; a plain
 * rm by the slower one could then delete the fresh lock the faster one just took. So the stale
 * file is renamed aside first and compared with what was judged stale: a fresh lock caught by
 * mistake is linked back (link never replaces a file that exists).
 */
function removeStaleLock(file: string): void {
  let seen: string;
  try {
    const old = Date.now() - fs.statSync(file).mtimeMs > STALE_LOCK_MS;
    seen = fs.readFileSync(file, 'utf8');
    const pid = lockPid(seen);
    if (!old && (pid === null || isAlive(pid))) return;
  } catch {
    return; // no lock
  }
  const aside = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return; // somebody else moved it first
  }
  try {
    if (fs.readFileSync(aside, 'utf8') !== seen) {
      try {
        fs.linkSync(aside, file);
      } catch {
        // a third caller took the lock in between; theirs stays
      }
    }
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

/** Takes `run/start.lock`, removing it first when it is stale; null when another caller holds it. */
function tryLock(paths: LurkdPaths): Lock | null {
  const file = paths.startLock;
  removeStaleLock(file);
  const mark = `${process.pid} ${crypto.randomBytes(8).toString('hex')}\n`;
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw e;
  }
  try {
    fs.writeSync(fd, mark);
  } finally {
    fs.closeSync(fd);
  }
  const refresh = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(file, now, now);
    } catch {
      // a lock removed under us: the release below leaves the new holder's lock alone
    }
  }, LOCK_REFRESH_MS);
  refresh.unref();
  return {
    release() {
      clearInterval(refresh);
      try {
        // Only our own lock: one that went stale and was taken over belongs to its new holder.
        if (fs.readFileSync(file, 'utf8') === mark) fs.rmSync(file, { force: true });
      } catch {
        // already gone
      }
    },
  };
}

// ---- spawning the server ----

interface Spawned {
  /** The exit code once the child has exited before the server came up, else undefined. */
  exited(): number | null | undefined;
}

/**
 * Spawns `dist/server/main.js` detached in its own session (no controlling terminal), stdin
 * closed, stdout and stderr appended to `logs/server.log` at 0600.
 */
function spawnServer(paths: LurkdPaths): Spawned {
  const main = path.join(PACKAGE_ROOT, 'dist', 'server', 'main.js');
  if (!fs.existsSync(main)) throw new LurkdError('server_unavailable', `The lurkd server is missing from this install (${main}). Reinstall lurkd.`);
  ensureHome(paths);
  const fd = fs.openSync(paths.logFile, 'a', 0o600);
  let code: number | null | undefined;
  try {
    fs.fchmodSync(fd, 0o600);
    const child = spawn(process.execPath, [main], { cwd: paths.home, env: process.env, detached: true, stdio: ['ignore', fd, fd] });
    child.once('error', () => {
      code = null;
    });
    child.once('exit', (c) => {
      code = c;
    });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
  return { exited: () => code };
}

function startFailed(paths: LurkdPaths, why: string): LurkdError {
  return new LurkdError('server_unavailable', `Could not start the lurkd server: ${why}. See ${paths.logFile} for details.`);
}

export interface EnsureServerOptions {
  spawn?: () => void;
  waitMs?: number;
  installBrowser?: () => Promise<void>;
  /** How long a live lurkd server that does not answer gets before the start fails (default 5 s). */
  stalledMs?: number;
}

/**
 * Returns the running server, or starts one and waits for it. Opening the page is `openPage`'s
 * job. Throws `server_unavailable` when no server answers within `waitMs` (default 20 s); the
 * browser download is not counted.
 */
export async function ensureServer(paths: LurkdPaths, opts: EnsureServerOptions = {}): Promise<{ info: RunInfo; started: boolean }> {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const running = await healthyServer(paths);
  if (running) return { info: running, started: false };

  ensureHome(paths);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = tryLock(paths);
    if (lock !== null) {
      try {
        const again = await healthyServer(paths);
        if (again) return { info: again, started: false };
        const left = readRunFile(paths);
        if (left !== null && isOurServer(left.pid)) {
          // Our server is alive but did not answer: give it a few seconds. A second server on the
          // same browser profile is never the way out.
          const end = Date.now() + (opts.stalledMs ?? STALLED_RETRY_MS);
          for (;;) {
            await sleep(POLL_MS);
            const info = await healthyServer(paths);
            if (info) return { info, started: false };
            const now = readRunFile(paths);
            if (now === null || !isOurServer(now.pid)) break;
            if (Date.now() > end)
              throw new LurkdError(
                'server_unavailable',
                `The lurkd server (pid ${now.pid}) is running but does not answer. Run lurkd stop, then lurkd start.`,
              );
          }
        }
        // Whatever is there did not answer with its token: a crashed server, or another program
        // on a reused port.
        removeRunFile(paths);
        await (opts.installBrowser ?? (() => ensureBrowserInstalled((line) => process.stderr.write(`${line}\n`))))();
        let exited: () => number | null | undefined = () => undefined;
        if (opts.spawn) opts.spawn();
        else exited = spawnServer(paths).exited;
        const end = Date.now() + waitMs;
        for (;;) {
          await sleep(POLL_MS);
          const info = await healthyServer(paths);
          if (info) return { info, started: true };
          const code = exited();
          if (code !== undefined) throw startFailed(paths, `the server process exited${code === null ? '' : ` with code ${code}`}`);
          if (Date.now() > end) throw startFailed(paths, `no answer within ${Math.round(waitMs / 1000)} s`);
        }
      } finally {
        lock.release();
      }
    }
    // Another caller is starting the server: wait for it rather than spawning a second one.
    await sleep(POLL_MS);
    const info = await healthyServer(paths);
    if (info) return { info, started: false };
    if (Date.now() > deadline) {
      let holder = '';
      try {
        const pid = lockPid(fs.readFileSync(paths.startLock, 'utf8'));
        if (pid !== null) holder = ` (written by pid ${pid})`;
      } catch {
        // gone in the meantime
      }
      throw new LurkdError(
        'server_unavailable',
        `Could not start the lurkd server: the start lock ${paths.startLock}${holder} blocked this start for ${Math.round(waitMs / 1000)} s and no server came up. ` +
          'If no other lurkd start is running, remove that file and run lurkd start again.',
      );
    }
  }
}

// ---- stopping ----

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: alive, but somebody else's.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ENTRY_RE = new RegExp(`(^|\\s)(${SERVER_ENTRIES.map(escapeRe).join('|')})(\\s|$)`);

/**
 * True only when the pid is alive and `ps` shows the command line of our own server: one of
 * `SERVER_ENTRIES` as a whole argument. A pid reused by `tail -f my-lurkd-notes.txt` does not match.
 */
export function isOurServer(pid: number): boolean {
  if (!isAlive(pid)) return false;
  const r = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return r.status === 0 && typeof r.stdout === 'string' && ENTRY_RE.test(r.stdout.trim());
}

async function waitFor(probe: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (probe()) return true;
    if (Date.now() > end) return false;
    await sleep(100);
  }
}

export interface StopTiming {
  /** Wait for the run file to go after /api/shutdown (default 5 s). */
  shutdownMs: number;
  /** Wait for the process to exit once the run file is gone (default 5 s). */
  exitMs: number;
  /** Wait after SIGTERM (default 20 s: the server's own close() is bounded at 17 s). */
  termMs: number;
  /** Wait after SIGKILL (default 2 s). */
  killMs: number;
}

const STOP_TIMING: StopTiming = { shutdownMs: SHUTDOWN_WAIT_MS, exitMs: EXIT_WAIT_MS, termMs: SIGTERM_WAIT_MS, killMs: KILL_WAIT_MS };

/**
 * Asks the server to shut down through /api/shutdown and waits for its run file to go and its
 * process to exit. A process that stays gets SIGTERM, then SIGKILL, but only when `ps` shows our
 * own server's command line. A run file whose pid is dead or is not our server, and whose server
 * does not answer, is removed and reported as `not_running`. When the process is still alive at
 * the end, or the server still answers, the run file stays and this throws `server_unavailable`
 * naming the pid: `stopped` always means the server is gone.
 */
export async function stopServer(paths: LurkdPaths, timing: Partial<StopTiming> = {}): Promise<'stopped' | 'not_running'> {
  const t = { ...STOP_TIMING, ...timing };
  const info = readRunFile(paths);
  if (info === null) return 'not_running';
  const ours = (): boolean => sameServer(readRunFile(paths), info);
  const exited = (): boolean => !isAlive(info.pid);

  // The only request that carries the token to a port we have not confirmed.
  const healthy = await checkHealth(info);
  if (!healthy && !isOurServer(info.pid)) {
    if (ours()) removeRunFile(paths);
    return 'not_running';
  }

  if (healthy) {
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, {
        method: 'POST',
        headers: { authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(DEFAULT_HEALTH_MS),
      });
      await res.body?.cancel();
      // The run file goes once the browser and the database are closed; the process exits next.
      if (await waitFor(() => !ours(), t.shutdownMs)) await waitFor(exited, t.exitMs);
    } catch {
      // fall through to the signals
    }
  }
  if (!exited() && isOurServer(info.pid)) {
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch {
      // exited in between
    }
    if (!(await waitFor(exited, t.termMs)) && isOurServer(info.pid)) {
      try {
        process.kill(info.pid, 'SIGKILL');
      } catch {
        // exited in between
      }
      await waitFor(exited, t.killMs);
    }
  }
  if (!exited() || (await checkHealth(info))) {
    throw new LurkdError('server_unavailable', `The lurkd server (pid ${info.pid}) did not stop. Its run file stays in ${paths.runFile}.`);
  }
  if (ours()) removeRunFile(paths);
  return 'stopped';
}

// ---- the browser download (D16) ----

export interface BrowserInstallDeps {
  executablePath?: () => string;
  /** Runs `node <args>` and resolves when it exits 0. */
  run?: (args: string[]) => Promise<void>;
}

function runNode(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // stdout goes to stderr too: under `lurkd mcp`, stdout carries the protocol.
    const child = spawn(process.execPath, args, { stdio: ['ignore', 2, 2] });
    child.once('error', reject);
    child.once('exit', (code, signal) => (code === 0 ? resolve() : reject(new Error(`exit ${code ?? signal}`))));
  });
}

/**
 * Downloads Chromium through Playwright's own CLI on the first start, when the browser this
 * Playwright version expects is missing. Output goes to stderr.
 */
export async function ensureBrowserInstalled(log: (line: string) => void, deps: BrowserInstallDeps = {}): Promise<void> {
  let exe = '';
  try {
    exe = (deps.executablePath ?? (() => chromium.executablePath()))();
  } catch {
    // treated as missing
  }
  if (exe !== '' && fs.existsSync(exe)) return;
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  log('lurkd: downloading Chromium for the headless browser (first start only).');
  try {
    await (deps.run ?? runNode)([cli, 'install', 'chromium', '--no-shell']);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new LurkdError('browser_unavailable', `Could not download Chromium (${why}). Run lurkd start again, or check the network.`);
  }
}

// ---- the page ----

/** The shape of a one-time page link of the server on `port` (D52): `/?n=` and 32 bytes in base64url. */
const pageLinkRe = (port: number): RegExp => new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?n=[A-Za-z0-9_-]{43}$`);

/**
 * D52: asks the server for a one-time link to the page, with the token as a Bearer header. The
 * link works once, within 60 seconds; the token is never part of it. Throws `server_unavailable`
 * when the server does not answer with such a link.
 */
export async function mintPageLink(info: RunInfo): Promise<string> {
  const refused = (why: string) => new LurkdError('server_unavailable', `The lurkd server gave no page link (${why}). Run lurkd stop, then lurkd start.`);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}/api/page-link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new LurkdError('server_unavailable', 'The lurkd server stopped answering. Run lurkd start again.');
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw refused(`HTTP ${res.status}`);
  }
  let url: unknown;
  try {
    url = ((await res.json()) as { url?: unknown } | null)?.url;
  } catch {
    throw refused('not JSON');
  }
  if (typeof url !== 'string' || !pageLinkRe(info.port).test(url)) throw refused('not a page link');
  return url;
}

export interface OpenPageOptions {
  /** False for --no-open: the link is only handed back, for the caller to print. */
  open: boolean;
  /** Opens a URL in the system browser and says whether it could; `openInBrowser` unless a test passes its own. */
  openUrl?: (url: string) => boolean;
}

/**
 * `lurkd start` and `lurkd open` (D52): mints a one-time link and, with `open`, opens the browser
 * with it. `opened` is false when the link was not handed to a browser, so the caller prints it.
 */
export async function openPage(info: RunInfo, opts: OpenPageOptions): Promise<{ link: string; opened: boolean }> {
  const link = await mintPageLink(info);
  const opened = opts.open && (opts.openUrl ?? openInBrowser)(link);
  return { link, opened };
}

/** The system opener for a URL: the URL is its only argument. Null on a platform lurkd has none for. */
export function openerCommand(url: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } | null {
  const cmd = platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : null;
  return cmd === null ? null : { cmd, args: [url] };
}

/**
 * Opens the URL in the system browser, detached. False when this platform has no opener or the
 * spawn throws at once; an opener that fails later is not seen.
 */
export function openInBrowser(url: string): boolean {
  const opener = openerCommand(url);
  if (opener === null) return false;
  try {
    const child = spawn(opener.cmd, opener.args, { detached: true, stdio: 'ignore' });
    child.once('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
