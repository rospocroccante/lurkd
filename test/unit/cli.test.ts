import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/client/api.js';
import { runCommand } from '../../src/cli/commands.js';
import { EXIT_CODE, LurkdError } from '../../src/errors.js';
import type { ArchiveHitOut, AuthorSignalsOut, FetchResponse, SampleOut, SessionStatusOut } from '../../src/fetch/service.js';
import { writeRunFile } from '../../src/launcher/runfile.js';
import { lurkdPaths, PACKAGE_ROOT, VERSION } from '../../src/paths.js';
import { bareHostile, HOSTILE_NAME, hostileRegistry, thrown } from '../helpers/hostile.js';

// The CLI mirror against a fake ApiClient, and once as the real bin for the usage and help paths
// that never reach the server.

type Fake = ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

const fetched: FetchResponse = {
  jobId: 'job-1',
  source: 'l1t',
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

interface Harness {
  client: Fake;
  out: string[];
  err: string[];
  readFile: ReturnType<typeof vi.fn>;
  statFile: ReturnType<typeof vi.fn>;
  deps: Parameters<typeof runCommand>[1];
}

function harness(files: Record<string, string> = {}, stats: Record<string, { isFile: boolean; size: number }> = {}): Harness {
  const client = { get: vi.fn(), post: vi.fn() } as unknown as Fake;
  const out: string[] = [];
  const err: string[] = [];
  const readFile = vi.fn((p: string): string => {
    const v = files[p];
    if (v === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
    return v;
  });
  const statFile = vi.fn((p: string): { isFile: boolean; size: number } => {
    const o = stats[p];
    if (o !== undefined) return o;
    const v = files[p];
    if (v === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: 'ENOENT' });
    return { isFile: true, size: Buffer.byteLength(v) };
  });
  return { client, out, err, readFile, statFile, deps: { client, out: (s) => out.push(s), err: (s) => err.push(s), readFile, statFile } };
}

describe('lurkd CLI mirror', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('maps fetch flags to the API body', async () => {
    h.client.post.mockResolvedValue(fetched);
    const code = await runCommand(['fetch', 'l1t', '--query', 'gpu passthrough', '--max-threads', '2'], h.deps);
    expect(code).toBe(0);
    expect(h.client.post).toHaveBeenCalledTimes(1);
    expect(h.client.post.mock.calls[0]).toEqual(['/api/fetch', { source: 'l1t', query: 'gpu passthrough', max_threads: 2 }]);
    expect(Object.keys(h.client.post.mock.calls[0]![1] as object).sort()).toEqual(['max_threads', 'query', 'source']);
    expect(h.out.join('\n')).toContain('<untrusted-content source="l1t" kind="thread">');
  });

  it('maps the other fetch flags', async () => {
    h.client.post.mockResolvedValue(fetched);
    await runCommand(['fetch', 'l1t', '--url', 'https://forum.example/t/b12/1', '--refresh', '--from-post', '5', '--max-chars', '9000'], h.deps);
    expect(h.client.post.mock.calls[0]).toEqual([
      '/api/fetch',
      { source: 'l1t', url: 'https://forum.example/t/b12/1', refresh: true, from_post: 5, max_chars: 9000 },
    ]);
  });

  it('refuses --query with --url', async () => {
    expect(await runCommand(['fetch', 'a', '--query', 'x', '--url', 'y'], h.deps)).toBe(2);
    expect(h.client.post).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('Usage');
  });

  it('refuses fetch without --query or --url, and a missing source', async () => {
    expect(await runCommand(['fetch', 'a'], h.deps)).toBe(2);
    expect(await runCommand(['fetch', '--query', 'x'], h.deps)).toBe(2);
    expect(h.client.post).not.toHaveBeenCalled();
  });

  it('refuses a number flag that is not an integer', async () => {
    expect(await runCommand(['fetch', 'a', '--query', 'x', '--max-threads', 'two'], h.deps)).toBe(2);
    expect(await runCommand(['search', 'x', '--limit', '1.5'], h.deps)).toBe(2);
    expect(h.client.post).not.toHaveBeenCalled();
    expect(h.client.get).not.toHaveBeenCalled();
  });

  it('exits 3 on needs_login and prints the user action', async () => {
    h.client.post.mockRejectedValue(new LurkdError('needs_login', 'Log in at https://forum.example/login', { source: 'l1t', loginUrl: 'https://forum.example/login' }));
    const code = await runCommand(['fetch', 'l1t', '--query', 'x'], h.deps);
    expect(code).toBe(3);
    const err = h.err.join('\n');
    expect(err).toContain('"Log in"');
    expect(err).not.toContain('forum.example');
    expect(h.out).toEqual([]);
  });

  it('exits 4 on run_cap', async () => {
    h.client.post.mockRejectedValue(new LurkdError('run_cap', 'The run hit its request cap.', { source: 'l1t' }));
    expect(await runCommand(['fetch', 'l1t', '--query', 'x'], h.deps)).toBe(4);
    expect(h.err.join('\n')).toContain('run_cap');
  });

  it('returns EXIT_CODE for every error code and never prints details or a token', async () => {
    const token = 'ab'.repeat(32);
    h.client.get.mockRejectedValue(new LurkdError('server_unavailable', 'The lurkd server stopped answering.', { reason: `secret ${token}`, path: '/Users/x/.lurkd/run/server.json' }));
    expect(await runCommand(['sources'], h.deps)).toBe(EXIT_CODE.server_unavailable);
    const err = h.err.join('\n');
    expect(err).not.toContain(token);
    expect(err).not.toContain('server.json');
    expect(err).not.toContain('secret');
  });

  it('does not print an unexpected error message', async () => {
    h.client.get.mockRejectedValue(new TypeError('boom with /Users/x/secret'));
    expect(await runCommand(['sources'], h.deps)).toBe(1);
    expect(h.err.join('\n')).not.toContain('secret');
    expect(h.err.join('\n')).toContain('Error internal');
  });

  it('prints raw JSON with --json', async () => {
    h.client.post.mockResolvedValue(fetched);
    expect(await runCommand(['fetch', 'l1t', '--query', 'x', '--json'], h.deps)).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0]!)).toEqual(fetched);
    expect(h.client.post.mock.calls[0]![1]).toEqual({ source: 'l1t', query: 'x' });
  });

  it('prints raw JSON for sources, search, sample and author', async () => {
    const sources = [{ id: 'l1t', name: 'L1T' }];
    h.client.get.mockResolvedValueOnce(sources);
    await runCommand(['sources', '--json'], h.deps);
    expect(JSON.parse(h.out.pop()!)).toEqual(sources);

    const hits: ArchiveHitOut[] = [];
    h.client.get.mockResolvedValueOnce(hits);
    await runCommand(['search', 'x', '--json'], h.deps);
    expect(JSON.parse(h.out.pop()!)).toEqual(hits);

    const sample: SampleOut = { status: 'needs_user', message: 'Open the page.' } as unknown as SampleOut;
    h.client.post.mockResolvedValueOnce(sample);
    await runCommand(['sample', 'https://forum.example/t/1', '--json'], h.deps);
    expect(JSON.parse(h.out.pop()!)).toEqual(sample);

    const signals: AuthorSignalsOut = { source: 'l1t', author: 'author-0a1b2c3d4e', postCount: 3, joinedAt: null, extra: [], cached: false };
    h.client.post.mockResolvedValueOnce(signals);
    await runCommand(['author', 'l1t', 'author-0a1b2c3d4e', '--json'], h.deps);
    expect(JSON.parse(h.out.pop()!)).toEqual(signals);
  });

  it('projects session entries in --json without loginUrl or block urls, keeping the rest', async () => {
    const list: SessionStatusOut[] = [
      {
        id: 'l1t',
        name: 'L1T',
        state: 'expired',
        loginUrl: 'https://forum.example/login',
        lastLoginAt: '2026-11-01T10:00:00.000Z',
        lastCheckAt: '2026-11-08T10:00:00.000Z',
        needsAcknowledgment: false,
        lastBlock: { kind: 'login', url: 'https://forum.example/login?x=1' },
      },
      {
        id: 'b',
        name: 'B',
        state: 'logged_in',
        loginUrl: null,
        lastLoginAt: null,
        lastCheckAt: null,
        needsAcknowledgment: true,
        lastBlock: null,
      } as unknown as SessionStatusOut,
    ];
    h.client.get.mockResolvedValue(list);
    expect(await runCommand(['session', '--json'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).not.toContain('forum.example');
    expect(text).not.toContain('loginUrl');
    expect(JSON.parse(text)).toEqual([
      { id: 'l1t', name: 'L1T', state: 'expired', lastLoginAt: '2026-11-01T10:00:00.000Z', lastCheckAt: '2026-11-08T10:00:00.000Z', needsAcknowledgment: false, block: 'login' },
      { id: 'b', name: 'B', state: 'logged_in', lastLoginAt: null, lastCheckAt: null, needsAcknowledgment: true, block: null },
    ]);
  });

  it('keeps checkError in the session --json projection', async () => {
    const list = [
      {
        id: 'l1t',
        name: 'L1T',
        state: 'logged_in',
        loginUrl: 'https://forum.example/login',
        lastLoginAt: null,
        lastCheckAt: null,
        needsAcknowledgment: false,
        lastBlock: { kind: 'challenge', url: 'https://forum.example/c' },
        checkError: 'timeout',
      },
    ] as unknown as SessionStatusOut[];
    h.client.get.mockResolvedValue(list);
    await runCommand(['session', '--check', '--json'], h.deps);
    const text = h.out.join('\n');
    expect(text).not.toContain('forum.example');
    expect(JSON.parse(text)).toEqual([
      { id: 'l1t', name: 'L1T', state: 'logged_in', lastLoginAt: null, lastCheckAt: null, needsAcknowledgment: false, block: 'challenge', checkError: 'timeout' },
    ]);
  });

  it('drops loginUrl from sources --json and keeps the rest raw', async () => {
    const list = [
      { id: 'l1t', name: 'L1T', ruleUrl: 'https://forum.example/rules', domains: ['forum.example'], loginUrl: 'https://forum.example/login', enabled: true },
    ];
    h.client.get.mockResolvedValue(list);
    expect(await runCommand(['sources', '--json'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).not.toContain('loginUrl');
    expect(text).not.toContain('/login');
    expect(JSON.parse(text)).toEqual([{ id: 'l1t', name: 'L1T', ruleUrl: 'https://forum.example/rules', domains: ['forum.example'], enabled: true }]);
  });

  it('maps session flags and prints the formatted text', async () => {
    h.client.get.mockResolvedValue([]);
    expect(await runCommand(['session', 'l1t', '--check'], h.deps)).toBe(0);
    expect(h.client.get.mock.calls[0]).toEqual(['/api/session', { source: 'l1t', check: true }]);
    expect(h.out.join('\n')).toBe('No lurkd sources.');
    await runCommand(['session'], h.deps);
    expect(h.client.get.mock.calls[1]).toEqual(['/api/session', {}]);
  });

  it('maps sources, search and author', async () => {
    h.client.get.mockResolvedValue([]);
    h.client.post.mockResolvedValue({ source: 'l1t', author: 'a', postCount: 1, joinedAt: null, extra: [], cached: true });
    await runCommand(['sources', 'gpu', '--topic', 'virtualization'], h.deps);
    expect(h.client.get.mock.calls[0]).toEqual(['/api/sources', { q: 'gpu', topic: 'virtualization' }]);
    await runCommand(['sources'], h.deps);
    expect(h.client.get.mock.calls[1]).toEqual(['/api/sources', {}]);
    // D51: --group names one of the user's groups.
    await runCommand(['sources', '--group', 'Smart home'], h.deps);
    expect(h.client.get.mock.calls.at(-1)).toEqual(['/api/sources', { group: 'Smart home' }]);
    h.client.get.mock.calls.pop();
    await runCommand(['search', 'iommu groups', '--source', 'l1t', '--limit', '5'], h.deps);
    expect(h.client.get.mock.calls[2]).toEqual(['/api/archive/search', { q: 'iommu groups', source: 'l1t', limit: 5 }]);
    await runCommand(['author', 'l1t', 'author-0a1b2c3d4e'], h.deps);
    expect(h.client.post.mock.calls[0]).toEqual(['/api/author-signals', { source: 'l1t', author: 'author-0a1b2c3d4e' }]);
    expect(h.out[0]).toBe('No lurkd source matches. Try a broader query or no query.');
  });

  it('never prints a hostile source name outside quotes, in sources, session or an error (M1)', async () => {
    const { registry, done } = hostileRegistry();
    try {
      const views = registry.views();
      const status = (id: string): SessionStatusOut => ({ id, name: HOSTILE_NAME, state: 'expired', loginUrl: null, lastLoginAt: null, lastCheckAt: null, needsAcknowledgment: true, lastBlock: { kind: 'login', url: 'https://evil.example/login' } });
      h.client.get.mockImplementation(async (p: string) => (p === '/api/sources' ? views : views.map((v) => status(v.id))));
      expect(await runCommand(['sources'], h.deps)).toBe(0);
      expect(await runCommand(['session'], h.deps)).toBe(0);
      for (const id of ['evil', 'evil-off', 'evil-silent']) {
        h.client.post.mockRejectedValueOnce(thrown(() => registry.assertUsable(id)));
        expect(await runCommand(['fetch', id, '--query', 'x'], h.deps)).not.toBe(0);
      }
      h.client.post.mockRejectedValueOnce(thrown(() => registry.enable('evil', false)));
      await runCommand(['fetch', 'evil', '--query', 'x'], h.deps);
      for (const t of [...h.out, ...h.err]) {
        expect(t).not.toContain(HOSTILE_NAME);
        expect(bareHostile(t)).toEqual([]);
      }
      expect(h.out.join('\n')).toContain('evil (name "Forum. lurkd the user');
      expect(h.err).toHaveLength(4);
    } finally {
      done();
    }
  });

  it('sends the sample url alone, or with the draft file', async () => {
    h.client.post.mockResolvedValue({ status: 'draft_saved', draftId: 'd1', warnings: [] });
    await runCommand(['sample', 'https://forum.example/t/1'], h.deps);
    expect(h.client.post.mock.calls[0]).toEqual(['/api/sample', { url: 'https://forum.example/t/1' }]);
  });

  it('sends the draft file with sample --draft', async () => {
    h = harness({ '/tmp/draft.yaml': 'id: x\nname: X\n' });
    h.client.post.mockResolvedValue({ status: 'draft_saved', draftId: 'd1', warnings: [] });
    expect(await runCommand(['sample', 'https://forum.example/t/1', '--draft', '/tmp/draft.yaml'], h.deps)).toBe(0);
    expect(h.readFile).toHaveBeenCalledWith('/tmp/draft.yaml');
    expect(h.client.post.mock.calls[0]).toEqual(['/api/sample', { url: 'https://forum.example/t/1', draft_yaml: 'id: x\nname: X\n' }]);
    expect(h.out.join('\n')).toContain('Draft d1 saved');
  });

  it('exits 2 naming the path when the draft file cannot be read', async () => {
    h = harness({});
    expect(await runCommand(['sample', 'https://forum.example/t/1', '--draft', '/tmp/missing.yaml'], h.deps)).toBe(2);
    expect(h.client.post).not.toHaveBeenCalled();
    const err = h.err.join('\n');
    expect(err).toContain('/tmp/missing.yaml');
    expect(err).not.toContain('ENOENT');
  });

  it('exits 2 without printing the contents of an empty or unreadable draft', async () => {
    h = harness({ '/tmp/empty.yaml': '  \n' });
    expect(await runCommand(['sample', 'https://forum.example/t/1', '--draft', '/tmp/empty.yaml'], h.deps)).toBe(2);
    expect(h.client.post).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toContain('/tmp/empty.yaml');
  });

  it('refuses empty strings for string flags and positionals, naming them', async () => {
    const cases: [string[], string][] = [
      [['sources', '--topic', ''], '--topic'],
      [['sources', '--group', ''], '--group'],
      [['sources', ''], 'query'],
      [['search', 'x', '--source', ''], '--source'],
      [['search', ''], 'query'],
      [['session', ''], 'source'],
      [['fetch', '', '--query', 'x'], 'source'],
      [['fetch', 'a', '--query', ''], '--query'],
      [['fetch', 'a', '--url', ''], '--url'],
      [['sample', ''], 'url'],
      [['author', '', 'p'], 'source'],
      [['author', 's', ''], 'pseudonym'],
    ];
    for (const [argv, name] of cases) {
      h = harness();
      expect(await runCommand(argv, h.deps), argv.join(' ')).toBe(2);
      expect(h.err.join('\n'), argv.join(' ')).toContain(name);
      expect(h.err.join('\n')).toContain('empty');
      expect(h.client.get).not.toHaveBeenCalled();
      expect(h.client.post).not.toHaveBeenCalled();
    }
  });

  it('exits 2 with a clear message for an empty --draft path', async () => {
    expect(await runCommand(['sample', 'https://forum.example/t/1', '--draft', ''], h.deps)).toBe(2);
    expect(h.client.post).not.toHaveBeenCalled();
    expect(h.readFile).not.toHaveBeenCalled();
    const err = h.err.join('\n');
    expect(err).toContain('draft path is empty');
    expect(err).not.toContain('Cannot read');
  });

  it('refuses a draft that is not a regular file, without reading it', async () => {
    h = harness({}, { '/tmp/fifo': { isFile: false, size: 0 }, '/tmp/dir': { isFile: false, size: 4096 } });
    for (const p of ['/tmp/fifo', '/tmp/dir']) {
      expect(await runCommand(['sample', 'https://forum.example/t/1', '--draft', p], h.deps)).toBe(2);
      expect(h.err.join('\n')).toContain(p);
    }
    expect(h.err.join('\n')).toContain('regular file');
    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.client.post).not.toHaveBeenCalled();
  });

  it('refuses a draft above 1 MB, without reading it, and accepts exactly 1 MB', async () => {
    h = harness({}, { '/tmp/big.yaml': { isFile: true, size: 1024 * 1024 + 1 }, '/tmp/ok.yaml': { isFile: true, size: 1024 * 1024 } });
    expect(await runCommand(['sample', 'https://forum.example/t/1', '--draft', '/tmp/big.yaml'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('/tmp/big.yaml');
    expect(h.err.join('\n')).toContain('1 MB');
    expect(h.readFile).not.toHaveBeenCalled();
    h.readFile.mockReturnValue('id: x\n');
    h.client.post.mockResolvedValue({ status: 'draft_saved', draftId: 'd1', warnings: [] });
    expect(await runCommand(['sample', 'https://forum.example/t/1', '--draft', '/tmp/ok.yaml'], h.deps)).toBe(0);
  });

  it('exits 2 naming the path when the draft file cannot be statted', async () => {
    expect(await runCommand(['sample', 'https://forum.example/t/1', '--draft', '/tmp/nope.yaml'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('/tmp/nope.yaml');
    expect(h.err.join('\n')).not.toContain('ENOENT');
    expect(h.readFile).not.toHaveBeenCalled();
  });

  it('queues a forum with add and says how to open the page, without asking for anything else (D45)', async () => {
    h.client.post.mockResolvedValue({ status: 'queued', host: 'bench.example', url: 'https://bench.example/' });
    expect(await runCommand(['add', 'https://bench.example/'], h.deps)).toBe(0);
    expect(h.client.post.mock.calls).toEqual([['/api/add', { url: 'https://bench.example/' }]]);
    expect(h.client.get).not.toHaveBeenCalled();
    expect(h.out).toEqual([
      'bench.example is waiting on the lurkd page. Ask the user to run lurkd open, which opens the lurkd page, and press "Analyse" next to bench.example under "Add a forum". lurkd does not open the address until they do.',
    ]);
  });

  it('says so when the host already waits with another address, which lurkd keeps (L4)', async () => {
    h.client.post.mockResolvedValue({ status: 'already_queued', host: 'bench.example', url: 'https://bench.example/forums/' });
    expect(await runCommand(['add', 'https://bench.example/elsewhere/'], h.deps)).toBe(0);
    expect(h.out).toEqual([
      'bench.example is already waiting on the lurkd page with the address https://bench.example/forums/, and lurkd keeps that one. Ask the user to run lurkd open, which opens the lurkd page, and press "Analyse" next to bench.example under "Add a forum", or to dismiss it there before you queue another address.',
    ]);
  });

  it('says how to open the page, and names a known source', async () => {
    h.client.post.mockResolvedValue({ status: 'queued', host: 'bench.example', url: 'https://bench.example/' });
    expect(await runCommand(['add', 'https://bench.example/'], h.deps)).toBe(0);
    expect(h.out.at(-1)).toContain('Ask the user to run lurkd open, which opens the lurkd page, and press "Analyse"');
    h.client.post.mockResolvedValue({ status: 'known', host: 'lg.example', sourceId: 'lg' });
    expect(await runCommand(['add', 'https://lg.example/'], h.deps)).toBe(0);
    expect(h.out.at(-1)).toBe('lg.example is already the lurkd source lg. Read it with lurkd fetch lg.');
    h.client.post.mockResolvedValue({ status: 'known', host: 'lg.example', sourceId: 'lg' });
    expect(await runCommand(['add', 'https://lg.example/', '--json'], h.deps)).toBe(0);
    expect(JSON.parse(h.out.at(-1)!)).toEqual({ status: 'known', host: 'lg.example', sourceId: 'lg' });
  });

  it('passes a refused address on as an error, exit 2', async () => {
    h.client.post.mockRejectedValue(new LurkdError('invalid_request', 'lurkd opens public forums only, not addresses on your own network.'));
    expect(await runCommand(['add', 'https://10.0.0.1/'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('lurkd opens public forums only');
    expect(h.out).toEqual([]);
  });

  it('exits 2 with usage on stderr for unknown flags, commands and wrong argument counts', async () => {
    for (const argv of [
      ['sources', '--nope'],
      ['sources', 'a', 'b'],
      ['search'],
      ['search', 'a', 'b'],
      ['session', 'a', 'b'],
      ['session', '--draft', 'x'],
      ['sample'],
      ['sample', 'u', '--check'],
      ['author', 'a'],
      ['author', 'a', 'b', 'c'],
      ['add'],
      ['add', 'a', 'b'],
      ['add', 'u', '--draft', 'x'],
      ['bogus'],
      [],
    ]) {
      h = harness();
      expect(await runCommand(argv, h.deps), argv.join(' ')).toBe(2);
      expect(h.err.join('\n')).toContain('Usage');
      expect(h.out).toEqual([]);
      expect(h.client.get).not.toHaveBeenCalled();
      expect(h.client.post).not.toHaveBeenCalled();
    }
  });
});

describe('lurkd import reddit (D50)', () => {
  const THREAD = fs.readFileSync(path.join(PACKAGE_ROOT, 'test', 'fixtures', 'reddit', 'thread.json'), 'utf8');
  const LISTING = fs.readFileSync(path.join(PACKAGE_ROOT, 'test', 'fixtures', 'reddit', 'subreddit-listing.json'), 'utf8');
  const imported = {
    source: 'reddit-import',
    threadId: 12,
    url: 'https://www.reddit.com/comments/1k2m3n4/',
    title: 'Zigbee coordinator drops after the update (thanks u/author-0a1b2c3d4e for the first hint)',
    posts: 8,
    comments: 7,
    notInFile: 11,
    replaced: false,
    replacedImportAt: null,
    importedBy: 'lurkd import / API',
    importedAt: '2026-11-10T09:00:00.000Z',
  };

  it('reads the file itself, checks it, and sends its content to the import route', async () => {
    const h = harness({ '/tmp/t.json': THREAD });
    h.client.post.mockResolvedValue(imported);
    expect(await runCommand(['import', 'reddit', '/tmp/t.json'], h.deps)).toBe(0);
    expect(h.statFile).toHaveBeenCalledWith('/tmp/t.json');
    expect(h.client.post).toHaveBeenCalledTimes(1);
    expect(h.client.post.mock.calls[0]).toEqual(['/api/import/reddit', JSON.parse(THREAD)]);
    const out = h.out.join('\n');
    expect(out).toContain('Imported the saved Reddit thread into the archive as thread 12 of reddit-import: 8 posts, the post and 7 comments. 11 more comments were not in the saved file.');
    expect(out).toContain('Read it with lurkd fetch reddit-import --url https://www.reddit.com/comments/1k2m3n4/ (source.fetch with that url), or search it with lurkd search <words> (archive.search).');
    expect(out).toContain('<untrusted-content source="reddit-import" kind="thread">\nTitle: Zigbee coordinator drops after the update (thanks u/author-0a1b2c3d4e for the first hint)\n</untrusted-content>');
    expect(h.err).toEqual([]);
  });

  it('says how many comments of the file were not kept (C5)', async () => {
    const h = harness({ '/tmp/t.json': THREAD });
    h.client.post.mockResolvedValue({ ...imported, posts: 20001, comments: 20000, notKept: 130000, notInFile: 0 });
    expect(await runCommand(['import', 'reddit', '/tmp/t.json'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain(
      'Imported the saved Reddit thread into the archive as thread 12 of reddit-import: 20,001 posts, the post and 20,000 comments. 130,000 more comments in the file were not kept: lurkd keeps the first 20,000 comments of a thread.',
    );
    const one = harness({ '/tmp/t.json': THREAD });
    one.client.post.mockResolvedValue({ ...imported, notKept: 1 });
    expect(await runCommand(['import', 'reddit', '/tmp/t.json'], one.deps)).toBe(0);
    expect(one.out.join('\n')).toContain('11 more comments were not in the saved file. 1 more comment in the file was not kept: lurkd keeps the first 20,000 comments of a thread.');
    // An older server sends no notKept: nothing is said about it.
    const old = harness({ '/tmp/t.json': THREAD });
    old.client.post.mockResolvedValue(imported);
    expect(await runCommand(['import', 'reddit', '/tmp/t.json'], old.deps)).toBe(0);
    expect(old.out.join('\n')).not.toContain('not kept');
  });

  it('says when the import replaced an earlier one, and prints the raw answer with --json', async () => {
    const h = harness({ '/tmp/t.json': THREAD });
    h.client.post.mockResolvedValue({ ...imported, replaced: true, replacedImportAt: '2026-11-09T08:15:00.000Z', notInFile: 0, comments: 1, posts: 2 });
    expect(await runCommand(['import', 'reddit', '/tmp/t.json'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain(
      'Replaced the earlier import of this thread from 2026-11-09 08:15 UTC in the archive (thread 12 of reddit-import): 2 posts, the post and 1 comment. The thread keeps that date in its front matter (replaced).',
    );
    expect(h.out.join('\n')).not.toContain('more comment');
    const j = harness({ '/tmp/t.json': THREAD });
    j.client.post.mockResolvedValue(imported);
    expect(await runCommand(['import', 'reddit', '/tmp/t.json', '--json'], j.deps)).toBe(0);
    expect(JSON.parse(j.out[0]!)).toEqual(imported);
  });

  it('refuses a folder, a missing file and a file over 20 MB without reading or sending it', async () => {
    const h = harness({}, { '/tmp/dir': { isFile: false, size: 96 }, '/tmp/big.json': { isFile: true, size: 20 * 1024 * 1024 + 1 } });
    expect(await runCommand(['import', 'reddit', '/tmp/dir'], h.deps)).toBe(2);
    expect(await runCommand(['import', 'reddit', '/tmp/big.json'], h.deps)).toBe(2);
    expect(await runCommand(['import', 'reddit', '/tmp/missing.json'], h.deps)).toBe(2);
    expect(h.err).toEqual([
      'Error invalid_request: /tmp/dir is not a regular file. lurkd imports one saved thread file per call, not a folder.',
      'Error invalid_request: /tmp/big.json is larger than 20 MB, so lurkd does not import it.',
      'Error invalid_request: Cannot read the file /tmp/missing.json.',
    ]);
    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.client.post).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a Reddit thread before any server call, and never prints its content', async () => {
    const h = harness({ '/tmp/key': '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n', '/tmp/listing.json': LISTING, '/tmp/other.json': '{"a":1}' });
    for (const f of ['/tmp/key', '/tmp/listing.json', '/tmp/other.json']) expect(await runCommand(['import', 'reddit', f], h.deps), f).toBe(2);
    expect(h.err[0]).toMatch(/^Error invalid_request: The file is not JSON\./);
    expect(h.err[1]).toMatch(/^Error invalid_request: The file holds a list of posts, not one thread\./);
    expect(h.err[2]).toMatch(/^Error invalid_request: The file is JSON but not a Reddit thread/);
    expect(h.err.join('\n')).not.toContain('secret');
    expect(h.out).toEqual([]);
    expect(h.client.post).not.toHaveBeenCalled();
  });

  it('takes one kind, reddit, and one file per call', async () => {
    for (const argv of [['import'], ['import', 'reddit'], ['import', 'twitter', '/tmp/t.json'], ['import', 'reddit', '/tmp/a.json', '/tmp/b.json'], ['import', 'reddit', '/tmp/t.json', '--draft', 'x']]) {
      const h = harness({ '/tmp/t.json': THREAD });
      expect(await runCommand(argv, h.deps), argv.join(' ')).toBe(2);
      expect(h.err.join('\n')).toContain('Usage: lurkd import reddit <file> [--json]');
      expect(h.client.post).not.toHaveBeenCalled();
      expect(h.readFile).not.toHaveBeenCalled();
    }
    const h = harness();
    await runCommand(['import', 'twitter', 'x'], h.deps);
    expect(h.err[0]).toBe('lurkd imports Reddit threads only: lurkd import reddit <file>.');
    const two = harness();
    await runCommand(['import', 'reddit', 'a', 'b'], two.deps);
    expect(two.err[0]).toBe('lurkd import reddit takes one file per call, not several and not a pattern.');
  });

  it('passes a server error through with its exit code', async () => {
    const h = harness({ '/tmp/t.json': THREAD });
    h.client.post.mockRejectedValue(new LurkdError('server_unavailable', 'The lurkd server is not running.'));
    expect(await runCommand(['import', 'reddit', '/tmp/t.json'], h.deps)).toBe(1);
    expect(h.err).toEqual(['Error server_unavailable: The lurkd server is not running.']);
  });
});

describe('the lurkd bin', () => {
  const run = (args: string[]) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-cli-'));
    try {
      return spawnSync(process.execPath, ['--import', 'tsx', path.join(PACKAGE_ROOT, 'src', 'bin', 'lurkd.ts'), ...args], {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, LURKD_HOME: home },
        encoding: 'utf8',
        timeout: 30_000,
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  it('lists the four lifecycle commands, the six mirror commands and add in --help', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    for (const c of ['start', 'stop', 'status', 'update', 'mcp', 'sources', 'fetch', 'search', 'session', 'sample', 'author', 'add', 'import']) {
      expect(r.stdout, c).toMatch(new RegExp(`^  ${c}\\b`, 'm'));
    }
  });

  it('exits 2 with usage on stderr for an unknown mirror flag, before any server starts', () => {
    const r = run(['fetch', 'a', '--query', 'x', '--bogus']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Usage');
  });

  it('exits 2 for an unknown command', () => {
    const r = run(['frobnicate']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Unknown command: frobnicate');
  });

  it('exits 2 for an unknown update flag, before it asks the registry', () => {
    const r = run(['update', '--force']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: lurkd update [--yes]');
  });
});

// D53: the bin against a stub server on 127.0.0.1 that a run file of another version points at.
describe('the lurkd bin and a running server', () => {
  const OLD = '0.0.1';
  const update = { current: OLD, latest: '99.0.0', checkedAt: '2026-11-11T09:00:00.000Z' };
  let server: http.Server;
  let home: string;
  let seen: string[];

  beforeEach(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      const json = (v: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      if (req.url === '/health') return json({ ok: true, version: OLD, pid: process.pid, browser: 'ready' });
      if (req.url === '/api/update') return json({ update });
      if (req.url === '/api/status')
        return json({ version: OLD, pid: process.pid, browser: { state: 'ready', lastError: null }, queueLength: 0, attention: [], update });
      if (req.url?.startsWith('/api/archive/search')) return json([]);
      return json({ error: { code: 'not_found', message: 'No such route.' } }, 404);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-cli-run-'));
    const paths = lurkdPaths({ LURKD_HOME: home });
    writeRunFile(paths, { pid: process.pid, port: (server.address() as AddressInfo).port, token: 'c'.repeat(64), version: OLD, startedAt: new Date().toISOString() });
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** The bin, run without blocking this process, which serves the stub. */
  const runAsync = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', path.join(PACKAGE_ROOT, 'src', 'bin', 'lurkd.ts'), ...args], {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, LURKD_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      child.once('exit', (status) => resolve({ status, stdout, stderr }));
    });

  const SKEW = `A lurkd server of version ${OLD} is running; this command is version ${VERSION}, which is newer. Run lurkd stop, then lurkd start.`;

  // L1: a route the older server lacks prints the skew line once, not once more in the error.
  it('prints the skew line once when the older server lacks the route', async () => {
    const r = await runAsync(['sources']);
    expect(r.status).not.toBe(0);
    expect(r.stderr.split(SKEW).length - 1).toBe(1);
    expect(r.stderr).toContain('does not know this request');
  }, 30_000);

  it('names the other version once, then the newer lurkd on one stderr line', async () => {
    const r = await runAsync(['search', 'gpu']);
    expect(r.status).toBe(0);
    expect(r.stderr.split('\n').filter((l) => l !== '')).toEqual([SKEW, 'lurkd 99.0.0 is available: run lurkd update']);
    expect(r.stdout).not.toContain('99.0.0');
    expect(seen).toContain('/api/update');
  }, 30_000);

  it('prints no notice with --json', async () => {
    const r = await runAsync(['search', 'gpu', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
    expect(r.stderr).not.toContain('is available');
    expect(seen).not.toContain('/api/update');
  }, 30_000);

  it('shows the update in lurkd status, and in --json, without a second line', async () => {
    const text = await runAsync(['status']);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('Update: lurkd 99.0.0 is available. Run lurkd update in a terminal to install it.');
    expect(text.stderr).not.toContain('is available');
    expect(text.stderr).toContain(SKEW);
    const json = await runAsync(['status', '--json']);
    expect((JSON.parse(json.stdout) as { update: unknown }).update).toEqual(update);
    expect(json.stderr).not.toContain('is available');
  }, 30_000);
});
