import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getSetting, openArchive, setSetting } from '../../src/archive/db.js';
import { StateStore } from '../../src/archive/state.js';
import { ThreadStore } from '../../src/archive/threads.js';
import type { BrowserManager, BrowserState, HandoffInfo } from '../../src/browser/manager.js';
import { LurkdError } from '../../src/errors.js';
import { FetchQueue } from '../../src/fetch/queue.js';
import { FetchService, type SessionStatusOut } from '../../src/fetch/service.js';
import { HostPacer } from '../../src/policy/limiter.js';
import { COOKIE_NOTICE, createApp, type AppDeps } from '../../src/server/app.js';
import { captureSample, finishHandoff } from '../../src/server/handoff.js';
import { DraftStore, SampleStore } from '../../src/sources/drafts.js';
import { Registry } from '../../src/sources/registry.js';

const TOKEN = 'tok';
const PORT = 4100;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const COOKIE = `lurkd_token=${TOKEN}`;

const sourceYaml = (id: string, host: string, extra: Record<string, unknown> = {}) =>
  YAML.stringify({
    id,
    name: `${id} forum`,
    topics: ['testing'],
    engine: 'discourse',
    base_url: `https://${host}`,
    domains: [host],
    automation: { policy: 'allowed', rule_url: `https://${host}/rules`, rule_quote: 'Bots welcome.', checked_at: '2026-11-08' },
    ...extra,
  });

interface FakeBrowser {
  state: BrowserState;
  lastError: string | null;
  handoff: HandoffInfo | null;
  page: { url: () => string; evaluate: ReturnType<typeof vi.fn>; waitForLoadState: ReturnType<typeof vi.fn> } | null;
  beginHandoff: ReturnType<typeof vi.fn>;
  endHandoff: ReturnType<typeof vi.fn>;
  handoffPage: () => unknown;
}

function fakeBrowser(): FakeBrowser {
  const b: FakeBrowser = {
    state: 'ready',
    lastError: null,
    handoff: null,
    page: null,
    beginHandoff: vi.fn(async (info: Omit<HandoffInfo, 'startedAt'>) => {
      if (b.handoff) throw new LurkdError('handoff_in_progress', 'A browser window is already open for a handoff.');
      b.handoff = { ...info, startedAt: '2026-11-09T12:00:00.000Z' };
      b.state = 'handoff';
    }),
    endHandoff: vi.fn(async () => {
      const finalUrl = b.page?.url() ?? null;
      b.handoff = null;
      b.page = null;
      b.state = 'ready';
      return { finalUrl };
    }),
    handoffPage: () => (b.handoff ? b.page : null),
  };
  return b;
}

function fakeService() {
  return {
    fetch: vi.fn(),
    archiveSearch: vi.fn(() => []),
    sessionStatus: vi.fn(async (): Promise<SessionStatusOut[]> => []),
    sample: vi.fn(),
    authorSignals: vi.fn(),
    threadMarkdown: vi.fn(() => '# A thread'),
  };
}

describe('createApp', () => {
  let tmp: string;
  let uiDir: string;
  let db: Database.Database;
  let state: StateStore;
  let registry: Registry;
  let threads: ThreadStore;
  let samples: SampleStore;
  let drafts: DraftStore;
  let queue: FetchQueue;
  let browser: FakeBrowser;
  let service: ReturnType<typeof fakeService>;
  let shutdown: Mock<() => void>;
  let deps: AppDeps;
  let app: ReturnType<typeof createApp>;

  const get = (p: string, headers: Record<string, string> = {}, host = `127.0.0.1:${PORT}`) => app.request(`http://${host}${p}`, { headers });
  const send = (method: string, p: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`http://127.0.0.1:${PORT}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // A UI mutation as the page sends it: the cookie and the page's own Origin.
  const ui = (p: string, body: unknown = {}, method = 'POST') => send(method, p, body, { cookie: COOKIE, origin: ORIGIN });
  const bearer = { authorization: `Bearer ${TOKEN}` };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-app-'));
    const seedDir = path.join(tmp, 'seed');
    const userDir = path.join(tmp, 'user');
    uiDir = path.join(tmp, 'ui');
    for (const d of [seedDir, userDir, uiDir]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>lurkd</title>');
    fs.writeFileSync(path.join(uiDir, 'app.js'), 'export {};');
    fs.writeFileSync(path.join(uiDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    fs.writeFileSync(path.join(uiDir, 'view.js'), 'export {};');
    fs.writeFileSync(path.join(uiDir, 'app.css'), 'body{}');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"secret":true}');
    fs.writeFileSync(path.join(userDir, 'lg.yaml'), sourceYaml('lg', 'lg.example', { login_url: 'https://lg.example/login' }));
    fs.writeFileSync(path.join(userDir, 'nl.yaml'), sourceYaml('nl', 'nl.example'));
    fs.writeFileSync(
      path.join(userDir, 'fb.yaml'),
      sourceYaml('fb', 'fb.example', {
        enabled: false,
        automation: { policy: 'forbidden', rule_url: 'https://fb.example/rules', rule_quote: 'No bots.', checked_at: '2026-11-08' },
      }),
    );
    db = openArchive(':memory:');
    state = new StateStore(db);
    registry = Registry.load({ seedDir, userDir, state });
    expect(registry.errors()).toEqual([]);
    threads = new ThreadStore(db, 'a'.repeat(64));
    samples = new SampleStore(db);
    drafts = new DraftStore(db, registry, { state });
    queue = new FetchQueue();
    browser = fakeBrowser();
    service = fakeService();
    shutdown = vi.fn<() => void>();
    deps = {
      token: TOKEN,
      port: () => PORT,
      version: '0.1.0',
      db,
      service: service as unknown as FetchService,
      registry,
      state,
      threads,
      drafts,
      samples,
      browser: browser as unknown as BrowserManager,
      queue,
      uiDir,
      shutdown,
    };
    app = createApp(deps);
  });

  afterEach(async () => {
    await queue.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('Host, Origin and token (D3)', () => {
    it('rejects a foreign Host (DNS rebinding)', async () => {
      const r = await get('/health', bearer, 'evil.example:4100');
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('bad_host');
      // The right host on another port is foreign too.
      expect((await get('/health', bearer, '127.0.0.1:4101')).status).toBe(403);
      expect((await get('/health', bearer, 'localhost:4100')).status).toBe(200);
    });

    it('rejects a foreign Origin', async () => {
      expect((await get('/health', { ...bearer, origin: 'https://evil.example' })).status).toBe(403);
      expect((await get('/health', { ...bearer, origin: 'null' })).status).toBe(403);
      expect((await get('/health', { ...bearer, origin: 'http://127.0.0.1:4101' })).status).toBe(403);
      expect((await get('/health', { ...bearer, origin: ORIGIN })).status).toBe(200);
      expect((await get('/health', { ...bearer, origin: `http://localhost:${PORT}` })).status).toBe(200);
    });

    it('rejects a missing or wrong token', async () => {
      const none = await get('/health');
      expect(none.status).toBe(401);
      expect(((await none.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
      expect((await get('/health', { authorization: 'Bearer nope' })).status).toBe(401);
      expect((await get('/health', { authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
      expect((await get('/health', { cookie: 'lurkd_token=nope' })).status).toBe(401);
      // ?t= counts on GET / only.
      expect((await get(`/health?t=${TOKEN}`)).status).toBe(401);
      expect((await get('/?t=nope')).status).toBe(401);
      // An unknown path is checked like any other.
      expect((await get('/nothing-here')).status).toBe(401);
    });

    it('accepts the token as Bearer or as the cookie on agent routes', async () => {
      const r = await get('/health', bearer);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, version: '0.1.0', pid: process.pid, browser: 'ready' });
      expect((await get('/health', { cookie: COOKIE })).status).toBe(200);
    });

    it('sets the cookie from ?t= and redirects to /', async () => {
      const r = await get(`/?t=${TOKEN}`);
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe('/');
      expect(r.headers.get('set-cookie')).toMatch(/lurkd_token=tok;.*HttpOnly.*SameSite=Strict/i);
      expect(r.headers.get('set-cookie')).toMatch(/Path=\//);
    });

    it('keeps UI routes cookie-only and mutations Origin-only', async () => {
      expect((await get('/api/state', bearer)).status).toBe(401);
      expect((await get('/', bearer)).status).toBe(401);
      expect((await get('/api/state', { cookie: COOKIE })).status).toBe(200);
      const noOrigin = await send('POST', '/api/sources/nl/enable', { acknowledge: false }, { cookie: COOKIE });
      expect(noOrigin.status).toBe(403);
      expect(((await noOrigin.json()) as { error: { code: string } }).error.code).toBe('bad_host');
      expect((await send('POST', '/api/sources/nl/enable', { acknowledge: false }, { ...bearer, origin: ORIGIN })).status).toBe(401);
      expect((await ui('/api/sources/nl/enable', { acknowledge: false })).status).toBe(200);
      expect((await send('DELETE', '/api/sources/nl/archive', undefined, { cookie: COOKIE })).status).toBe(403);
    });

    it('lets agent POSTs through without an Origin', async () => {
      service.fetch.mockResolvedValue({ jobId: 'j', source: 'nl', threads: [], otherResults: [], stopped: null, requestsUsed: 0 });
      const r = await send('POST', '/api/fetch', { source: 'nl', query: 'b12' }, bearer);
      expect(r.status).toBe(200);
      expect(service.fetch).toHaveBeenCalledWith({ source: 'nl', query: 'b12', maxThreads: 3, refresh: false, fromPost: 1, maxChars: 40_000 });
    });

    it('sends no-store and framing headers', async () => {
      const r = await get('/health', bearer);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    });
  });

  describe('errors', () => {
    it('maps LurkdError codes to HTTP statuses', async () => {
      service.fetch.mockRejectedValue(new LurkdError('needs_login', 'Log in first.', { source: 'lg' }));
      const r = await send('POST', '/api/fetch', { source: 'lg', query: 'x' }, bearer);
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: { code: 'needs_login', message: 'Log in first.', details: { source: 'lg' } } });
      service.fetch.mockRejectedValue(new LurkdError('handoff_in_progress', 'A window is open.'));
      expect((await send('POST', '/api/fetch', { source: 'lg', query: 'x' }, bearer)).status).toBe(423);
      service.fetch.mockRejectedValue(new LurkdError('timeout', 'Slow.'));
      expect((await send('POST', '/api/fetch', { source: 'lg', query: 'x' }, bearer)).status).toBe(504);
    });

    it('answers invalid_request for a bad body without echoing it', async () => {
      const raw = 'https://user:secret@lg.example/x';
      const r = await app.request(`${ORIGIN}/api/fetch`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: `{"url":"${raw}"` });
      expect(r.status).toBe(400);
      const text = await r.text();
      expect(text).toContain('invalid_request');
      expect(text).not.toContain('secret');
      const bad = await send('POST', '/api/fetch', { source: 'lg', url: raw, query: 'x' }, bearer);
      expect(bad.status).toBe(400);
      expect(await bad.text()).not.toContain('secret');
    });

    it('hides the text of an unexpected error', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      service.archiveSearch.mockImplementation(() => {
        throw new Error('SQLITE_CORRUPT at /Users/someone/.lurkd/archive.db');
      });
      const r = await get('/api/archive/search?q=b12', bearer);
      expect(r.status).toBe(500);
      const body = (await r.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('internal');
      expect(body.error.message).not.toContain('/Users/');
      spy.mockRestore();
    });

    it('refuses a body larger than 1 MB', async () => {
      const r = await send('POST', '/api/sample', { url: 'https://nl.example/', draft_yaml: 'x'.repeat(1_100_000) }, bearer);
      expect(r.status).toBe(400);
      expect(service.sample).not.toHaveBeenCalled();
    });
  });

  describe('UI files', () => {
    it('serves only the UI files and the icon', async () => {
      const page = await get('/', { cookie: COOKIE });
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/text\/html/);
      expect(await page.text()).toContain('<title>lurkd</title>');
      const js = await get('/ui/app.js', { cookie: COOKIE });
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toMatch(/javascript/);
      expect((await get('/ui/view.js', { cookie: COOKIE })).status).toBe(200);
      expect((await get('/ui/app.css', { cookie: COOKIE })).headers.get('content-type')).toMatch(/text\/css/);
      expect((await get('/ui/favicon.svg', { cookie: COOKIE })).headers.get('content-type')).toMatch(/image\/svg\+xml/);
      expect((await get('/ui/favicon.svg')).status).toBe(401);
      expect((await get('/ui/..%2Fpackage.json', { cookie: COOKIE })).status).toBe(404);
      expect((await get('/ui/../package.json', { cookie: COOKIE })).status).toBe(404);
      expect((await get('/ui/index.html', { cookie: COOKIE })).status).toBe(404);
      expect((await get('/ui/app.js', bearer)).status).toBe(401);
    });

    it('answers not_found when a UI file is missing', async () => {
      fs.rmSync(path.join(uiDir, 'view.js'));
      expect((await get('/ui/view.js', { cookie: COOKIE })).status).toBe(404);
    });
  });

  describe('agent routes', () => {
    it('lists sources through registry.search', async () => {
      const r = await get('/api/sources?q=lg', bearer);
      expect(r.status).toBe(200);
      expect(((await r.json()) as { id: string }[]).map((s) => s.id)).toEqual(['lg']);
      expect(((await (await get('/api/sources?topic=testing', bearer)).json()) as unknown[]).length).toBe(3);
    });

    it('passes archive search parameters through', async () => {
      await get('/api/archive/search?q=b12&source=lg&limit=5', bearer);
      expect(service.archiveSearch).toHaveBeenCalledWith('b12', { sourceId: 'lg', limit: 5 });
      expect((await get('/api/archive/search?q=b12&limit=abc', bearer)).status).toBe(400);
      expect((await get('/api/archive/search', bearer)).status).toBe(400);
    });

    it('passes session status and checkError through unchanged', async () => {
      const out: SessionStatusOut = {
        id: 'lg',
        name: 'lg forum',
        state: 'expired',
        loginUrl: 'https://lg.example/login',
        lastLoginAt: null,
        lastCheckAt: null,
        needsAcknowledgment: false,
        lastBlock: null,
        checkError: 'challenge',
      };
      service.sessionStatus.mockResolvedValue([out]);
      const r = await get('/api/session?check=true', bearer);
      expect(service.sessionStatus).toHaveBeenLastCalledWith(undefined, true);
      expect(await r.json()).toEqual([out]);
      await get('/api/session?source=lg', bearer);
      expect(service.sessionStatus).toHaveBeenLastCalledWith('lg', false);
      expect((await get('/api/session?check=maybe', bearer)).status).toBe(400);
    });

    it('forwards sample and author-signals bodies', async () => {
      service.sample.mockResolvedValue({ status: 'needs_user', host: 'x.example', message: 'm' });
      await send('POST', '/api/sample', { url: 'https://x.example/t/1', draft_yaml: 'id: x' }, bearer);
      expect(service.sample).toHaveBeenCalledWith('https://x.example/t/1', 'id: x');
      await send('POST', '/api/sample', { url: 'https://x.example/t/1' }, bearer);
      expect(service.sample).toHaveBeenLastCalledWith('https://x.example/t/1', undefined);
      expect((await send('POST', '/api/sample', { url: 7 }, bearer)).status).toBe(400);
      service.authorSignals.mockResolvedValue({ source: 'lg', author: 'author-0123456789', postCount: 1, joinedAt: null, extra: [], cached: false });
      await send('POST', '/api/author-signals', { source: 'lg', author: 'author-0123456789' }, bearer);
      expect(service.authorSignals).toHaveBeenCalledWith('lg', 'author-0123456789');
      expect((await send('POST', '/api/author-signals', { source: 'lg' }, bearer)).status).toBe(400);
    });

    it('reports status with the sessions that need attention', async () => {
      state.setSession('lg', { state: 'expired' });
      state.setSession('nl', { state: 'never', lastBlockKind: 'challenge', lastBlockUrl: 'https://nl.example/t/1' });
      const mk = (id: string, s: Partial<SessionStatusOut>): SessionStatusOut => ({
        id,
        name: id,
        state: 'never',
        loginUrl: null,
        lastLoginAt: null,
        lastCheckAt: null,
        needsAcknowledgment: false,
        lastBlock: null,
        ...s,
      });
      service.sessionStatus.mockResolvedValue([
        mk('fb', { state: 'disabled' }),
        mk('lg', { state: 'expired' }),
        mk('nl', { lastBlock: { kind: 'challenge', url: 'https://nl.example/t/1' } }),
      ]);
      const r = (await (await get('/api/status', bearer)).json()) as { attention: SessionStatusOut[] } & Record<string, unknown>;
      expect(r).toMatchObject({ version: '0.1.0', pid: process.pid, browser: { state: 'ready', lastError: null }, queueLength: 0 });
      expect(r.attention.map((a) => a.id)).toEqual(['lg', 'nl']);
      expect(service.sessionStatus).toHaveBeenLastCalledWith();
    });

    it('answers 202 to shutdown and then calls shutdown', async () => {
      const r = await send('POST', '/api/shutdown', {}, bearer);
      expect(r.status).toBe(202);
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
    });
  });

  describe('UI routes', () => {
    it('reports the page state without fetch log URLs', async () => {
      state.logFetch({ sourceId: 'lg', jobId: 'j1', url: 'https://lg.example/u/alice.json', method: 'GET', kind: 'navigate', status: 200 });
      state.logFetch({ sourceId: 'lg', jobId: 'j1', url: 'https://cdn.example/a.js', method: 'GET', kind: 'blocked', status: null, note: 'off_domain' });
      state.logFetch({ sourceId: 'lg', jobId: 'j1', url: 'https://lg.example/cdn-cgi/x', method: 'POST', kind: 'blocked', status: null, note: 'beacon:cloudflare' });
      state.logFetch({ sourceId: 'lg', jobId: 'j1', url: 'https://lg.example/t/1', method: 'GET', kind: 'detection', status: 403, note: 'challenge' });
      state.setSession('lg', { lastBlockKind: 'challenge', lastBlockUrl: 'https://lg.example/t/secret-thread' });
      state.setSession('nl', { lastBlockKind: 'login', lastBlockUrl: 'https://nl.example/t/other' });
      samples.request('new.example', 'https://new.example/t/1');
      setSetting(db, 'retention_days', '90');
      const r = await get('/api/state', { cookie: COOKIE });
      const text = await r.text();
      expect(text).not.toContain('alice');
      expect(text).not.toContain('cdn.example');
      expect(text).not.toContain('secret-thread');
      expect(text).not.toContain('/t/other');
      const s = JSON.parse(text) as Record<string, unknown> & { sources: (Record<string, unknown> & { id: string })[] };
      expect(s).toMatchObject({
        version: '0.1.0',
        browser: { state: 'ready', lastError: null, handoff: null },
        jobs: [],
        drafts: [],
        samplesPending: [{ host: 'new.example', url: 'https://new.example/t/1' }],
        registryErrors: [],
        retentionDays: 90,
        cookieNotice: COOKIE_NOTICE,
      });
      const lg = s.sources.find((v) => v.id === 'lg')!;
      expect(lg.counts7d).toEqual({ blocked: 2, beaconsBlocked: 1, challenges: 1 });
      expect(lg.block).toBe('challenge');
      expect(s.sources.find((v) => v.id === 'nl')!.block).toBe('login');
      expect(s.sources.find((v) => v.id === 'fb')!.block).toBeNull();
      expect(lg.loginUrl).toBe('https://lg.example/login');
    });

    it('has the exact cookie notice (D28)', () =>
      expect(COOKIE_NOTICE).toBe(
        'lurkd keeps your forum cookies in its own browser profile at ~/.lurkd/profiles/default. Playwright starts that browser with a fixed encryption key, so anyone who can read the folder can read the cookies. Only your user account can open the folder (mode 0700).',
      ));

    it('renders a stored thread', async () => {
      const r = await get('/api/threads/12', { cookie: COOKIE });
      expect(await r.json()).toEqual({ markdown: '# A thread' });
      expect(service.threadMarkdown).toHaveBeenCalledWith(12);
      expect((await get('/api/threads/abc', { cookie: COOKIE })).status).toBe(400);
    });

    it('switches sources on and off, real names and beacons', async () => {
      expect((await ui('/api/sources/fb/enable', { acknowledge: false })).status).toBe(409);
      const on = await ui('/api/sources/fb/enable', { acknowledge: true });
      expect(on.status).toBe(200);
      expect(((await on.json()) as { source: { enabled: boolean } }).source.enabled).toBe(true);
      await ui('/api/sources/fb/disable');
      expect(registry.get('fb').enabled).toBe(false);
      await ui('/api/sources/lg/real-names', { show: true });
      expect(registry.get('lg').show_real_names).toBe(true);
      await ui('/api/sources/lg/beacons', { allow: true });
      expect(registry.get('lg').allow_beacons).toBe(true);
      expect((await ui('/api/sources/lg/beacons', { allow: 'yes' })).status).toBe(400);
      expect((await ui('/api/sources/nope/disable')).status).toBe(404);
    });

    it('starts a login handoff at login_url', async () => {
      const r = await ui('/api/sources/lg/login');
      expect(r.status).toBe(200);
      expect(browser.beginHandoff).toHaveBeenCalledWith({ sourceId: 'lg', url: 'https://lg.example/login', purpose: 'login' });
      expect(((await r.json()) as { handoff: HandoffInfo }).handoff).toMatchObject({ sourceId: 'lg', purpose: 'login' });
    });

    it('starts a challenge handoff at the blocked URL', async () => {
      state.setSession('lg', { lastBlockKind: 'challenge', lastBlockUrl: 'https://lg.example/t/topic/9' });
      expect((await ui('/api/sources/lg/login')).status).toBe(200);
      expect(browser.beginHandoff).toHaveBeenCalledWith({ sourceId: 'lg', url: 'https://lg.example/t/topic/9', purpose: 'challenge' });
    });

    it('refuses a login handoff for a source without login_url', async () => {
      const r = await ui('/api/sources/nl/login');
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
      expect(browser.beginHandoff).not.toHaveBeenCalled();
    });

    it('checks the session after a login handoff and records the login', async () => {
      await ui('/api/sources/lg/login');
      service.sessionStatus.mockImplementation(async () => {
        state.setSession('lg', { state: 'logged_in', lastCheckAt: '2026-11-09T12:01:00.000Z' });
        return [
          { id: 'lg', name: 'lg forum', state: 'logged_in', loginUrl: 'https://lg.example/login', lastLoginAt: null, lastCheckAt: null, needsAcknowledgment: false, lastBlock: null },
        ];
      });
      const r = await ui('/api/handoff/done');
      expect(r.status).toBe(200);
      expect(browser.endHandoff).toHaveBeenCalledTimes(1);
      expect(service.sessionStatus).toHaveBeenCalledWith('lg', true);
      expect(state.getSession('lg').lastLoginAt).not.toBeNull();
      const body = (await r.json()) as { sessions: SessionStatusOut[] };
      expect(body.sessions[0]!.state).toBe('logged_in');
      expect(body.sessions[0]!.lastLoginAt).not.toBeNull();
    });

    it('keeps the check error when the check after a login fails', async () => {
      await ui('/api/sources/lg/login');
      service.sessionStatus.mockImplementation(async (_id?: string, check?: boolean) => {
        if (check) throw new LurkdError('challenge', 'Human check.');
        return [{ id: 'lg', name: 'lg forum', state: 'never', loginUrl: 'https://lg.example/login', lastLoginAt: null, lastCheckAt: null, needsAcknowledgment: false, lastBlock: null }];
      });
      const out = await finishHandoff(deps, true);
      expect(out).toEqual([expect.objectContaining({ id: 'lg', checkError: 'challenge' })]);
      expect(state.getSession('lg').lastLoginAt).toBeNull();
    });

    it('cancels a handoff without a check', async () => {
      await ui('/api/sources/lg/login');
      const r = await ui('/api/handoff/cancel');
      expect(r.status).toBe(200);
      expect(browser.endHandoff).toHaveBeenCalledTimes(1);
      expect(service.sessionStatus).not.toHaveBeenCalledWith('lg', true);
      expect(await finishHandoff(deps, false)).toBeNull();
    });

    it('clears the challenge mark when the user finishes a challenge handoff', async () => {
      state.setSession('lg', { lastBlockKind: 'challenge', lastBlockUrl: 'https://lg.example/t/topic/9' });
      await ui('/api/sources/lg/login');
      await ui('/api/handoff/done');
      expect(state.getSession('lg')).toMatchObject({ lastBlockKind: null, lastBlockUrl: null });
    });

    it('opens a sample window at the requested URL and captures through formatStructure', async () => {
      samples.request('new.example', 'https://new.example/threads/one.1/');
      const opened = await ui('/api/sample-requests/open', { host: 'New.Example' });
      expect(opened.status).toBe(200);
      expect(browser.beginHandoff).toHaveBeenCalledWith({ sourceId: null, url: 'https://new.example/threads/one.1/', purpose: 'sample' });
      // A tampered walk: text smuggled into a tag name and a class must not reach the store.
      const tampered = { tag: 'body', classes: ['ok', 'Hello Bob, password 1234'], attrs: [], text: 3, children: [{ tag: 'p onclick=steal()', classes: [], attrs: [], text: 1, children: [] }] };
      browser.page = {
        url: () => 'https://new.example:8443/threads/one.1/?sid=abcdef0123&page=2#post-3',
        evaluate: vi.fn(async () => tampered),
        waitForLoadState: vi.fn(async () => {}),
      };
      const r = await ui('/api/sample-requests/capture');
      expect(r.status).toBe(200);
      const out = (await r.json()) as { status: string; host: string; url: string; structure: string };
      expect(out.status).toBe('sampled');
      expect(out.host).toBe('new.example');
      expect(out.structure).toBe('body.ok text=3\n  ? text=1');
      expect(out.url).toBe('https://new.example:8443/threads/one.1/?page=2');
      expect(samples.get('new.example')).toMatchObject({ structure: 'body.ok text=3\n  ? text=1' });
      expect(samples.pending()).toEqual([]);
      expect(browser.endHandoff).toHaveBeenCalledTimes(1);
    });

    it('refuses to capture a page of another host and keeps the window open', async () => {
      samples.request('new.example', 'https://new.example/t/1');
      await ui('/api/sample-requests/open', { host: 'new.example' });
      browser.page = { url: () => 'https://other.example/t/1', evaluate: vi.fn(), waitForLoadState: vi.fn(async () => {}) };
      const r = await ui('/api/sample-requests/capture');
      expect(r.status).toBe(400);
      expect(browser.page.evaluate).not.toHaveBeenCalled();
      expect(browser.endHandoff).not.toHaveBeenCalled();
      expect(samples.pending()).toHaveLength(1);
    });

    it('times out a page walk that never returns', async () => {
      samples.request('new.example', 'https://new.example/t/1');
      await ui('/api/sample-requests/open', { host: 'new.example' });
      browser.page = { url: () => 'https://new.example/t/1', evaluate: vi.fn(() => new Promise(() => {})), waitForLoadState: vi.fn(async () => {}) };
      await expect(captureSample(deps, { timeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout' });
      expect(samples.pending()).toHaveLength(1);
    });

    it('refuses to open a sample window for a host nobody asked for', async () => {
      expect((await ui('/api/sample-requests/open', { host: 'nobody.example' })).status).toBe(404);
      expect((await ui('/api/sample-requests/capture')).status).toBe(400);
    });

    it('approves and rejects drafts', async () => {
      const yaml = sourceYaml('dr', 'dr.example', { engine: 'generic' });
      const a = drafts.submit(yaml, 'dr.example');
      const b = drafts.submit(sourceYaml('dr2', 'dr2.example', { engine: 'generic' }), 'dr2.example');
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      const r = await ui(`/api/drafts/${a.draft.id}/approve`);
      expect(r.status).toBe(200);
      expect(((await r.json()) as { source: { id: string } }).source.id).toBe('dr');
      expect((await ui(`/api/drafts/${b.draft.id}/reject`)).status).toBe(200);
      expect(drafts.list('pending')).toEqual([]);
      expect((await ui('/api/drafts/999/approve')).status).toBe(404);
    });

    it('deletes the archive of a source through ThreadStore.deleteSource', async () => {
      const spy = vi.spyOn(threads, 'deleteSource');
      const r = await ui('/api/sources/lg/archive', undefined, 'DELETE');
      expect(r.status).toBe(200);
      expect(spy).toHaveBeenCalledWith('lg');
      expect(await r.json()).toEqual({ deleted: 0 });
    });

    it('stores the retention setting and applies it', async () => {
      const spy = vi.spyOn(threads, 'applyRetention');
      expect((await ui('/api/settings/retention', { days: 30 })).status).toBe(200);
      expect(getSetting(db, 'retention_days')).toBe('30');
      expect(spy).toHaveBeenCalledWith(30, expect.any(String));
      expect((await ui('/api/settings/retention', { days: null })).status).toBe(200);
      expect(getSetting(db, 'retention_days')).toBeNull();
      expect((await ui('/api/settings/retention', { days: 7 })).status).toBe(400);
      expect((await ui('/api/settings/retention', {})).status).toBe(400);
    });
  });

  describe('URLs in errors, through the real FetchService (requirement 9)', () => {
    let real: ReturnType<typeof createApp>;
    let withPage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      withPage = vi.fn();
      const b = Object.assign(browser, { withPage }) as unknown as BrowserManager;
      const svc = new FetchService({ registry, state, threads, samples, drafts, browser: b, queue, pacer: new HostPacer(), salt: 'a'.repeat(64) });
      real = createApp({ ...deps, service: svc, browser: b });
    });

    const post = (p: string, body: unknown) =>
      real.request(`${ORIGIN}${p}`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('never echoes a user name, password, query or fragment', async () => {
      const cases: [string, number, string][] = [
        ['https://user:secret@other.example/x?token=secret#secret', 403, 'off_domain'],
        ['https://user:secret@nl.example/t/topic/1', 400, 'invalid_request'],
        ['https://nl.example/session/logout?next=secret#secret', 403, 'denied_path'],
        ['not a url, user:secret', 403, 'off_domain'],
        ['javascript:alert("user:secret")', 403, 'off_domain'],
      ];
      for (const [url, status, code] of cases) {
        const r = await post('/api/fetch', { source: 'nl', url });
        const text = await r.text();
        expect([r.status, (JSON.parse(text) as { error: { code: string } }).error.code]).toEqual([status, code]);
        expect(text).not.toContain('secret');
        expect(text).not.toContain('user:');
      }
      const off = (await (await post('/api/fetch', { source: 'nl', url: 'https://user:secret@other.example/x?q=1' })).json()) as { error: { message: string; details: { url: string } } };
      expect(off.error.details.url).toBe('https://other.example/x');
      expect(off.error.message).toContain('https://other.example/x is not on a domain of nl');
      expect(withPage).not.toHaveBeenCalled();
    });

    it('keeps credentials out of a sample request', async () => {
      const r = await post('/api/sample', { url: 'https://user:secret@new.example/t/1' });
      const text = await r.text();
      expect(r.status).toBe(200);
      expect(text).not.toContain('secret');
      expect(samples.get('new.example')?.url).toBe('https://new.example/t/1');
    });
  });
});
