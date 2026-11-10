import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchLogEntry } from '../../src/archive/state.js';
import { BrowserManager } from '../../src/browser/manager.js';
import { PageReader } from '../../src/browser/reader.js';
import type { ExtractContext } from '../../src/extract/engine.js';
import { xenforoAdapter } from '../../src/extract/xenforo.js';
import { nameResolver, renderThread, toRenderInput } from '../../src/output/render.js';
import { lurkdPaths } from '../../src/paths.js';
import { HostPacer, RunLimiter } from '../../src/policy/limiter.js';
import { findLeaks } from '../../src/pseudonym.js';
import type { SourceConfig } from '../../src/sources/schema.js';
import { fixture, range, testSource } from '../helpers/common.js';
import { html, startFixtureServer, type FixtureServer, type Handler } from '../helpers/fixture-server.js';

// Real Chromium, always headless: BrowserManager launches headed only inside beginHandoff,
// which no test here calls. Every request below goes through PageReader.

const SALT = 'e'.repeat(64);
const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin'];
let server: FixtureServer;
let home: string;
let browser: BrowserManager;
let origin = '';
let loggedIn = false;
const log: FetchLogEntry[] = [];
const progress: { postsFetched: number; page?: number }[] = [];

const ENDPOINT = [{ method: 'POST' as const, path: '/search/search', note: 'XenForo search form' }];
const source = (overrides: Partial<SourceConfig> = {}): SourceConfig => testSource({ id: 'test-xenforo', engine: 'xenforo', base_url: origin, ...overrides });

const status = (code: number, body: string): Handler => (_req, res) => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};

// A thread whose page 2 links "next" back to page 1, and one whose next link leaves the thread.
const p1 = fixture('xenforo/thread-p1.html');
const p2 = fixture('xenforo/thread-p2.html');
const loopP1 = p1.replaceAll('/threads/test.55/', '/threads/loop.56/');
const loopP2 = p2.replaceAll('/threads/test.55/', '/threads/loop.56/').replace('href="/threads/loop.56/page-3" class="pageNav-jump pageNav-jump--next"', 'href="/threads/loop.56/" class="pageNav-jump pageNav-jump--next"');
const leaveP1 = p1.replaceAll('/threads/test.55/', '/threads/leave.57/').replace('href="/threads/leave.57/page-2" class="pageNav-jump pageNav-jump--next"', 'href="/threads/elsewhere.58/page-2" class="pageNav-jump pageNav-jump--next"');

function lateMenu(ms: number): string {
  return `<!doctype html><body><p>Forum list.</p><script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<a href="/logout/?t=x">Log out</a>'), ${ms});</script></body>`;
}

function withCtx<T>(jobId: string, src: SourceConfig, fn: (ctx: ExtractContext) => Promise<T>): Promise<T> {
  return browser.withPage({ source: src, jobId }, async (page, arm) => {
    const limiter = new RunLimiter({ minIntervalMs: 0, maxRequestsPerRun: 60, maxRequestsPerDay: 300, deadlineMs: 600_000 }, new HostPacer(), () => 0);
    const reader = new PageReader(page, src, { limiter, log: (e) => log.push(e), jobId, arm });
    return fn({ reader, source: src, onProgress: (p) => progress.push(p) });
  });
}

beforeAll(async () => {
  server = await startFixtureServer({
    '/': (req, res, body) => (loggedIn ? html(fixture('xenforo/search-form.html')) : html('<!doctype html><body><a href="/login/">Log in</a></body>'))(req, res, body),
    '/threads/test.55/': html(p1),
    '/threads/test.55/page-2': html(p2),
    '/threads/test.55/page-3': html(fixture('xenforo/thread-p3.html')),
    '/threads/loop.56/': html(loopP1),
    '/threads/loop.56/page-2': html(loopP2),
    '/threads/leave.57/': html(leaveP1),
    '/threads/elsewhere.58/page-2': html(p2),
    '/threads/missing.59/': status(404, '<!doctype html><html data-template="error"><body><div class="blockMessage">The requested thread could not be found.</div></body></html>'),
    '/threads/plain404.60/': status(404, '<!doctype html><body><p>Not here.</p></body>'),
    '/threads/gone.61/': status(410, '<!doctype html><body><p>Gone.</p></body>'),
    '/members/erin.5/': status(404, '<!doctype html><body><p>Not here.</p></body>'),
    // A visitor menu that arrives after load, as XenForo may load it.
    '/late/': html(lateMenu(500)),
    '/later/': html(lateMenu(1500)),
    '/account/': (req, res, body) =>
      html(`<!doctype html><body><a href="/account/" class="p-navgroup-link--user"${loggedIn ? '' : ' style="display:none"'}>Account</a></body>`)(req, res, body),
    '/search/': html(fixture('xenforo/search-form.html')),
    '/search/search': (_req, res) => {
      res.writeHead(303, { location: '/search/77/?q=board+resets&o=relevance' });
      res.end();
    },
    '/search/77/': html(fixture('xenforo/search-results.html')),
    '/members/alice.1/': html(fixture('xenforo/member.html')),
    '/members/dave.4/': status(404, '<!doctype html><html data-template="error"><body><div class="blockMessage">The requested member could not be found.</div></body></html>'),
  });
  origin = server.origin;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-xenforo-'));
  browser = new BrowserManager({ profileDir: lurkdPaths({ LURKD_HOME: home }).profileDir, log: (e) => log.push(e) });
  await browser.start();
  expect(browser.state).toBe('ready');
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

const pathsSince = (since: number) => server.requests.slice(since).map((r) => `${r.method} ${r.url}`);

describe('xenforoAdapter in headless Chromium', () => {
  it('reads three pages in order with continuous numbering', async () => {
    const since = server.requests.length;
    progress.length = 0;
    const t = await withCtx('thread', source(), (ctx) => xenforoAdapter.fetchThread(ctx, `${origin}/threads/test.55/`));
    expect(t.posts.map((p) => p.number)).toEqual(range(1, 50));
    expect(t.pages).toBe(3);
    expect(t.posts[25]!.notes).toContain('page 2');
    expect(t.posts[25]!.page).toBe(2);
    expect(t).toMatchObject({ url: `${origin}/threads/test.55/`, engine: 'xenforo', postsExpected: null, extraction: 'dom (3 of 3 pages)', quality: 'full' });
    expect(t.title).toBe('Solved Board resets after the firmware update');
    expect(t.posts[0]!.authorUrl).toBe(`${origin}/members/alice.1/`);
    // One navigation per page, nothing else: no avatars, no next link of page 3.
    expect(pathsSince(since)).toEqual(['GET /threads/test.55/', 'GET /threads/test.55/page-2', 'GET /threads/test.55/page-3']);
    expect(log.filter((e) => e.jobId === 'thread').map((e) => [e.kind, new URL(e.url).pathname])).toEqual([
      ['navigate', '/threads/test.55/'],
      ['navigate', '/threads/test.55/page-2'],
      ['navigate', '/threads/test.55/page-3'],
    ]);
    expect(progress).toEqual([
      { postsFetched: 20, page: 1 },
      { postsFetched: 40, page: 2 },
      { postsFetched: 50, page: 3 },
    ]);
  });

  it('stores page-N variants under the canonical thread URL', async () => {
    const since = server.requests.length;
    const again = await withCtx('thread-page', source(), (ctx) => xenforoAdapter.fetchThread(ctx, `${origin}/threads/test.55/page-2#post-1026`));
    expect(again.url).toBe(`${origin}/threads/test.55/`);
    expect(again.posts.map((p) => p.number)).toEqual(range(1, 50));
    expect(pathsSince(since)[0]).toBe('GET /threads/test.55/');
  });

  it('stops at max_pages_per_thread', async () => {
    const since = server.requests.length;
    const capped = await withCtx('capped', source({ pagination: { max_pages_per_thread: 2 } }), (ctx) => xenforoAdapter.fetchThread(ctx, `${origin}/threads/test.55/`));
    expect(capped.pages).toBe(2);
    expect(capped.extraction).toBe('dom (2 of 3 pages)');
    expect(capped.posts.map((p) => p.number)).toEqual(range(1, 40));
    expect(pathsSince(since)).toEqual(['GET /threads/test.55/', 'GET /threads/test.55/page-2']);
  });

  it('never revisits a page and never leaves the thread', async () => {
    let since = server.requests.length;
    const loop = await withCtx('loop', source(), (ctx) => xenforoAdapter.fetchThread(ctx, `${origin}/threads/loop.56/`));
    expect(loop.pages).toBe(2);
    expect(pathsSince(since)).toEqual(['GET /threads/loop.56/', 'GET /threads/loop.56/page-2']);
    since = server.requests.length;
    const leave = await withCtx('leave', source(), (ctx) => xenforoAdapter.fetchThread(ctx, `${origin}/threads/leave.57/`));
    expect(leave.pages).toBe(1);
    expect(leave.extraction).toBe('dom (1 of 3 pages)');
    expect(pathsSince(since)).toEqual(['GET /threads/leave.57/']);
  });

  it('answers not_found for a thread error page', async () => {
    await expect(withCtx('missing', source(), (ctx) => xenforoAdapter.fetchThread(ctx, `${origin}/threads/missing.59/`))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('answers not_found for a 404 or 410 thread without the error template', async () => {
    for (const p of ['/threads/plain404.60/', '/threads/gone.61/']) {
      await expect(withCtx('missing-plain', source(), (ctx) => xenforoAdapter.fetchThread(ctx, `${origin}${p}`))).rejects.toMatchObject({ code: 'not_found' });
    }
  });

  it('pseudonymises quote headers', async () => {
    const own = await withCtx('quotes', source(), (ctx) => xenforoAdapter.fetchThread(ctx, `${origin}/threads/test.55/`));
    const md = renderThread(toRenderInput('test-xenforo', own, '2026-11-09T00:00:00.000Z'), nameResolver({ sourceId: 'test-xenforo', salt: SALT, realNames: false })).markdown;
    expect(md).toMatch(/> author-[0-9a-f]{10} wrote \(post id 1001\):/);
    expect([...findLeaks(md, NAMES)]).toEqual([]);
  });

  it('searches through one armed form POST', async () => {
    const since = server.requests.length;
    const hits = await withCtx('search', source({ read_endpoints: ENDPOINT }), (ctx) => xenforoAdapter.search(ctx, 'board resets', 10));
    expect(hits).toEqual([
      { url: `${origin}/threads/test.55/`, title: 'Board resets after the firmware update', posts: null },
      { url: `${origin}/threads/riser-cable-errors.57/`, title: 'Riser cable errors on a second board', posts: null },
      { url: `${origin}/threads/fan-curve-resets.58/`, title: 'Fan curve resets on reboot', posts: null },
    ]);
    const mine = server.requests.slice(since);
    expect(mine.filter((r) => r.method === 'POST')).toHaveLength(1);
    const post = mine.find((r) => r.method === 'POST')!;
    expect(post.url).toBe('/search/search');
    const form = new URLSearchParams(post.body);
    expect(form.get('keywords')).toBe('board resets');
    // The author field stays empty: no author search (anti-goals).
    expect(form.get('c[users]')).toBe('');
    expect(mine.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /search/', 'POST /search/search', 'GET /search/77/?q=board+resets&o=relevance']);
    expect(log.filter((e) => e.jobId === 'search').map((e) => [e.kind, e.method, new URL(e.url).pathname])).toContainEqual(['form', 'POST', '/search/search']);
    const limited = await withCtx('search-limit', source({ read_endpoints: ENDPOINT }), (ctx) => xenforoAdapter.search(ctx, 'board resets', 1));
    expect(limited).toHaveLength(1);
  });

  it('searches with GET through search_url', async () => {
    const since = server.requests.length;
    const hits = await withCtx('search-get', source({ search_url: `${origin}/search/77/?q={query}&o=relevance` }), (ctx) => xenforoAdapter.search(ctx, 'board resets', 2));
    expect(hits.map((h) => h.url)).toEqual([`${origin}/threads/test.55/`, `${origin}/threads/riser-cable-errors.57/`]);
    expect(pathsSince(since)).toEqual(['GET /search/77/?q=board%20resets&o=relevance']);
  });

  it('refuses POST search without read_endpoints', async () => {
    const since = server.requests.length;
    await expect(withCtx('search-none', source(), (ctx) => xenforoAdapter.search(ctx, 'board', 5))).rejects.toMatchObject({
      code: 'search_unsupported',
      message: 'This XenForo source searches with POST and lists no read_endpoints entry.',
    });
    expect(server.requests.slice(since)).toEqual([]);
  });

  it('refuses a form that posts outside read_endpoints, before sending', async () => {
    const since = server.requests.length;
    const other = source({ read_endpoints: [{ method: 'POST', path: '/find/run', note: 'not the form' }] });
    await expect(withCtx('search-other', other, (ctx) => xenforoAdapter.search(ctx, 'board', 5))).rejects.toMatchObject({ code: 'search_unsupported' });
    expect(server.requests.slice(since).filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('checks the session through the logout link', async () => {
    loggedIn = false;
    expect(await withCtx('session-out', source(), (ctx) => xenforoAdapter.checkSession(ctx))).toBe(false);
    loggedIn = true;
    const since = server.requests.length;
    expect(await withCtx('session-in', source(), (ctx) => xenforoAdapter.checkSession(ctx))).toBe(true);
    // The logout link is read, never followed.
    expect(pathsSince(since)).toEqual(['GET /']);
  });

  it('waits for a visitor menu inserted after load', async () => {
    for (const p of ['/late/', '/later/']) {
      const since = server.requests.length;
      expect(await withCtx(`session-late-${p}`, source({ base_url: `${origin}${p}` }), (ctx) => xenforoAdapter.checkSession(ctx))).toBe(true);
      expect(pathsSince(since)).toEqual([`GET ${p}`]);
    }
  });

  it('honours session_check with a visible logged_in_selector', async () => {
    const checked = source({ session_check: { url: `${origin}/account/`, logged_in_selector: '.p-navgroup-link--user' } });
    loggedIn = true;
    let since = server.requests.length;
    expect(await withCtx('session-check-in', checked, (ctx) => xenforoAdapter.checkSession(ctx))).toBe(true);
    expect(pathsSince(since)).toEqual(['GET /account/']);
    // A match that is hidden is not a session.
    loggedIn = false;
    since = server.requests.length;
    expect(await withCtx('session-check-out', checked, (ctx) => xenforoAdapter.checkSession(ctx))).toBe(false);
    expect(pathsSince(since)).toEqual(['GET /account/']);
  });

  it('reads member stats for author signals', async () => {
    const since = server.requests.length;
    const signals = await withCtx('signals', source(), (ctx) => xenforoAdapter.authorSignals(ctx, { username: 'alice', profileUrl: `${origin}/members/alice.1/` }));
    expect(signals).toEqual({ postCount: 1234, joinedAt: '2019-03-01T10:00:00.000Z', extra: ['solutions 3', 'reaction score 567', 'points 89'] });
    expect(pathsSince(since)).toEqual(['GET /members/alice.1/']);
  });

  it('answers not_found for an unknown member without the name in the error', async () => {
    const err = await withCtx('signals-missing', source(), (ctx) => xenforoAdapter.authorSignals(ctx, { username: 'dave', profileUrl: `${origin}/members/dave.4/?tab=about` })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'not_found' });
    expect(JSON.stringify(err) + String((err as Error).message)).not.toMatch(/dave|tab=about/);
    // A plain 404 without the error template is not_found too.
    const plain = await withCtx('signals-404', source(), (ctx) => xenforoAdapter.authorSignals(ctx, { username: 'erin', profileUrl: `${origin}/members/erin.5/` })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(plain).toMatchObject({ code: 'not_found', details: { status: 404 } });
    expect(JSON.stringify(plain) + String((plain as Error).message)).not.toMatch(/erin/);
  });
});
