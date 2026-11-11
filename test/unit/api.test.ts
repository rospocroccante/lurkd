import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, skewMessage } from '../../src/client/api.js';
import { LurkdError } from '../../src/errors.js';
import { writeRunFile } from '../../src/launcher/runfile.js';
import { lurkdPaths, type LurkdPaths } from '../../src/paths.js';

// The API client against in-process stub servers on 127.0.0.1 and a temp LURKD_HOME. The launcher
// is a fake: no test here starts a real server.

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  host: string | undefined;
  body: string;
}

interface Stub {
  port: number;
  seen: Seen[];
  close(): Promise<void>;
}

const servers: Stub[] = [];

async function stubServer(answer: (s: Seen) => { status: number; body: string }): Promise<Stub> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8').on('data', (d: string) => (body += d));
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, host: req.headers.host, body };
      seen.push(s);
      const a = answer(s);
      res.writeHead(a.status, { 'content-type': 'application/json' }).end(a.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const stub: Stub = {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  servers.push(stub);
  return stub;
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const c = spawn('true', [], { stdio: 'ignore' });
  await new Promise((r) => c.once('exit', r));
  return c.pid!;
}

const TOKEN = 'a'.repeat(64);
const ok = (v: unknown) => ({ status: 200, body: JSON.stringify(v) });

let home: string;
let paths: LurkdPaths;

function runFile(port: number, pid: number = process.pid, token: string = TOKEN): void {
  writeRunFile(paths, { pid, port, token, version: '0.1.0', startedAt: new Date().toISOString() });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-api-'));
  paths = lurkdPaths({ LURKD_HOME: home });
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('createApiClient', () => {
  it('sends the token from the run file and the query string', async () => {
    const stub = await stubServer(() => ok([{ id: 'a' }]));
    runFile(stub.port);
    const client = createApiClient(paths, { ensure: vi.fn() });
    expect(await client.get('/api/archive/search', { q: 'gpu pass', source: undefined, limit: 5, check: true })).toEqual([{ id: 'a' }]);
    expect(stub.seen[0]).toMatchObject({ method: 'GET', url: '/api/archive/search?q=gpu+pass&limit=5&check=true', auth: `Bearer ${TOKEN}`, host: `127.0.0.1:${stub.port}` });
  });

  it('posts JSON', async () => {
    const stub = await stubServer(() => ok({ ok: true }));
    runFile(stub.port);
    const client = createApiClient(paths);
    await client.post('/api/fetch', { source: 'a', query: 'b12', max_threads: 2 });
    expect(stub.seen[0]!.method).toBe('POST');
    expect(JSON.parse(stub.seen[0]!.body)).toEqual({ source: 'a', query: 'b12', max_threads: 2 });
  });

  it('reads the run file on every call', async () => {
    const one = await stubServer(() => ok(1));
    const two = await stubServer(() => ok(2));
    runFile(one.port);
    const client = createApiClient(paths);
    expect(await client.get('/x')).toBe(1);
    runFile(two.port, process.pid, 'b'.repeat(64));
    expect(await client.get('/x')).toBe(2);
    expect(two.seen[0]!.auth).toBe(`Bearer ${'b'.repeat(64)}`);
  });

  it('turns an error body into a LurkdError', async () => {
    const stub = await stubServer(() => ({
      status: 409,
      body: JSON.stringify({ error: { code: 'needs_login', message: 'Log in first.', details: { source: 'a' } } }),
    }));
    runFile(stub.port);
    const err = await createApiClient(paths).get('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LurkdError);
    expect(err).toMatchObject({ code: 'needs_login', message: 'Log in first.', details: { source: 'a' } });
  });

  it('replaces the run-file token in a lurkd-shaped error body (message and details, recursively)', async () => {
    const stub = await stubServer(() => ({
      status: 401,
      body: JSON.stringify({
        error: {
          code: 'unauthorized',
          message: `Bad token ${TOKEN}, I repeat ${TOKEN}.`,
          details: { echoed: TOKEN, nested: { list: [`x ${TOKEN} y`, 3, { deep: `Bearer ${TOKEN}` }] }, n: 1 },
        },
      }),
    }));
    runFile(stub.port);
    const err = (await createApiClient(paths).get('/x').catch((e: unknown) => e)) as LurkdError;
    expect(err).toBeInstanceOf(LurkdError);
    expect(err.code).toBe('unauthorized');
    expect(err.message).toBe('Bad token <token>, I repeat <token>.');
    expect(err.details).toEqual({ echoed: '<token>', nested: { list: ['x <token> y', 3, { deep: 'Bearer <token>' }] }, n: 1 });
    expect(JSON.stringify(err.details) + err.message).not.toContain(TOKEN);
  });

  it('abandons an in-flight call when its signal aborts, and sends nothing when it is aborted already', async () => {
    const held: http.IncomingMessage[] = [];
    const server = http.createServer((req) => void held.push(req)); // never answers
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    servers.push({
      port: 0,
      seen: [],
      close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
    });
    runFile((server.address() as AddressInfo).port);
    const ac = new AbortController();
    const client = createApiClient(paths, { signal: ac.signal });
    const pending = client.get('/x').catch((e: unknown) => e);
    const end = Date.now() + 5000;
    while (held.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(held).toHaveLength(1);
    ac.abort();
    const err = (await pending) as LurkdError;
    expect(err).toBeInstanceOf(LurkdError);
    expect(err.code).toBe('server_unavailable');
    // Already aborted: no request leaves.
    const again = (await client.get('/y').catch((e: unknown) => e)) as LurkdError;
    expect(again.code).toBe('server_unavailable');
    expect(held).toHaveLength(1);
  });

  it('maps an unknown error code to internal', async () => {
    const stub = await stubServer(() => ({ status: 500, body: JSON.stringify({ error: { code: 'weird', message: 'odd' } }) }));
    runFile(stub.port);
    await expect(createApiClient(paths).get('/x')).rejects.toMatchObject({ code: 'internal' });
  });

  it('rejects an answer that is not lurkd JSON', async () => {
    const stub = await stubServer(() => ({ status: 502, body: '<html>bad gateway</html>' }));
    runFile(stub.port);
    const err = (await createApiClient(paths).get('/x').catch((e: unknown) => e)) as LurkdError;
    expect(err.code).toBe('server_unavailable');
    expect(err.message).not.toContain('bad gateway');
  });

  it('retries once through the launcher on a refused connection', async () => {
    const live = await stubServer(() => ok('up'));
    runFile(await closedPort());
    const ensure = vi.fn(async () => runFile(live.port));
    expect(await createApiClient(paths, { autoStart: true, ensure }).get('/x')).toBe('up');
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('starts the server when the run file is missing', async () => {
    const live = await stubServer(() => ok('up'));
    const ensure = vi.fn(async () => runFile(live.port));
    expect(await createApiClient(paths, { autoStart: true, ensure }).get('/x')).toBe('up');
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('starts the server when the run file names a dead process, without calling the old port', async () => {
    const old = await stubServer(() => ok('stale'));
    const live = await stubServer(() => ok('up'));
    runFile(old.port, await deadPid());
    const ensure = vi.fn(async () => runFile(live.port));
    expect(await createApiClient(paths, { autoStart: true, ensure }).get('/x')).toBe('up');
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(old.seen).toHaveLength(0);
  });

  it('does not start anything without autoStart', async () => {
    runFile(await closedPort());
    const ensure = vi.fn();
    const err = (await createApiClient(paths, { ensure }).get('/x').catch((e: unknown) => e)) as LurkdError;
    expect(err.code).toBe('server_unavailable');
    expect(err.message).toContain('lurkd start');
    expect(ensure).not.toHaveBeenCalled();
    fs.rmSync(paths.runFile);
    await expect(createApiClient(paths, { ensure }).get('/x')).rejects.toMatchObject({ code: 'server_unavailable' });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('throws server_unavailable when the server cannot start', async () => {
    runFile(await closedPort());
    const ensure = vi.fn(async () => {
      throw new LurkdError('server_unavailable', `Could not start the lurkd server: no answer within 20 s. See ${paths.logFile} for details.`);
    });
    const err = (await createApiClient(paths, { autoStart: true, ensure }).get('/x').catch((e: unknown) => e)) as LurkdError;
    expect(err.code).toBe('server_unavailable');
    expect(err.message).toBe('Could not start the lurkd server. Run lurkd start in a terminal and try again.');
  });

  it('retries only once', async () => {
    const port = await closedPort();
    runFile(port);
    const ensure = vi.fn(async () => runFile(port));
    const err = (await createApiClient(paths, { autoStart: true, ensure }).get('/x').catch((e: unknown) => e)) as LurkdError;
    expect(err.code).toBe('server_unavailable');
    expect(err.message).toBe('Could not start the lurkd server. Run lurkd start in a terminal and try again.');
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error answer', async () => {
    const stub = await stubServer(() => ({ status: 429, body: JSON.stringify({ error: { code: 'run_cap', message: 'cap' } }) }));
    runFile(stub.port);
    const ensure = vi.fn();
    await expect(createApiClient(paths, { autoStart: true, ensure }).post('/api/fetch', {})).rejects.toMatchObject({ code: 'run_cap' });
    expect(ensure).not.toHaveBeenCalled();
    expect(stub.seen).toHaveLength(1);
  });

  it('never puts the token in an error', async () => {
    const stub = await stubServer(() => ({ status: 401, body: JSON.stringify({ error: { code: 'unauthorized', message: 'A valid lurkd token is required.' } }) }));
    runFile(stub.port);
    const err = (await createApiClient(paths).get('/x').catch((e: unknown) => e)) as LurkdError;
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(TOKEN);
  });
});

// D53: a server started by another lurkd version.
describe('version skew', () => {
  const SKEW = 'A lurkd server of version 0.1.0 is running; this command is version 0.2.1, which is newer. Run lurkd stop, then lurkd start.';

  // M1: the advice depends on which side is older.
  it('tells an older client to restart the agent session or run the new lurkd, not to restart the server', () => {
    const m = skewMessage('0.2.2', '0.2.1');
    expect(m).toBe(
      'This lurkd is version 0.2.1, older than the running lurkd server (version 0.2.2). If an agent runs it as lurkd mcp, restart the agent session so it loads the new version; in a terminal, run the new lurkd.',
    );
    expect(m).not.toContain('lurkd stop');
    // A pre-release is older than its release.
    expect(skewMessage('0.3.0', '0.3.0-beta.1')).toContain('older than the running lurkd server');
  });

  it('tells a newer client to restart the older server', () => {
    expect(skewMessage('0.1.0', '0.2.1')).toBe(SKEW);
    expect(skewMessage('0.2.1', '0.2.10')).toContain('Run lurkd stop, then lurkd start.');
  });

  it('falls back to the restart advice when a version does not parse', () => {
    expect(skewMessage('weird', '0.2.1')).toBe('A lurkd server of version weird is running; this command is version 0.2.1. Run lurkd stop, then lurkd start.');
  });

  // L1: the caller that printed the skew line gets an error that does not repeat it.
  it('does not repeat the skew line in the error when onSkew has told it', async () => {
    const stub = await stubServer(() => ({ status: 404, body: JSON.stringify({ error: { code: 'not_found', message: 'No such route.' } }) }));
    runFile(stub.port);
    const onSkew = vi.fn();
    const err = (await createApiClient(paths, { version: '0.2.1', onSkew }).get('/api/new-thing').catch((e: unknown) => e)) as LurkdError;
    expect(onSkew).toHaveBeenCalledWith(SKEW);
    expect(err.code).toBe('server_unavailable');
    expect(err.message).toBe('The running lurkd server (version 0.1.0) does not know this request.');
  });

  it('says so once when the running server has another version', async () => {
    const stub = await stubServer(() => ok([]));
    runFile(stub.port);
    const onSkew = vi.fn();
    const client = createApiClient(paths, { version: '0.2.1', onSkew });
    await client.get('/api/sources');
    await client.get('/api/sources');
    await client.post('/api/fetch', {});
    expect(onSkew).toHaveBeenCalledTimes(1);
    expect(onSkew).toHaveBeenCalledWith(SKEW);
  });

  it('says nothing when the versions match', async () => {
    const stub = await stubServer(() => ok([]));
    runFile(stub.port);
    const onSkew = vi.fn();
    await createApiClient(paths, { version: '0.1.0', onSkew }).get('/api/sources');
    expect(onSkew).not.toHaveBeenCalled();
  });

  it('gives the restart message instead of "No such route" from an older server', async () => {
    const stub = await stubServer(() => ({ status: 404, body: JSON.stringify({ error: { code: 'not_found', message: 'No such route.' } }) }));
    runFile(stub.port);
    const err = (await createApiClient(paths, { version: '0.2.1' }).get('/api/new-thing').catch((e: unknown) => e)) as LurkdError;
    expect(err).toBeInstanceOf(LurkdError);
    expect(err.code).toBe('server_unavailable');
    expect(err.message).toBe(SKEW);
  });

  it('keeps "No such route" when the versions match, and any other not_found as it is', async () => {
    const stub = await stubServer((s) =>
      s.url === '/gone'
        ? { status: 404, body: JSON.stringify({ error: { code: 'not_found', message: 'No such route.' } }) }
        : { status: 404, body: JSON.stringify({ error: { code: 'not_found', message: 'No thread has the id 3.' } }) },
    );
    runFile(stub.port);
    expect(await createApiClient(paths, { version: '0.1.0' }).get('/gone').catch((e: unknown) => e)).toMatchObject({ code: 'not_found', message: 'No such route.' });
    expect(await createApiClient(paths, { version: '0.2.1' }).get('/x').catch((e: unknown) => e)).toMatchObject({ code: 'not_found', message: 'No thread has the id 3.' });
  });
});
