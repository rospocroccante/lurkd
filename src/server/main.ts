import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { getSalt, openArchive } from '../archive/db.js';
import { StateStore } from '../archive/state.js';
import { ThreadStore } from '../archive/threads.js';
import { BrowserManager, type LaunchFn } from '../browser/manager.js';
import { FetchQueue } from '../fetch/queue.js';
import { FetchService } from '../fetch/service.js';
import { readRunFile, removeRunFile, writeRunFile } from '../launcher/runfile.js';
import { ensureHome, lurkdPaths, PACKAGE_ROOT, VERSION, type LurkdPaths } from '../paths.js';
import { HostPacer } from '../policy/limiter.js';
import { AddRequestStore, DraftStore, ForbiddenLog, SampleStore } from '../sources/drafts.js';
import { Registry } from '../sources/registry.js';
import { createApp, retentionDays } from './app.js';

// The server process: one archive, one registry, one headless browser, one queue and one pacer
// (Task 8 carry: the per-host spacing spans every job), behind the HTTP app on 127.0.0.1.

/** How long close() waits for the running job to stop before it closes the browser under it. */
const QUEUE_CLOSE_MS = 5_000;
/** How long close() waits for the browser, and then for open connections. */
const BROWSER_CLOSE_MS = 10_000;
const CONNECTIONS_CLOSE_MS = 2_000;
/** Retention also runs while the server stays up, not only at start. */
const RETENTION_EVERY_MS = 6 * 3_600_000;

export interface StartedServer {
  port: number;
  token: string;
  /** The page's address, without the token (D52): the page opens from a one-time link. */
  url: string;
  close(): Promise<void>;
}

function bounded(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  return Promise.race([work.then(() => {}, () => {}), limit]).finally(() => clearTimeout(timer));
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0]!.trim() || 'unknown error';
}

/**
 * Starts the server. A browser that cannot launch leaves its state `error` with `lastError` and
 * the server serves anyway. `close()` stops listening, stops the queue (bounded wait), closes the
 * browser and the database and removes the run file; it runs once, and `/api/shutdown` calls it.
 * `onClose` runs after close() has finished (the process entry point exits there).
 */
export async function startServer(opts: {
  paths: LurkdPaths;
  seedDir?: string;
  uiDir?: string;
  launch?: LaunchFn;
  onClose?: () => void;
  /**
   * Tests only: "Add a forum" may open 127.0.0.1 and localhost, where the fixture forums run.
   * The process entry point below never passes it, and nothing reads it from the environment.
   */
  allowLoopbackForTests?: boolean;
}): Promise<StartedServer> {
  const { paths } = opts;
  ensureHome(paths);
  const db = openArchive(paths.archiveDb);
  let browser: BrowserManager | null = null;
  // Hoisted so a failure after serve() can release the port and the timer too.
  let server: http.Server | null = null;
  let timer: NodeJS.Timeout | null = null;
  try {
    const salt = getSalt(db);
    const state = new StateStore(db);
    const registry = Registry.load({ seedDir: opts.seedDir ?? path.join(PACKAGE_ROOT, 'sources'), userDir: paths.userSourcesDir, state, builtins: true });
    const threads = new ThreadStore(db, salt);
    const applyRetention = () => threads.applyRetention(retentionDays(db), new Date().toISOString());
    applyRetention();
    const samples = new SampleStore(db);
    const drafts = new DraftStore(db, registry, { state });
    const addRequests = new AddRequestStore(db);
    const forbidden = new ForbiddenLog(db);
    const b = new BrowserManager({ profileDir: paths.profileDir, log: (e) => state.logFetch(e), ...(opts.launch ? { launch: opts.launch } : {}) });
    browser = b;
    // Never throws: a failed launch leaves state `error` and the next read tries again.
    await b.start();
    const queue = new FetchQueue();
    const allowLoopbackForTests = opts.allowLoopbackForTests === true;
    const service = new FetchService({ registry, state, threads, samples, drafts, browser: b, queue, pacer: new HostPacer(), salt, allowLoopbackForTests });
    const token = crypto.randomBytes(32).toString('hex');

    let port = 0;
    let closing: Promise<void> | null = null;

    const close = (): Promise<void> => {
      closing ??= (async () => {
        if (timer) clearInterval(timer);
        const srv = server;
        const listening = srv ? new Promise<void>((resolve) => srv.close(() => resolve())) : Promise.resolve();
        srv?.closeIdleConnections();
        // Queued jobs fail with server_unavailable and the running one is told to stop; a request
        // already in flight could run to its page timeout, so the wait is bounded.
        await bounded(queue.close(), QUEUE_CLOSE_MS);
        await bounded(b.close(), BROWSER_CLOSE_MS);
        srv?.closeAllConnections();
        await bounded(listening, CONNECTIONS_CLOSE_MS);
        db.close();
        // Only our own run file: a server started after this one keeps its file.
        const info = readRunFile(paths);
        if (info !== null && info.pid === process.pid && info.port === port) removeRunFile(paths);
        opts.onClose?.();
      })();
      return closing;
    };

    const app = createApp({
      token,
      port: () => port,
      version: VERSION,
      db,
      service,
      registry,
      state,
      threads,
      drafts,
      samples,
      addRequests,
      forbidden,
      browser: b,
      queue,
      uiDir: opts.uiDir ?? path.join(PACKAGE_ROOT, 'ui'),
      shutdown: () => void close(),
      allowLoopbackForTests,
    });

    server = await new Promise<http.Server>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
        port = info.port;
        s.off('error', reject);
        resolve(s as http.Server);
      });
      s.once('error', reject);
    });

    timer = setInterval(() => {
      try {
        applyRetention();
      } catch (e) {
        console.error('lurkd: retention failed:', firstLine(e));
      }
    }, RETENTION_EVERY_MS);
    timer.unref();

    writeRunFile(paths, { pid: process.pid, port, token, version: VERSION, startedAt: new Date().toISOString() });
    return { port, token, url: `http://127.0.0.1:${port}/`, close };
  } catch (e) {
    if (timer) clearInterval(timer);
    const srv = server as http.Server | null;
    if (srv) {
      const listening = new Promise<void>((resolve) => srv.close(() => resolve()));
      srv.closeAllConnections();
      await bounded(listening, CONNECTIONS_CLOSE_MS);
    }
    if (browser) await bounded(browser.close(), BROWSER_CLOSE_MS);
    db.close();
    throw e;
  }
}

/** The detached server process that `lurkd start` spawns. */
async function main(): Promise<void> {
  if (process.platform === 'win32') {
    process.stderr.write('lurkd does not support Windows yet.\n');
    process.exit(1);
  }
  const paths = lurkdPaths();
  ensureHome(paths);
  const log = (line: string): void => {
    try {
      fs.appendFileSync(paths.logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // a log line is never worth stopping the server for
    }
  };
  process.on('uncaughtExceptionMonitor', (e) => log(`uncaught: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));

  let started: StartedServer;
  try {
    started = await startServer({
      paths,
      onClose: () => {
        log('stopped');
        process.exit(0);
      },
    });
  } catch (e) {
    log(`could not start: ${firstLine(e)}`);
    process.exit(1);
  }
  // The token stays out of the log.
  log(`lurkd ${VERSION} listening on 127.0.0.1:${started.port}, pid ${process.pid}`);

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) process.exit(1);
    stopping = true;
    log(`${signal}: shutting down`);
    void started.close();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) void main();
