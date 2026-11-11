import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkHealth, ensureBrowserInstalled, ensureServer, isOurServer, openerCommand, openPage, SERVER_ENTRIES, serverUrl, stopServer } from '../../src/launcher/launcher.js';
import { readRunFile, writeRunFile, type RunInfo } from '../../src/launcher/runfile.js';
import { ensureHome, lurkdPaths, type LurkdPaths } from '../../src/paths.js';

// The launcher against in-process stub servers: the fake spawn starts a stub that answers /health
// with its token and writes the run file 100 ms later, as the real server does once it listens.

const servers: http.Server[] = [];
const children: ChildProcess[] = [];

const noInstall = async (): Promise<void> => {};

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

/**
 * A stub lurkd: /health with the Bearer token, /api/shutdown removes the run file and ends `pid`
 * (or, with `hang`, accepts the request and does nothing).
 */
async function stubServer(
  paths: LurkdPaths,
  opts: { pid?: number; onShutdown?: () => void; hang?: boolean; pageLink?: (port: number) => string } = {},
): Promise<RunInfo> {
  const token = `${Math.random().toString(16).slice(2)}`.padEnd(64, '0');
  const { server, port } = await listen((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end('{"error":"unauthorized"}');
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, version: '0.1.0', pid: opts.pid ?? process.pid, browser: 'ready' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/page-link') {
      const url = opts.pageLink?.(port) ?? `http://127.0.0.1:${port}/?n=${'N'.repeat(43)}`;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ url, expiresInSeconds: 60 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/shutdown') {
      res.writeHead(202).end('{"ok":true}');
      if (opts.hang) return;
      setTimeout(() => {
        fs.rmSync(paths.runFile, { force: true });
        // A server that has exited no longer answers.
        server.close();
        server.closeAllConnections();
        opts.onShutdown?.();
      }, 20);
      return;
    }
    res.writeHead(404).end();
  });
  return { pid: opts.pid ?? process.pid, port, token, version: '0.1.0', startedAt: new Date().toISOString() };
}

/** A port nothing listens on any more. */
async function deadPort(): Promise<number> {
  const { server, port } = await listen(() => {});
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** A process whose command line does not name lurkd. */
function sleeper(): ChildProcess {
  const c = spawnChild('sleep', ['30'], { stdio: 'ignore' });
  children.push(c);
  return c;
}

/** Some other program on a reused port: 200 and ok to everything, with its own pid. */
async function foreignServer(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const { port } = await listen((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, version: '9.9.9', pid: 1 }));
  });
  return { port, hits };
}

/**
 * A process whose command line carries our server entry as an argument, as the real detached
 * server's does. With `ignoreTerm` it survives SIGTERM.
 */
async function fakeServerProcess(ignoreTerm = false): Promise<ChildProcess> {
  const script = `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000); process.stdout.write('ready\\n');`;
  const c = spawnChild(process.execPath, ['-e', script, SERVER_ENTRIES[0]!], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(c);
  await new Promise<void>((resolve) => c.stdout!.once('data', () => resolve()));
  return c;
}

/** A process that names lurkd in its arguments without being our server. */
async function lurkdNamedProcess(dir: string): Promise<ChildProcess> {
  const notes = path.join(dir, 'my-lurkd-notes.txt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(notes, '');
  const c = spawnChild('tail', ['-f', notes], { stdio: 'ignore' });
  children.push(c);
  await new Promise((r) => setTimeout(r, 100));
  return c;
}

async function deadPid(): Promise<number> {
  const c = spawnChild('true', [], { stdio: 'ignore' });
  await new Promise((r) => c.once('exit', r));
  return c.pid!;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('launcher', () => {
  let home: string;
  let paths: LurkdPaths;
  let spawnCalls: number;
  let spawned: RunInfo[];
  const spawn = (): void => {
    spawnCalls++;
    void stubServer(paths).then((info) => {
      spawned.push(info);
      setTimeout(() => writeRunFile(paths, info), 100);
    });
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-launcher-'));
    paths = lurkdPaths({ LURKD_HOME: home });
    spawnCalls = 0;
    spawned = [];
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('builds the page address from the run file, without the token (D52)', () => {
    expect(serverUrl({ pid: 1, port: 4321, token: 'abc', version: '0.1.0', startedAt: 'x' })).toBe('http://127.0.0.1:4321/');
  });

  it('opens the page with a one-time link the server mints, never with the token (D52)', async () => {
    const info = await stubServer(paths);
    const openUrl = vi.fn(() => true);
    const a = await openPage(info, { open: true, openUrl });
    expect(a).toEqual({ link: `http://127.0.0.1:${info.port}/?n=${'N'.repeat(43)}`, opened: true });
    expect(openUrl.mock.calls).toEqual([[a.link]]);
    expect(a.link).not.toContain(info.token);
    // --no-open: the link only, for the caller to print.
    const b = await openPage(info, { open: false, openUrl });
    expect(b.opened).toBe(false);
    expect(openUrl).toHaveBeenCalledTimes(1);
    // No way to open a browser here: the caller prints the link.
    expect((await openPage(info, { open: true, openUrl: () => false })).opened).toBe(false);
  });

  it('refuses a page link that is not a one-time link of this server', async () => {
    for (const bad of [
      (port: number) => `http://127.0.0.1:${port}/?t=abc`,
      (port: number) => `http://evil.example:${port}/?n=${'N'.repeat(43)}`,
      (port: number) => `http://127.0.0.1:${port + 1}/?n=${'N'.repeat(43)}`,
      (port: number) => `http://127.0.0.1:${port}/?n=short`,
    ]) {
      const info = await stubServer(paths, { pageLink: bad });
      const openUrl = vi.fn(() => true);
      await expect(openPage(info, { open: true, openUrl })).rejects.toMatchObject({ code: 'server_unavailable' });
      expect(openUrl).not.toHaveBeenCalled();
    }
  });

  it('hands the system opener the link alone as its only argument', () => {
    const link = `http://127.0.0.1:4321/?n=${'N'.repeat(43)}`;
    expect(openerCommand(link, 'darwin')).toEqual({ cmd: 'open', args: [link] });
    expect(openerCommand(link, 'linux')).toEqual({ cmd: 'xdg-open', args: [link] });
    expect(openerCommand(link, 'win32')).toBeNull();
  });

  it('checks /health with the Bearer token', async () => {
    const info = await stubServer(paths);
    expect(await checkHealth(info)).toBe(true);
    expect(await checkHealth({ ...info, token: 'f'.repeat(64) })).toBe(false);
    expect(await checkHealth({ ...info, port: await deadPort() })).toBe(false);
  });

  it('refuses a /health answer that names another pid or has no version', async () => {
    const info = await stubServer(paths, { pid: 4242 });
    expect(await checkHealth(info)).toBe(true);
    expect(await checkHealth({ ...info, pid: 4243 })).toBe(false);
    const { port } = await listen((_req, res) => res.writeHead(200).end(JSON.stringify({ ok: true, pid: process.pid })));
    expect(await checkHealth({ ...info, pid: process.pid, port })).toBe(false);
  });

  it('accepts only our server entry as a whole argument', async () => {
    const fake = await fakeServerProcess();
    const named = await lurkdNamedProcess(home);
    expect(isOurServer(fake.pid!)).toBe(true);
    expect(isOurServer(named.pid!)).toBe(false);
    expect(isOurServer(process.pid)).toBe(false);
    expect(isOurServer(await deadPid())).toBe(false);
  });

  it('starts one server when two callers race (Review Focus 5)', async () => {
    const [a, b] = await Promise.all([
      ensureServer(paths, { spawn, installBrowser: noInstall }),
      ensureServer(paths, { spawn, installBrowser: noInstall }),
    ]);
    expect(spawnCalls).toBe(1);
    expect(serverUrl(a.info)).toBe(serverUrl(b.info));
    expect([a.started, b.started].sort()).toEqual([false, true]);
    // The lock is released.
    expect(fs.existsSync(paths.startLock)).toBe(false);
  });

  it('returns the running server without spawning', async () => {
    ensureHome(paths);
    const info = await stubServer(paths);
    writeRunFile(paths, info);
    const r = await ensureServer(paths, { spawn, installBrowser: noInstall });
    expect(r).toEqual({ info, started: false });
    expect(spawnCalls).toBe(0);
  });

  it('replaces a stale run file whose server is gone', async () => {
    ensureHome(paths);
    const stale: RunInfo = { pid: 999_999, port: await deadPort(), token: 'a'.repeat(64), version: '0.1.0', startedAt: new Date().toISOString() };
    writeRunFile(paths, stale);
    const r = await ensureServer(paths, { spawn, installBrowser: noInstall });
    expect(r.started).toBe(true);
    expect(spawnCalls).toBe(1);
    expect(r.info.port).not.toBe(stale.port);
    expect(readRunFile(paths)).toEqual(r.info);
  });

  it('ignores a server that answers without our token', async () => {
    ensureHome(paths);
    const { port } = await listen((_req, res) => res.writeHead(401).end('{"error":"unauthorized"}'));
    writeRunFile(paths, { pid: process.pid, port, token: 'b'.repeat(64), version: '0.1.0', startedAt: new Date().toISOString() });
    const r = await ensureServer(paths, { spawn, installBrowser: noInstall });
    expect(r.started).toBe(true);
    expect(r.info.port).not.toBe(port);
  });

  it('treats a foreign server on the run file port as stale', async () => {
    ensureHome(paths);
    const foreign = await foreignServer();
    writeRunFile(paths, { pid: await deadPid(), port: foreign.port, token: 'e'.repeat(64), version: '0.1.0', startedAt: new Date().toISOString() });
    const r = await ensureServer(paths, { spawn, installBrowser: noInstall });
    expect(r.started).toBe(true);
    expect(r.info.port).not.toBe(foreign.port);
  });

  it('gives a live lurkd server that does not answer a few seconds, then fails without a second server', async () => {
    ensureHome(paths);
    const fake = await fakeServerProcess();
    const stalled: RunInfo = { pid: fake.pid!, port: await deadPort(), token: 'f'.repeat(64), version: '0.1.0', startedAt: new Date().toISOString() };
    writeRunFile(paths, stalled);
    const t0 = Date.now();
    await expect(ensureServer(paths, { spawn, installBrowser: noInstall, stalledMs: 800 })).rejects.toMatchObject({
      code: 'server_unavailable',
      message: expect.stringContaining(`pid ${fake.pid}`),
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
    expect(spawnCalls).toBe(0);
    expect(readRunFile(paths)).toEqual(stalled);
    expect(fs.existsSync(paths.startLock)).toBe(false);
  });

  it('keeps a live lurkd server that answers again during the retry', async () => {
    ensureHome(paths);
    const fake = await fakeServerProcess();
    writeRunFile(paths, { pid: fake.pid!, port: await deadPort(), token: 'f'.repeat(64), version: '0.1.0', startedAt: new Date().toISOString() });
    const back = await stubServer(paths, { pid: fake.pid! });
    setTimeout(() => writeRunFile(paths, back), 400);
    const r = await ensureServer(paths, { spawn, installBrowser: noInstall, stalledMs: 3_000 });
    expect(r).toEqual({ info: back, started: false });
    expect(spawnCalls).toBe(0);
  });

  it('removes a fresh lock at once when the pid in it is dead', async () => {
    ensureHome(paths);
    fs.writeFileSync(paths.startLock, `${await deadPid()} crashed\n`);
    const t0 = Date.now();
    const r = await ensureServer(paths, { spawn, waitMs: 5_000, installBrowser: noInstall });
    expect(r.started).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('names the lock file when a held lock blocks the start', async () => {
    ensureHome(paths);
    fs.writeFileSync(paths.startLock, `${process.pid} other\n`);
    await expect(ensureServer(paths, { spawn, waitMs: 600, installBrowser: noInstall })).rejects.toMatchObject({
      code: 'server_unavailable',
      message: expect.stringContaining(paths.startLock),
    });
    expect(spawnCalls).toBe(0);
  });

  it('removes a lock older than 30 s', async () => {
    ensureHome(paths);
    fs.writeFileSync(paths.startLock, '1 old');
    const past = new Date(Date.now() - 31_000);
    fs.utimesSync(paths.startLock, past, past);
    const r = await ensureServer(paths, { spawn, waitMs: 3_000, installBrowser: noInstall });
    expect(r.started).toBe(true);
    expect(spawnCalls).toBe(1);
  });

  it('waits for the caller that holds a fresh lock instead of spawning', async () => {
    ensureHome(paths);
    fs.writeFileSync(paths.startLock, '1 other');
    const pending = ensureServer(paths, { spawn, installBrowser: noInstall });
    const info = await stubServer(paths);
    setTimeout(() => writeRunFile(paths, info), 300);
    const r = await pending;
    expect(r).toEqual({ info, started: false });
    expect(spawnCalls).toBe(0);
    // Somebody else's lock stays where it is.
    expect(fs.readFileSync(paths.startLock, 'utf8')).toBe('1 other');
  });

  it('fails with server_unavailable when the server never answers, and releases the lock', async () => {
    const install = vi.fn(noInstall);
    await expect(ensureServer(paths, { spawn: () => {}, waitMs: 600, installBrowser: install })).rejects.toMatchObject({
      code: 'server_unavailable',
    });
    expect(install).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(paths.startLock)).toBe(false);
  });

  it('installs the browser only when it starts a server', async () => {
    const install = vi.fn(noInstall);
    await ensureServer(paths, { spawn, installBrowser: install });
    await ensureServer(paths, { spawn, installBrowser: install });
    expect(install).toHaveBeenCalledTimes(1);
  });

  describe('stopServer', () => {
    it('reports not_running without a run file', async () => {
      expect(await stopServer(paths)).toBe('not_running');
    });

    it('asks the server to shut down and waits for it', async () => {
      ensureHome(paths);
      const child = sleeper();
      const info = await stubServer(paths, { pid: child.pid!, onShutdown: () => child.kill('SIGTERM') });
      writeRunFile(paths, info);
      expect(await stopServer(paths)).toBe('stopped');
      expect(readRunFile(paths)).toBeNull();
      expect(alive(child.pid!)).toBe(false);
    });

    it('kills a server that ignores SIGTERM', async () => {
      ensureHome(paths);
      const fake = await fakeServerProcess(true);
      writeRunFile(paths, { pid: fake.pid!, port: await deadPort(), token: 'a'.repeat(64), version: '0.1.0', startedAt: new Date().toISOString() });
      expect(await stopServer(paths, { termMs: 300 })).toBe('stopped');
      expect(fake.signalCode).toBe('SIGKILL');
      expect(alive(fake.pid!)).toBe(false);
      expect(readRunFile(paths)).toBeNull();
    });

    it('fails and keeps the run file when a healthy server ignores the shutdown and its pid is not lurkd', async () => {
      ensureHome(paths);
      const child = sleeper();
      const info = await stubServer(paths, { pid: child.pid!, hang: true });
      writeRunFile(paths, info);
      await expect(stopServer(paths, { shutdownMs: 300 })).rejects.toMatchObject({
        code: 'server_unavailable',
        message: expect.stringContaining(`pid ${child.pid}`),
      });
      expect(readRunFile(paths)).toEqual(info);
      expect(alive(child.pid!)).toBe(true);
      expect(child.signalCode).toBeNull();
    });

    it('does not post the token to a foreign server on the run file port', async () => {
      ensureHome(paths);
      const foreign = await foreignServer();
      writeRunFile(paths, { pid: await deadPid(), port: foreign.port, token: 'b'.repeat(64), version: '0.1.0', startedAt: new Date().toISOString() });
      expect(await stopServer(paths)).toBe('not_running');
      expect(foreign.hits).toEqual(['GET /health']);
      expect(readRunFile(paths)).toBeNull();
    });

    it('never signals a pid whose command line names lurkd elsewhere', async () => {
      ensureHome(paths);
      const named = await lurkdNamedProcess(home);
      writeRunFile(paths, { pid: named.pid!, port: await deadPort(), token: 'c'.repeat(64), version: '0.1.0', startedAt: new Date().toISOString() });
      expect(await stopServer(paths)).toBe('not_running');
      expect(alive(named.pid!)).toBe(true);
      expect(named.signalCode).toBeNull();
    });

    it('removes a stale run file whose pid is dead', async () => {
      ensureHome(paths);
      writeRunFile(paths, { pid: 999_999, port: await deadPort(), token: 'c'.repeat(64), version: '0.1.0', startedAt: new Date().toISOString() });
      expect(await stopServer(paths)).toBe('not_running');
      expect(readRunFile(paths)).toBeNull();
    });

    it('never signals a live pid that is not lurkd', async () => {
      ensureHome(paths);
      const child = sleeper();
      await new Promise((r) => setTimeout(r, 50));
      writeRunFile(paths, { pid: child.pid!, port: await deadPort(), token: 'd'.repeat(64), version: '0.1.0', startedAt: new Date().toISOString() });
      expect(await stopServer(paths)).toBe('not_running');
      expect(readRunFile(paths)).toBeNull();
      expect(alive(child.pid!)).toBe(true);
      expect(child.signalCode).toBeNull();
    });
  });

  describe('ensureBrowserInstalled', () => {
    it('does nothing when Chromium is already installed', async () => {
      const log = vi.fn();
      const run = vi.fn(async () => {});
      const exe = path.join(home, 'chrome');
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(exe, '');
      await ensureBrowserInstalled(log, { executablePath: () => exe, run });
      expect(log).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it("runs Playwright's own installer when Chromium is missing", async () => {
      const log = vi.fn();
      const run = vi.fn(async (_args: string[]) => {});
      await ensureBrowserInstalled(log, { executablePath: () => path.join(home, 'missing', 'chrome'), run });
      expect(log).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledTimes(1);
      const args = run.mock.calls[0]![0];
      expect(args[0]).toMatch(/playwright[\\/]cli\.js$/);
      expect(args.slice(1)).toEqual(['install', 'chromium', '--no-shell']);
    });

    it('reports a failed install as browser_unavailable', async () => {
      const run = vi.fn(async () => {
        throw new Error('exit 1');
      });
      await expect(ensureBrowserInstalled(() => {}, { executablePath: () => '', run })).rejects.toMatchObject({ code: 'browser_unavailable' });
    });
  });
});
