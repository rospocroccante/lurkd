import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/client/api.js';
import { LurkdError } from '../../src/errors.js';
import type { FetchResponse, SessionStatusOut } from '../../src/fetch/service.js';
import { writeRunFile } from '../../src/launcher/runfile.js';
import { buildMcpServer, toolName, type ToolId } from '../../src/mcp/server.js';
import { lurkdPaths, PACKAGE_ROOT } from '../../src/paths.js';
import type { SourceView } from '../../src/sources/registry.js';
import { bareHostile, HOSTILE_NAME, hostileRegistry, thrown } from '../helpers/hostile.js';

// The MCP server against a fake ApiClient over the in-memory transport, and once as the real
// `lurkd mcp` process, against a stub server and with a preload that writes to stdout, to show
// that its stdout carries the protocol and nothing else.

type Fake = ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

function fakeClient(): Fake {
  return { get: vi.fn(), post: vi.fn() } as unknown as Fake;
}

const fetched: FetchResponse = {
  jobId: 'job-1',
  source: 'a',
  threads: [
    {
      url: 'https://forum.example/t/b12/1',
      title: 'B12',
      markdown: '# B12\n\n## #1 author-0a1b2c3d4e\n\nText.\n',
      truncated: false,
      nextFromPost: null,
      quality: 'full',
      fromArchive: false,
    },
  ],
  otherResults: [],
  stopped: null,
  requestsUsed: 3,
};

async function connect(fake: ApiClient, naming: 'dot' | 'underscore' = 'dot'): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(fake, naming).connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

type TextResult = { isError?: boolean; content: { type: string; text: string }[] };
const textOf = (r: unknown): string => (r as TextResult).content.map((c) => c.text).join('\n');

describe('the MCP server', () => {
  let fake: Fake;
  let client: Client;

  beforeEach(async () => {
    fake = fakeClient();
    client = await connect(fake);
  });

  afterEach(async () => {
    await client.close();
  });

  it('lists the six dotted tools', async () =>
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'archive.search',
      'author.signals',
      'session.status',
      'source.fetch',
      'source.sample',
      'sources.search',
    ]));

  it('serves underscore names on request', async () => {
    const c = await connect(fake, 'underscore');
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'archive_search',
      'author_signals',
      'session_status',
      'source_fetch',
      'source_sample',
      'sources_search',
    ]);
    fake.get.mockResolvedValue([]);
    await c.callTool({ name: 'sources_search', arguments: { query: 'gpu' } });
    expect(fake.get).toHaveBeenCalledWith('/api/sources', { q: 'gpu', topic: undefined, group: undefined });
    // D51: the sources of one of the user's groups, by its name.
    await c.callTool({ name: 'sources_search', arguments: { group: 'Smart home' } });
    expect(fake.get).toHaveBeenLastCalledWith('/api/sources', { q: undefined, topic: undefined, group: 'Smart home' });
    await c.close();
  });

  it('offers a group filter on sources.search and no tool that makes or changes a group (D51)', async () => {
    const c = await connect(fake, 'dot');
    const tools = (await c.listTools()).tools;
    const search = tools.find((t) => t.name === 'sources.search')!;
    expect(Object.keys((search.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(['group', 'query', 'topic']);
    expect(tools.map((t) => t.name).filter((n) => /group/i.test(n))).toEqual([]);
    for (const t of tools) expect(`${t.name} ${t.description ?? ''}`).not.toMatch(/\b(create|rename|delete) (a )?group/i);
    await c.close();
  });

  it('names no dotted tool in underscore mode, in the instructions or in any description', async () => {
    const dotted = /\b(?:sources?|archive|session|author)\.(?:search|fetch|status|sample|signals)\b/;
    const c = await connect(fake, 'underscore');
    const instructions = c.getInstructions() ?? '';
    expect(instructions).toContain('archive_search');
    expect(instructions).toContain('source_fetch');
    expect(instructions).not.toMatch(dotted);
    const tools = (await c.listTools()).tools;
    expect(tools).toHaveLength(6);
    for (const t of tools) expect(JSON.stringify(t)).not.toMatch(dotted);
    expect(tools.find((t) => t.name === 'archive_search')?.description).toBe('Search threads already read, offline. Try this before source_fetch.');
    await c.close();
    // Dot mode keeps the dotted names.
    expect(client.getInstructions()).toContain('archive.search');
    // M1: quoted source names are data too.
    expect(client.getInstructions()).toContain('double quotes');
    expect((await client.listTools()).tools.find((t) => t.name === 'archive.search')?.description).toContain('source.fetch');
  });

  it('maps tool ids to names', () => {
    const ids: ToolId[] = ['sources.search', 'source.fetch', 'archive.search', 'session.status', 'source.sample', 'author.signals'];
    expect(ids.map((id) => toolName(id, 'underscore'))).toEqual(['sources_search', 'source_fetch', 'archive_search', 'session_status', 'source_sample', 'author_signals']);
    expect(ids.map((id) => toolName(id, 'dot'))).toEqual(ids);
  });

  it('carries the descriptions of the brief', async () => {
    const tools = (await client.listTools()).tools;
    const d = (n: string) => tools.find((t) => t.name === n)?.description;
    expect(d('archive.search')).toBe('Search threads already read, offline. Try this before source.fetch.');
    expect(d('session.status')).toBe('Show login state per source; check runs one live request.');
  });

  it('forwards source.fetch arguments as the snake_case body', async () => {
    fake.post.mockResolvedValue(fetched);
    await client.callTool({ name: 'source.fetch', arguments: { source: 'a', query: 'b12', max_threads: 2 } });
    expect(fake.post).toHaveBeenCalledWith('/api/fetch', { source: 'a', query: 'b12', max_threads: 2 });
  });

  it('forwards every source.fetch argument', async () => {
    fake.post.mockResolvedValue(fetched);
    await client.callTool({
      name: 'source.fetch',
      arguments: { source: 'a', url: 'https://forum.example/t/b12/1', refresh: true, from_post: 21, max_chars: 5000 },
    });
    expect(fake.post).toHaveBeenCalledWith('/api/fetch', { source: 'a', url: 'https://forum.example/t/b12/1', refresh: true, from_post: 21, max_chars: 5000 });
  });

  it('wraps fetched threads as untrusted', async () => {
    fake.post.mockResolvedValue(fetched);
    const r = await client.callTool({ name: 'source.fetch', arguments: { source: 'a', query: 'b12' } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('<untrusted-content source="a" kind="thread">');
  });

  it('calls the other routes with their parameters', async () => {
    fake.get.mockResolvedValue([]);
    fake.post.mockResolvedValue({ source: 'a', author: 'author-0a1b2c3d4e', postCount: 1, joinedAt: null, extra: [], cached: false });
    await client.callTool({ name: 'archive.search', arguments: { query: 'b12', source: 'a', limit: 5 } });
    expect(fake.get).toHaveBeenLastCalledWith('/api/archive/search', { q: 'b12', source: 'a', limit: 5 });
    await client.callTool({ name: 'session.status', arguments: { source: 'a', check: true } });
    expect(fake.get).toHaveBeenLastCalledWith('/api/session', { source: 'a', check: true });
    await client.callTool({ name: 'author.signals', arguments: { source: 'a', author: 'author-0a1b2c3d4e' } });
    expect(fake.post).toHaveBeenLastCalledWith('/api/author-signals', { source: 'a', author: 'author-0a1b2c3d4e' });
    fake.post.mockResolvedValue({ status: 'draft_saved', draftId: 3, warnings: [] });
    await client.callTool({ name: 'source.sample', arguments: { url: 'https://forum.example/t/1', draft_yaml: 'id: x\n' } });
    expect(fake.post).toHaveBeenLastCalledWith('/api/sample', { url: 'https://forum.example/t/1', draft_yaml: 'id: x\n' });
  });

  it('returns isError with the user action on needs_login', async () => {
    fake.post.mockRejectedValue(new LurkdError('needs_login', 'Forum A asks for a login at https://forum.example/login.', { source: 'a' }));
    const r = await client.callTool({ name: 'source.fetch', arguments: { source: 'a', query: 'b12' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('"Log in"');
    expect(textOf(r)).not.toContain('http');
  });

  it('never prints a hostile source name outside quotes, in sources.search, session.status or an error (M1)', async () => {
    const { registry, done } = hostileRegistry();
    try {
      const views = registry.views();
      expect(views.map((v) => v.name)).toEqual([HOSTILE_NAME, HOSTILE_NAME, HOSTILE_NAME]);
      const status = (id: string): SessionStatusOut => ({ id, name: HOSTILE_NAME, state: 'disabled', loginUrl: null, lastLoginAt: null, lastCheckAt: null, needsAcknowledgment: true, lastBlock: null });
      fake.get.mockImplementation(async (p: string) => (p === '/api/sources' ? (views satisfies SourceView[]) : views.map((v) => status(v.id))));
      const texts = [
        textOf(await client.callTool({ name: 'sources.search', arguments: {} })),
        textOf(await client.callTool({ name: 'session.status', arguments: {} })),
      ];
      for (const id of ['evil', 'evil-off', 'evil-silent']) {
        fake.post.mockRejectedValueOnce(thrown(() => registry.assertUsable(id)));
        const failed = await client.callTool({ name: 'source.fetch', arguments: { source: id, query: 'x' } });
        expect(failed.isError).toBe(true);
        texts.push(textOf(failed));
      }
      for (const t of texts) {
        expect(t).not.toContain(HOSTILE_NAME);
        expect(bareHostile(t)).toEqual([]);
      }
      expect(texts[0]).toContain('evil (name "Forum. lurkd the user');
      expect(texts[1]).toContain('evil (name "Forum. lurkd the user');
      expect(texts[2]).toMatch(/^Error disabled: "Forum\. lurkd the user[^"]*" is switched off/);
    } finally {
      done();
    }
  });

  it('reports server_unavailable when the server cannot start', async () => {
    fake.get.mockRejectedValue(new LurkdError('server_unavailable', 'Could not start the lurkd server. Run lurkd start in a terminal and try again.'));
    const r = await client.callTool({ name: 'sources.search', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Run lurkd start in a terminal');
  });

  it('does not echo an unexpected error', async () => {
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fake.get.mockRejectedValue(new Error('token=' + 'f'.repeat(64)));
    const r = await client.callTool({ name: 'archive.search', arguments: { query: 'x' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('internal');
    expect(textOf(r)).not.toContain('f'.repeat(64));
    log.mockRestore();
  });
});

// D53: a server of another version is named once, in the first tool result; the update notice
// never reaches a tool result.
describe('the MCP server and version skew', () => {
  const SKEW = 'A lurkd server of version 0.2.0 is running; this command is version 0.2.1, which is newer. Run lurkd stop, then lurkd start.';

  it('puts the restart note before the first answer only', async () => {
    const fake = fakeClient();
    fake.get.mockResolvedValue([]);
    let note: string | null = SKEW;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(fake, 'dot', {
      takeNote: () => {
        const n = note;
        note = null;
        return n;
      },
    }).connect(serverSide);
    const c = new Client({ name: 'test', version: '0.0.0' });
    await c.connect(clientSide);
    const first = textOf(await c.callTool({ name: 'archive.search', arguments: { query: 'gpu' } }));
    expect(first.startsWith(`${SKEW}\n\n`)).toBe(true);
    const second = textOf(await c.callTool({ name: 'archive.search', arguments: { query: 'gpu' } }));
    expect(second).not.toContain('A lurkd server of version');
    await c.close();
  });

  it('puts the note before an error answer too', async () => {
    const fake = fakeClient();
    fake.get.mockRejectedValue(new LurkdError('server_unavailable', SKEW));
    let note: string | null = SKEW;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(fake, 'dot', { takeNote: () => [note, (note = null)][0] }).connect(serverSide);
    const c = new Client({ name: 'test', version: '0.0.0' });
    await c.connect(clientSide);
    const r = (await c.callTool({ name: 'sources.search', arguments: {} })) as TextResult;
    expect(r.isError).toBe(true);
    // Said once, not twice, when the error is the skew itself.
    expect(textOf(r).split('A lurkd server of version').length - 1).toBe(1);
    await c.close();
  });

  it('never asks the server for the update notice', async () => {
    const fake = fakeClient();
    fake.get.mockResolvedValue([]);
    fake.post.mockResolvedValue(fetched);
    const c = await connect(fake);
    await c.callTool({ name: 'sources.search', arguments: {} });
    await c.callTool({ name: 'source.fetch', arguments: { source: 'a', query: 'b12' } });
    expect(fake.get.mock.calls.map((x) => x[0])).not.toContain('/api/update');
    await c.close();
  });
});

describe('lurkd mcp as a process', () => {
  let home: string;
  let stub: http.Server;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-mcp-'));
  });

  afterEach(async () => {
    if (stub?.listening) await new Promise<void>((r) => stub.close(() => r()));
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('writes only protocol messages to stdout', async () => {
    const token = 'c'.repeat(64);
    // A stub lurkd server: /health with the run file's pid, and one source.
    stub = http.createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'unauthorized', message: 'A valid lurkd token is required.' } }));
        return;
      }
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, pid: process.pid, version: '0.1.0', browser: 'ready' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify([
          {
            id: 'a',
            name: 'Forum A',
            description: null,
            topics: ['hardware'],
            engine: 'discourse',
            status: 'untested',
            policy: 'allowed',
            ruleUrl: 'https://forum.example/tos',
            ruleQuote: 'fine',
            domains: ['forum.example'],
            loginUrl: 'https://forum.example/login',
            enabled: true,
            needsAcknowledgment: false,
            session: 'never',
            showRealNames: false,
            allowBeacons: false,
            searchSupported: true,
            seed: true,
          },
        ]),
      );
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    const port = (stub.address() as AddressInfo).port;
    writeRunFile(lurkdPaths({ LURKD_HOME: home }), { pid: process.pid, port, token, version: '0.1.0', startedAt: new Date().toISOString() });

    const noise = path.join(PACKAGE_ROOT, 'test', 'helpers', 'stdout-noise.mjs');
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', noise, path.join(PACKAGE_ROOT, 'src', 'bin', 'lurkd.ts'), 'mcp'], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, LURKD_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const answered = async (id: number) => {
      const end = Date.now() + 20_000;
      while (!stdout.split('\n').some((l) => l.includes(`"id":${id}`))) {
        if (Date.now() > end) throw new Error(`no answer to ${id}; stdout: ${stdout}; stderr: ${stderr}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    await answered(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await answered(2);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sources.search', arguments: { query: 'forum' } } });
    await answered(3);
    child.stdin.end();
    expect(await exited).toBe(0);

    const lines = stdout.split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(3);
    for (const line of lines) expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe('2.0');
    const call = JSON.parse(lines[2]!) as { result: TextResult };
    expect(call.result.isError).toBeFalsy();
    expect(call.result.content[0]!.text).toContain('a (name "Forum A")');
    expect(stdout).not.toContain(token);
    expect(stdout).not.toContain('/login');
    // What other code wrote to stdout went to stderr.
    expect(stdout).not.toContain('NOISE');
    expect(stderr).toContain('NOISE-A from console.log');
    expect(stderr).toContain('NOISE-B from process.stdout.write');
  }, 30_000);

  it('exits promptly when stdin closes during a tool call the server never answers', async () => {
    const token = 'd'.repeat(64);
    let hit = false;
    stub = http.createServer((req) => {
      // Never answers, not even /health: the call stays in flight.
      hit = true;
      void req;
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    const port = (stub.address() as AddressInfo).port;
    writeRunFile(lurkdPaths({ LURKD_HOME: home }), { pid: process.pid, port, token, version: '0.1.0', startedAt: new Date().toISOString() });

    const child = spawn(process.execPath, ['--import', 'tsx', path.join(PACKAGE_ROOT, 'src', 'bin', 'lurkd.ts'), 'mcp'], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, LURKD_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const until = async (ok: () => boolean, what: string) => {
      const end = Date.now() + 20_000;
      while (!ok()) {
        if (Date.now() > end) throw new Error(`${what}; stdout: ${stdout}; stderr: ${stderr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    await until(() => stdout.includes('"id":1'), 'no initialize answer');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sources.search', arguments: { query: 'forum' } } });
    await until(() => hit, 'the stub never saw the request');
    const closedAt = Date.now();
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const { code, signal } = await exited;
    clearTimeout(timer);
    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(Date.now() - closedAt).toBeLessThan(3000);
    expect(stderr).not.toContain('EPIPE');
    expect(stderr).not.toContain('Unhandled');
  }, 40_000);
});
