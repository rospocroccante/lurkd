import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchLogEntry } from '../../src/archive/state.js';
import { BrowserManager } from '../../src/browser/manager.js';
import { PageReader } from '../../src/browser/reader.js';
import { discourseAdapter } from '../../src/extract/discourse.js';
import type { ExtractContext } from '../../src/extract/engine.js';
import { genericAdapter } from '../../src/extract/generic.js';
import { customAdapter, extractWithSelectors } from '../../src/extract/selectors.js';
import { nameResolver, renderThread, toRenderInput } from '../../src/output/render.js';
import { lurkdPaths } from '../../src/paths.js';
import { HostPacer, RunLimiter } from '../../src/policy/limiter.js';
import { findLeaks, NAME_CLOSE, NAME_OPEN } from '../../src/pseudonym.js';
import type { Selectors, SourceConfig } from '../../src/sources/schema.js';
import { fixture, range, testSource } from '../helpers/common.js';
import { html, startFixtureServer, type FixtureServer, type Handler } from '../helpers/fixture-server.js';

// Real Chromium, always headless: BrowserManager launches headed only inside beginHandoff,
// which no test here calls. Every request below goes through PageReader.

const SALT = 'b'.repeat(64);
const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin'];
let server: FixtureServer;
let home: string;
let browser: BrowserManager;
let origin = '';
let loggedIn = false;
const log: FetchLogEntry[] = [];
const progress: { postsFetched: number; page?: number }[] = [];

const SEL: Selectors = {
  title: 'h1.thread-title',
  post: 'article.post',
  author: '.post-author .name',
  author_signals: '.post-author .stats',
  date: 'time',
  body: '.post-body',
  quote: 'div.quote',
  next_page: 'a[rel=next]',
  thread_list: 'ol.results li a.thread-title',
};
const custom = (overrides: Partial<SourceConfig> = {}): SourceConfig =>
  testSource({ id: 'test-custom', engine: 'custom', base_url: origin, selectors: SEL, ...overrides });

const status = (code: number, body: string, type = 'text/html; charset=utf-8'): Handler => (_req, res) => {
  res.writeHead(code, { 'content-type': type });
  res.end(body);
};

// /thread/42 and /thread/42?page=2 share a path; the fixture server routes by path only.
const thread42: Handler = (req, res, body) => {
  const page = new URL(req.url ?? '/', 'http://x').searchParams.get('page');
  html(fixture(page === '2' ? 'custom/thread-2.html' : 'custom/thread-1.html'))(req, res, body);
};
// A thread whose next link leaves for another host.
const leaving = fixture('custom/thread-1.html').replace('href="/thread/42?page=2"', 'href="https://elsewhere.example.net/thread/42?page=2"');

const searchForm = '<!doctype html><body><form id="search" method="post" action="/search/run"><input type="text" name="keywords"><button>Go</button></form></body>';

function withCtx<T>(jobId: string, src: SourceConfig, fn: (ctx: ExtractContext) => Promise<T>): Promise<T> {
  return browser.withPage({ source: src, jobId }, async (page, arm) => {
    const limiter = new RunLimiter({ minIntervalMs: 0, maxRequestsPerRun: 60, maxRequestsPerDay: 300, deadlineMs: 600_000 }, new HostPacer(), () => 0);
    const reader = new PageReader(page, src, { limiter, log: (e) => log.push(e), jobId, arm });
    return fn({ reader, source: src, onProgress: (p) => progress.push(p) });
  });
}

beforeAll(async () => {
  server = await startFixtureServer({
    '/': html(searchForm),
    '/thread/42': thread42,
    '/thread/50': html(leaving),
    '/thread/51': html('<!doctype html><body><h1>Empty</h1><p>No posts here.</p></body>'),
    '/thread/52': status(404, '<!doctype html><body><p>Not here.</p></body>'),
    '/find': html(fixture('custom/list.html')),
    '/search/run': (_req, res) => {
      res.writeHead(303, { location: '/find?q=from-form' });
      res.end();
    },
    '/account': (req, res, body) => html(`<!doctype html><body>${loggedIn ? '<a class="logout" href="/account/sign-off">Sign off</a>' : '<a href="/login">Log in</a>'}</body>`)(req, res, body),
    '/a/1': html(fixture('generic/article.html')),
    '/t/x/7': html(fixture('generic/article.html')),
    '/t/x/7.json': html('<!doctype html><body><p>JSON is switched off on this forum.</p></body>'),
    '/t/x/8': html(fixture('generic/article.html')),
    '/t/x/8.json': status(404, '{"errors":["not found"]}', 'application/json; charset=utf-8'),
  });
  origin = server.origin;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-selectors-'));
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

describe('declarative selectors in headless Chromium', () => {
  it('reads posts across two pages with declarative selectors', async () => {
    const since = server.requests.length;
    progress.length = 0;
    const t = await withCtx('custom-thread', custom(), (ctx) => customAdapter.fetchThread(ctx, `${origin}/thread/42`));
    expect(t.posts.map((p) => p.number)).toEqual(range(1, 6));
    expect(t.posts[3]!.notes).toContain('page 2');
    expect(t.posts.some((p) => p.bodyMd.split('\n').some((line) => line.startsWith('> ')))).toBe(true);
    expect(t).toMatchObject({ url: `${origin}/thread/42`, engine: 'custom', pages: 2, postsExpected: null, quality: 'full', title: 'Sourdough starter smells of acetone' });
    expect(t.posts.map((p) => p.author)).toEqual(['alice', 'bob', 'carol', 'dave', 'erin', 'alice']);
    expect(t.posts[4]!.bodyMd).toMatch(/^> > Feed it twice a day\./m);
    // Quote headers carry the quoted author as a marked name (D34).
    expect(t.posts[2]!.bodyMd).toContain(`> ${NAME_OPEN}bob${NAME_CLOSE} wrote:`);
    expect(t.posts[4]!.bodyMd).toContain(`> ${NAME_OPEN}dave${NAME_CLOSE} wrote:`);
    // Page 2 links back to page 1: never read twice.
    expect(pathsSince(since)).toEqual(['GET /thread/42', 'GET /thread/42?page=2']);
    expect(progress).toEqual([{ postsFetched: 3, page: 1 }, { postsFetched: 6, page: 2 }]);
    const md = renderThread(toRenderInput('test-custom', t, '2026-11-09T00:00:00.000Z'), nameResolver({ sourceId: 'test-custom', salt: SALT, realNames: false })).markdown;
    expect([...findLeaks(md, NAMES)]).toEqual([]);
  });

  it('reads with extractWithSelectors and stops at the page cap', async () => {
    const since = server.requests.length;
    const src = custom({ pagination: { max_pages_per_thread: 1 } });
    const t = await withCtx('custom-cap', src, (ctx) => extractWithSelectors(ctx, `${origin}/thread/42#p102`, SEL));
    expect(t.posts.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(t.url).toBe(`${origin}/thread/42`);
    expect(pathsSince(since)).toEqual(['GET /thread/42']);
  });

  it('never follows a next link to another host', async () => {
    const since = server.requests.length;
    const t = await withCtx('custom-leave', custom(), (ctx) => customAdapter.fetchThread(ctx, `${origin}/thread/50`));
    expect(t.posts).toHaveLength(3);
    expect(pathsSince(since)).toEqual(['GET /thread/50']);
  });

  it('fails on a page without posts, naming the selector, and on a missing thread', async () => {
    await expect(withCtx('custom-empty', custom(), (ctx) => customAdapter.fetchThread(ctx, `${origin}/thread/51`))).rejects.toMatchObject({
      code: 'extraction_failed',
      message: expect.stringContaining('selectors.post'),
    });
    await expect(withCtx('custom-404', custom(), (ctx) => customAdapter.fetchThread(ctx, `${origin}/thread/52`))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports an invalid selector without crashing', async () => {
    const src = custom({ selectors: { ...SEL, author: 'span[[' } });
    await expect(withCtx('custom-bad', src, (ctx) => customAdapter.fetchThread(ctx, `${origin}/thread/42`))).rejects.toMatchObject({
      code: 'extraction_failed',
      message: expect.stringContaining('selectors.author'),
    });
  });

  it('searches with search_url and thread_list', async () => {
    const since = server.requests.length;
    const src = custom({ search_url: `${origin}/find?q={query}` });
    const hits = await withCtx('custom-search', src, (ctx) => customAdapter.search(ctx, 'sourdough starter', 10));
    expect(hits).toHaveLength(3);
    for (const h of hits) expect(h.url.startsWith(`${origin}/thread/`)).toBe(true);
    expect(hits.map((h) => h.url)).toEqual([`${origin}/thread/42`, `${origin}/thread/43`, `${origin}/thread/45`]);
    expect(pathsSince(since)).toEqual(['GET /find?q=sourdough%20starter']);
    const two = await withCtx('custom-search-2', src, (ctx) => customAdapter.search(ctx, 'sourdough starter', 2));
    expect(two).toHaveLength(2);
  });

  it('searches through one armed form POST', async () => {
    const since = server.requests.length;
    const src = custom({
      selectors: { ...SEL, search_form: 'form#search', search_input: 'input[name=keywords]' },
      read_endpoints: [{ method: 'POST', path: '/search/run', note: 'search form' }],
    });
    const hits = await withCtx('custom-form', src, (ctx) => customAdapter.search(ctx, 'rye', 10));
    expect(hits).toHaveLength(3);
    expect(pathsSince(since)).toEqual(['GET /', 'POST /search/run', 'GET /find?q=from-form']);
  });

  it('refuses search without search_url or a form', async () => {
    const since = server.requests.length;
    await expect(withCtx('custom-nosearch', custom(), (ctx) => customAdapter.search(ctx, 'rye', 10))).rejects.toMatchObject({ code: 'search_unsupported' });
    await expect(withCtx('generic-nosearch', testSource({ id: 'test-generic', engine: 'generic', base_url: origin }), (ctx) => genericAdapter.search(ctx, 'rye', 10))).rejects.toMatchObject({
      code: 'search_unsupported',
    });
    expect(pathsSince(since)).toEqual([]);
  });

  it('runs session_check', async () => {
    const src = custom({ session_check: { url: `${origin}/account`, logged_in_selector: 'a.logout' } });
    loggedIn = true;
    await expect(withCtx('session-in', src, (ctx) => customAdapter.checkSession(ctx))).resolves.toBe(true);
    loggedIn = false;
    await expect(withCtx('session-out', src, (ctx) => customAdapter.checkSession(ctx))).resolves.toBe(false);
    const since = server.requests.length;
    await expect(withCtx('session-none', custom(), (ctx) => customAdapter.checkSession(ctx))).resolves.toBe(false);
    expect(pathsSince(since)).toEqual([]);
  });

  it('reads a generic page through readability', async () => {
    const since = server.requests.length;
    const src = testSource({ id: 'test-generic', engine: 'generic', base_url: origin });
    const t = await withCtx('generic', src, (ctx) => genericAdapter.fetchThread(ctx, `${origin}/a/1#top`));
    expect(t).toMatchObject({ url: `${origin}/a/1`, engine: 'generic', quality: 'low', extraction: 'readability (names not pseudonymised)' });
    expect(t.posts[0]!.notes).toEqual(['names in this text are not pseudonymised']);
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]!.bodyMd).toContain('Fermented foods');
    expect(t.posts[0]!.bodyMd).not.toContain('Home | About | Contact');
    // One navigation; readability follows no link.
    expect(pathsSince(since)).toEqual(['GET /a/1']);
  });

  it('falls back to readability when the Discourse topic JSON is missing', async () => {
    const src = testSource({ id: 'test-discourse', engine: 'discourse', base_url: origin });
    const t = await withCtx('discourse-fallback', src, (ctx) => discourseAdapter.fetchThread(ctx, `${origin}/t/x/7`));
    expect(t.quality).toBe('low');
    expect(t.extraction.startsWith('readability')).toBe(true);
    expect(t).toMatchObject({ engine: 'discourse', url: `${origin}/t/x/7` });
    expect(t.posts[0]!.bodyMd).toContain('Fermented foods');
    // A 404 on the topic JSON still means the topic is gone.
    await expect(withCtx('discourse-404', src, (ctx) => discourseAdapter.fetchThread(ctx, `${origin}/t/x/8`))).rejects.toMatchObject({ code: 'not_found' });
  });
});
