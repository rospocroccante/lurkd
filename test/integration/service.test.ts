import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { parseHTML } from 'linkedom';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openArchive } from '../../src/archive/db.js';
import { StateStore } from '../../src/archive/state.js';
import { ThreadStore } from '../../src/archive/threads.js';
import { BrowserManager } from '../../src/browser/manager.js';
import type { DiscoursePost } from '../../src/extract/discourse.js';
import { formatStructure, reduceStructure, SAMPLE_LIMITS } from '../../src/extract/sample.js';
import { FetchQueue } from '../../src/fetch/queue.js';
import { FetchService, parseFetchRequest } from '../../src/fetch/service.js';
import { lurkdPaths } from '../../src/paths.js';
import { HostPacer } from '../../src/policy/limiter.js';
import { findLeaks, pseudonym } from '../../src/pseudonym.js';
import { DraftStore, SampleStore } from '../../src/sources/drafts.js';
import { Registry } from '../../src/sources/registry.js';
import { fixture } from '../helpers/common.js';
import { html, startFixtureServer, type FixtureServer, type Handler } from '../helpers/fixture-server.js';

// Real Chromium, always headless, against the fixture server: BrowserManager launches headed only
// inside beginHandoff, which nothing here calls. Every request goes through FetchService.

const SALT = 'f'.repeat(64);
let server: FixtureServer;
let home: string;
let db: Database.Database;
let state: StateStore;
let threads: ThreadStore;
let samples: SampleStore;
let browser: BrowserManager;
let queue: FetchQueue;
let deps: ConstructorParameters<typeof FetchService>[0];
let svc: FetchService;
let origin = '';

function json(body: unknown, status = 200): Handler {
  return (_req, res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

const chunkPosts = (JSON.parse(fixture('discourse/posts-100.json')) as { post_stream: { posts: DiscoursePost[] } }).post_stream.posts;
const postsHandler: Handler = (req, res) => {
  const ids = new URL(req.url ?? '/', 'http://x').searchParams.getAll('post_ids[]').map(Number);
  json({ id: 100, post_stream: { posts: chunkPosts.filter((p) => ids.includes(p.id)) } })(req, res, '');
};

// The search fixture with the post of topic 100 first, so the first hit is the topic the fixtures hold.
const search = JSON.parse(fixture('discourse/search.json')) as { posts: { topic_id: number }[] };
search.posts.sort((a, b) => Number(b.topic_id === 100) - Number(a.topic_id === 100));

const samplePage = fixture('sample/page.html');
// A page whose own script makes the structure walk hang: getAttribute never returns.
const hangingPage = samplePage.replace('<head>', '<head><script>Element.prototype.getAttribute = function () { for (;;) {} };</script>');

const jobRequests = (jobId: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM fetch_log WHERE job_id = ? AND kind IN ('navigate', 'fetch')`).get(jobId) as { n: number }).n;

beforeAll(async () => {
  server = await startFixtureServer({
    '/': html('<!doctype html><body><p>home</p></body>'),
    '/t/test-topic/100': html(fixture('discourse/topic.html')),
    '/t/test-topic/100.json': json(fixture('discourse/topic-100.json')),
    '/t/100/posts.json': postsHandler,
    '/search': html('<!doctype html><body><p>search page</p></body>'),
    '/search.json': json(search),
    '/threads/sample.55/': html(samplePage),
    '/threads/hang.56/': html(hangingPage),
    // D48: an anonymous visitor gets no current user, and the gated topic shows a login form.
    '/session/current.json': json({ errors: ['You are not permitted to view the requested resource.'] }, 404),
    '/t/gated-topic/200': html(
      '<!doctype html><title>Log in</title><body><form action="/session" method="post"><input name="login"><input type="password" name="password"></form></body>',
    ),
  });
  origin = server.origin;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-service-'));
  const seedDir = path.join(home, 'seed');
  const userDir = path.join(home, 'sources');
  fs.mkdirSync(seedDir);
  fs.mkdirSync(userDir);
  fs.writeFileSync(
    path.join(userDir, 'disc.yaml'),
    YAML.stringify({
      id: 'disc',
      name: 'Disc forum',
      topics: ['testing'],
      engine: 'discourse',
      base_url: origin,
      domains: ['127.0.0.1'],
      automation: { policy: 'allowed', rule_url: `${origin}/rules`, rule_quote: 'Bots welcome.', checked_at: '2026-11-08' },
      rate_limit: { min_delay_s: 1 },
    }),
  );
  db = openArchive(path.join(home, 'archive.db'));
  state = new StateStore(db);
  const registry = Registry.load({ seedDir, userDir, state });
  expect(registry.errors()).toEqual([]);
  threads = new ThreadStore(db, SALT);
  samples = new SampleStore(db);
  browser = new BrowserManager({ profileDir: lurkdPaths({ LURKD_HOME: home }).profileDir, log: (e) => state.logFetch(e) });
  await browser.start();
  expect(browser.state).toBe('ready');
  queue = new FetchQueue();
  deps = { registry, state, threads, samples, drafts: new DraftStore(db, registry, { state }), browser, queue, pacer: new HostPacer(), salt: SALT };
  svc = new FetchService(deps);
});

afterAll(async () => {
  await queue?.close();
  await browser?.close();
  await server?.close();
  db?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('FetchService end to end in headless Chromium', () => {
  it('searches, reads one thread, archives it and finds a phrase from post 30', async () => {
    const r = await svc.fetch(parseFetchRequest({ source: 'disc', query: 'board reset', max_threads: 1 }));
    expect(r.stopped).toBeNull();
    expect(r.threads).toHaveLength(1);
    const t = r.threads[0]!;
    expect(t).toMatchObject({ url: `${origin}/t/test-topic/100`, title: 'Board resets after the update (synthetic fixture)', truncated: false, fromArchive: false, quality: 'full' });
    expect(t.markdown).toContain('post_count: 45');
    expect(t.markdown).toContain('authors: pseudonyms');
    // erin stands in a post body as free text (D34), so only the other names are checked.
    expect([...findLeaks(t.markdown, ['alice', 'bob', 'carol', 'dave'])]).toEqual([]);
    expect(r.otherResults.map((h) => h.title)).toEqual(['Third synthetic topic', 'Second synthetic topic', 'Fourth synthetic topic']);
    // The search page, the search JSON, the topic page, the topic JSON and one chunk.
    expect(r.requestsUsed).toBe(5);
    expect(jobRequests(r.jobId!)).toBe(r.requestsUsed);
    expect(queue.snapshot().at(-1)).toMatchObject({ jobId: r.jobId, state: 'done', threadIndex: 1, threadCount: 1, postsFetched: 45, requestsUsed: 5, requestCap: 60 });

    const hits = svc.archiveSearch('shares the config', { sourceId: 'disc' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: 'disc', threadUrl: `${origin}/t/test-topic/100`, postNumber: 30, author: pseudonym('disc', 'erin', SALT) });
    expect(hits[0]!.excerpt).toContain('Post 30 shares the config');
    expect(hits[0]!.excerpt).not.toMatch(/carol/);

    // The same thread again comes from the archive, without a request.
    const before = server.requests.length;
    const again = await svc.fetch(parseFetchRequest({ source: 'disc', url: `${origin}/t/test-topic/100`, from_post: 30 }));
    expect(again).toMatchObject({ jobId: null, requestsUsed: 0 });
    expect(again.threads[0]!.fromArchive).toBe(true);
    expect(again.threads[0]!.markdown).toContain(`## #30, ${pseudonym('disc', 'erin', SALT)}`);
    expect(server.requests.length).toBe(before);
  });

  it('samples a page of a known host headless and stores only the formatted outline', async () => {
    const r = await svc.sample(`${origin}/threads/sample.55/`);
    expect(r.status).toBe('sampled');
    if (r.status !== 'sampled') return;
    expect(r.host).toBe('127.0.0.1');
    expect(r.structure).toBe(formatStructure(reduceStructure(SAMPLE_LIMITS, parseHTML(samplePage).document as unknown as Document)));
    expect(r.structure).not.toMatch(/alice|bob|carol|dave|secret-token-123|Original question/);
    expect(samples.get('127.0.0.1')).toMatchObject({ structure: r.structure, url: `${origin}/threads/sample.55/` });
    expect(queue.snapshot().at(-1)).toMatchObject({ kind: 'sample', state: 'done' });
    // A stored sample answers without the browser.
    const before = server.requests.length;
    expect(await svc.sample(`${origin}/threads/other.57/`)).toEqual(r);
    expect(server.requests.length).toBe(before);
  });

  it('stops a structure walk that a page makes hang, and the browser keeps working', async () => {
    const quick = new FetchService({ ...deps, pageTimeoutMs: 3000 });
    // Asking again drops the stored sample, so the page is sampled anew.
    samples.request('127.0.0.1', `${origin}/threads/hang.56/`);
    const started = Date.now();
    await expect(quick.sample(`${origin}/threads/hang.56/`)).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining('A script in'),
      details: expect.objectContaining({ source: 'disc' }),
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(samples.get('127.0.0.1')?.structure).toBeNull();
    const r = await quick.sample(`${origin}/threads/sample.55/`);
    expect(r.status).toBe('sampled');
  });
});

describe('a read on an expired session in headless Chromium (D48)', () => {
  let gdb: Database.Database;
  let gstate: StateStore;
  let gsvc: FetchService;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(home, 'gated-'));
    const seedDir = path.join(dir, 'seed');
    const userDir = path.join(dir, 'sources');
    fs.mkdirSync(seedDir);
    fs.mkdirSync(userDir);
    fs.writeFileSync(
      path.join(userDir, 'gated.yaml'),
      YAML.stringify({
        id: 'gated',
        name: 'Gated forum',
        topics: ['testing'],
        engine: 'discourse',
        base_url: origin,
        domains: ['127.0.0.1'],
        login_url: `${origin}/login`,
        automation: { policy: 'allowed', rule_url: `${origin}/rules`, rule_quote: 'Bots welcome.', checked_at: '2026-11-08' },
        rate_limit: { min_delay_s: 1 },
      }),
    );
    // Its own archive, so the topic the first test archived under disc stays there.
    gdb = openArchive(path.join(dir, 'archive.db'));
    gstate = new StateStore(gdb);
    const registry = Registry.load({ seedDir, userDir, state: gstate });
    expect(registry.errors()).toEqual([]);
    gsvc = new FetchService({
      ...deps,
      registry,
      state: gstate,
      threads: new ThreadStore(gdb, SALT),
      samples: new SampleStore(gdb),
      drafts: new DraftStore(gdb, registry, { state: gstate }),
      pacer: new HostPacer(),
    });
  });

  afterAll(() => gdb?.close());

  it('reads a public thread without login, then stops with needs_login at a login wall', async () => {
    // Logged in a day ago and not checked since: the read checks the session first.
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    gstate.setSession('gated', { state: 'logged_in', lastLoginAt: dayAgo, lastCheckAt: dayAgo });
    const before = server.requests.length;
    const r = await gsvc.fetch(parseFetchRequest({ source: 'gated', url: `${origin}/t/test-topic/100` }));
    const paths = server.requests.slice(before).map((q) => q.url);
    // The session check runs first, and the topic is still requested after it found no user.
    expect(paths).toContain('/session/current.json');
    expect(paths.indexOf('/session/current.json')).toBeLessThan(paths.indexOf('/t/test-topic/100.json'));
    expect(r).toMatchObject({ stopped: null, readWithoutLogin: 'session_expired' });
    expect(r.threads).toHaveLength(1);
    const md = r.threads[0]!.markdown;
    expect(md).toContain('post_count: 45');
    expect(md.split('\n')).toContain('note: "read without login: the session expired"');
    await expect(gsvc.sessionStatus('gated')).resolves.toEqual([expect.objectContaining({ state: 'expired', lastBlock: null })]);
    expect(queue.snapshot().at(-1)).toMatchObject({ jobId: r.jobId, state: 'done', message: expect.stringMatching(/Read without login: the session expired\.$/) });

    // The same expired session meets a login wall: the read stops as it did before D48.
    await expect(gsvc.fetch(parseFetchRequest({ source: 'gated', url: `${origin}/t/gated-topic/200` }))).rejects.toMatchObject({
      code: 'needs_login',
      details: expect.objectContaining({ source: 'gated' }),
    });
    const [status] = await gsvc.sessionStatus('gated');
    expect(status).toMatchObject({ state: 'expired', lastBlock: { kind: 'login' } });
    expect(queue.snapshot().at(-1)).toMatchObject({ state: 'failed', message: expect.stringMatching(/^Error needs_login:/) });
  });
});
