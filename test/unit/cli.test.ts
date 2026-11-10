import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/client/api.js';
import { runCommand } from '../../src/cli/commands.js';
import { EXIT_CODE, LurkdError } from '../../src/errors.js';
import type { ArchiveHitOut, AuthorSignalsOut, FetchResponse, SampleOut, SessionStatusOut } from '../../src/fetch/service.js';
import { PACKAGE_ROOT } from '../../src/paths.js';

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
    await runCommand(['search', 'iommu groups', '--source', 'l1t', '--limit', '5'], h.deps);
    expect(h.client.get.mock.calls[2]).toEqual(['/api/archive/search', { q: 'iommu groups', source: 'l1t', limit: 5 }]);
    await runCommand(['author', 'l1t', 'author-0a1b2c3d4e'], h.deps);
    expect(h.client.post.mock.calls[0]).toEqual(['/api/author-signals', { source: 'l1t', author: 'author-0a1b2c3d4e' }]);
    expect(h.out[0]).toBe('No lurkd source matches. Try a broader query or no query.');
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

  it('lists the four lifecycle commands and the six mirror commands in --help', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    for (const c of ['start', 'stop', 'status', 'mcp', 'sources', 'fetch', 'search', 'session', 'sample', 'author']) {
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
});
