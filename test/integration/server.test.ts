import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { playwrightLaunch, type LaunchFn } from '../../src/browser/manager.js';
import { readRunFile } from '../../src/launcher/runfile.js';
import { lurkdPaths, VERSION, type LurkdPaths } from '../../src/paths.js';
import { startServer } from '../../src/server/main.js';
import { fixture, pageCookie } from '../helpers/common.js';
import { html, startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

// A real server on 127.0.0.1 with a real Chromium, always headless. The sample handoff test passes
// a launch function that forces headless, so even the handoff window never shows.

type Started = Awaited<ReturnType<typeof startServer>>;

let fixtures: FixtureServer;
const homes: string[] = [];
const running: Started[] = [];

function tempHome(): { paths: LurkdPaths; seedDir: string; uiDir: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-server-'));
  homes.push(home);
  const seedDir = path.join(home, 'seed');
  const uiDir = path.join(home, 'ui-files');
  fs.mkdirSync(seedDir);
  fs.mkdirSync(uiDir);
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>lurkd</title>');
  for (const f of ['app.js', 'view.js', 'app.css']) fs.writeFileSync(path.join(uiDir, f), '');
  return { paths: lurkdPaths({ LURKD_HOME: home }), seedDir, uiDir };
}

async function start(opts: { launch?: LaunchFn; allowLoopbackForTests?: boolean } = {}): Promise<{ s: Started; paths: LurkdPaths }> {
  const { paths, seedDir, uiDir } = tempHome();
  const s = await startServer({ paths, seedDir, uiDir, ...opts });
  running.push(s);
  return { s, paths };
}

/** A raw request, so the test controls the Host header. */
function rawGet(port: number, p: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** The TCP ports this process listens on, from lsof. */
function listeningPorts(): Set<string> {
  const r = spawnSync('lsof', ['-nP', '-a', '-p', String(process.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
  return new Set(r.stdout.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)));
}

beforeAll(async () => {
  fixtures = await startFixtureServer({ '/threads/sample.55/': html(fixture('sample/page.html')) });
});

afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});

afterAll(async () => {
  await fixtures?.close();
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});

describe('startServer', () => {
  it('starts, writes the run file, reports a ready browser and cleans up on close', async () => {
    const { s, paths } = await start();
    expect(s.url).toBe(`http://127.0.0.1:${s.port}/`);
    expect(s.token).toMatch(/^[0-9a-f]{64}$/);
    const info = readRunFile(paths);
    expect(info).toMatchObject({ pid: process.pid, port: s.port, token: s.token, version: VERSION });
    expect(fs.statSync(paths.runFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.archiveDb).mode & 0o777).toBe(0o600);

    const health = await fetch(`http://127.0.0.1:${s.port}/health`, { headers: { authorization: `Bearer ${s.token}` } });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: VERSION, pid: process.pid, browser: 'ready' });

    // DNS rebinding: the right socket, a foreign Host header.
    expect((await rawGet(s.port, '/health', { host: `evil.example:${s.port}`, authorization: `Bearer ${s.token}` })).status).toBe(403);
    expect((await rawGet(s.port, '/health', { host: `localhost:${s.port}`, authorization: `Bearer ${s.token}` })).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${s.port}/health`)).status).toBe(401);

    await s.close();
    running.splice(running.indexOf(s), 1);
    expect(readRunFile(paths)).toBeNull();
    await expect(fetch(`http://127.0.0.1:${s.port}/health`)).rejects.toThrow();
    // A second close is a no-op.
    await s.close();
  });

  it('keeps serving when the browser cannot start', async () => {
    const failing: LaunchFn = async () => {
      throw new Error('no browser here');
    };
    const { s } = await start({ launch: failing });
    const r = await fetch(`http://127.0.0.1:${s.port}/api/status`, { headers: { authorization: `Bearer ${s.token}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ browser: { state: 'error', lastError: 'no browser here' }, queueLength: 0, attention: [] });
  });

  it('releases the port when startup fails after listening', async () => {
    const { paths, seedDir, uiDir } = tempHome();
    // A folder where the run file goes: the rename into place fails after serve() has bound the port.
    fs.mkdirSync(paths.runFile, { recursive: true });
    fs.writeFileSync(path.join(paths.runFile, 'keep'), '');
    const failing: LaunchFn = async () => {
      throw new Error('no browser here');
    };
    const before = listeningPorts();
    await expect(startServer({ paths, seedDir, uiDir, launch: failing })).rejects.toThrow();
    expect([...listeningPorts()].filter((p) => !before.has(p))).toEqual([]);
  });

  it('runs a sample request through the page handoff (headless) and back', async () => {
    const headless: LaunchFn = (dir) => playwrightLaunch(dir, { headless: true });
    // M2: a sample request is recorded under the address rules of "Analyse"; the fixture forum is on 127.0.0.1.
    const { s } = await start({ launch: headless, allowLoopbackForTests: true });
    const base = `http://127.0.0.1:${s.port}`;
    const auth = { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' };
    const url = `${fixtures.origin}/threads/sample.55/`;

    const asked = await fetch(`${base}/api/sample`, { method: 'POST', headers: auth, body: JSON.stringify({ url }) });
    expect(((await asked.json()) as { status: string }).status).toBe('needs_user');

    const cookie = await pageCookie(s.port, s.token);
    const uiHeaders = { cookie, origin: base, 'content-type': 'application/json' };

    const state = async () => (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()) as { browser: { state: string }; samplesPending: { host: string }[] };
    expect((await state()).samplesPending.map((p) => p.host)).toEqual(['127.0.0.1']);

    const opened = await fetch(`${base}/api/sample-requests/open`, { method: 'POST', headers: uiHeaders, body: JSON.stringify({ host: '127.0.0.1' }) });
    expect(opened.status).toBe(200);
    expect((await state()).browser.state).toBe('handoff');

    // The window navigates on its own; capture once it shows the requested host.
    let out: { status?: string; structure?: string } = {};
    for (let i = 0; i < 20 && out.status !== 'sampled'; i++) {
      const r = await fetch(`${base}/api/sample-requests/capture`, { method: 'POST', headers: uiHeaders, body: '{}' });
      out = (await r.json()) as typeof out;
      if (out.status !== 'sampled') await new Promise((res) => setTimeout(res, 250));
    }
    expect(out.status).toBe('sampled');
    expect(out.structure).toMatch(/^body/);
    expect((await state()).browser.state).toBe('ready');

    const again = await fetch(`${base}/api/sample`, { method: 'POST', headers: auth, body: JSON.stringify({ url }) });
    expect(await again.json()).toMatchObject({ status: 'sampled', host: '127.0.0.1', structure: out.structure });
  });
});
