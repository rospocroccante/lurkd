import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchLogEntry } from '../../src/archive/state.js';
import { BrowserManager } from '../../src/browser/manager.js';
import { PageReader } from '../../src/browser/reader.js';
import { discourseAdapter, type DiscoursePost } from '../../src/extract/discourse.js';
import type { ExtractContext } from '../../src/extract/engine.js';
import { nameResolver, renderThread, toRenderInput } from '../../src/output/render.js';
import { lurkdPaths } from '../../src/paths.js';
import { HostPacer, RunLimiter } from '../../src/policy/limiter.js';
import { findLeaks } from '../../src/pseudonym.js';
import type { SourceConfig } from '../../src/sources/schema.js';
import type { ExtractedThread } from '../../src/types.js';
import { fixture, range, testSource } from '../helpers/common.js';
import { html, startFixtureServer, type FixtureServer, type Handler } from '../helpers/fixture-server.js';

// Real Chromium, always headless: BrowserManager launches headed only inside beginHandoff,
// which no test here calls. Every request below goes through PageReader.

const SALT = 'e'.repeat(64);
let server: FixtureServer;
let home: string;
let browser: BrowserManager;
let src: SourceConfig;
let sub: SourceConfig;
let origin = '';
let loggedIn = false;
const log: FetchLogEntry[] = [];
const progress: { postsFetched: number; page?: number }[] = [];

function json(body: unknown, status = 200): Handler {
  return (_req, res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

// posts.json answers the asked ids only, in reverse, so the extractor has to follow the stream.
const chunkPosts = (JSON.parse(fixture('discourse/posts-100.json')) as { post_stream: { posts: DiscoursePost[] } }).post_stream.posts;
const postsHandler: Handler = (req, res) => {
  const ids = new URL(req.url ?? '/', 'http://x').searchParams.getAll('post_ids[]').map(Number);
  json({ id: 100, post_stream: { posts: chunkPosts.filter((p) => ids.includes(p.id)).reverse() } })(req, res, '');
};

function topicRoutes(prefix: string): Record<string, Handler> {
  return {
    [`${prefix}/`]: html('<!doctype html><body><p>home</p></body>'),
    [`${prefix}/t/test-topic/100`]: html(fixture('discourse/topic.html')),
    [`${prefix}/t/test-topic/100.json`]: json(fixture('discourse/topic-100.json')),
    [`${prefix}/t/100/posts.json`]: postsHandler,
  };
}

function withCtx<T>(jobId: string, fn: (ctx: ExtractContext) => Promise<T>, source: SourceConfig = src): Promise<T> {
  return browser.withPage({ source, jobId }, async (page, arm) => {
    const limiter = new RunLimiter({ minIntervalMs: 0, maxRequestsPerRun: 60, maxRequestsPerDay: 300, deadlineMs: 600_000 }, new HostPacer(), () => 0);
    const reader = new PageReader(page, source, { limiter, log: (e) => log.push(e), jobId, arm });
    return fn({ reader, source, onProgress: (p) => progress.push(p) });
  });
}

beforeAll(async () => {
  server = await startFixtureServer({
    ...topicRoutes(''),
    ...topicRoutes('/community'),
    '/t/no-json/101': html(fixture('discourse/topic.html')),
    '/t/no-json/101.json': html('<!doctype html><body><p>not json</p></body>'),
    '/search': html('<!doctype html><body><p>search page</p></body>'),
    '/search.json': json(fixture('discourse/search.json')),
    '/session/current.json': (req, res) =>
      loggedIn ? json(fixture('discourse/session-current.json'))(req, res, '') : json('{"error":"not logged in"}', 404)(req, res, ''),
    '/u/alice.json': json(fixture('discourse/user-alice.json')),
  });
  origin = server.origin;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-discourse-'));
  src = testSource({ id: 'test-discourse', engine: 'discourse', base_url: origin });
  sub = testSource({ id: 'test-discourse', engine: 'discourse', base_url: `${origin}/community` });
  browser = new BrowserManager({ profileDir: lurkdPaths({ LURKD_HOME: home }).profileDir, log: (e) => log.push(e) });
  await browser.start();
  expect(browser.state).toBe('ready');
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('discourseAdapter in headless Chromium', () => {
  let t: ExtractedThread;

  it('reads all 45 posts in stream order with one chunk request', async () => {
    const since = server.requests.length;
    progress.length = 0;
    t = await withCtx('topic', (ctx) => discourseAdapter.fetchThread(ctx, `${origin}/t/test-topic/100`));
    expect(t.posts.map((p) => p.number)).toEqual(range(1, 45));
    expect(t.postsExpected).toBe(45);
    expect(server.requests.filter((r) => r.url.startsWith('/t/100/posts.json'))).toHaveLength(1);
    expect(t.posts.every((p) => p.page === null)).toBe(true);
    expect(t).toMatchObject({ url: `${origin}/t/test-topic/100`, engine: 'discourse', pages: null, extraction: 'json', quality: 'full' });
    // The chunk asks for exactly the 20 posts the first payload lacked.
    const chunkUrl = server.requests.find((r) => r.url.startsWith('/t/100/posts.json'))!.url;
    expect(new URL(chunkUrl, origin).searchParams.getAll('post_ids[]').map(Number)).toEqual(range(1026, 1045));
    // The page, the topic JSON, one chunk; all logged by the reader.
    const mine = server.requests.slice(since).map((r) => r.url.split('?')[0]);
    expect(mine).toEqual(['/t/test-topic/100', '/t/test-topic/100.json', '/t/100/posts.json']);
    expect(log.filter((e) => e.jobId === 'topic').map((e) => [e.kind, new URL(e.url).pathname])).toEqual([
      ['navigate', '/t/test-topic/100'],
      ['fetch', '/t/test-topic/100.json'],
      ['fetch', '/t/100/posts.json'],
    ]);
    expect(progress).toEqual([{ postsFetched: 25 }, { postsFetched: 45 }]);
  });

  it('leaks only the documented free-text name', () => {
    const md = renderThread(toRenderInput('test-discourse', t, '2026-11-08T00:00:00.000Z'), nameResolver({ sourceId: 'test-discourse', salt: SALT, realNames: false })).markdown;
    expect([...findLeaks(md, ['alice', 'bob', 'carol', 'erin'])]).toEqual([['erin', 1]]); // 'thanks erin' in a post body (D34)
  });

  it('reads a topic under a subfolder base_url', async () => {
    const since = server.requests.length;
    const s = await withCtx('subfolder', (ctx) => discourseAdapter.fetchThread(ctx, `${origin}/community/t/test-topic/100/7`), sub);
    expect(s.url).toBe(`${origin}/community/t/test-topic/100`);
    expect(s.posts.map((p) => p.number)).toEqual(range(1, 45));
    expect(s.posts[0]!.authorUrl).toBe(`${origin}/community/u/alice`);
    expect(server.requests.slice(since).map((r) => r.url.split('?')[0])).toEqual([
      '/community/t/test-topic/100',
      '/community/t/test-topic/100.json',
      '/community/t/100/posts.json',
    ]);
  });

  it('falls back to readability when the topic JSON is not served', async () => {
    const t = await withCtx('no-json', (ctx) => discourseAdapter.fetchThread(ctx, `${origin}/t/no-json/101`));
    expect(t).toMatchObject({ url: `${origin}/t/no-json/101`, engine: 'discourse', quality: 'low', extraction: 'readability (names not pseudonymised; topic JSON not served, HTTP 200)' });
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]!.author).toBe('');
  });

  it('searches through GET in relevance order', async () => {
    const since = server.requests.length;
    const hits = await withCtx('search', (ctx) => discourseAdapter.search(ctx, 'board reset', 3));
    expect(hits).toEqual([
      { url: `${origin}/t/topic-102/102`, title: 'Third synthetic topic', posts: 7 },
      { url: `${origin}/t/test-topic/100`, title: 'Board resets after the update (synthetic fixture)', posts: 45 },
      { url: `${origin}/t/topic-101/101`, title: 'Second synthetic topic', posts: 6 },
    ]);
    const mine = server.requests.slice(since);
    expect(mine.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /search?q=board%20reset', 'GET /search.json?q=board%20reset']);
    const all = await withCtx('search-all', (ctx) => discourseAdapter.search(ctx, 'board reset', 10));
    expect(all.map((h) => h.title)).toEqual(['Third synthetic topic', 'Board resets after the update (synthetic fixture)', 'Second synthetic topic', 'Fourth synthetic topic']);
  });

  it('checks the session', async () => {
    loggedIn = false;
    expect(await withCtx('session-out', (ctx) => discourseAdapter.checkSession(ctx))).toBe(false);
    loggedIn = true;
    expect(await withCtx('session-in', (ctx) => discourseAdapter.checkSession(ctx))).toBe(true);
    expect(log.filter((e) => e.jobId === 'session-in' && e.kind === 'fetch').map((e) => [new URL(e.url).pathname, e.status])).toEqual([['/session/current.json', 200]]);
  });

  it('fetches author signals with one request', async () => {
    const signals = await withCtx('signals', async (ctx) => {
      // Put the page on the source first, so the only request counted is the profile JSON.
      await ctx.reader.open(`${origin}/`);
      const since = server.requests.length;
      const s = await discourseAdapter.authorSignals(ctx, { username: 'alice', profileUrl: `${origin}/u/alice` });
      expect(server.requests.slice(since).map((r) => r.url)).toEqual(['/u/alice.json']);
      return s;
    });
    // P34: in this fixture both postCount and joinedAt come back non-null.
    expect(signals).toEqual({ postCount: 212, joinedAt: '2021-04-03T10:00:00.000Z', extra: ['trust level 4', '14 badges'] });
  });

  it('answers not_found for an unknown author', async () => {
    await expect(withCtx('signals-missing', (ctx) => discourseAdapter.authorSignals(ctx, { username: 'dave', profileUrl: null }))).rejects.toMatchObject({ code: 'not_found' });
  });
});
