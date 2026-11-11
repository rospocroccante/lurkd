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
import { AddRequestStore, DraftStore, ForbiddenLog, SampleStore } from '../../src/sources/drafts.js';
import type { ResolveHost } from '../../src/sources/analyse.js';
import { GroupStore } from '../../src/sources/groups.js';
import { Registry } from '../../src/sources/registry.js';
import { UpdateStore } from '../../src/update/check.js';
import { formatError } from '../../src/client/format.js';
import { bareHostile, HOSTILE_NAME } from '../helpers/hostile.js';

const TOKEN = 'tok';
const PORT = 4100;
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** The token as a cookie, as a process that read the run file could set it by hand (D52). */
const TOKEN_COOKIE = `lurkd_token=${TOKEN}`;

type Requester = { request: (url: string, init?: RequestInit) => Response | Promise<Response> };

/** D52: a one-time page link, minted through the Bearer route as `lurkd open` mints it. */
async function pageLink(app: Requester): Promise<string> {
  const r = await app.request(`${ORIGIN}/api/page-link`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { url: string; expiresInSeconds: number };
  expect(body.expiresInSeconds).toBe(60);
  expect(body.url).toMatch(/^http:\/\/127\.0\.0\.1:4100\/\?n=[A-Za-z0-9_-]{43}$/);
  return body.url;
}

/** The `lurkd_page` cookie of an answer, as `name=value`, or undefined. */
const pageCookieOf = (r: Response): string | undefined =>
  r.headers
    .getSetCookie()
    .find((c) => c.startsWith('lurkd_page='))
    ?.split(';')[0];

/**
 * D52: the page's cookie, the page secret the app hands out once a one-time link is opened, as a
 * browser opening the link lurkd open printed gets it.
 */
async function pageCookie(app: Requester): Promise<string> {
  const r = await app.request(await pageLink(app));
  expect(r.status).toBe(200);
  const cookie = pageCookieOf(r);
  expect(cookie).toMatch(/^lurkd_page=[0-9a-f]{64}$/);
  return cookie!;
}

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
  pendingHandoffSourceId: string | null;
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
    pendingHandoffSourceId: null,
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
    analyse: vi.fn(),
    authorSignals: vi.fn(),
    threadMarkdown: vi.fn(() => '# A thread'),
    importReddit: vi.fn((_text: string, _via: 'page' | 'api') => ({
      source: 'reddit-import',
      threadId: 1,
      url: 'https://www.reddit.com/comments/1k2m3n4/',
      title: 'Zigbee',
      posts: 8,
      comments: 7,
      notInFile: 11,
      replaced: false,
      replacedImportAt: null,
      importedBy: 'lurkd import / API',
      importedAt: '2026-11-10T09:00:00.000Z',
    })),
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
  let addRequests: AddRequestStore;
  let forbidden: ForbiddenLog;
  let queue: FetchQueue;
  let browser: FakeBrowser;
  let service: ReturnType<typeof fakeService>;
  let shutdown: Mock<() => void>;
  let deps: AppDeps;
  let app: ReturnType<typeof createApp>;
  /** The page secret of `app` as the page's cookie. */
  let COOKIE: string;

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

  beforeEach(async () => {
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
    fs.writeFileSync(
      path.join(userDir, 'lg.yaml'),
      sourceYaml('lg', 'lg.example', { login_url: 'https://lg.example/login', signup_url: 'https://lg.example/signup' }),
    );
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
    addRequests = new AddRequestStore(db);
    forbidden = new ForbiddenLog(db);
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
      addRequests,
      forbidden,
      browser: browser as unknown as BrowserManager,
      queue,
      uiDir,
      shutdown,
      // M3: the draft routes look names up; nothing here reaches a DNS server.
      resolveHost: async () => [{ address: '93.184.215.14', family: 4 }],
    };
    app = createApp(deps);
    COOKIE = await pageCookie(app);
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
      // The token in an address opens nothing (D52).
      expect((await get(`/health?t=${TOKEN}`)).status).toBe(401);
      expect((await get(`/health?n=${TOKEN}`)).status).toBe(401);
      expect((await get('/?t=nope')).status).toBe(401);
      // An unknown path is checked like any other.
      expect((await get('/nothing-here')).status).toBe(401);
    });

    it('accepts the token as Bearer, or the page secret as the cookie, on agent routes', async () => {
      const r = await get('/health', bearer);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, version: '0.1.0', pid: process.pid, browser: 'ready' });
      // The page itself searches the archive, so the page's cookie opens agent routes too.
      expect((await get('/health', { cookie: COOKIE })).status).toBe(200);
      // D52: the token in a cookie opens nothing.
      expect((await get('/health', { cookie: TOKEN_COOKIE })).status).toBe(401);
      expect((await get('/health', { cookie: `lurkd_page=${TOKEN}` })).status).toBe(401);
    });

    it('opens the page from a one-time link: the page itself, the page secret in an HttpOnly, SameSite=Strict cookie, the old token cookie cleared (D52, M1, L2)', async () => {
      const link = await pageLink(app);
      const r = await app.request(link, { headers: { cookie: TOKEN_COOKIE } });
      // The page itself, not a redirect: a link followed from another site opens it too (M1).
      expect(r.status).toBe(200);
      expect(r.headers.get('location')).toBeNull();
      expect(r.headers.get('content-type')).toMatch(/text\/html/);
      expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(await r.text()).toContain('<title>lurkd</title>');
      const set = r.headers.getSetCookie();
      const page = set.find((c) => c.startsWith('lurkd_page='))!;
      expect(page).toMatch(/^lurkd_page=[0-9a-f]{64};.*HttpOnly.*SameSite=Strict/i);
      expect(page).toMatch(/Path=\//);
      // L2: a cookie an earlier lurkd set with the token goes.
      expect(set.find((c) => c.startsWith('lurkd_token='))).toMatch(/^lurkd_token=;.*Max-Age=0.*Path=\//i);
      expect(set.join('\n')).not.toContain(TOKEN_COOKIE);
      // The same secret for every link of this app, never the token.
      const secret = page.split(';')[0]!.slice('lurkd_page='.length);
      expect(secret).not.toBe(TOKEN);
      expect(COOKIE).toBe(`lurkd_page=${secret}`);
      expect(await pageCookie(app)).toBe(COOKIE);
    });

    it('takes each link once, for 60 seconds, and keeps at most five waiting (D52)', async () => {
      let clock = Date.parse('2026-11-11T10:00:00.000Z');
      const timed = createApp({ ...deps, now: () => clock });
      const link = await pageLink(timed);
      expect((await timed.request(link)).status).toBe(200);
      const again = await timed.request(link);
      expect(again.status).toBe(401);
      expect(again.headers.get('content-type')).toMatch(/text\/html/);
      expect(pageCookieOf(again)).toBeUndefined();
      expect(await again.text()).toContain('This link has been used or has expired.');
      // Expired after 60 s, even unused.
      const late = await pageLink(timed);
      const inTime = await pageLink(timed);
      clock += 60_000;
      expect((await timed.request(inTime)).status).toBe(200);
      clock += 1;
      const expired = await timed.request(late);
      expect([expired.status, pageCookieOf(expired)]).toEqual([401, undefined]);
      // The sixth link pushes out the oldest waiting one.
      const links: string[] = [];
      for (let i = 0; i < 6; i++) links.push(await pageLink(timed));
      expect((await timed.request(links[0]!)).status).toBe(401);
      for (const l of links.slice(1)) expect((await timed.request(l)).status).toBe(200);
      // Every link is new.
      expect(new Set(links).size).toBe(6);
    });

    it('never opens the page for the token, in the address or in a cookie (D52)', async () => {
      for (const [p, headers] of [
        [`/?t=${TOKEN}`, {}],
        [`/?n=${TOKEN}`, {}],
        [`/?t=${TOKEN}&n=${TOKEN}`, {}],
        ['/', { cookie: TOKEN_COOKIE }],
        ['/', { cookie: `lurkd_page=${TOKEN}` }],
        ['/', bearer],
        [`/?t=${TOKEN}`, bearer],
      ] as [string, Record<string, string>][]) {
        const r = await get(p, headers);
        expect([p, headers, r.status, pageCookieOf(r) ?? null]).toEqual([p, headers, 401, null]);
        expect(r.headers.get('content-type')).toMatch(/text\/html/);
      }
    });

    it('answers / without the page cookie with a small HTML page that says to run lurkd open, and API routes with JSON (M1)', async () => {
      const r = await get('/');
      expect(r.status).toBe(401);
      expect(r.headers.get('content-type')).toMatch(/^text\/html/);
      expect(r.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
      const html = await r.text();
      expect(html).toMatch(/^<!doctype html>/i);
      expect(html).toContain('lang="en-GB"');
      expect(html).toContain('<code>lurkd open</code>');
      expect(html).toContain('<code>lurkd start</code>');
      expect(html).not.toContain('<script');
      expect(html.length).toBeLessThan(3000);
      // L2: a plain link to / from another site arrives without the SameSite=Strict cookie.
      expect(html).toContain('This browser has not opened lurkd from a link yet, or lurkd has restarted since.');
      expect(html).toContain('A plain link to lurkd from another page does not open it either, even in a browser that opened it before.');
      const head = await app.request(`${ORIGIN}/`, { method: 'HEAD' });
      expect(head.status).toBe(401);
      // API routes keep JSON errors.
      const api = await get('/api/state');
      expect(api.status).toBe(401);
      expect(((await api.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    });

    it('shows the page to a browser that has the cookie, whatever link it opens again', async () => {
      const link = await pageLink(app);
      expect((await app.request(link)).status).toBe(200);
      const reload = await app.request(link, { headers: { cookie: COOKIE } });
      expect(reload.status).toBe(200);
      expect(await reload.text()).toContain('<title>lurkd</title>');
    });

    it('uses up a link opened by a browser that already has the cookie, so a cookieless client is refused it (M1)', async () => {
      const link = await pageLink(app);
      // `lurkd open` again in a browser that holds the cookie: the page, and nothing new set.
      const withCookie = await app.request(link, { headers: { cookie: COOKIE } });
      expect(withCookie.status).toBe(200);
      expect(await withCookie.text()).toContain('<title>lurkd</title>');
      // The same link, copied from `ps` or the history, by a client without the cookie.
      const stolen = await app.request(link);
      expect([stolen.status, pageCookieOf(stolen)]).toEqual([401, undefined]);
      expect(await stolen.text()).toContain('This link has been used or has expired.');
      // A used or unknown link with the cookie still shows the page, and mints nothing.
      for (const l of [link, `${ORIGIN}/?n=${'A'.repeat(43)}`]) {
        const r = await app.request(l, { headers: { cookie: COOKIE } });
        expect([r.status, pageCookieOf(r) ?? null]).toEqual([200, null]);
      }
    });

    it('checks the Origin and the Host before a link is taken, and HEAD takes none (D3, D52)', async () => {
      const link = await pageLink(app);
      const foreign = await app.request(link, { headers: { origin: 'https://evil.example' } });
      expect(foreign.status).toBe(403);
      expect(pageCookieOf(foreign)).toBeUndefined();
      const rebound = await app.request(link.replace(`127.0.0.1:${PORT}`, `evil.example:${PORT}`));
      expect([rebound.status, pageCookieOf(rebound)]).toEqual([403, undefined]);
      const head = await app.request(link, { method: 'HEAD' });
      expect([head.status, pageCookieOf(head)]).toEqual([401, undefined]);
      // The link was not used up by any of these.
      expect((await app.request(link)).status).toBe(200);
    });

    it('mints links for the Bearer token only: never for the page cookie, and never for a request from a web page (D52)', async () => {
      const mint = (headers: Record<string, string>, method = 'POST') => app.request(`${ORIGIN}/api/page-link`, { method, headers });
      const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
      const noBearer = await mint({ cookie: COOKIE });
      expect([noBearer.status, await code(noBearer)]).toEqual([401, 'unauthorized']);
      const fromPage = await mint({ cookie: COOKIE, origin: ORIGIN });
      expect(fromPage.status).toBe(403);
      // A browser sends an Origin with every POST; the CLI sends none. Even lurkd's own Origin is refused.
      for (const origin of [ORIGIN, `http://localhost:${PORT}`, 'https://evil.example', 'null']) {
        const r = await mint({ ...bearer, origin });
        expect([origin, r.status, await code(r)]).toEqual([origin, 403, 'bad_host']);
      }
      expect((await mint({ cookie: TOKEN_COOKIE })).status).toBe(401);
      expect((await mint(bearer, 'GET')).status).toBe(404);
      expect((await mint({ ...bearer, cookie: COOKIE })).status).toBe(200);
      // The answer holds the link only: neither the token nor the page secret.
      const text = await (await mint(bearer)).text();
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(COOKIE.slice('lurkd_page='.length));
    });

    it('starts every app with its own page secret, which no answer of an agent route carries (D52)', async () => {
      const other = createApp(deps);
      const otherCookie = await pageCookie(other);
      expect(otherCookie).not.toBe(COOKIE);
      expect((await other.request(`${ORIGIN}/api/state`, { headers: { cookie: COOKIE } })).status).toBe(401);
      expect((await other.request(`${ORIGIN}/api/state`, { headers: { cookie: otherCookie } })).status).toBe(200);
      const secret = COOKIE.slice('lurkd_page='.length);
      for (const p of ['/health', '/api/status', '/api/sources', '/api/session']) {
        const text = await (await get(p, bearer)).text();
        expect([p, text.includes(secret)]).toEqual([p, false]);
      }
    });

    it('refuses the token in a cookie on every page route, even with the page Origin (D52)', async () => {
      // Every route the app holds that is not an agent route belongs to the page.
      const agentRoutes = new Set([
        'GET /health',
        'GET /api/status',
        'GET /api/sources',
        'POST /api/fetch',
        'GET /api/archive/search',
        'GET /api/session',
        'POST /api/sample',
        'POST /api/add',
        'POST /api/import/reddit',
        'POST /api/author-signals',
        'POST /api/shutdown',
        'POST /api/page-link',
      ]);
      const pageRoutes = [...new Set(app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`))].filter((r) => !agentRoutes.has(r));
      expect(pageRoutes.length).toBeGreaterThan(30);
      expect(pageRoutes).toContain('GET /');
      expect(pageRoutes).toContain('POST /api/bulk/acknowledge');
      const fill = (p: string) => p.replace(':file', 'app.js').replace(':host', 'bench.example').replace(/:id/g, '1');
      for (const route of pageRoutes) {
        const [method, p] = route.split(' ') as [string, string];
        for (const cookie of [TOKEN_COOKIE, `lurkd_page=${TOKEN}`, `${TOKEN_COOKIE}; lurkd_page=nope`]) {
          const r = await send(method, fill(p), method === 'GET' ? undefined : {}, { cookie, origin: ORIGIN });
          // GET / answers the small HTML page; every other route a JSON error.
          const what = route === 'GET /' ? (r.headers.get('content-type') ?? '').split(';')[0] : ((await r.json()) as { error: { code: string } }).error.code;
          expect([route, cookie, r.status, what]).toEqual([route, cookie, 401, route === 'GET /' ? 'text/html' : 'unauthorized']);
        }
        // With the page secret the same request passes the check (whatever the route answers then).
        const ok = await send(method, fill(p), method === 'GET' ? undefined : {}, { cookie: COOKIE, origin: ORIGIN });
        expect([route, ok.status === 401]).toEqual([route, false]);
      }
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

  describe('Reddit import (D50)', () => {
    const thread = '[{"kind":"Listing","data":{"children":[]}},{"kind":"Listing","data":{"children":[]}}]';
    const raw = (p: string, body: string, headers: Record<string, string>) =>
      app.request(`${ORIGIN}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

    it('takes the file content from the CLI on the agent route and hands the text over unchanged', async () => {
      const r = await raw('/api/import/reddit', thread, bearer);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ source: 'reddit-import', threadId: 1, posts: 8 });
      // The CLI and an agent both hold the token, so the route is recorded as "lurkd import / API".
      expect(service.importReddit).toHaveBeenCalledWith(thread, 'api');
    });

    it('keeps the upload route to the page: cookie and Origin, never the Bearer token', async () => {
      expect((await raw('/api/import/reddit/upload', thread, bearer)).status).toBe(401);
      expect((await raw('/api/import/reddit/upload', thread, { ...bearer, origin: ORIGIN })).status).toBe(401);
      const noOrigin = await raw('/api/import/reddit/upload', thread, { cookie: COOKIE });
      expect([noOrigin.status, await code(noOrigin)]).toEqual([403, 'bad_host']);
      expect(service.importReddit).not.toHaveBeenCalled();
      const ok = await raw('/api/import/reddit/upload', thread, { cookie: COOKIE, origin: ORIGIN });
      expect(ok.status).toBe(200);
      expect(service.importReddit).toHaveBeenCalledWith(thread, 'page');
    });

    it('checks the page cookie and Origin on the upload route before the 20 MB limit (L4)', async () => {
      const over = ' '.repeat(20 * 1024 * 1024 + 1);
      for (const [h, status, c] of [
        [bearer, 401, 'unauthorized'],
        [{ ...bearer, origin: ORIGIN }, 401, 'unauthorized'],
        [{ cookie: TOKEN_COOKIE, origin: ORIGIN }, 401, 'unauthorized'],
        [{ cookie: COOKIE }, 403, 'bad_host'],
      ] as [Record<string, string>, number, string][]) {
        const r = await raw('/api/import/reddit/upload', over, h);
        expect([h, r.status, await code(r)]).toEqual([h, status, c]);
      }
      expect(service.importReddit).not.toHaveBeenCalled();
    });

    it('takes bodies up to 20 MB on the import routes only', async () => {
      const big = `[${' '.repeat(2 * 1024 * 1024)}]`;
      expect((await raw('/api/import/reddit', big, bearer)).status).toBe(200);
      expect((await raw('/api/import/reddit/upload', big, { cookie: COOKIE, origin: ORIGIN })).status).toBe(200);
      const over = ' '.repeat(20 * 1024 * 1024 + 1);
      for (const [p, h] of [['/api/import/reddit', bearer], ['/api/import/reddit/upload', { cookie: COOKIE, origin: ORIGIN }]] as const) {
        const r = await raw(p, over, h);
        expect(r.status).toBe(400);
        const body = (await r.json()) as { error: { code: string; message: string } };
        expect(body.error).toEqual({ code: 'invalid_request', message: 'The request body is larger than 20 MB.' });
      }
      expect(service.importReddit).toHaveBeenCalledTimes(2);
      // Every other route keeps the 1 MB cap.
      expect((await raw('/api/fetch', big, bearer)).status).toBe(400);
      expect((await raw('/api/import/reddit/other', big, bearer)).status).toBe(400);
    });

    it('refuses an empty body before the service sees it', async () => {
      const r = await raw('/api/import/reddit', '  ', bearer);
      expect([r.status, await code(r)]).toEqual([400, 'invalid_request']);
      expect(service.importReddit).not.toHaveBeenCalled();
    });

    it('answers lurkd add on a Reddit address with the import steps and queues nothing', async () => {
      const r = await send('POST', '/api/add', { url: 'https://old.reddit.com/r/homeassistant/comments/1k2m3n4/x/' }, bearer);
      expect(r.status).toBe(422);
      const body = (await r.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('unsupported');
      expect(body.error.message).toContain('lurkd import reddit <file>');
      expect(addRequests.pending()).toEqual([]);
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

    it('describes the page secret and the one-time link in the header comment of the real ui/app.js (L1)', () => {
      const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'ui', 'app.js'), 'utf8');
      const header = src.slice(0, src.search(/^import /m));
      expect(header).not.toMatch(/redirect/i);
      expect(header).not.toMatch(/holds it as a cookie/);
      expect(header).toContain('page secret');
      expect(header).toContain('one-time link');
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
      expect(lg.signupUrl).toBe('https://lg.example/signup');
      expect(s.sources.find((v) => v.id === 'nl')!.signupUrl).toBeNull();
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

    it('refuses to open a sample window at a local or private address recorded before the check (M2)', async () => {
      for (const [host, url] of [
        ['192.168.1.20', 'https://192.168.1.20/t/1'],
        ['localhost', 'http://localhost:8080/'],
        ['nas.local', 'https://nas.local/t/1'],
      ] as const) {
        samples.request(host, url);
        const r = await ui('/api/sample-requests/open', { host });
        expect(r.status, host).toBe(400);
        expect(((await r.json()) as { error: { message: string } }).error.message).toBe('lurkd opens public forums only, not addresses on your own network.');
      }
      expect(browser.beginHandoff).not.toHaveBeenCalled();
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

    // 0.2.1: a draft 0.2.0 stored, before the address rules, meets them and the DNS check on approval.
    it('holds a draft stored before the address rules to them, and to the DNS check, on approval', async () => {
      const LOCAL = 'lurkd opens public forums only, not addresses on your own network.';
      const stored = (id: string, host: string, extra: Record<string, unknown> = {}): number =>
        Number(
          db
            .prepare('INSERT INTO drafts (source_id, host, yaml, warnings, state, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, host, sourceYaml(id, host, { engine: 'generic', status: 'untested', enabled: false, ...extra }), '[]', 'pending', '2026-11-01T10:00:00.000Z')
            .lastInsertRowid,
        );
      const refused = async (r: Response): Promise<string[]> => {
        expect(r.status).toBe(400);
        const out = (await r.json()) as { error: { code: string; details: { errors: string[] } } };
        expect(out.error.code).toBe('invalid_request');
        return out.error.details.errors;
      };
      const login = stored('dr', 'dr.example', { domains: ['dr.example', '192.168.1.10'], login_url: 'https://192.168.1.10/login' });
      expect(await refused(await ui(`/api/drafts/${login}/approve`))).toContain(`dr.yaml: login_url: ${LOCAL}`);
      const rule = stored('dr2', 'dr2.example', { automation: { policy: 'allowed', rule_url: 'https://user:secret@dr2.example/rules', rule_quote: 'Bots welcome.', checked_at: '2026-11-08' } });
      const ruleErrors = await refused(await ui(`/api/drafts/${rule}/approve`));
      expect(ruleErrors).toEqual(['dr2.yaml: automation.rule_url: lurkd does not open addresses that carry a user name or password.']);
      expect(JSON.stringify(ruleErrors)).not.toContain('secret');
      const reddit = stored('dr3', 'dr3.example', { automation: { policy: 'allowed', rule_url: 'https://www.reddit.com/r/dr3/wiki/rules', rule_quote: 'Bots welcome.', checked_at: '2026-11-08' } });
      expect(await refused(await ui(`/api/drafts/${reddit}/approve`))).toEqual([
        'dr3.yaml: automation.rule_url: lurkd never reads Reddit live; Reddit threads come from files you saved (lurkd import reddit).',
      ]);
      // The base host resolves to a private address: the app's resolver, never real DNS.
      const resolveHost = vi.fn<ResolveHost>(async () => [{ address: '192.168.1.1', family: 4 }]);
      const dns = createApp({ ...deps, resolveHost });
      const dnsCookie = await pageCookie(dns);
      const base = stored('dr4', 'dr4.example');
      const r = await dns.request(`${ORIGIN}/api/drafts/${base}/approve`, { method: 'POST', headers: { cookie: dnsCookie, origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
      expect(await refused(r)).toEqual([`dr4.yaml: base_url: ${LOCAL}`, `dr4.yaml: domains: ${LOCAL}`]);
      expect(resolveHost).toHaveBeenCalledWith('dr4.example');
      for (const id of ['dr', 'dr2', 'dr3', 'dr4']) {
        expect(registry.ids()).not.toContain(id);
        expect(fs.existsSync(path.join(tmp, 'user', `${id}.yaml`))).toBe(false);
      }
      expect(drafts.list('pending').map((d) => d.id)).toEqual([login, rule, reddit, base]);
      // A clean draft still approves, through the default app's public resolver.
      const clean = stored('dr5', 'dr5.example');
      expect((await ui(`/api/drafts/${clean}/approve`)).status).toBe(200);
      expect(registry.ids()).toContain('dr5');
    });

    it('lets a loopback draft through approval only with the test-only allowance', async () => {
      const yaml = sourceYaml('loop', '127.0.0.1', { engine: 'generic', status: 'untested', enabled: false, base_url: 'http://127.0.0.1:4123', automation: { policy: 'allowed', rule_url: 'http://127.0.0.1:4123/rules', rule_quote: 'Bots welcome.', checked_at: '2026-11-08' } });
      const id = Number(
        db
          .prepare('INSERT INTO drafts (source_id, host, yaml, warnings, state, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run('loop', '127.0.0.1', yaml, '[]', 'pending', '2026-11-01T10:00:00.000Z').lastInsertRowid,
      );
      const resolveHost = vi.fn<ResolveHost>(async () => [{ address: '93.184.215.14', family: 4 }]);
      const plain = createApp({ ...deps, resolveHost });
      const tests = createApp({ ...deps, resolveHost, allowLoopbackForTests: true });
      const approve = async (a: ReturnType<typeof createApp>) =>
        a.request(`${ORIGIN}/api/drafts/${id}/approve`, { method: 'POST', headers: { cookie: await pageCookie(a), origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
      expect((await approve(plain)).status).toBe(400);
      expect(registry.ids()).not.toContain('loop');
      expect((await approve(tests)).status).toBe(200);
      expect(registry.ids()).toContain('loop');
      // 127.0.0.1 is not looked up under the allowance.
      expect(resolveHost).not.toHaveBeenCalled();
    });

    it('deletes the archive of a source through ThreadStore.deleteSource', async () => {
      const spy = vi.spyOn(threads, 'deleteSource');
      const r = await ui('/api/sources/lg/archive', undefined, 'DELETE');
      expect(r.status).toBe(200);
      expect(spy).toHaveBeenCalledWith('lg');
      expect(await r.json()).toEqual({ deleted: 0 });
    });

    it('starts a sign-up handoff at signup_url and checks the session on Done (D47)', async () => {
      const r = await ui('/api/sources/lg/signup');
      expect(r.status).toBe(200);
      expect(browser.beginHandoff).toHaveBeenCalledWith({ sourceId: 'lg', url: 'https://lg.example/signup', purpose: 'signup' });
      expect(((await r.json()) as { handoff: HandoffInfo }).handoff).toMatchObject({ sourceId: 'lg', url: 'https://lg.example/signup', purpose: 'signup' });
      service.sessionStatus.mockImplementation(async () => {
        state.setSession('lg', { state: 'logged_in', lastCheckAt: '2026-11-09T12:01:00.000Z' });
        return [
          { id: 'lg', name: 'lg forum', state: 'logged_in', loginUrl: 'https://lg.example/login', lastLoginAt: null, lastCheckAt: null, needsAcknowledgment: false, lastBlock: null },
        ];
      });
      const done = await ui('/api/handoff/done');
      expect(done.status).toBe(200);
      expect(browser.endHandoff).toHaveBeenCalledTimes(1);
      expect(service.sessionStatus).toHaveBeenCalledWith('lg', true);
      expect(state.getSession('lg').lastLoginAt).not.toBeNull();
    });

    it('opens the sign-up page even while a challenge is pending', async () => {
      state.setSession('lg', { lastBlockKind: 'challenge', lastBlockUrl: 'https://lg.example/t/topic/9' });
      expect((await ui('/api/sources/lg/signup')).status).toBe(200);
      expect(browser.beginHandoff).toHaveBeenCalledWith({ sourceId: 'lg', url: 'https://lg.example/signup', purpose: 'signup' });
    });

    it('refuses a sign-up handoff for a source without signup_url or an unknown source', async () => {
      const r = await ui('/api/sources/nl/signup');
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('invalid_request');
      expect(body.error.message).toBe('"nl forum" has no sign-up page, so there is nothing to open.');
      expect((await ui('/api/sources/nope/signup')).status).toBe(404);
      expect(browser.beginHandoff).not.toHaveBeenCalled();
    });

    it('keeps the sign-up route cookie-only and Origin-only', async () => {
      expect((await send('POST', '/api/sources/lg/signup', {}, { cookie: COOKIE })).status).toBe(403);
      expect((await send('POST', '/api/sources/lg/signup', {}, { ...bearer, origin: ORIGIN })).status).toBe(401);
      expect(browser.beginHandoff).not.toHaveBeenCalled();
    });

    it('removes a user source, clears its state and keeps its archive (D46)', async () => {
      threads.save('lg', {
        url: 'https://lg.example/t/1', title: 'B12 dosage', engine: 'discourse', postsExpected: 1, pages: null, extraction: 'discourse-json', quality: 'full',
        posts: [{ number: 1, page: 1, author: 'alice', authorUrl: null, signals: [], notes: [], postedAt: null, bodyMd: 'Once a week.' }],
      });
      registry.setShowRealNames('lg', true);
      state.setSession('lg', { state: 'logged_in' });
      const r = await ui('/api/sources/lg', undefined, 'DELETE');
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ removed: 'lg' });
      expect(fs.existsSync(path.join(tmp, 'user', 'lg.yaml'))).toBe(false);
      expect(registry.ids()).toEqual(['fb', 'nl']);
      expect(state.getOverride('lg').showRealNames).toBeNull();
      expect(state.getSession('lg').state).toBe('never');
      expect(threads.getByUrl('https://lg.example/t/1')).not.toBeNull();
      expect((await ui('/api/sources/lg', undefined, 'DELETE')).status).toBe(404);
    });

    it('refuses to remove a seed source or an unknown one', async () => {
      fs.writeFileSync(path.join(tmp, 'seed', 'sd.yaml'), sourceYaml('sd', 'sd.example'));
      registry.reload();
      expect(registry.view('sd').seed).toBe(true);
      const r = await ui('/api/sources/sd', undefined, 'DELETE');
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('invalid_request');
      expect(body.error.message).toBe('"sd forum" is a seed source (sd.yaml), so it cannot be removed; switch it off instead.');
      expect(fs.existsSync(path.join(tmp, 'seed', 'sd.yaml'))).toBe(true);
      expect((await ui('/api/sources/nope', undefined, 'DELETE')).status).toBe(404);
      expect((await ui('/api/sources/..%2Fseed%2Fsd', undefined, 'DELETE')).status).toBe(404);
      expect(registry.ids()).toEqual(['fb', 'lg', 'nl', 'sd']);
    });

    it('keeps removal cookie-only and Origin-only', async () => {
      expect((await send('DELETE', '/api/sources/nl', undefined, { cookie: COOKIE })).status).toBe(403);
      expect((await send('DELETE', '/api/sources/nl', undefined, { ...bearer, origin: ORIGIN })).status).toBe(401);
      expect((await send('DELETE', '/api/sources/nl', undefined, bearer)).status).toBe(401);
      expect(registry.ids()).toContain('nl');
    });

    it('refuses to remove a source while its handoff window is open', async () => {
      await ui('/api/sources/lg/login');
      const r = await ui('/api/sources/lg', undefined, 'DELETE');
      expect(r.status).toBe(423);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('handoff_in_progress');
      expect(registry.ids()).toContain('lg');
      // Another source's window does not block it.
      expect((await ui('/api/sources/nl', undefined, 'DELETE')).status).toBe(200);
    });

    it('refuses to remove a source while its handoff window is still launching', async () => {
      browser.pendingHandoffSourceId = 'lg';
      const r = await ui('/api/sources/lg', undefined, 'DELETE');
      expect(r.status).toBe(423);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('handoff_in_progress');
      expect(registry.ids()).toContain('lg');
      expect((await ui('/api/sources/nl', undefined, 'DELETE')).status).toBe(200);
      browser.pendingHandoffSourceId = null;
      expect((await ui('/api/sources/lg', undefined, 'DELETE')).status).toBe(200);
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

  describe('update check (D53)', () => {
    const CHECKED = '2026-11-11T09:00:00.000Z';
    let updates: UpdateStore;
    let nudged: Mock<(on: boolean) => void>;

    beforeEach(async () => {
      updates = new UpdateStore(db, { version: '0.1.0', env: {} });
      nudged = vi.fn<(on: boolean) => void>();
      app = createApp({ ...deps, updates, onUpdateCheckChanged: nudged });
      COOKIE = await pageCookie(app);
    });

    const pageState = async () => (await (await get('/api/state', { cookie: COOKIE })).json()) as { update: unknown; updateCheck: unknown };

    it('reports nothing until the registry named a newer version', async () => {
      expect(await pageState()).toMatchObject({ update: null, updateCheck: { on: true, offByEnv: false } });
      updates.recordSuccess('0.1.0', CHECKED);
      expect((await pageState()).update).toBeNull();
    });

    it('puts a newer version in /api/state, /api/status and /api/update', async () => {
      updates.recordSuccess('0.3.0', CHECKED);
      const info = { current: '0.1.0', latest: '0.3.0', checkedAt: CHECKED };
      expect((await pageState()).update).toEqual(info);
      expect(((await (await get('/api/status', bearer)).json()) as { update: unknown }).update).toEqual(info);
      expect(await (await get('/api/update', bearer)).json()).toEqual({ update: info });
      // The page's cookie reads it too.
      expect(await (await get('/api/update', { cookie: COOKIE })).json()).toEqual({ update: info });
      expect((await get('/api/update')).status).toBe(401);
    });

    it('switches the check off and on from the page only', async () => {
      updates.recordSuccess('0.3.0', CHECKED);
      const off = await ui('/api/settings/update-check', { enabled: false });
      expect(off.status).toBe(200);
      expect(await off.json()).toEqual({ updateCheck: { on: false, offByEnv: false } });
      expect(await pageState()).toMatchObject({ update: null, updateCheck: { on: false, offByEnv: false } });
      expect(((await (await get('/api/status', bearer)).json()) as { update: unknown }).update).toBeNull();
      expect(nudged).toHaveBeenLastCalledWith(false);
      expect((await ui('/api/settings/update-check', { enabled: true })).status).toBe(200);
      expect((await pageState()).update).not.toBeNull();
      expect(nudged).toHaveBeenLastCalledWith(true);
      // The agent's token cannot change it, and a body without a boolean is refused.
      expect((await send('POST', '/api/settings/update-check', { enabled: false }, bearer)).status).toBe(401);
      expect((await send('POST', '/api/settings/update-check', { enabled: false }, { cookie: COOKIE })).status).toBe(403);
      expect((await ui('/api/settings/update-check', { enabled: 'no' })).status).toBe(400);
      expect(updates.userEnabled()).toBe(true);
    });

    // M2: the dismissal lives in the archive, so it outlives a restart on another port.
    it('stores a dismissed banner version on the server, from the page only', async () => {
      updates.recordSuccess('0.3.0', CHECKED);
      expect(await pageState()).toMatchObject({ updateDismissed: null });
      const r = await ui('/api/update/dismiss', { version: '0.3.0' });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ updateDismissed: '0.3.0' });
      expect(updates.dismissed()).toBe('0.3.0');
      expect(await pageState()).toMatchObject({ updateDismissed: '0.3.0' });
      // A new app on the same archive (a restarted server) still knows it.
      app = createApp({ ...deps, updates: new UpdateStore(db, { version: '0.1.0', env: {} }) });
      COOKIE = await pageCookie(app);
      expect(await pageState()).toMatchObject({ updateDismissed: '0.3.0' });
      // The agent's token cannot dismiss, nor the cookie without the page's Origin; only a plain version is stored.
      expect((await send('POST', '/api/update/dismiss', { version: '0.4.0' }, bearer)).status).toBe(401);
      expect((await send('POST', '/api/update/dismiss', { version: '0.4.0' }, { cookie: COOKIE })).status).toBe(403);
      for (const version of ['0.4.0-beta', 'x', 3, null, '1.2.3\n'])
        expect((await ui('/api/update/dismiss', { version })).status, String(version)).toBe(400);
      expect(updates.dismissed()).toBe('0.3.0');
    });

    it('says when the environment turned the check off', async () => {
      const envOff = new UpdateStore(db, { version: '0.1.0', env: { LURKD_NO_UPDATE_CHECK: '1' } });
      envOff.recordSuccess('0.3.0', CHECKED);
      app = createApp({ ...deps, updates: envOff });
      COOKIE = await pageCookie(app);
      expect(await pageState()).toMatchObject({ update: null, updateCheck: { on: false, offByEnv: true } });
    });
  });

  describe('Add a forum (D45)', () => {
    const form = (over: Record<string, unknown> = {}) => ({
      engine: 'discourse',
      name: 'Plant Growers',
      base_url: 'https://plants.example',
      login_url: 'https://plants.example/login',
      signup_url: 'https://plants.example/signup',
      topics: ['gardening'],
      ...over,
    });

    it('queues an address from an agent and never loads it', async () => {
      const r = await send('POST', '/api/add', { url: 'https://Bench.Example/forums/#top' }, bearer);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ status: 'queued', host: 'bench.example', url: 'https://bench.example/forums/' });
      expect(addRequests.pending()).toEqual([{ host: 'bench.example', url: 'https://bench.example/forums/', requestedAt: expect.any(String) }]);
      // Nothing opened: no analysis, no job, no window.
      expect(service.analyse).not.toHaveBeenCalled();
      expect(service.sample).not.toHaveBeenCalled();
      expect(browser.beginHandoff).not.toHaveBeenCalled();
      expect(queue.snapshot()).toEqual([]);
      // The page lists it for "Analyse".
      const s = (await (await get('/api/state', { cookie: COOKIE })).json()) as { addRequests: unknown[] };
      expect(s.addRequests).toEqual([{ host: 'bench.example', url: 'https://bench.example/forums/', requestedAt: expect.any(String) }]);
    });

    // 0.2.1: the form's draft and an agent's draft (source.sample) follow one set of address rules.
    it('refuses a form draft whose addresses lurkd would not open, naming the field only', async () => {
      for (const [over, field] of [
        [{ base_url: 'https://10.0.0.5', domains: ['10.0.0.5'], login_url: null, signup_url: null }, 'base_url'],
        [{ domains: ['plants.example', 'nas.local'] }, 'domains'],
        [{ domains: ['plants.example', '192.168.1.9'], login_url: 'https://192.168.1.9/login' }, 'login_url'],
      ] as const) {
        const r = await ui('/api/add/draft', form(over));
        const text = await r.text();
        expect(r.status, field).toBe(400);
        const errors = (JSON.parse(text) as { error: { details: { errors: string[] } } }).error.details.errors;
        expect(errors.some((l) => l.includes(`${field}: lurkd opens public forums only`)), errors.join(' | ')).toBe(true);
      }
      expect(drafts.list('pending')).toEqual([]);
    });

    // M3: the form's draft runs the DNS half too, for the base host and every domain.
    it('refuses a form draft whose names resolve to private addresses', async () => {
      const looked: string[] = [];
      app = createApp({
        ...deps,
        resolveHost: async (host) => {
          looked.push(host);
          return [{ address: host === 'plants.example' ? '10.9.8.7' : '93.184.215.14', family: 4 }];
        },
      });
      COOKIE = await pageCookie(app);
      const r = await ui('/api/add/draft', form());
      expect(r.status).toBe(400);
      const errors = ((await r.json()) as { error: { details: { errors: string[] } } }).error.details.errors;
      expect(errors.some((l) => l.includes('base_url: lurkd opens public forums only')), errors.join(' | ')).toBe(true);
      expect(looked).toContain('plants.example');
      expect(drafts.list('pending')).toEqual([]);
      // The rules page of the form is checked as well.
      app = createApp(deps);
      COOKIE = await pageCookie(app);
      const bad = await ui('/api/add/draft', form({ automation: { policy: 'unknown', rule_url: 'https://192.168.0.1/tos', rule_quote: null } }));
      expect(bad.status).toBe(400);
      expect(await bad.text()).toContain('automation.rule_url: lurkd opens public forums only');
      expect((await ui('/api/add/draft', form())).status).toBe(200);
    });

    it('answers with the source id when a source already claims the host', async () => {
      const r = await send('POST', '/api/add', { url: 'https://lg.example/t/topic/1' }, bearer);
      expect(await r.json()).toEqual({ status: 'known', host: 'lg.example', sourceId: 'lg' });
      expect(addRequests.pending()).toEqual([]);
    });

    it('refuses an address it would not open, without echoing it', async () => {
      for (const url of ['https://10.0.0.1/', 'file:///etc/passwd', 'http://bench.example/', 'https://user:pw@printer.local/', 'https://alice:secret@bench.example/']) {
        const r = await send('POST', '/api/add', { url }, bearer);
        const text = await r.text();
        expect(r.status, url).toBe(400);
        expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe('invalid_request');
        expect(text).not.toMatch(/10\.0\.0\.1|passwd|pw@|printer|alice|secret/);
      }
      expect((await send('POST', '/api/add', {}, bearer)).status).toBe(400);
      expect(addRequests.pending()).toEqual([]);
    });

    it('refuses every loopback address from an agent by default, on any port (M1)', async () => {
      for (const url of [
        'http://127.0.0.1:4123/',
        'https://127.0.0.1/',
        'http://localhost:3000/',
        'https://localhost:8443/',
        'https://127.1/',
        'https://0x7f.0.0.1/',
        'https://2130706433/',
        'https://[::1]/',
        'https://[::1]:8443/',
      ]) {
        const r = await send('POST', '/api/add', { url }, bearer);
        expect(r.status, url).toBe(400);
        expect(((await r.json()) as { error: { code: string; message: string } }).error).toEqual({
          code: 'invalid_request',
          message: 'lurkd opens public forums only, not addresses on your own network.',
        });
      }
      expect(addRequests.pending()).toEqual([]);
      // The allowance exists only where a test builds the app, never by default.
      const tests = createApp({ ...deps, allowLoopbackForTests: true });
      const r = await tests.request(`${ORIGIN}/api/add`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:4123/' }) });
      expect(await r.json()).toEqual({ status: 'queued', host: '127.0.0.1', url: 'http://127.0.0.1:4123/' });
    });

    it('keeps the address the page shows: a host queued again keeps its first address (L4)', async () => {
      expect(await (await send('POST', '/api/add', { url: 'https://bench.example/forums/' }, bearer)).json()).toEqual({
        status: 'queued',
        host: 'bench.example',
        url: 'https://bench.example/forums/',
      });
      expect(await (await send('POST', '/api/add', { url: 'https://bench.example/elsewhere/' }, bearer)).json()).toEqual({
        status: 'already_queued',
        host: 'bench.example',
        url: 'https://bench.example/forums/',
      });
      expect(await (await send('POST', '/api/add', { url: 'https://bench.example/forums/' }, bearer)).json()).toEqual({
        status: 'queued',
        host: 'bench.example',
        url: 'https://bench.example/forums/',
      });
      expect(addRequests.pending()).toEqual([{ host: 'bench.example', url: 'https://bench.example/forums/', requestedAt: expect.any(String) }]);
    });

    it('dismisses a queued request from the lurkd page only (M2)', async () => {
      addRequests.request('bench.example', 'https://bench.example/');
      addRequests.request('plants.example', 'https://plants.example/');
      // The agent's token cannot dismiss, a forged Origin included; the page needs its Origin.
      expect((await send('DELETE', '/api/add/bench.example', undefined, bearer)).status).toBe(401);
      expect((await send('DELETE', '/api/add/bench.example', undefined, { ...bearer, origin: ORIGIN })).status).toBe(401);
      expect((await send('DELETE', '/api/add/bench.example', undefined, { cookie: COOKIE })).status).toBe(403);
      expect(addRequests.pending()).toHaveLength(2);
      const r = await ui('/api/add/Bench.Example', undefined, 'DELETE');
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ dismissed: 'bench.example' });
      expect(addRequests.pending().map((x) => x.host)).toEqual(['plants.example']);
      const gone = await ui('/api/add/bench.example', undefined, 'DELETE');
      expect(gone.status).toBe(404);
      expect(((await gone.json()) as { error: { code: string } }).error.code).toBe('not_found');
      expect(service.analyse).not.toHaveBeenCalled();
    });

    it('clears the queued request of a host when its draft is rejected (M2)', async () => {
      const saved = (await (await ui('/api/add/draft', form())).json()) as { draftId: number };
      // The agent queued the host again after the draft was saved.
      addRequests.request('plants.example', 'https://plants.example/');
      addRequests.request('bench.example', 'https://bench.example/');
      expect((await ui(`/api/drafts/${saved.draftId}/reject`)).status).toBe(200);
      expect(addRequests.pending().map((x) => x.host)).toEqual(['bench.example']);
    });

    it('refuses a user name or password in the form without echoing it (L5)', async () => {
      const r = await ui('/api/add/draft', form({ base_url: 'https://alice:secret@plants.example/' }));
      const text = await r.text();
      expect(r.status).toBe(400);
      expect(JSON.parse(text)).toMatchObject({ error: { code: 'invalid_request', details: { field: 'base_url' } } });
      expect(text).not.toMatch(/alice|secret/);
      expect(drafts.list()).toEqual([]);
    });

    it('keeps analyse and draft on the lurkd page: no Bearer token, no page without its Origin', async () => {
      for (const p of ['/api/add/analyse', '/api/add/draft']) {
        expect((await send('POST', p, { url: 'https://bench.example/' }, bearer)).status, p).toBe(401);
        expect((await send('POST', p, { url: 'https://bench.example/' }, { ...bearer, origin: ORIGIN })).status, p).toBe(401);
        expect((await send('POST', p, { url: 'https://bench.example/' }, { cookie: COOKIE })).status, p).toBe(403);
      }
      expect(service.analyse).not.toHaveBeenCalled();
      expect(drafts.list()).toEqual([]);
    });

    it('analyses the address the page sends and drops a queued request once a source claims the host', async () => {
      service.analyse.mockResolvedValueOnce({
        status: 'analysed',
        host: 'bench.example',
        forum: { engine: 'xenforo' },
        block: null,
        rules: { pages: [], clause: null },
        automation: { policy: 'unknown', rule_url: null, rule_quote: null },
      });
      const r = await ui('/api/add/analyse', { url: 'https://bench.example/' });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ status: 'analysed', host: 'bench.example' });
      expect(service.analyse).toHaveBeenCalledWith('https://bench.example/');
      addRequests.request('lg.example', 'https://lg.example/');
      service.analyse.mockResolvedValueOnce({ status: 'known', host: 'lg.example', sourceId: 'lg' });
      expect(await (await ui('/api/add/analyse', { url: 'https://lg.example/' })).json()).toEqual({ status: 'known', host: 'lg.example', sourceId: 'lg' });
      expect(addRequests.pending()).toEqual([]);
      expect((await ui('/api/add/analyse', {})).status).toBe(400);
    });

    it('saves the form as a pending draft through DraftStore and clears the queued request', async () => {
      addRequests.request('plants.example', 'https://plants.example/');
      const r = await ui('/api/add/draft', form());
      expect(r.status).toBe(200);
      const body = (await r.json()) as { status: string; draftId: number; sourceId: string; warnings: string[] };
      expect(body).toMatchObject({ status: 'draft_saved', host: 'plants.example', sourceId: 'plants-example' });
      expect(body.warnings).toEqual([
        'domains: plants.example',
        'login_url: https://plants.example/login',
        'signup_url: https://plants.example/signup',
        'policy unknown (https://plants.example)',
      ]);
      expect(addRequests.pending()).toEqual([]);
      const s = (await (await get('/api/state', { cookie: COOKIE })).json()) as { drafts: { id: number; sourceId: string }[] };
      expect(s.drafts.map((d) => [d.id, d.sourceId])).toEqual([[body.draftId, 'plants-example']]);
      // Approval is the existing path.
      expect((await ui(`/api/drafts/${body.draftId}/approve`)).status).toBe(200);
      expect(registry.view('plants-example')).toMatchObject({ enabled: false, signupUrl: 'https://plants.example/signup' });
    });

    it('cannot be used to loosen what protects the forum or the user', async () => {
      const r = await ui(
        '/api/add/draft',
        form({
          status: 'verified',
          enabled: true,
          show_real_names: true,
          allow_beacons: true,
          rate_limit: { min_delay_s: 0.1, max_requests_per_run: 60, max_requests_per_day: 100000 },
          pagination: { max_pages_per_thread: 500 },
          read_endpoints: [{ method: 'POST', path: '/search', note: 'search' }],
          deny_paths: [],
          automation: { policy: 'allowed', rule_url: 'https://plants.example/tos', rule_quote: 'Bots are welcome.' },
        }),
      );
      expect(r.status).toBe(200);
      const d = drafts.list('pending')[0]!;
      const stored = YAML.parse(d.yaml) as Record<string, unknown>;
      expect(stored).toMatchObject({ status: 'untested', enabled: false });
      for (const k of ['show_real_names', 'allow_beacons', 'rate_limit', 'pagination', 'read_endpoints']) expect(stored, k).not.toHaveProperty(k);
      expect((await ui(`/api/drafts/${d.id}/approve`)).status).toBe(200);
      const source = registry.get('plants-example');
      expect(source).toMatchObject({ status: 'untested', enabled: false, show_real_names: false, allow_beacons: false, read_endpoints: [] });
      expect(source.rate_limit).toEqual({ min_delay_s: 2, max_requests_per_run: 60, max_requests_per_day: 300 });
      expect(() => registry.assertUsable('plants-example')).toThrow(expect.objectContaining({ code: 'disabled' }));
    });

    it('reports what the schema refuses, field by field', async () => {
      const r = await ui('/api/add/draft', form({ topics: 'Gardening Tips', automation: { policy: 'allowed' }, login_url: 'https://elsewhere.example/login' }));
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: { code: string; details: { errors: string[] } } };
      expect(body.error.code).toBe('invalid_request');
      expect(body.error.details.errors).toEqual(
        expect.arrayContaining([
          'plants-example.yaml: topics[0] must be kebab-case (lowercase letters, digits, hyphens)',
          'plants-example.yaml: automation.rule_quote is required when automation.policy is allowed',
          'plants-example.yaml: login_url host elsewhere.example is not listed in domains',
        ]),
      );
      const engine = (await (await ui('/api/add/draft', form({ engine: 'custom' }))).json()) as { error: { code: string; details: { field: string } } };
      expect(engine.error).toMatchObject({ code: 'invalid_request', details: { field: 'engine' } });
      expect(drafts.list()).toEqual([]);
    });

    it('answers with the source id instead of a draft when a source already claims the host', async () => {
      addRequests.request('lg.example', 'https://lg.example/');
      const r = await ui('/api/add/draft', form({ base_url: 'https://lg.example', login_url: null, signup_url: null }));
      expect(await r.json()).toEqual({ status: 'known', host: 'lg.example', sourceId: 'lg' });
      expect(drafts.list()).toEqual([]);
      expect(addRequests.pending()).toEqual([]);
    });
  });

  describe('Forums that forbid automated access (D49)', () => {
    const CLAUSE = 'You may not automate access to the forum, or monitor the forum, such as with a web crawler.';
    const benchForum = {
      engine: 'discourse',
      name: 'Bench Electronics',
      base_url: 'https://bench.example',
      domains: ['bench.example'],
      login_url: 'https://bench.example/login',
      search_url: null,
      signup_url: 'https://bench.example/signup',
      termsLinks: [],
    };
    const analysed = (clause: { url: string; sentence: string } | null, forum: Record<string, unknown> = benchForum) => ({
      status: 'analysed',
      host: 'bench.example',
      forum,
      block: null,
      rules: { pages: [{ url: 'https://bench.example/tos', outcome: 'read' }], clause },
      automation:
        clause === null ? { policy: 'unknown', rule_url: null, rule_quote: null } : { policy: 'forbidden', rule_url: clause.url, rule_quote: clause.sentence },
    });
    const pageState = async () => (await (await get('/api/state', { cookie: COOKIE })).json()) as { forbidden: Record<string, unknown>[] };
    const record = () =>
      forbidden.record({
        host: 'bench.example',
        name: 'Bench Electronics',
        engine: 'discourse',
        baseUrl: 'https://bench.example',
        loginUrl: 'https://bench.example/login',
        signupUrl: 'https://bench.example/signup',
        searchUrl: null,
        ruleUrl: 'https://bench.example/tos',
        sentence: CLAUSE,
      });

    it('writes every clause the analysis finds to the log, latest first, and lists it in /api/state', async () => {
      service.analyse.mockResolvedValueOnce(analysed(null));
      await ui('/api/add/analyse', { url: 'https://bench.example/' });
      expect((await pageState()).forbidden).toEqual([]);
      service.analyse.mockResolvedValueOnce(analysed({ url: 'https://bench.example/tos', sentence: 'Bots are not allowed.' }));
      const r = await ui('/api/add/analyse', { url: 'https://bench.example/' });
      expect(await r.json()).toMatchObject({ automation: { policy: 'forbidden', rule_url: 'https://bench.example/tos', rule_quote: 'Bots are not allowed.' } });
      service.analyse.mockResolvedValueOnce(analysed({ url: 'https://bench.example/guidelines', sentence: CLAUSE }));
      await ui('/api/add/analyse', { url: 'https://bench.example/latest' });
      expect((await pageState()).forbidden).toEqual([
        {
          host: 'bench.example',
          name: 'Bench Electronics',
          engine: 'discourse',
          baseUrl: 'https://bench.example',
          ruleUrl: 'https://bench.example/guidelines',
          sentence: CLAUSE,
          foundAt: expect.any(String),
          sourceId: null,
        },
      ]);
      // A later analysis without a clause leaves the entry: only "Dismiss" removes it.
      service.analyse.mockResolvedValueOnce(analysed(null));
      await ui('/api/add/analyse', { url: 'https://bench.example/' });
      expect((await pageState()).forbidden).toHaveLength(1);
    });

    it('keeps the log on the lurkd page: no Bearer token, no change without the Origin', async () => {
      record();
      expect((await get('/api/state', bearer)).status).toBe(401);
      for (const [method, p] of [
        ['POST', '/api/forbidden/bench.example/draft'],
        ['DELETE', '/api/forbidden/bench.example'],
      ] as const) {
        expect((await send(method, p, { topics: 'electronics' }, bearer)).status, p).toBe(401);
        expect((await send(method, p, { topics: 'electronics' }, { ...bearer, origin: ORIGIN })).status, p).toBe(401);
        expect((await send(method, p, { topics: 'electronics' }, { cookie: COOKIE })).status, p).toBe(403);
      }
      expect(forbidden.list()).toHaveLength(1);
      expect(drafts.list()).toEqual([]);
    });

    it('"Add anyway" drafts the source with policy forbidden, the sentence and its page, through DraftStore', async () => {
      record();
      addRequests.request('bench.example', 'https://bench.example/');
      // The body cannot change the policy, the quote or the switch.
      const r = await ui('/api/forbidden/bench.example/draft', {
        topics: 'electronics, test-gear',
        enabled: true,
        status: 'verified',
        automation: { policy: 'allowed', rule_url: 'https://bench.example/', rule_quote: 'Anything goes.' },
      });
      expect(r.status).toBe(200);
      const out = (await r.json()) as { status: string; draftId: number; sourceId: string; warnings: string[] };
      expect(out).toMatchObject({ status: 'draft_saved', host: 'bench.example', sourceId: 'bench-example' });
      expect(out.warnings).toContain(`policy forbidden: "${CLAUSE}" (https://bench.example/tos)`);
      const [d] = drafts.list('pending');
      const yaml = YAML.parse(d!.yaml) as Record<string, any>;
      expect(yaml).toMatchObject({
        id: 'bench-example',
        status: 'untested',
        enabled: false,
        engine: 'discourse',
        topics: ['electronics', 'test-gear'],
        login_url: 'https://bench.example/login',
        automation: { policy: 'forbidden', rule_url: 'https://bench.example/tos', rule_quote: CLAUSE },
      });
      expect(forbidden.list()).toEqual([]);
      expect(addRequests.pending()).toEqual([]);
      // Approved, it lands switched off and needs "I accept".
      expect((await ui(`/api/drafts/${out.draftId}/approve`)).status).toBe(200);
      expect(registry.view('bench-example')).toMatchObject({ enabled: false, policy: 'forbidden', needsAcknowledgment: true });
      const on = await ui('/api/sources/bench-example/enable', {});
      expect(((await on.json()) as { error: { code: string } }).error.code).toBe('needs_acknowledgment');
    });

    it('"Add anyway" saves the name the person checked, and the logged name when the page sends none (M1)', async () => {
      record();
      const empty = await ui('/api/forbidden/bench.example/draft', { topics: 'electronics', name: '   ' });
      expect(empty.status).toBe(400);
      expect(((await empty.json()) as { error: { details: { errors: string[] } } }).error.details.errors).toEqual(['bench-example.yaml: name must not be empty']);
      const long = await ui('/api/forbidden/bench.example/draft', { topics: 'electronics', name: 'x'.repeat(101) });
      expect(long.status).toBe(400);
      expect(((await long.json()) as { error: { details: { field: string } } }).error.details.field).toBe('name');
      expect(forbidden.list()).toHaveLength(1);
      const r = await ui('/api/forbidden/bench.example/draft', { topics: 'electronics', name: '  Bench   Electronics Forum ' });
      expect(r.status).toBe(200);
      expect(YAML.parse(drafts.list('pending')[0]!.yaml)).toMatchObject({ name: 'Bench Electronics Forum', automation: { policy: 'forbidden', rule_quote: CLAUSE } });
      record();
      drafts.reject(drafts.list('pending')[0]!.id);
      expect((await ui('/api/forbidden/bench.example/draft', { topics: 'electronics' })).status).toBe(200);
      expect(YAML.parse(drafts.list('pending')[0]!.yaml)).toMatchObject({ name: 'Bench Electronics' });
    });

    it('"Add anyway" reports the schema errors field by field and keeps the entry', async () => {
      record();
      const r = await ui('/api/forbidden/bench.example/draft', { topics: 'Test Gear' });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: { details: { errors: string[] } } }).error.details.errors).toEqual([
        'bench-example.yaml: topics[0] must be kebab-case (lowercase letters, digits, hyphens)',
      ]);
      expect(forbidden.list()).toHaveLength(1);
      expect(drafts.list()).toEqual([]);
    });

    it('"Add anyway" refuses an unknown host and an engine lurkd cannot read, and answers known for a host a source claims', async () => {
      const missing = await ui('/api/forbidden/nobody.example/draft', { topics: 'x' });
      expect(missing.status).toBe(404);
      expect(await missing.text()).not.toContain('nobody.example');
      forbidden.record({ host: 'odd.example', name: 'Odd', engine: null, baseUrl: 'https://odd.example', loginUrl: null, signupUrl: null, searchUrl: null, ruleUrl: 'https://odd.example/rules', sentence: 'No bots.' });
      const odd = (await (await ui('/api/forbidden/odd.example/draft', { topics: 'x' })).json()) as { error: { code: string; details: { field: string } } };
      expect(odd.error).toMatchObject({ code: 'invalid_request', details: { field: 'engine' } });
      forbidden.record({ host: 'lg.example', name: 'LG', engine: 'discourse', baseUrl: 'https://lg.example', loginUrl: null, signupUrl: null, searchUrl: null, ruleUrl: 'https://lg.example/tos', sentence: 'No bots.' });
      expect((await pageState()).forbidden.find((e) => e.host === 'lg.example')).toMatchObject({ sourceId: 'lg' });
      expect(await (await ui('/api/forbidden/lg.example/draft', { topics: 'x' })).json()).toEqual({ status: 'known', host: 'lg.example', sourceId: 'lg' });
      expect(forbidden.get('lg.example')).toBeNull();
      expect(drafts.list()).toEqual([]);
    });

    it('"Dismiss" removes the entry', async () => {
      record();
      const r = await ui('/api/forbidden/BENCH.example', undefined, 'DELETE');
      expect(await r.json()).toEqual({ dismissed: 'bench.example' });
      expect(forbidden.list()).toEqual([]);
      const again = await ui('/api/forbidden/bench.example', undefined, 'DELETE');
      expect(again.status).toBe(404);
    });
  });

  describe('groups and bulk switching (D51)', () => {
    type Bulk = {
      enabled: string[];
      alreadyOn: string[];
      needsAcknowledgment: { id: string; name: string; policy: string; ruleUrl: string; ruleQuote: string | null }[];
      forbidden: { id: string; name: string; ruleUrl: string; ruleQuote: string | null }[];
      notSwitchable: string[];
      acknowledgment: { token: string; ids: string[] } | null;
    };
    const body = async <T>(r: Response): Promise<T> => (await r.json()) as T;
    const code = async (r: Response) => (await body<{ error: { code: string } }>(r)).error.code;
    let clock: number;
    let d51: ReturnType<typeof createApp>;
    let d51Cookie: string;
    const page = (p: string, b: unknown = {}, method = 'POST') =>
      d51.request(`${ORIGIN}${p}`, { method, headers: { 'content-type': 'application/json', cookie: d51Cookie, origin: ORIGIN }, body: b === undefined ? undefined : JSON.stringify(b) });
    const asAgent = (p: string, b: unknown = {}, method = 'POST') =>
      d51.request(`${ORIGIN}${p}`, { method, headers: { 'content-type': 'application/json', ...bearer }, body: b === undefined ? undefined : JSON.stringify(b) });
    const unknownYaml = (id: string) =>
      sourceYaml(id, `${id}.example`, { enabled: false, automation: { policy: 'unknown', rule_url: `https://${id}.example/tos`, rule_quote: null, checked_at: '2026-11-08' } });
    const on = (id: string) => registry.view(id).enabled;
    const acked = (id: string) => state.getOverride(id).acknowledgedAt !== null;

    beforeEach(async () => {
      const userDir = path.join(tmp, 'user');
      fs.writeFileSync(path.join(userDir, 'uk.yaml'), unknownYaml('uk'));
      fs.writeFileSync(path.join(userDir, 'uk2.yaml'), unknownYaml('uk2'));
      fs.writeFileSync(path.join(userDir, 'al.yaml'), sourceYaml('al', 'al.example', { enabled: false }));
      registry = Registry.load({ seedDir: path.join(tmp, 'seed'), userDir, state, builtins: true });
      expect(registry.errors()).toEqual([]);
      clock = Date.parse('2026-11-11T10:00:00.000Z');
      d51 = createApp({ ...deps, registry, now: () => clock });
      d51Cookie = await pageCookie(d51);
    });

    it('keeps every group and bulk route to the page: the Bearer token is refused, and a change needs the Origin', async () => {
      const routes: [string, string][] = [
        ['POST', '/api/groups'],
        ['POST', '/api/groups/1/rename'],
        ['DELETE', '/api/groups/1'],
        ['POST', '/api/groups/1/add'],
        ['POST', '/api/groups/1/remove'],
        ['POST', '/api/bulk/enable'],
        ['POST', '/api/bulk/acknowledge'],
        ['POST', '/api/bulk/disable'],
      ];
      for (const [method, p] of routes) {
        const r = await asAgent(p, { name: 'x', ids: ['al'] }, method);
        expect([p, r.status, await code(r)]).toEqual([p, 401, 'unauthorized']);
        const noOrigin = await d51.request(`${ORIGIN}${p}`, { method, headers: { 'content-type': 'application/json', cookie: d51Cookie }, body: '{"name":"x","ids":["al"]}' });
        expect([p, noOrigin.status]).toEqual([p, 403]);
      }
      expect(new GroupStore(db).list()).toEqual([]);
      expect(on('al')).toBe(false);
    });

    it('switches on at once the allowed sources, lists the unknown ones for one dialog and names the forbidden ones', async () => {
      const r = await page('/api/bulk/enable', { ids: ['al', 'uk', 'uk2', 'fb', 'lg', 'reddit-import'] });
      expect(r.status).toBe(200);
      const out = await body<Bulk>(r);
      expect(out.enabled).toEqual(['al']);
      expect(out.alreadyOn).toEqual(['lg']);
      expect(out.needsAcknowledgment).toEqual([
        { id: 'uk', name: 'uk forum', policy: 'unknown', ruleUrl: 'https://uk.example/tos', ruleQuote: null },
        { id: 'uk2', name: 'uk2 forum', policy: 'unknown', ruleUrl: 'https://uk2.example/tos', ruleQuote: null },
      ]);
      expect(out.forbidden).toEqual([{ id: 'fb', name: 'fb forum', ruleUrl: 'https://fb.example/rules', ruleQuote: 'No bots.' }]);
      expect(out.notSwitchable).toEqual(['reddit-import']);
      expect(out.acknowledgment?.ids).toEqual(['uk', 'uk2']);
      expect(out.acknowledgment?.token).toMatch(/^[0-9a-f]{32}$/);
      expect([on('al'), on('uk'), on('uk2'), on('fb'), on('reddit-import')]).toEqual([true, false, false, false, false]);
      expect([acked('uk'), acked('uk2'), acked('fb')]).toEqual([false, false, false]);

      // "I accept for these 2" acknowledges exactly the two the dialog listed.
      const ok = await page('/api/bulk/acknowledge', { token: out.acknowledgment!.token, ids: ['uk2', 'uk'] });
      expect(ok.status).toBe(200);
      expect(await body(ok)).toEqual({ enabled: ['uk', 'uk2'] });
      expect([on('uk'), on('uk2'), acked('uk'), acked('uk2'), on('fb'), acked('fb')]).toEqual([true, true, true, true, false, false]);
      expect(state.getOverride('uk').acknowledgedPolicy).toBe('unknown');
    });

    it('acknowledges nothing for a forged list: other ids, a forbidden id, a subset, a second use or no list at all', async () => {
      const plan = async () => (await body<Bulk>(await page('/api/bulk/enable', { ids: ['uk', 'uk2', 'fb'] }))).acknowledgment!;
      const forged: unknown[] = [];
      let a = await plan();
      forged.push({ token: a.token, ids: ['uk', 'uk2', 'fb'] });
      a = await plan();
      forged.push({ token: a.token, ids: ['uk', 'fb'] });
      a = await plan();
      forged.push({ token: a.token, ids: ['uk'] });
      a = await plan();
      forged.push({ token: a.token, ids: ['uk', 'uk2', 'lg'] });
      a = await plan();
      forged.push({ token: a.token, ids: ['uk', 'uk2', 'uk2', 'nope'] });
      forged.push({ token: 'f'.repeat(32), ids: ['uk', 'uk2'] });
      forged.push({ ids: ['uk', 'uk2'] });
      forged.push({ token: a.token });
      forged.push({ token: a.token, ids: 'uk' });
      for (const f of forged) {
        const r = await page('/api/bulk/acknowledge', f);
        expect([JSON.stringify(f), r.status]).toEqual([JSON.stringify(f), 400]);
      }
      expect([acked('uk'), acked('uk2'), acked('fb'), on('uk'), on('uk2'), on('fb')]).toEqual([false, false, false, false, false, false]);

      // A list is used once: the second "I accept" with the same token is refused.
      const good = await plan();
      expect((await page('/api/bulk/acknowledge', { token: good.token, ids: good.ids })).status).toBe(200);
      state.setOverride('uk', { enabled: false, acknowledgedAt: null, acknowledgedPolicy: null });
      expect((await page('/api/bulk/acknowledge', { token: good.token, ids: good.ids })).status).toBe(400);
      expect(acked('uk')).toBe(false);
    });

    it('never offers a forbidden source for the dialog, even with a forged plan request that names only forbidden ids', async () => {
      const out = await body<Bulk>(await page('/api/bulk/enable', { ids: ['fb'] }));
      expect(out).toMatchObject({ enabled: [], needsAcknowledgment: [], acknowledgment: null, forbidden: [{ id: 'fb' }] });
      expect([on('fb'), acked('fb')]).toEqual([false, false]);
      // Acknowledged once, by hand, it still does not go on in bulk.
      registry.enable('fb', true);
      registry.disable('fb');
      const again = await body<Bulk>(await page('/api/bulk/enable', { ids: ['fb'] }));
      expect(again).toMatchObject({ enabled: [], forbidden: [{ id: 'fb' }] });
      expect(on('fb')).toBe(false);
    });

    it('refuses the list once it is older than ten minutes, or once the rules of a listed source changed', async () => {
      const first = (await body<Bulk>(await page('/api/bulk/enable', { ids: ['uk', 'uk2'] }))).acknowledgment!;
      clock += 10 * 60_000 + 1;
      const late = await page('/api/bulk/acknowledge', first);
      expect([late.status, await code(late)]).toEqual([400, 'invalid_request']);
      expect(acked('uk')).toBe(false);

      const second = (await body<Bulk>(await page('/api/bulk/enable', { ids: ['uk', 'uk2'] }))).acknowledgment!;
      // uk2 now says its rules forbid automation: nothing is acknowledged, uk included.
      fs.writeFileSync(
        path.join(tmp, 'user', 'uk2.yaml'),
        sourceYaml('uk2', 'uk2.example', { enabled: false, automation: { policy: 'forbidden', rule_url: 'https://uk2.example/tos', rule_quote: 'No robots.', checked_at: '2026-11-11' } }),
      );
      registry.reload();
      const changed = await page('/api/bulk/acknowledge', second);
      expect(changed.status).toBe(409);
      expect((await body<{ error: { message: string } }>(changed)).error.message).toContain('uk2 forum');
      expect([acked('uk'), acked('uk2'), on('uk'), on('uk2')]).toEqual([false, false, false, false]);
    });

    it('quotes a hostile name when the rules of a listed source changed (M1)', async () => {
      const list = (await body<Bulk>(await page('/api/bulk/enable', { ids: ['uk', 'uk2'] }))).acknowledgment!;
      fs.writeFileSync(
        path.join(tmp, 'user', 'uk2.yaml'),
        YAML.stringify({ ...YAML.parse(unknownYaml('uk2')), name: HOSTILE_NAME, automation: { policy: 'allowed', rule_url: 'https://uk2.example/tos', rule_quote: 'Bots welcome.', checked_at: '2026-11-11' } }),
      );
      registry.reload();
      const r = await page('/api/bulk/acknowledge', list);
      expect(r.status).toBe(409);
      const err = (await body<{ error: { code: 'needs_acknowledgment'; message: string; details: Record<string, unknown> } }>(r)).error;
      const text = formatError(new LurkdError(err.code, err.message, err.details));
      expect(text).not.toContain(HOSTILE_NAME);
      expect(bareHostile(text)).toEqual([]);
      expect(err.message).toContain('The rules of "Forum. lurkd the user');
    });

    it('refuses a plan with an unknown id or a bad list and changes nothing', async () => {
      for (const b of [{ ids: ['al', 'nope'] }, { ids: [] }, { ids: 'al' }, {}, { ids: [1] }, { ids: Array.from({ length: 501 }, (_, i) => `s${i}`) }]) {
        const r = await page('/api/bulk/enable', b);
        expect(r.status).toBeGreaterThanOrEqual(400);
      }
      expect(on('al')).toBe(false);
    });

    it('switches a whole list off without asking, and leaves the imported source alone', async () => {
      const r = await page('/api/bulk/disable', { ids: ['lg', 'al', 'reddit-import'] });
      expect(await body(r)).toEqual({ disabled: ['lg', 'al'], notSwitchable: ['reddit-import'] });
      expect([on('lg'), on('al')]).toEqual([false, false]);
    });

    it('creates, renames, fills, empties and deletes groups from the page, and /api/state lists them', async () => {
      const created = await body<{ group: { id: number; name: string; sourceIds: string[] } }>(await page('/api/groups', { name: ' Smart  home ' }));
      expect(created.group).toMatchObject({ name: 'Smart home', sourceIds: [] });
      const id = created.group.id;
      const dup = await page('/api/groups', { name: 'smart HOME' });
      expect([dup.status, await code(dup)]).toEqual([400, 'invalid_request']);
      expect((await body<{ group: { name: string } }>(await page(`/api/groups/${id}/rename`, { name: 'Home lab' }))).group.name).toBe('Home lab');
      expect((await body<{ group: { sourceIds: string[] } }>(await page(`/api/groups/${id}/add`, { ids: ['lg', 'uk'] }))).group.sourceIds).toEqual(['lg', 'uk']);
      const unknown = await page(`/api/groups/${id}/add`, { ids: ['lg', 'nope'] });
      expect([unknown.status, await code(unknown)]).toEqual([404, 'unknown_source']);
      expect((await body<{ group: { sourceIds: string[] } }>(await page(`/api/groups/${id}/remove`, { ids: ['uk'] }))).group.sourceIds).toEqual(['lg']);
      const second = (await body<{ group: { id: number } }>(await page('/api/groups', { name: 'GPU' }))).group.id;
      await page(`/api/groups/${second}/add`, { ids: ['lg'] });
      const st = await body<{ groups: { id: number; name: string; sourceIds: string[] }[] }>(await d51.request(`${ORIGIN}/api/state`, { headers: { cookie: d51Cookie } }));
      expect(st.groups).toEqual([
        { id: second, name: 'GPU', sourceIds: ['lg'] },
        { id, name: 'Home lab', sourceIds: ['lg'] },
      ]);
      expect(await body(await page(`/api/groups/${id}`, undefined, 'DELETE'))).toEqual({ deleted: id });
      const gone = await page(`/api/groups/${id}`, undefined, 'DELETE');
      expect([gone.status, await code(gone)]).toEqual([404, 'not_found']);
      for (const bad of ['abc', '0', '-1']) expect((await page(`/api/groups/${bad}/rename`, { name: 'x' })).status).toBe(400);
    });

    it('lets the agent list the sources of a group by name, and nothing else about groups', async () => {
      const groups = new GroupStore(db);
      const g = groups.create('Smart home');
      groups.addMembers(g.id, ['lg', 'uk']);
      groups.create('Empty one');
      const r = await d51.request(`${ORIGIN}/api/sources?group=${encodeURIComponent('smart HOME')}`, { headers: bearer });
      expect(r.status).toBe(200);
      expect((await body<{ id: string }[]>(r)).map((v) => v.id)).toEqual(['lg', 'uk']);
      const withQuery = await d51.request(`${ORIGIN}/api/sources?group=Smart%20home&q=uk`, { headers: bearer });
      expect((await body<{ id: string }[]>(withQuery)).map((v) => v.id)).toEqual(['uk']);
      const none = await d51.request(`${ORIGIN}/api/sources?group=Nope`, { headers: bearer });
      expect(none.status).toBe(404);
      const err = (await body<{ error: { code: string; message: string } }>(none)).error;
      expect(err.code).toBe('not_found');
      expect(err.message).toBe('The user has no group named "Nope". Their groups: Empty one, Smart home.');
      expect((await d51.request(`${ORIGIN}/api/sources?group=Empty%20one`, { headers: bearer })).status).toBe(200);
      // An agent cannot see the groups any other way: /api/state is the page's.
      expect((await d51.request(`${ORIGIN}/api/state`, { headers: bearer })).status).toBe(401);
    });

    it('answers a group name that is not well-formed text with invalid_request, never a 500 (A8 L1)', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      for (const name of ['x\uD800', 'x\uD801']) {
        const r = await page('/api/groups', { name });
        expect([r.status, await code(r)]).toEqual([400, 'invalid_request']);
      }
      const ok = (await body<{ group: { id: number } }>(await page('/api/groups', { name: 'Fine' }))).group.id;
      const renamed = await page(`/api/groups/${ok}/rename`, { name: '\uDC00' });
      expect([renamed.status, await code(renamed)]).toEqual([400, 'invalid_request']);
      const zw = await page('/api/groups', { name: 'Fi​ne' });
      expect([zw.status, await code(zw)]).toEqual([400, 'invalid_request']);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      expect(new GroupStore(db).list().map((g) => g.name)).toEqual(['Fine']);
    });

    it('echoes an unknown group name to the agent without control, bidirectional or format characters (A8 L3)', async () => {
      const raw = 'Evil‮egap⁦x⁩‏​name\u0007\u{F0000}';
      const r = await d51.request(`${ORIGIN}/api/sources?group=${encodeURIComponent(raw)}`, { headers: bearer });
      expect(r.status).toBe(404);
      const msg = (await body<{ error: { message: string } }>(r)).error.message;
      expect(msg).toBe('The user has no group named "Evilegapxname". They have made no group yet; groups are made on the lurkd page.');
      expect(msg).not.toMatch(/[\p{Cc}\p{Cf}\p{Co}]/u);
    });

    it('takes group names with emoji ZWJ sequences and Persian ZWNJ, refuses look-alikes, and echoes ZWJ sequences whole (A9 M2)', async () => {
      const family = 'Trips \u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
      const persian = '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645';
      for (const name of [family, persian, 'Home']) {
        const r = await page('/api/groups', { name });
        expect([name, r.status]).toEqual([name, 200]);
        expect((await body<{ group: { name: string } }>(r)).group.name).toBe(name);
      }
      for (const name of ['Ho\u200Dme', 'H\u200Bome', '\u200D', 'Home\u2060']) {
        const r = await page('/api/groups', { name });
        expect([name, r.status, await code(r)]).toEqual([name, 400, 'invalid_request']);
      }
      // The agent finds them by name; an unknown name comes back with its ZWJ sequence whole.
      expect((await d51.request(`${ORIGIN}/api/sources?group=${encodeURIComponent(family)}`, { headers: bearer })).status).toBe(200);
      expect((await d51.request(`${ORIGIN}/api/sources?group=${encodeURIComponent('\u0645\u06CC\u062E\u0648\u0627\u0647\u0645')}`, { headers: bearer })).status).toBe(200);
      const rainbow = 'Pride \u{1F3F3}\uFE0F\u200D\u{1F308}';
      const r = await d51.request(`${ORIGIN}/api/sources?group=${encodeURIComponent(`${rainbow}\u200B`)}`, { headers: bearer });
      expect(r.status).toBe(404);
      expect((await body<{ error: { message: string } }>(r)).error.message).toContain(`no group named "${rainbow}".`);
    });

    it('forgets a removed source in every group', async () => {
      const groups = new GroupStore(db);
      const g = groups.create('Mixed');
      groups.addMembers(g.id, ['al', 'lg']);
      expect((await page('/api/sources/al', undefined, 'DELETE')).status).toBe(200);
      expect(groups.get(g.id)!.sourceIds).toEqual(['lg']);
    });

    it('gives each source the time of its latest archived thread as lastReadAt', async () => {
      const t = (url: string) => ({ url, title: 'T', engine: 'discourse' as const, postsExpected: 1, pages: null, extraction: 'x', quality: 'full' as const, posts: [] });
      threads.save('lg', t('https://lg.example/t/a/1'), '2026-11-09T08:00:00.000Z');
      threads.save('lg', t('https://lg.example/t/b/2'), '2026-11-10T09:30:00.000Z');
      threads.save('uk', t('https://uk.example/t/c/3'), '2026-11-01T07:00:00.000Z');
      const st = await body<{ sources: { id: string; lastReadAt: string | null }[] }>(await d51.request(`${ORIGIN}/api/state`, { headers: { cookie: d51Cookie } }));
      const read = Object.fromEntries(st.sources.map((v) => [v.id, v.lastReadAt]));
      expect(read).toMatchObject({ lg: '2026-11-10T09:30:00.000Z', uk: '2026-11-01T07:00:00.000Z', al: null, fb: null });
    });
  });

  describe('URLs in errors, through the real FetchService (requirement 9)', () => {
    let real: ReturnType<typeof createApp>;
    let realCookie: string;
    let withPage: ReturnType<typeof vi.fn>;
    let resolveHost: Mock<ResolveHost>;

    beforeEach(async () => {
      withPage = vi.fn();
      // C4: an injected resolver, so no unit test reaches real DNS.
      resolveHost = vi.fn<ResolveHost>(async () => [{ address: '10.0.0.1', family: 4 }]);
      const b = Object.assign(browser, { withPage }) as unknown as BrowserManager;
      const svc = new FetchService({ registry, state, threads, samples, drafts, browser: b, queue, pacer: new HostPacer(), salt: 'a'.repeat(64), resolveHost });
      real = createApp({ ...deps, service: svc, browser: b });
      realCookie = await pageCookie(real);
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

    it('analyses nothing it would refuse to open, and never echoes the address (D45)', async () => {
      const page = (body: unknown) =>
        real.request(`${ORIGIN}/api/add/analyse`, { method: 'POST', headers: { cookie: realCookie, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const cases: [string, number, string][] = [
        ['https://user:secret@bench.example/', 400, 'invalid_request'],
        ['https://192.168.1.10/?token=secret', 400, 'invalid_request'],
        ['ftp://bench.example/secret', 400, 'invalid_request'],
        ['https://bench.example/session/logout?next=secret#secret', 403, 'denied_path'],
        ['https://bench.example/posts/9/react', 403, 'denied_path'],
        // M1: no loopback by default, whatever its spelling or port.
        ['http://127.0.0.1:4123/', 400, 'invalid_request'],
        ['http://localhost:4123/', 400, 'invalid_request'],
        ['https://127.1/', 400, 'invalid_request'],
        ['https://0x7f.0.0.1/', 400, 'invalid_request'],
        ['https://2130706433/', 400, 'invalid_request'],
        ['https://[::1]:8443/', 400, 'invalid_request'],
      ];
      for (const [url, status, code] of cases) {
        const r = await page({ url });
        const text = await r.text();
        expect([url, r.status, (JSON.parse(text) as { error: { code: string } }).error.code]).toEqual([url, status, code]);
        expect(text).not.toContain('secret');
      }
      expect(await (await page({ url: 'https://lg.example/t/topic/1' })).json()).toEqual({ status: 'known', host: 'lg.example', sourceId: 'lg' });
      expect(withPage).not.toHaveBeenCalled();
      expect(queue.snapshot()).toEqual([]);
    });

    it('looks hosts up through the injected resolver, never real DNS (C4)', async () => {
      const r = await real.request(`${ORIGIN}/api/add/analyse`, {
        method: 'POST',
        headers: { cookie: realCookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://bench.example/' }),
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: { message: string } }).error.message).toBe('lurkd opens public forums only, not addresses on your own network.');
      expect(resolveHost).toHaveBeenCalledWith('bench.example');
      expect(withPage).not.toHaveBeenCalled();
    });

    it('keeps credentials out of a sample request', async () => {
      // M2: a sample request is recorded only for a host that resolves to public addresses.
      resolveHost.mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
      const r = await post('/api/sample', { url: 'https://user:secret@new.example/t/1' });
      const text = await r.text();
      expect(r.status).toBe(200);
      expect(text).not.toContain('secret');
      expect(samples.get('new.example')?.url).toBe('https://new.example/t/1');
    });
  });
});
