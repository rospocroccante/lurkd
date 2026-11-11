import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import type Database from 'better-sqlite3';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import YAML from 'yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openArchive } from '../../src/archive/db.js';
import { StateStore } from '../../src/archive/state.js';
import { ThreadStore } from '../../src/archive/threads.js';
import type { BrowserManager, BrowserState, HandoffInfo } from '../../src/browser/manager.js';
import { FetchQueue } from '../../src/fetch/queue.js';
import type { ArchiveHitOut, FetchService } from '../../src/fetch/service.js';
import { createApp, type AppDeps } from '../../src/server/app.js';
import { AddRequestStore, DraftStore, ForbiddenLog, SampleStore } from '../../src/sources/drafts.js';
import { Registry } from '../../src/sources/registry.js';
import { UpdateStore } from '../../src/update/check.js';
import { lurkdPaths, PACKAGE_ROOT } from '../../src/paths.js';
import { startServer } from '../../src/server/main.js';
import { UNKNOWN_ENGINE_TEXT } from '../../ui/view.js';
import { fixture, pageCookie, pageLink } from '../helpers/common.js';
import { html, startFixtureServer, type FixtureServer, type Handler } from '../helpers/fixture-server.js';

// The lurkd page in a headless Chromium, served by the real app on 127.0.0.1 with fake service and
// browser objects. The page files are the real ones from <repo>/ui.

const TOKEN = 'tok';
const MARKERS = `alice`;

const sourceYaml = (id: string, host: string, extra: Record<string, unknown> = {}) =>
  YAML.stringify({
    id,
    name: `${id} forum`,
    description: `Talk about ${id}`,
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
  beginHandoff: ReturnType<typeof vi.fn>;
  endHandoff: ReturnType<typeof vi.fn>;
  handoffPage: () => null;
}

function fakeBrowser(): FakeBrowser {
  const b: FakeBrowser = {
    state: 'ready',
    lastError: null,
    handoff: null,
    beginHandoff: vi.fn(async (info: Omit<HandoffInfo, 'startedAt'>) => {
      b.handoff = { ...info, startedAt: '2026-11-09T12:00:00.000Z' };
      b.state = 'handoff';
    }),
    endHandoff: vi.fn(async () => {
      b.handoff = null;
      b.state = 'ready';
      return { finalUrl: null };
    }),
    handoffPage: () => null,
  };
  return b;
}

const hit: ArchiveHitOut = {
  source: 'lg',
  threadId: 7,
  threadUrl: 'https://lg.example/t/b12/7',
  threadTitle: 'B12 levels in plant diets',
  postNumber: 3,
  author: 'author-0a1b2c3d4e',
  postedAt: '2026-10-01T08:00:00.000Z',
  excerpt: '... most people on a plant diet should check B12 once a year ...',
  signals: [],
};


// The page polls every 1.5 s, so a check waits longer than vitest's default second.
const poll = <T>(fn: () => T | Promise<T>) => expect.poll(fn, { timeout: 8000 });
const see = (loc: Locator, timeout = 5000) => loc.first().waitFor({ state: 'visible', timeout });
const gone = (loc: Locator, timeout = 5000) => loc.first().waitFor({ state: 'hidden', timeout });
const has = (loc: Locator, text: string) => poll(async () => (await loc.allInnerTexts()).join('\n')).toContain(text);
/** M1: the detected name sits in the form's Name field, as its value. */
const hasName = (loc: Locator, name: string) => poll(async () => (await loc.locator('#add-name').count()) > 0 && (await loc.locator('#add-name').inputValue())).toBe(name);
// A7: one table row per source, its actions in a row menu.
const rowOf = (page: Page, name: string) => page.locator('tr.source', { hasText: name });
const openMenu = async (page: Page, name: string) => {
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  const menu = page.getByRole('menu', { name: `Actions for ${name}`, exact: true });
  await see(menu);
  return menu;
};
const item = (menu: Locator, name: string) => menu.getByRole('menuitem', { name, exact: true });
// Menu items in the page, open or not.
const itemsInPage = (page: Page, text: string) => page.locator('[role^=menuitem]', { hasText: new RegExp(`^${text}$`) });

describe('the lurkd page', () => {
  let chrome: Browser;
  let tmp: string;
  let db: Database.Database;
  let queue: FetchQueue;
  let browser: FakeBrowser;
  let registry: Registry;
  let server: http.Server;
  let origin: string;
  let page: Page;
  let problems: string[];
  let updates: UpdateStore;
  let appDeps: AppDeps;
  let service: {
    archiveSearch: ReturnType<typeof vi.fn>;
    sessionStatus: ReturnType<typeof vi.fn>;
    threadMarkdown: ReturnType<typeof vi.fn>;
  };

  beforeAll(async () => {
    chrome = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await chrome?.close();
  });

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-ui-'));
    const seedDir = path.join(tmp, 'seed');
    const userDir = path.join(tmp, 'user');
    fs.mkdirSync(seedDir);
    fs.mkdirSync(userDir);
    fs.writeFileSync(path.join(userDir, 'lg.yaml'), sourceYaml('lg', 'lg.example', { login_url: 'https://lg.example/login' }));
    fs.writeFileSync(
      path.join(userDir, 'fb.yaml'),
      sourceYaml('fb', 'fb.example', {
        enabled: false,
        automation: { policy: 'forbidden', rule_url: 'https://fb.example/rules', rule_quote: 'No bots.', checked_at: '2026-11-08' },
      }),
    );
    db = openArchive(':memory:');
    const state = new StateStore(db);
    // D53: on, as a fresh install is, with nothing found yet; no request is ever made here.
    updates = new UpdateStore(db, { version: '0.1.0', env: {} });
    registry = Registry.load({ seedDir, userDir, state });
    expect(registry.errors()).toEqual([]);
    queue = new FetchQueue();
    browser = fakeBrowser();
    service = {
      archiveSearch: vi.fn((q: string) => (/b12/i.test(q) ? [hit] : [])),
      sessionStatus: vi.fn(async () => []),
      threadMarkdown: vi.fn(() => `# B12 levels\n\n## Post 1 by ${MARKERS}\n\n<b>not bold</b> and <script>window.__pwned = 1</script>`),
    };
    let port = 0;
    const deps: AppDeps = (appDeps = {
      token: TOKEN,
      port: () => port,
      version: '0.1.0',
      db,
      service: service as unknown as FetchService,
      registry,
      state,
      threads: new ThreadStore(db, 'a'.repeat(64)),
      drafts: new DraftStore(db, registry, { state }),
      samples: new SampleStore(db),
      addRequests: new AddRequestStore(db),
      forbidden: new ForbiddenLog(db),
      browser: browser as unknown as BrowserManager,
      queue,
      uiDir: path.join(PACKAGE_ROOT, 'ui'),
      shutdown: () => {},
      updates,
      // M3: the draft routes look names up; nothing here reaches a DNS server.
      resolveHost: async () => [{ address: '93.184.215.14', family: 4 }],
    });
    const app = createApp(deps);
    server = await new Promise<http.Server>((resolve) => {
      const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
        port = info.port;
        resolve(s as unknown as http.Server);
      });
    });
    origin = `http://127.0.0.1:${port}`;
    page = await chrome.newPage({ viewport: { width: 1000, height: 900 } });
    problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`);
    });
  });

  afterEach(async () => {
    await page.close();
    await new Promise((r) => server.close(r));
    server.closeAllConnections();
    await queue.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const open = async () => {
    await page.goto(await pageLink(Number(new URL(origin).port), TOKEN));
    await page.getByText('fb forum', { exact: true }).waitFor();
  };

  // D53: the banner for a newer lurkd and the "Check for new versions" switch.
  it('shows a newer lurkd in a banner that Dismiss hides for that version only, and switches the check off', async () => {
    updates.recordSuccess('0.3.0', '2026-11-11T09:00:00.000Z');
    await open();
    const banner = page.locator('#update-banner');
    await see(banner);
    await has(banner, 'lurkd 0.3.0 is available. Run lurkd update in a terminal to install it.');
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await gone(banner);
    // M2: the dismissal is stored by the server, not in this browser's storage for this port.
    await poll(() => updates.dismissed()).toBe('0.3.0');
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).toBe('{}');
    await page.reload();
    await page.getByText('fb forum', { exact: true }).waitFor();
    expect(await banner.isHidden()).toBe(true);
    // A restarted server on another port (another origin, so other browser storage) still hides it.
    const before = origin;
    await new Promise((r) => server.close(r));
    server.closeAllConnections();
    let port2 = 0;
    const app2 = createApp({ ...appDeps, port: () => port2, updates: new UpdateStore(db, { version: '0.1.0', env: {} }) });
    server = await new Promise<http.Server>((resolve) => {
      const s2 = serve({ fetch: app2.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
        port2 = info.port;
        resolve(s2 as unknown as http.Server);
      });
    });
    origin = `http://127.0.0.1:${port2}`;
    expect(origin).not.toBe(before);
    await open();
    await page.locator('#settings > summary').waitFor();
    // The page has drawn its state: the directory is there and the banner stays hidden.
    expect(await banner.isHidden()).toBe(true);
    // A newer version shows again.
    updates.recordSuccess('0.4.0', '2026-11-12T09:00:00.000Z');
    await see(banner, 8000);
    await has(banner, 'lurkd 0.4.0 is available.');
    // Settings: on by default; switching it off hides the banner and stores the choice.
    await page.locator('#settings > summary').click();
    const sw = page.getByRole('switch', { name: 'Check for new versions' });
    expect(await sw.isChecked()).toBe(true);
    await sw.click();
    await poll(() => updates.userEnabled()).toBe(false);
    await gone(banner);
    expect(await sw.isChecked()).toBe(false);
    await sw.click();
    await poll(() => updates.userEnabled()).toBe(true);
    await see(banner);
    expect(problems).toEqual([]);
  });

  it('greys out the switch when the environment turned the check off', async () => {
    await page.close();
    await new Promise((r) => server.close(r));
    server.closeAllConnections();
    const envOff = new UpdateStore(db, { version: '0.1.0', env: { LURKD_NO_UPDATE_CHECK: '1' } });
    envOff.recordSuccess('0.3.0', '2026-11-11T09:00:00.000Z');
    let port = 0;
    const app = createApp({
      token: TOKEN,
      port: () => port,
      version: '0.1.0',
      db,
      service: service as unknown as FetchService,
      registry,
      state: new StateStore(db),
      threads: new ThreadStore(db, 'a'.repeat(64)),
      drafts: new DraftStore(db, registry),
      samples: new SampleStore(db),
      addRequests: new AddRequestStore(db),
      forbidden: new ForbiddenLog(db),
      browser: browser as unknown as BrowserManager,
      queue,
      uiDir: path.join(PACKAGE_ROOT, 'ui'),
      shutdown: () => {},
      updates: envOff,
      resolveHost: async () => [{ address: '93.184.215.14', family: 4 }],
    });
    server = await new Promise<http.Server>((resolve) => {
      const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
        port = info.port;
        resolve(s as unknown as http.Server);
      });
    });
    origin = `http://127.0.0.1:${port}`;
    page = await chrome.newPage({ viewport: { width: 1000, height: 900 } });
    await open();
    await page.locator('#settings > summary').click();
    const sw = page.getByRole('switch', { name: 'Check for new versions' });
    await poll(() => sw.isDisabled()).toBe(true);
    expect(await sw.isChecked()).toBe(false);
    await has(page.locator('#update-check-note'), 'LURKD_NO_UPDATE_CHECK=1');
    expect(await page.locator('#update-banner').isHidden()).toBe(true);
  });

  it('walks the directory, the acknowledgment, the search and the handoff banner', async () => {
    await open();

    // The token left the address bar, the DOM and storage; the page loaded from /.
    expect(page.url()).toBe(`${origin}/`);
    expect(await page.evaluate(() => document.documentElement.outerHTML.includes('tok') && document.documentElement.outerHTML.includes('?t='))).toBe(false);
    expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).toBe('[{},{}]');

    // A forbidden row shows "Switched off".
    const fb = rowOf(page, 'fb forum');
    await see(fb.getByText('Switched off', { exact: true }));
    await see(fb.getByText('Automation forbidden', { exact: true }));
    await see(rowOf(page, 'lg forum').getByText('Not logged in', { exact: true }));

    // Its switch opens a dialog with the rule quote; "I accept" posts acknowledge: true.
    const posts: { url: string; body: string; origin: string | undefined }[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET') posts.push({ url: new URL(r.url()).pathname, body: r.postData() ?? '', origin: r.headers()['origin'] });
    });
    await fb.getByRole('switch', { name: /fb forum/ }).click();
    const dialog = page.getByRole('dialog');
    await see(dialog);
    await has(dialog, 'No bots.');
    expect(await dialog.locator('a').getAttribute('href')).toBe('https://fb.example/rules');
    expect(await dialog.locator('a').getAttribute('rel')).toBe('noopener noreferrer');
    // Cancel sends nothing.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await gone(dialog);
    expect(posts).toEqual([]);
    await fb.getByRole('switch', { name: /fb forum/ }).click();
    await page.getByRole('button', { name: 'I accept' }).click();
    await poll(() => fb.getByRole('switch', { name: /fb forum/ }).isChecked()).toBe(true);
    await poll(() => posts.length).toBe(1);
    // The server refuses a change from the page without its Origin, so the enable below went out with it.
    expect(posts[0]).toMatchObject({ url: '/api/sources/fb/enable' });
    expect(JSON.parse(posts[0]!.body)).toEqual({ acknowledge: true });
    expect(registry.view('fb').enabled).toBe(true);

    // Typing filters the directory at once and searches the archive after a pause.
    const search = page.getByRole('searchbox', { name: /search/i });
    await search.fill('b12');
    await poll(() => page.locator('tr.source').count()).toBe(0);
    await see(page.getByText('No source matches "b12".', { exact: true }));
    const hits = page.locator('#results li');
    await poll(() => hits.count()).toBe(1);
    await has(hits.first(), 'B12 levels in plant diets');
    await has(hits.first(), 'lg');
    await has(hits.first(), 'post 3');
    await has(hits.first(), 'author-0a1b2c3d4e');
    await has(hits.first(), 'plant diet');
    expect(service.archiveSearch).toHaveBeenCalledWith('b12', {});

    // A click shows the Markdown as text in a <pre>: no markup, no script, markers left as they are.
    await hits.first().getByRole('button').click();
    const pre = page.locator('#thread-panel pre');
    await has(pre, '# B12 levels');
    expect(await pre.textContent()).toContain('<b>not bold</b> and <script>window.__pwned = 1</script>');
    expect(await pre.textContent()).toContain(MARKERS);
    expect(await page.locator('#thread-panel b').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(service.threadMarkdown).toHaveBeenCalledWith(7);

    // A query with no hit says so.
    await search.fill('zzzz');
    await see(page.getByText('No archived posts match'));
    await search.fill('');
    await poll(() => page.locator('tr.source').count()).toBe(2);

    // The handoff banner shows while the browser reports a handoff; Done posts to /api/handoff/done.
    browser.handoff = { sourceId: 'lg', url: 'https://lg.example/login', purpose: 'login', startedAt: '2026-11-09T12:00:00.000Z' };
    browser.state = 'handoff';
    const banner = page.getByRole('status').filter({ hasText: 'A browser window is open for' });
    await has(banner, 'A browser window is open for lg forum. Log in there, then press Done.');
    posts.length = 0;
    await banner.getByRole('button', { name: 'Done' }).click();
    await gone(banner);
    expect(posts.map((p) => p.url)).toContain('/api/handoff/done');
    expect(browser.endHandoff).toHaveBeenCalled();

    // A sample handoff shows its own text.
    browser.handoff = { sourceId: null, url: 'https://new.example/t/1', purpose: 'sample', startedAt: '2026-11-09T12:00:00.000Z' };
    const sample = page.getByRole('status').filter({ hasText: 'Open a thread page of' });
    await has(sample, 'Open a thread page of new.example in the window, then press Use this page.');
    await see(sample.getByRole('button', { name: 'Use this page' }));
    await sample.getByRole('button', { name: 'Cancel' }).click();
    await gone(sample);
    expect(browser.endHandoff).toHaveBeenCalledTimes(2);

    // D19: no control starts a read.
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('button, a, [role=button], input[type=submit]')].map((e) => ((e as HTMLElement).innerText || e.getAttribute('aria-label') || '').trim()),
    );
    expect(labels.length).toBeGreaterThan(3);
    for (const l of labels) expect(l).not.toMatch(/fetch|read now/i);

    expect(problems).toEqual([]);
  });

  it('shows the queue, the retention choice, the cookie notice and the sample and draft panels', async () => {
    await open();
    // A7: archive settings and the cookie note sit in a collapsed Settings section at the bottom.
    const settings = page.locator('details#settings');
    const notice = page.locator('details.cookie-notice');
    expect(await settings.getAttribute('open')).toBeNull();
    expect(await notice.getAttribute('open')).toBeNull();
    expect(await page.evaluate(() => {
      const box = document.getElementById('settings')!;
      return [...document.querySelectorAll('main > *')].filter((el) => !(el as HTMLElement).hidden).at(-1) === box;
    })).toBe(true);
    await settings.locator('summary').first().click();
    await poll(() => settings.getAttribute('open')).toBe('');
    expect(await notice.getAttribute('open')).toBeNull();
    await notice.locator('summary').click();
    await poll(() => notice.getAttribute('open')).toBe('');
    await has(notice, 'lurkd keeps your forum cookies in its own browser profile at ~/.lurkd/profiles/default.');
    await notice.locator('summary').click();
    await poll(() => notice.getAttribute('open')).toBeNull();

    // The queue panel opens from the queue state in the header.
    const queueState = page.locator('#queue-state');
    await has(queueState, 'Queue empty');
    await queueState.click();
    expect(await queueState.getAttribute('aria-expanded')).toBe('true');
    await see(page.locator('#panel-queue').getByText('No jobs yet'));
    // The samples and drafts panels say when they are empty.
    await page.locator('#panel-queue').getByRole('button', { name: 'Close Queue' }).click();
    await gone(page.locator('#panel-queue'));
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('queue-state');
    const retention = page.getByLabel('Keep archived threads', { exact: true });
    await poll(() => retention.inputValue()).toBe('');
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') posts.push(`${new URL(r.url()).pathname} ${r.postData() ?? ''}`);
    });
    // Choosing 90 days asks first: it deletes older threads at once.
    await retention.selectOption('90');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    expect(posts).toEqual([]);
    await retention.selectOption('90');
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
    await poll(() => posts).toEqual(['/api/settings/retention {"days":90}']);

    expect(problems).toEqual([]);
  });

  it('inserts every server string as text and links only http and https', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    // An http(s) address that is also markup: rendered as a link it would give an <a>, rendered as
    // HTML an <a> and an <img>.
    const queuedUrl = 'https://evil.example/?q=<a href="https://evil.example/x">x</a><img src=x onerror="window.__pwned=6">';
    await page.route('**/api/state', async (route) => {
      const res = await route.fetch();
      const s = (await res.json()) as Record<string, any>;
      s.sources[0].name = hostile;
      s.sources[0].description = hostile;
      s.sources[0].topics = [hostile];
      s.sources[0].ruleUrl = 'javascript:window.__pwned=3';
      s.sources[0].ruleQuote = hostile;
      s.sources[0].loginUrl = 'javascript:window.__pwned=4';
      s.sources[1].ruleUrl = 'https://ok.example/rules';
      s.browser.lastError = hostile;
      s.jobs = [
        { jobId: 'a', sourceId: hostile, kind: 'fetch', state: 'failed', phase: 'done', threadIndex: 0, threadCount: 0, postsFetched: 0, requestsUsed: 0, requestCap: 0, message: hostile, queuedAt: 'x', startedAt: null, endedAt: null },
      ];
      s.drafts = [{ id: 1, sourceId: hostile, host: hostile, yaml: hostile, warnings: [hostile], state: 'pending', createdAt: 'x' }];
      s.samplesPending = [{ host: hostile, url: 'javascript:window.__pwned=5', requestedAt: 'x' }];
      s.addRequests = [{ host: hostile, url: queuedUrl, requestedAt: 'x' }];
      s.registryErrors = [hostile];
      s.forbidden = [
        { host: hostile, name: hostile, engine: 'discourse', baseUrl: 'https://x.example', ruleUrl: 'javascript:window.__pwned=7', sentence: hostile, foundAt: 'x', sourceId: null },
      ];
      await route.fulfill({ response: res, json: s });
    });
    await page.goto(await pageLink(Number(new URL(origin).port), TOKEN));
    await see(page.locator('tr.source').first());
    // Every panel open in turn: drafts, the add requests, the forbidden log, the source file errors.
    await page.locator('[data-todo="drafts"]').click();
    await see(page.locator('li.draft'));
    await page.locator('[data-todo="add"]').click();
    await see(page.locator('#add-requests li'));
    await page.locator('[data-todo="forbidden"]').click();
    const entry = page.locator('#forbidden li');
    await see(entry);
    expect(await entry.locator('.source-name').textContent()).toBe(hostile);
    expect(await entry.locator('blockquote').textContent()).toBe(hostile);
    // A rules page that is not http(s) gets no link.
    expect(await entry.locator('a').count()).toBe(0);
    await page.locator('[data-todo="errors"]').click();
    await see(page.locator('#registry-errors li'));
    expect(await page.locator('#registry-errors li').textContent()).toBe(hostile);
    // The queued address and host are on the page as text, character for character, and nothing
    // in the list became an element of its own.
    const queued = page.locator('#add-requests li');
    expect(await queued.locator('a, img, script').count()).toBe(0);
    expect(await queued.locator('.desc').textContent()).toBe(queuedUrl);
    expect(await queued.locator('.source-name').textContent()).toBe(hostile);
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.locator('body script').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')));
    for (const h of hrefs) expect(h).toMatch(/^https?:\/\//);
    expect(hrefs).toContain('https://ok.example/rules');
    // The source whose login address is not http(s) gets no Log in item; the other one does.
    expect(await itemsInPage(page, 'Log in').count()).toBe(1);
    for (const a of await page.locator('a').all()) expect(await a.getAttribute('rel')).toBe('noopener noreferrer');
    service.archiveSearch.mockReturnValueOnce([{ ...hit, threadTitle: hostile, author: hostile, excerpt: hostile, source: hostile }]);
    await page.getByLabel(/search/i).fill('b12');
    await poll(() => page.locator('#results li').count()).toBe(1);

    await see(page.locator('#results li'));
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    // The hostile text is on the page as text.
    await see(page.getByText(hostile, { exact: false }).first());
    expect(problems).toEqual([]);
  });

  it('shows loading, an empty directory and a server that is not running', async () => {
    await page.route('**/api/state', async (route) => {
      const res = await route.fetch();
      const s = (await res.json()) as Record<string, unknown>;
      s['sources'] = [];
      await route.fulfill({ response: res, json: s });
    });
    await page.goto(await pageLink(Number(new URL(origin).port), TOKEN));
    await see(page.getByText('No sources are installed'));

    await page.unroute('**/api/state');
    await page.route('**/api/state', (route) => route.abort());
    await see(page.getByText('lurkd is not running. Run lurkd start in a terminal.'), 10000);
    // It recovers by itself when the server answers again.
    await page.unroute('**/api/state');
    await gone(page.getByText('lurkd is not running. Run lurkd start in a terminal.'), 10000);
    await see(page.locator('tr.source').first());
  });

  it('offers Open window only for a pending challenge', async () => {
    await page.route('**/api/state', async (route) => {
      const res = await route.fetch();
      const s = (await res.json()) as Record<string, any>;
      // fb: challenges in the last 7 days but nothing pending now; lg: a challenge pending.
      s.sources[0].counts7d = { blocked: 0, beaconsBlocked: 0, challenges: 5 };
      s.sources[0].block = null;
      s.sources[1].counts7d = { blocked: 0, beaconsBlocked: 0, challenges: 0 };
      s.sources[1].block = 'challenge';
      await route.fulfill({ response: res, json: s });
    });
    await page.goto(await pageLink(Number(new URL(origin).port), TOKEN));
    await see(page.locator('tr.source').first());
    await poll(() => itemsInPage(page, 'Open window').count()).toBe(1);
    // The row says so, and its menu holds the item.
    await see(rowOf(page, 'lg forum').getByText('Human check waiting', { exact: true }));
    expect(await rowOf(page, 'fb forum').getByText('Human check waiting').count()).toBe(0);
    const menu = await openMenu(page, 'lg forum');
    await see(item(menu, 'Open window'));
    await page.keyboard.press('Escape');
    expect(await rowOf(page, 'fb forum').locator('[role^=menuitem]', { hasText: 'Open window' }).count()).toBe(0);
    // A pending login block does not offer it either.
    await page.unroute('**/api/state');
    await page.route('**/api/state', async (route) => {
      const res = await route.fetch();
      const s = (await res.json()) as Record<string, any>;
      s.sources[1].block = 'login';
      await route.fulfill({ response: res, json: s });
    });
    await poll(() => itemsInPage(page, 'Open window').count()).toBe(0);
  });

  it('keeps the focus in a row while the counts change from poll to poll', async () => {
    let n = 0;
    await page.route('**/api/state', async (route) => {
      const res = await route.fetch();
      const s = (await res.json()) as Record<string, any>;
      n += 1;
      for (const v of s.sources) v.counts7d = { blocked: n, beaconsBlocked: 0, challenges: 0 };
      await route.fulfill({ response: res, json: s });
    });
    await page.goto(await pageLink(Number(new URL(origin).port), TOKEN));
    const row = rowOf(page, 'lg forum');
    // The 7-day counts show in the expanded row.
    await row.getByRole('button', { name: 'Details of lg forum' }).click();
    const counts = page.locator('#detail-lg .week-counts');
    await see(counts);
    await row.getByRole('switch').focus();
    await page.evaluate(() => {
      (window as unknown as { __kept: Element | null }).__kept = document.activeElement;
    });
    const before = await counts.innerText();
    await poll(() => counts.innerText()).not.toBe(before);
    // Several polls later the same input element still has the focus.
    const seen = n;
    await poll(() => n).toBeGreaterThanOrEqual(seen + 2);
    expect(await page.evaluate(() => document.activeElement === (window as unknown as { __kept: Element | null }).__kept && document.activeElement?.tagName)).toBe('INPUT');
  });

  it('words the challenge banner for a human check and the rules dialog as a plain decision', async () => {
    await open();
    browser.handoff = { sourceId: 'lg', url: 'https://lg.example/t/1', purpose: 'challenge', startedAt: '2026-11-09T12:00:00.000Z' };
    const banner = page.getByRole('status').filter({ hasText: 'A browser window is open for' });
    await has(banner, 'A browser window is open for lg forum. Complete the human check there, then press Done.');
    expect(await banner.innerText()).not.toContain('Log in there');
    await banner.getByRole('button', { name: 'Cancel' }).click();
    await gone(banner);

    const fb = rowOf(page, 'fb forum');
    await fb.getByRole('switch').click();
    const dialog = page.getByRole('dialog');
    await has(dialog, 'No bots.');
    const text = await dialog.innerText();
    expect(text).toContain('Switching this on means lurkd reads this site with your login although its rules forbid automation. You take that decision.');
    expect(text).not.toMatch(/slowly|acceptable|only reads/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  it('offers a labelled Read the warning button only while a source needs its acknowledgment', async () => {
    // An unknown-policy source is on by default but refused until the warning is accepted.
    fs.writeFileSync(
      path.join(tmp, 'user', 'uk.yaml'),
      sourceYaml('uk', 'uk.example', {
        automation: { policy: 'unknown', rule_url: 'https://uk.example/rules', rule_quote: null, checked_at: '2026-11-08' },
      }),
    );
    registry.reload();
    expect(registry.view('uk')).toMatchObject({ enabled: true, needsAcknowledgment: true });
    await open();

    const uk = rowOf(page, 'uk forum');
    // The row is on and refused until the warning is accepted: it says so.
    await see(uk.getByText('Warning to read', { exact: true }));
    let menu = await openMenu(page, 'uk forum');
    const button = item(menu, 'Read the warning');
    await see(button);
    await page.keyboard.press('Escape');
    // fb (forbidden, not yet accepted) has it too; lg (policy allowed) never does.
    await poll(() => itemsInPage(page, 'Read the warning').count()).toBe(2);
    expect(await rowOf(page, 'fb forum').locator('[role^=menuitem]', { hasText: 'Read the warning' }).count()).toBe(1);
    expect(await rowOf(page, 'lg forum').locator('[role^=menuitem]', { hasText: 'Read the warning' }).count()).toBe(0);

    const posts: { url: string; body: string }[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET') posts.push({ url: new URL(r.url()).pathname, body: r.postData() ?? '' });
    });
    menu = await openMenu(page, 'uk forum');
    await item(menu, 'Read the warning').click();
    const dialog = page.getByRole('dialog');
    await see(dialog);
    await has(dialog, 'The rules page has no line that lurkd could quote.');
    expect(await dialog.locator('a').getAttribute('href')).toBe('https://uk.example/rules');
    expect(await dialog.innerText()).toContain('You take that decision.');
    // Cancel sends nothing and the item stays.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await gone(dialog);
    expect(posts).toEqual([]);
    menu = await openMenu(page, 'uk forum');
    await item(menu, 'Read the warning').click();
    await page.getByRole('button', { name: 'I accept' }).click();
    await poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ url: '/api/sources/uk/enable' });
    expect(JSON.parse(posts[0]!.body)).toEqual({ acknowledge: true });
    await poll(() => rowOf(page, 'uk forum').locator('[role^=menuitem]', { hasText: 'Read the warning' }).count()).toBe(0);
    await poll(() => itemsInPage(page, 'Read the warning').count()).toBe(1);
    await poll(() => uk.getByText('Warning to read').count()).toBe(0);
    expect(registry.view('uk').needsAcknowledgment).toBe(false);
    expect(problems).toEqual([]);
  });

  it('offers Remove for user sources only, asks first and keeps the archive (D46)', async () => {
    fs.writeFileSync(path.join(tmp, 'seed', 'sd.yaml'), sourceYaml('sd', 'sd.example'));
    registry.reload();
    expect(registry.view('sd').seed).toBe(true);
    const threads = new ThreadStore(db, 'a'.repeat(64));
    threads.save('lg', {
      url: 'https://lg.example/t/b12/7', title: 'B12 levels in plant diets', engine: 'discourse', postsExpected: 1, pages: null, extraction: 'discourse-json', quality: 'full',
      posts: [{ number: 1, page: 1, author: 'alice', authorUrl: null, signals: [], notes: [], postedAt: null, bodyMd: 'Check once a year.' }],
    });
    await open();
    await see(page.getByText('sd forum', { exact: true }));

    const sd = rowOf(page, 'sd forum');
    const lg = rowOf(page, 'lg forum');
    expect(await lg.locator('[role=menuitem]', { hasText: /^Remove$/ }).count()).toBe(1);
    expect(await rowOf(page, 'fb forum').locator('[role=menuitem]', { hasText: /^Remove$/ }).count()).toBe(1);
    expect(await sd.locator('[role=menuitem]', { hasText: /^Remove/ }).count()).toBe(0);
    // The seed source still has Delete archive.
    expect(await sd.locator('[role=menuitem]', { hasText: 'Delete archive' }).count()).toBe(1);

    const sent: { method: string; url: string }[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET') sent.push({ method: r.method(), url: new URL(r.url()).pathname });
    });
    await item(await openMenu(page, 'lg forum'), 'Remove').click();
    const dialog = page.getByRole('dialog');
    await see(dialog);
    await has(dialog, 'Remove lg forum?');
    await has(dialog, 'lg.yaml');
    await has(dialog, 'The threads lurkd archived from lg forum stay.');
    // Cancel sends nothing.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await gone(dialog);
    expect(sent).toEqual([]);

    await item(await openMenu(page, 'lg forum'), 'Remove').click();
    await dialog.getByRole('button', { name: 'Remove source' }).click();
    await poll(() => sent).toEqual([{ method: 'DELETE', url: '/api/sources/lg' }]);
    await poll(() => lg.count()).toBe(0);
    await has(page.getByRole('status'), 'Removed lg forum. Its archived threads stay.');
    expect(fs.existsSync(path.join(tmp, 'user', 'lg.yaml'))).toBe(false);
    expect(registry.ids()).toEqual(['fb', 'sd']);
    expect(threads.getByUrl('https://lg.example/t/b12/7')?.thread.title).toBe('B12 levels in plant diets');
    expect(problems).toEqual([]);
  });

  it('offers Sign up next to Log in while the source has no session (D47)', async () => {
    fs.writeFileSync(
      path.join(tmp, 'user', 'lg.yaml'),
      sourceYaml('lg', 'lg.example', { login_url: 'https://lg.example/login', signup_url: 'https://lg.example/signup' }),
    );
    registry.reload();
    await open();
    const lg = rowOf(page, 'lg forum');
    const menu = await openMenu(page, 'lg forum');
    const signUp = item(menu, 'Sign up');
    await see(signUp);
    // Right after "Log in".
    const labels = await menu.getByRole('menuitem').allInnerTexts();
    expect(labels.slice(0, 2)).toEqual(['Log in', 'Sign up']);
    // fb has no signup_url.
    expect(await rowOf(page, 'fb forum').locator('[role=menuitem]', { hasText: 'Sign up' }).count()).toBe(0);

    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') posts.push(new URL(r.url()).pathname);
    });
    await signUp.click();
    await poll(() => posts).toContain('/api/sources/lg/signup');
    expect(browser.beginHandoff).toHaveBeenCalledWith({ sourceId: 'lg', url: 'https://lg.example/signup', purpose: 'signup' });
    const banner = page.getByRole('status').filter({ hasText: 'A browser window is open for' });
    await has(banner, 'A browser window is open for lg forum. Create your account there, then press Done.');
    // While the window is open the row's window items are off.
    await openMenu(page, 'lg forum');
    await poll(() => signUp.isDisabled()).toBe(true);
    expect(await item(menu, 'Log in').isDisabled()).toBe(true);
    await page.keyboard.press('Escape');
    await banner.getByRole('button', { name: 'Done' }).click();
    await gone(banner);
    expect(posts).toContain('/api/handoff/done');

    // With a session the button goes.
    new StateStore(db).setSession('lg', { state: 'logged_in' });
    await poll(() => lg.locator('[role=menuitem]', { hasText: 'Sign up' }).count()).toBe(0);
    await see(lg.getByText('Logged in', { exact: true }));
    expect(await lg.locator('[role=menuitem]', { hasText: /^Log in$/ }).count()).toBe(1);
    expect(problems).toEqual([]);
  });

  // ---- A7: "To do" bar, filters, row menu, forbidden log, budgets ----

  const draftYaml = (id: string, host: string) =>
    YAML.stringify({
      id, name: `${id} forum`, topics: ['testing'], engine: 'discourse', status: 'untested', enabled: false,
      base_url: `https://${host}`, domains: [host],
      automation: { policy: 'unknown', rule_url: `https://${host}/faq`, rule_quote: null, checked_at: '2026-11-10' },
    });

  it('says "Nothing needs you" when the "To do" bar has no count', async () => {
    await open();
    const bar = page.getByRole('region', { name: 'To do' });
    await has(bar, 'Nothing needs you');
    expect(await bar.getByRole('button').count()).toBe(0);
    expect(problems).toEqual([]);
  });

  it('counts the work that waits in the "To do" bar and opens its panel or filter', async () => {
    const st = new StateStore(db);
    // Two drafts, a warning to read, an expired session, a sample, three add requests, a forbidden
    // forum and a source file with a problem.
    const drafts = new DraftStore(db, registry, { state: st });
    expect(drafts.submit(draftYaml('d-one', 'one.example'), 'one.example').ok).toBe(true);
    expect(drafts.submit(draftYaml('d-two', 'two.example'), 'two.example').ok).toBe(true);
    fs.writeFileSync(path.join(tmp, 'user', 'uk.yaml'), sourceYaml('uk', 'uk.example', { automation: { policy: 'unknown', rule_url: 'https://uk.example/rules', rule_quote: null, checked_at: '2026-11-08' } }));
    fs.writeFileSync(path.join(tmp, 'user', 'broken.yaml'), 'id: broken\n');
    registry.reload();
    st.setSession('lg', { state: 'expired' });
    new SampleStore(db).request('new.example', 'https://new.example/t/1');
    const adds = new AddRequestStore(db);
    for (const h of ['a.example', 'b.example', 'c.example']) adds.request(h, `https://${h}/`);
    new ForbiddenLog(db).record({ host: 'strict.example', name: 'Strict forum', engine: 'discourse', baseUrl: 'https://strict.example', loginUrl: null, signupUrl: null, searchUrl: null, ruleUrl: 'https://strict.example/tos', sentence: 'You may not automate access to the forum.' });
    await open();

    const bar = page.getByRole('region', { name: 'To do' });
    const chips = bar.getByRole('button');
    await poll(() => chips.count()).toBe(7);
    expect(await chips.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual([
      'Drafts to approve: 2',
      'Warnings to read: 1',
      'Sessions expired: 1',
      'Sites waiting for a sample: 1',
      'Add requests from your agent: 3',
      'Forums that forbid automated access: 1',
      // One file, however many lines its errors take.
      'Source files with problems: 1',
    ]);
    expect(await bar.innerText()).not.toContain('Nothing needs you');

    // A panel count opens its panel at the top and closes any other; a second press closes it.
    const panels: [string, string, string][] = [
      ['drafts', '#panel-drafts', 'd-one'],
      ['samples', '#panel-samples', 'new.example'],
      ['add', '#add', 'a.example'],
      ['forbidden', '#panel-forbidden', 'Strict forum'],
      ['errors', '#panel-errors', 'broken.yaml'],
    ];
    for (const [key, sel, text] of panels) {
      const chip = bar.locator(`[data-todo="${key}"]`);
      await chip.click();
      await see(page.locator(sel));
      await has(page.locator(sel), text);
      expect(await chip.getAttribute('aria-expanded')).toBe('true');
      expect(await page.locator('#panels > .panel:not([hidden])').count()).toBe(1);
      expect((await page.locator(sel).boundingBox())!.y).toBeLessThan((await page.locator('#sources').boundingBox())!.y);
    }
    await bar.locator('[data-todo="errors"]').click();
    await poll(() => page.locator('#panels > .panel:not([hidden])').count()).toBe(0);

    // A source count applies its filter, shows it as a chip of the state group and keeps it in the hash.
    await bar.locator('[data-todo="warnings"]').click();
    await poll(() => page.locator('tr.source').count()).toBe(1);
    await see(rowOf(page, 'uk forum'));
    expect(await bar.locator('[data-todo="warnings"]').getAttribute('aria-pressed')).toBe('true');
    expect(await page.getByRole('group', { name: 'State' }).getByRole('button', { name: 'Warning to read' }).getAttribute('aria-pressed')).toBe('true');
    expect(new URL(page.url()).hash).toBe('#state=warning');
    await bar.locator('[data-todo="expired"]').click();
    await poll(() => page.locator('tr.source').count()).toBe(1);
    await see(rowOf(page, 'lg forum').getByText('Session expired', { exact: true }));
    expect(new URL(page.url()).hash).toBe('#state=expired');
    // Pressed again, it goes back to All.
    await bar.locator('[data-todo="expired"]').click();
    await poll(() => page.locator('tr.source').count()).toBe(3);
    expect(new URL(page.url()).hash).toBe('');

    // The counts follow the state: approving both drafts takes the chip away.
    for (const d of drafts.list('pending')) drafts.reject(d.id);
    await poll(() => bar.locator('[data-todo="drafts"]').count()).toBe(0);
    expect(problems).toEqual([]);
  });

  it('filters the table by text, topic, state, policy and engine, sorts it and keeps the filters in the hash', async () => {
    fs.writeFileSync(
      path.join(tmp, 'user', 'xf.yaml'),
      sourceYaml('xf', 'xf.example', {
        engine: 'xenforo',
        topics: ['cooking', 'bread'],
        search_url: 'https://xf.example/search/?q={query}',
        automation: { policy: 'unknown', rule_url: 'https://xf.example/rules', rule_quote: null, checked_at: '2026-11-08' },
      }),
    );
    registry.reload();
    new StateStore(db).setSession('lg', { state: 'logged_in' });
    await open();
    const names = () => page.locator('tr.source .source-name').allInnerTexts();
    await poll(names).toEqual(['fb forum', 'lg forum', 'xf forum']);
    await has(page.locator('#source-count'), '3');

    // Text.
    const search = page.getByRole('searchbox', { name: /search/i });
    await search.fill('xf');
    await poll(names).toEqual(['xf forum']);
    await has(page.locator('#source-count'), '1 of 3');
    expect(new URL(page.url()).hash).toBe('#q=xf');
    await search.fill('');
    await poll(names).toEqual(['fb forum', 'lg forum', 'xf forum']);

    // Topic: any topic of the source, chosen from the topics the sources have.
    const topic = page.getByLabel('Topic', { exact: true });
    expect(await topic.locator('option').allInnerTexts()).toEqual(['All topics', 'bread', 'cooking', 'testing']);
    await topic.selectOption('bread');
    await poll(names).toEqual(['xf forum']);
    expect(new URL(page.url()).hash).toBe('#topic=bread');
    await topic.selectOption('');

    // State chips.
    const group = page.getByRole('group', { name: 'State' });
    expect(await group.getByRole('button').allInnerTexts()).toEqual(['All', 'On', 'Off', 'Needs attention', 'Logged in']);
    const chip = (n: string) => group.getByRole('button', { name: n, exact: true });
    await chip('On').click();
    await poll(names).toEqual(['lg forum', 'xf forum']);
    expect(await chip('On').getAttribute('aria-pressed')).toBe('true');
    expect(await chip('All').getAttribute('aria-pressed')).toBe('false');
    await chip('Off').click();
    await poll(names).toEqual(['fb forum']);
    await chip('Needs attention').click();
    // xf is on and its rules are silent: refused until its warning is accepted.
    await poll(names).toEqual(['xf forum']);
    await chip('Logged in').click();
    await poll(names).toEqual(['lg forum']);
    await chip('All').click();
    await poll(names).toEqual(['fb forum', 'lg forum', 'xf forum']);

    // Policy and engine.
    const policy = page.getByLabel('Rules on automation', { exact: true });
    await policy.selectOption('forbidden');
    await poll(names).toEqual(['fb forum']);
    await policy.selectOption('unknown');
    await poll(names).toEqual(['xf forum']);
    await policy.selectOption('allowed');
    await poll(names).toEqual(['lg forum']);
    await policy.selectOption('');
    const engine = page.getByLabel('Engine', { exact: true });
    expect(await engine.locator('option').allInnerTexts()).toEqual(['All engines', 'Discourse', 'XenForo']);
    await engine.selectOption('xenforo');
    await poll(names).toEqual(['xf forum']);

    // Filters that match nothing say so and offer to clear them.
    await chip('Off').click();
    await poll(names).toEqual([]);
    await see(page.getByText('No source matches these filters.'));
    expect(new URL(page.url()).hash).toBe('#state=off&engine=xenforo');
    // A reload keeps them.
    await page.reload();
    await see(page.getByText('No source matches these filters.'));
    expect(await page.getByLabel('Engine', { exact: true }).inputValue()).toBe('xenforo');
    expect(await chip('Off').getAttribute('aria-pressed')).toBe('true');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await poll(names).toEqual(['fb forum', 'lg forum', 'xf forum']);
    expect(new URL(page.url()).hash).toBe('');

    // A hash typed by hand applies too.
    await page.evaluate(() => (location.hash = '#policy=forbidden'));
    await poll(names).toEqual(['fb forum']);
    expect(await page.getByLabel('Rules on automation', { exact: true }).inputValue()).toBe('forbidden');
    await page.evaluate(() => (location.hash = ''));
    await poll(names).toEqual(['fb forum', 'lg forum', 'xf forum']);

    // Sort: by topic (first topic), then by last read (D51: the latest archived thread first).
    const sort = page.getByLabel('Sort', { exact: true });
    await sort.selectOption('topic');
    await poll(names).toEqual(['xf forum', 'fb forum', 'lg forum']);
    expect(new URL(page.url()).hash).toBe('#sort=topic');
    new ThreadStore(db, 'a'.repeat(64)).save(
      'lg',
      { url: 'https://lg.example/t/a/1', title: 'T', engine: 'discourse', postsExpected: 1, pages: null, extraction: 'x', quality: 'full', posts: [] },
      '2026-11-10T09:30:00.000Z',
    );
    await sort.selectOption('last_read');
    await poll(names).toEqual(['lg forum', 'fb forum', 'xf forum']);
    await rowOf(page, 'lg forum').getByRole('button', { name: 'Details of lg forum' }).click();
    await has(page.locator('#detail-lg'), 'Last read');
    await sort.selectOption('name');
    await poll(names).toEqual(['fb forum', 'lg forum', 'xf forum']);
    expect(problems).toEqual([]);
  });

  it('expands a row to show the description and the 7-day counts', async () => {
    await open();
    const lg = rowOf(page, 'lg forum');
    const expand = lg.getByRole('button', { name: 'Details of lg forum' });
    expect(await expand.getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#detail-lg').isHidden()).toBe(true);
    await expand.click();
    expect(await expand.getAttribute('aria-expanded')).toBe('true');
    expect(await expand.getAttribute('aria-controls')).toBe('detail-lg');
    await has(page.locator('#detail-lg'), 'Talk about lg');
    await has(page.locator('#detail-lg'), 'Last 7 days: 0 blocked requests, 0 blocked beacons, 0 challenges');
    // A poll keeps it open.
    await page.waitForTimeout(1800);
    expect(await page.locator('#detail-lg').isVisible()).toBe(true);
    await expand.click();
    await gone(page.locator('#detail-lg'));
    expect(problems).toEqual([]);
  });

  it('runs every row menu action: Log in, Forum rules, real names, beacons and Delete archive', async () => {
    await open();
    const sent: { method: string; url: string; body: string }[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET') sent.push({ method: r.method(), url: new URL(r.url()).pathname, body: r.postData() ?? '' });
    });
    let menu = await openMenu(page, 'lg forum');
    expect(await menu.getByRole('menuitem').allInnerTexts()).toEqual(['Log in', 'Forum rules', 'Delete archive', 'Remove']);
    expect(await menu.getByRole('menuitemcheckbox').allInnerTexts()).toEqual(['Show real names to the agent', 'Let Cloudflare beacons through']);
    const rules = item(menu, 'Forum rules');
    expect(await rules.getAttribute('href')).toBe('https://lg.example/rules');
    expect(await rules.getAttribute('rel')).toBe('noopener noreferrer');
    expect(await rules.getAttribute('target')).toBe('_blank');

    // Log in opens the window.
    await item(menu, 'Log in').click();
    await poll(() => sent.map((r) => r.url)).toContain('/api/sources/lg/login');
    expect(browser.beginHandoff).toHaveBeenCalledWith({ sourceId: 'lg', url: 'https://lg.example/login', purpose: 'login' });
    await gone(menu);
    await page.getByRole('status').filter({ hasText: 'A browser window is open for' }).getByRole('button', { name: 'Cancel' }).click();

    // The two switches of the agent's view: checkbox items, sent and then shown as checked.
    menu = await openMenu(page, 'lg forum');
    const real = menu.getByRole('menuitemcheckbox', { name: 'Show real names to the agent' });
    expect(await real.getAttribute('aria-checked')).toBe('false');
    await real.click();
    await poll(() => sent.filter((r) => r.url === '/api/sources/lg/real-names').map((r) => JSON.parse(r.body))).toEqual([{ show: true }]);
    await poll(() => registry.view('lg').showRealNames).toBe(true);
    menu = await openMenu(page, 'lg forum');
    await poll(() => menu.getByRole('menuitemcheckbox', { name: 'Show real names to the agent' }).getAttribute('aria-checked')).toBe('true');
    await menu.getByRole('menuitemcheckbox', { name: 'Let Cloudflare beacons through' }).click();
    await poll(() => sent.filter((r) => r.url === '/api/sources/lg/beacons').map((r) => JSON.parse(r.body))).toEqual([{ allow: true }]);
    await poll(() => registry.view('lg').allowBeacons).toBe(true);
    menu = await openMenu(page, 'lg forum');
    await menu.getByRole('menuitemcheckbox', { name: 'Show real names to the agent' }).click();
    await poll(() => sent.filter((r) => r.url === '/api/sources/lg/real-names').map((r) => JSON.parse(r.body))).toEqual([{ show: true }, { show: false }]);

    // Delete archive asks first.
    menu = await openMenu(page, 'lg forum');
    await item(menu, 'Delete archive').click();
    const dialog = page.getByRole('dialog');
    await has(dialog, 'Delete the archive of lg forum?');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(sent.filter((r) => r.method === 'DELETE')).toEqual([]);
    await item(await openMenu(page, 'lg forum'), 'Delete archive').click();
    await dialog.getByRole('button', { name: 'Delete threads' }).click();
    await poll(() => sent.filter((r) => r.method === 'DELETE').map((r) => r.url)).toEqual(['/api/sources/lg/archive']);
    await has(page.getByRole('status'), 'Deleted 0 threads of lg forum.');
    expect(problems).toEqual([]);
  });

  it('works the row menu from the keyboard', async () => {
    await open();
    const trigger = page.getByRole('button', { name: 'Actions for lg forum', exact: true });
    expect(await trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(await trigger.getAttribute('aria-expanded')).toBe('false');
    const menu = page.getByRole('menu', { name: 'Actions for lg forum' });
    const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText ?? '');

    // Enter opens it on the first item; the arrows, Home and End move and wrap.
    await trigger.focus();
    await page.keyboard.press('Enter');
    await see(menu);
    expect(await trigger.getAttribute('aria-expanded')).toBe('true');
    expect(await trigger.getAttribute('aria-controls')).toBe(await menu.getAttribute('id'));
    expect(await focused()).toBe('Log in');
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe('Forum rules');
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe('Show real names to the agent');
    await page.keyboard.press('End');
    expect(await focused()).toBe('Remove');
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe('Log in');
    await page.keyboard.press('ArrowUp');
    expect(await focused()).toBe('Remove');
    await page.keyboard.press('Home');
    expect(await focused()).toBe('Log in');

    // Escape closes it and gives the focus back to the menu button.
    await page.keyboard.press('Escape');
    await gone(menu);
    expect(await trigger.getAttribute('aria-expanded')).toBe('false');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Actions for lg forum');

    // ArrowUp on the button opens it on the last item; Tab leaves and closes it.
    await page.keyboard.press('ArrowUp');
    await see(menu);
    expect(await focused()).toBe('Remove');
    await page.keyboard.press('Tab');
    await gone(menu);

    // Enter on an item runs it; a poll that redraws the row keeps the focus on its menu button.
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') posts.push(`${new URL(r.url()).pathname} ${r.postData() ?? ''}`);
    });
    await trigger.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe('Let Cloudflare beacons through');
    await page.keyboard.press('Enter');
    await poll(() => posts).toEqual(['/api/sources/lg/beacons {"allow":true}']);
    await poll(() => registry.view('lg').allowBeacons).toBe(true);
    await page.waitForTimeout(1800);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Actions for lg forum');

    // A click outside closes an open menu; only one menu is open at a time.
    await trigger.click();
    await see(menu);
    await page.getByRole('button', { name: 'Actions for fb forum', exact: true }).click();
    await gone(menu);
    await see(page.getByRole('menu', { name: 'Actions for fb forum' }));
    await page.locator('#h-directory').click();
    await poll(() => page.locator('[role=menu]:not([hidden])').count()).toBe(0);
    expect(problems).toEqual([]);
  });

  it('lists the forums that forbid automated access with Add anyway and Dismiss (D49)', async () => {
    const log = new ForbiddenLog(db);
    const sentence = 'You may not automate access to the forum, or monitor the forum, such as with a web crawler.';
    log.record({ host: 'plants.example', name: 'Plant Growers', engine: 'discourse', baseUrl: 'https://plants.example', loginUrl: 'https://plants.example/login', signupUrl: null, searchUrl: null, ruleUrl: 'https://plants.example/tos', sentence });
    log.record({ host: 'models.example', name: 'Model Railways', engine: null, baseUrl: 'https://models.example', loginUrl: null, signupUrl: null, searchUrl: null, ruleUrl: 'https://models.example/rules', sentence: 'No bots or scrapers.' });
    await open();
    const sent: { method: string; url: string; body: string }[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET') sent.push({ method: r.method(), url: new URL(r.url()).pathname, body: r.postData() ?? '' });
    });
    const chip = page.locator('[data-todo="forbidden"]');
    await has(chip, 'Forums that forbid automated access');
    await has(chip, '2');
    await chip.click();
    const panel = page.locator('#panel-forbidden');
    await see(panel);
    await has(panel, 'Add anyway saves a draft that stays switched off: lurkd reads the forum only after you approve the draft, switch it on and press I accept.');
    const plants = panel.locator('li', { hasText: 'Plant Growers' });
    const models = panel.locator('li', { hasText: 'Model Railways' });
    expect(await plants.locator('blockquote').textContent()).toBe(sentence);
    const rules = plants.getByRole('link', { name: 'Read the rules page' });
    expect(await rules.getAttribute('href')).toBe('https://plants.example/tos');
    expect(await rules.getAttribute('rel')).toBe('noopener noreferrer');
    // An engine lurkd cannot read: no Add anyway, the same line as under Add a forum.
    await has(models, UNKNOWN_ENGINE_TEXT);
    expect(await models.getByRole('button', { name: /Add .* anyway/ }).count()).toBe(0);

    // No topic: the page asks for one and sends nothing.
    const topics = plants.getByLabel('Topics');
    const add = plants.getByRole('button', { name: 'Add Plant Growers anyway' });
    await add.click();
    await has(plants.getByRole('alert'), 'Give at least one topic, for example gardening.');
    expect(await topics.getAttribute('aria-invalid')).toBe('true');
    expect(sent).toEqual([]);
    // A topic the schema refuses: the server's error lands next to the field.
    await topics.fill('Indoor Plants');
    await add.click();
    await has(plants.getByRole('alert'), 'Use lowercase letters, digits and hyphens, for example indoor-plants.');
    expect(sent.map((r) => [r.url, JSON.parse(r.body)])).toEqual([['/api/forbidden/plants.example/draft', { topics: ['Indoor Plants'], name: 'Plant Growers' }]]);
    // M1: the logged name starts the name field; an empty one is refused on the page.
    const name = plants.getByLabel('Name', { exact: true });
    expect(await name.inputValue()).toBe('Plant Growers');
    await name.fill('  ');
    await topics.fill('gardening');
    await add.click();
    await has(plants.getByRole('alert').first(), 'Give the forum a name.');
    expect(await name.getAttribute('aria-invalid')).toBe('true');
    expect(sent).toHaveLength(1);
    // What was typed survives the polls.
    await name.fill('Plant Growers Club');
    await topics.fill('gardening, indoor-plants');
    await page.waitForTimeout(1800);
    expect(await topics.inputValue()).toBe('gardening, indoor-plants');
    expect(await name.inputValue()).toBe('Plant Growers Club');
    await add.click();
    await has(page.getByRole('status'), 'Draft saved for Plant Growers Club.');
    expect(JSON.parse(sent.at(-1)!.body)).toEqual({ topics: ['gardening', 'indoor-plants'], name: 'Plant Growers Club' });
    await poll(() => plants.count()).toBe(0);
    // The draft has policy forbidden and the sentence, and waits under Drafts to approve.
    await see(page.locator('[data-todo="drafts"]'));
    const draft = new DraftStore(db, registry).list('pending')[0]!;
    expect(YAML.parse(draft.yaml)).toMatchObject({ name: 'Plant Growers Club', enabled: false, status: 'untested', automation: { policy: 'forbidden', rule_quote: sentence, rule_url: 'https://plants.example/tos' } });

    // Dismiss takes the other entry away.
    await models.getByRole('button', { name: 'Dismiss Model Railways' }).click();
    await poll(() => sent.filter((r) => r.method === 'DELETE').map((r) => r.url)).toEqual(['/api/forbidden/models.example']);
    await poll(() => models.count()).toBe(0);
    expect(log.list()).toEqual([]);
    await has(panel, 'No forum is listed.');
    await poll(() => page.locator('[data-todo="forbidden"]').count()).toBe(0);
    // Chromium logs the 400 of the refused topic; the page showed it next to the field.
    expect(problems.filter((p) => !/status of 400/.test(p))).toEqual([]);
  });

  it('fits header, "To do" bar, filters and 12 rows in a 1440x900 and a 1280x900 window, and 33 sources under 2,000 px', async () => {
    // The 31 seed sources that ship with lurkd, next to lg and fb: 33 rows.
    fs.cpSync(path.join(PACKAGE_ROOT, 'sources'), path.join(tmp, 'seed'), { recursive: true });
    registry.reload();
    expect(registry.errors()).toEqual([]);
    expect(registry.views()).toHaveLength(33);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open();
    await poll(() => page.locator('tr.source').count()).toBe(33);
    const measure = () =>
      page.evaluate(() => {
        const bottom = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().bottom;
        const all = [...document.querySelectorAll('tr.source')];
        const rows = all.filter((r) => r.getBoundingClientRect().bottom <= innerHeight).length;
        const heights = all.map((r) => Math.round(r.getBoundingClientRect().height));
        return {
          header: bottom('header.top'),
          todo: bottom('#todo'),
          filters: bottom('.toolbar'),
          thead: document.querySelector('.sources-table thead')!.getBoundingClientRect().height,
          firstRow: all[0]!.getBoundingClientRect().top,
          rows,
          tallest: Math.max(...heights),
          // The room the first 12 rows need, at the height they have.
          twelve: heights.slice(0, 12).reduce((a, b) => a + b, 0),
          page: document.documentElement.scrollHeight,
          width: document.querySelector('main')!.getBoundingClientRect().width,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          viewport: innerHeight,
        };
      });
    /** The header, the "To do" bar and the filters, in this order, leave room for 12 rows under them. */
    const roomForTwelve = (m: Awaited<ReturnType<typeof measure>>) => {
      expect(m.header).toBeGreaterThan(0);
      expect(m.todo).toBeGreaterThan(m.header);
      expect(m.filters).toBeGreaterThan(m.todo);
      expect(m.firstRow).toBeGreaterThanOrEqual(m.filters + m.thead - 1);
      expect(m.filters + m.thead + m.twelve).toBeLessThanOrEqual(m.viewport);
      expect(m.rows).toBeGreaterThanOrEqual(12);
    };
    const m = await measure();
    roomForTwelve(m);
    expect(m.tallest).toBeLessThanOrEqual(44);
    expect(m.page).toBeLessThan(2000);
    // The page uses the width of the screen.
    expect(m.width).toBeGreaterThan(1400);
    expect(m.overflow).toBeLessThanOrEqual(0);

    // At 1280x900 too: one line per row, 12 rows in view, the page under 2,000 px.
    await page.setViewportSize({ width: 1280, height: 900 });
    const m1280 = await measure();
    roomForTwelve(m1280);
    expect(m1280.tallest).toBeLessThanOrEqual(44);
    expect(m1280.page).toBeLessThan(2000);
    expect(m1280.overflow).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    // The header of the table stays on screen while the rows scroll.
    await page.mouse.wheel(0, 900);
    await poll(() => page.evaluate(() => document.querySelector('.sources-table thead th')!.getBoundingClientRect().top)).toBe(0);

    // At 390 px: two-line rows, a wrapping "To do" bar, nothing wider than the screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.mouse.wheel(0, -5000);
    const narrow = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      lines: [...document.querySelectorAll('tr.source')].slice(0, 5).map((r) => {
        const box = (sel: string) => r.querySelector(sel)!.getBoundingClientRect();
        const middle = (sel: string) => box(sel).top + box(sel).height / 2;
        // Name and switch share the first line; the chips start below it.
        return [Math.abs(middle('.c-name') - middle('.c-switch')) < 8, box('.c-session').top >= box('.c-name').bottom - 1];
      }),
    }));
    expect(narrow.overflow).toBeLessThanOrEqual(0);
    for (const l of narrow.lines) expect(l).toEqual([true, true]);
    expect(problems).toEqual([]);
  });

  it('fits header, "To do" bar, filters and 10 rows under group headers at 1440x900 and 1280x900, and the expanded page under 2,400 px (D51)', async () => {
    fs.cpSync(path.join(PACKAGE_ROOT, 'sources'), path.join(tmp, 'seed'), { recursive: true });
    registry.reload();
    expect(registry.views()).toHaveLength(33);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await pageLink(Number(new URL(origin).port), TOKEN));
    await page.goto(`${origin}/#group=topic`);
    await poll(() => page.locator('tr.source').count()).toBe(33);
    await poll(() => page.locator('tbody.group-head').count()).toBe(6);
    const measure = () =>
      page.evaluate(() => {
        const bottom = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().bottom;
        const rows = [...document.querySelectorAll('tr.source')];
        const heads = [...document.querySelectorAll('tr.group-row')];
        return {
          header: bottom('header.top'),
          todo: bottom('#todo'),
          filters: bottom('.toolbar'),
          firstHead: heads[0]!.getBoundingClientRect().top,
          rowsInView: rows.filter((r) => r.getBoundingClientRect().bottom <= innerHeight).length,
          tallestRow: Math.max(...rows.map((r) => Math.round(r.getBoundingClientRect().height))),
          tallestHead: Math.max(...heads.map((r) => Math.round(r.getBoundingClientRect().height))),
          page: document.documentElement.scrollHeight,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const m = await measure();
      expect({ width, todoUnderHeader: m.todo > m.header, filtersUnderTodo: m.filters > m.todo, tableUnderFilters: m.firstHead >= m.filters }).toEqual({
        width,
        todoUnderHeader: true,
        filtersUnderTodo: true,
        tableUnderFilters: true,
      });
      expect({ width, rows: m.rowsInView >= 10 }).toEqual({ width, rows: true });
      expect({ width, tallestRow: m.tallestRow <= 44, tallestHead: m.tallestHead <= 44, page: m.page < 2400, overflow: m.overflow <= 0 }).toEqual({
        width,
        tallestRow: true,
        tallestHead: true,
        page: true,
        overflow: true,
      });
    }
    expect(problems).toEqual([]);
  });

  it('fits every width from 320 to 1920 px without sideways scrolling, with the row menu on screen', async () => {
    fs.cpSync(path.join(PACKAGE_ROOT, 'sources'), path.join(tmp, 'seed'), { recursive: true });
    // C2: a source with two attention chips, "Warning to read" and "Human check waiting".
    fs.writeFileSync(
      path.join(tmp, 'user', 'c2.yaml'),
      sourceYaml('c2', 'c2.example', { status: 'public_read', automation: { policy: 'unknown', rule_url: 'https://c2.example/tos', rule_quote: null, checked_at: '2026-11-08' } }),
    );
    registry.reload();
    new StateStore(db).setSession('c2', { lastBlockKind: 'challenge', lastBlockUrl: 'https://c2.example/t/1' });
    expect(registry.views()).toHaveLength(34);
    await open();
    await poll(() => page.locator('tr.source').count()).toBe(34);
    await see(rowOf(page, 'c2 forum').getByText('Human check waiting'));
    const widths = [320, 360, 390, 600, 760, 761, 800, 900, 1024, 1100, 1280, 1366, 1440, 1920];
    const seen: Record<string, unknown> = {};
    // D51: the sweep runs without groups, then with group headers and the selection bar on screen.
    for (const mode of ['none', 'topic'] as const) {
    if (mode === 'topic') {
      await page.setViewportSize({ width: 1000, height: 900 });
      await page.getByLabel('Group the rows', { exact: true }).selectOption('topic');
      await poll(() => page.locator('tbody.group-head').count()).toBe(6);
      await page.getByRole('checkbox', { name: 'Select lg forum' }).check();
      await see(page.getByRole('region', { name: 'Selected sources' }));
    }
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const m = await page.evaluate(
        () =>
          new Promise<{ overflow: number; menus: string[]; names: string[]; tallest: number }>((resolve) =>
            requestAnimationFrame(() => {
              const rows = [...document.querySelectorAll('tr.source')];
              const menus: string[] = [];
              const names: string[] = [];
              for (const r of rows) {
                const b = r.querySelector('.menu-button')!.getBoundingClientRect();
                const label = r.querySelector('.menu-button')!.getAttribute('aria-label') ?? '';
                if (b.width < 20 || b.height < 20 || b.left < 0 || b.right > innerWidth) menus.push(`${label} at ${Math.round(b.left)}-${Math.round(b.right)}`);
                // A button in the window is the element under its centre: nothing covers or clips it.
                else if (b.top >= 0 && b.bottom <= innerHeight) {
                  const under = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
                  if (!under || !under.closest('.menu-button') || under.closest('tr.source') !== r) menus.push(`${label} covered`);
                }
                // The name stays readable: shown whole, or at least 120 px of it.
                const n = r.querySelector('.source-name') as HTMLElement;
                const shown = n.getBoundingClientRect().width;
                if (shown < Math.min(n.scrollWidth, 120) - 1) names.push(`${n.textContent} ${Math.round(shown)} px`);
              }
              resolve({
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                menus,
                names,
                tallest: Math.max(...rows.map((r) => Math.round(r.getBoundingClientRect().height))),
              });
            }),
          ),
      );
      seen[`${mode} ${width}`] = m;
      expect({ mode, width, overflow: m.overflow > 0 ? m.overflow : 0, menus: m.menus, names: m.names }).toEqual({ mode, width, overflow: 0, menus: [], names: [] });
      // From 1280 px up every row keeps to one line, the row with two attention chips too (C2).
      if (width >= 1280) expect({ mode, width, tallest: m.tallest }).toEqual({ mode, width, tallest: Math.min(m.tallest, 44) });
    }
    }
    // The row menu opens inside the window at a middle width.
    await page.setViewportSize({ width: 900, height: 900 });
    const menu = await openMenu(page, 'lg forum');
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(900);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.keyboard.press('Escape');
    // Topics hidden from the table at a middle width stay in the expanded row.
    await rowOf(page, 'lg forum').getByRole('button', { name: 'Details of lg forum' }).click();
    await see(page.locator('#detail-lg').getByText('Topics: testing', { exact: true }));
    expect(problems).toEqual([]);
  });

  it('puts no stray text in the job strip, the queue panel and the dialogs', async () => {
    const job = (o: Record<string, unknown>) => ({
      jobId: 'j1', sourceId: 'lg', kind: 'fetch', state: 'running', phase: 'queued', threadIndex: 0, threadCount: 0, postsFetched: 0, requestsUsed: 0, requestCap: 0,
      message: null, queuedAt: '2026-11-10T10:00:00.000Z', startedAt: '2026-11-10T10:00:00.000Z', endedAt: null, ...o,
    });
    let jobs: unknown[] = [];
    await page.route('**/api/state', async (route) => {
      const res = await route.fetch();
      const s = (await res.json()) as Record<string, any>;
      s.jobs = jobs;
      await route.fulfill({ response: res, json: s });
    });
    await open();
    const strip = page.locator('#job-strip');
    const stripText = () => strip.innerText();

    // An analysis runs: it counts no requests, so no progress bar, and nothing waits.
    jobs = [job({ sourceId: 'plants-example', kind: 'analyse', phase: 'analyse' })];
    await poll(stripText).toBe('Running\nplants-example\nAnalysing a forum address\nShow queue');
    // A job that has just started.
    jobs = [job({})];
    await poll(stripText).toBe('Running\nlg forum\nStarting\nShow queue');
    // Only jobs that wait.
    jobs = [job({ state: 'queued' }), job({ jobId: 'j2', sourceId: 'fb', state: 'queued' })];
    await poll(stripText).toBe('Waiting\n2 jobs waiting\nShow queue');
    // A read with its request count, and one job behind it.
    jobs = [job({ phase: 'thread', threadIndex: 2, threadCount: 3, postsFetched: 140, requestsUsed: 9, requestCap: 60 }), job({ jobId: 'j2', sourceId: 'fb', state: 'queued' })];
    await poll(stripText).toBe('Running\nlg forum\nReading thread 2 of 3, 140 posts, 9 of 60 requests\n1 job waiting\nShow queue');
    expect(await strip.locator('progress').count()).toBe(1);

    // The queue panel with a job running and nothing waiting.
    jobs = [job({ sourceId: 'plants-example', kind: 'analyse', phase: 'analyse' })];
    await poll(stripText).toBe('Running\nplants-example\nAnalysing a forum address\nShow queue');
    await page.locator('#queue-state').click();
    const queuePanel = page.locator('#queue');
    await poll(() => queuePanel.innerText()).toBe('Running now\nplants-exampleAnalysing a forum address\nLast 20 jobs\n\nNo job has finished yet.');
    await page.getByRole('button', { name: 'Close Queue' }).click();
    jobs = [];
    await gone(strip);

    // Each dialog holds its title, its paragraphs and its two buttons, nothing else.
    const dialog = page.getByRole('dialog');
    const dialogText = async () => (await dialog.innerText()).trim();
    await item(await openMenu(page, 'lg forum'), 'Delete archive').click();
    await see(dialog);
    expect(await dialogText()).toBe('Delete the archive of lg forum?\n\nThis removes every thread lurkd stored for this source. The forum itself is not touched.\n\nCancel\nDelete threads');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await gone(dialog);
    await item(await openMenu(page, 'lg forum'), 'Remove').click();
    await see(dialog);
    expect(await dialogText()).toBe(
      'Remove lg forum?\n\nThis deletes lg.yaml from ~/.lurkd/sources, so your agent can no longer read lg forum. The forum and your account there are not touched.\n\n' +
        'The threads lurkd archived from lg forum stay. To delete them too, press Delete archive before you remove the source.\n\nCancel\nRemove source',
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await gone(dialog);
    await rowOf(page, 'fb forum').getByRole('switch').click();
    await see(dialog);
    expect(await dialogText()).toBe(
      'Switch on fb forum?\n\nThe rules of fb forum forbid automated access.\n\nNo bots.\n\nRead the rules\n\n' +
        'Switching this on means lurkd reads this site with your login although its rules forbid automation. You take that decision.\n\nCancel\nI accept',
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await gone(dialog);
    await page.locator('details#settings summary').first().click();
    await page.getByLabel('Keep archived threads', { exact: true }).selectOption('90');
    await see(dialog);
    expect(await dialogText()).toBe('Keep archived threads for 90 days?\n\nThreads lurkd read more than 90 days ago are deleted now, and again whenever they pass that age.\n\nCancel\nApply');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(problems).toEqual([]);
  });

  it('keeps the focus on a "To do" chip pressed from the keyboard and while its count changes', async () => {
    const drafts = new DraftStore(db, registry, { state: new StateStore(db) });
    expect(drafts.submit(draftYaml('d-one', 'one.example'), 'one.example').ok).toBe(true);
    expect(drafts.submit(draftYaml('d-two', 'two.example'), 'two.example').ok).toBe(true);
    fs.writeFileSync(path.join(tmp, 'user', 'uk.yaml'), sourceYaml('uk', 'uk.example', { automation: { policy: 'unknown', rule_url: 'https://uk.example/rules', rule_quote: null, checked_at: '2026-11-08' } }));
    registry.reload();
    await open();
    const bar = page.getByRole('region', { name: 'To do' });
    const focusedChip = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.['todo'] ?? document.activeElement?.tagName);
    const chip = (key: string) => bar.locator(`[data-todo="${key}"]`);
    await see(chip('drafts'));

    // Enter opens the drafts panel and keeps the focus on the chip; Enter again closes it.
    await chip('drafts').focus();
    await page.keyboard.press('Enter');
    await see(page.locator('#panel-drafts'));
    expect(await chip('drafts').getAttribute('aria-expanded')).toBe('true');
    expect(await focusedChip()).toBe('drafts');
    await page.keyboard.press('Enter');
    await gone(page.locator('#panel-drafts'));
    expect(await chip('drafts').getAttribute('aria-expanded')).toBe('false');
    expect(await focusedChip()).toBe('drafts');

    // Enter on Warnings applies the filter; Enter again clears it. The focus stays on the chip.
    await chip('warnings').focus();
    await page.keyboard.press('Enter');
    await poll(() => page.locator('tr.source').count()).toBe(1);
    expect(new URL(page.url()).hash).toBe('#state=warning');
    expect(await chip('warnings').getAttribute('aria-pressed')).toBe('true');
    expect(await focusedChip()).toBe('warnings');
    await page.keyboard.press('Enter');
    await poll(() => page.locator('tr.source').count()).toBe(3);
    expect(new URL(page.url()).hash).toBe('');
    expect(await chip('warnings').getAttribute('aria-pressed')).toBe('false');
    expect(await focusedChip()).toBe('warnings');

    // A poll that changes a count keeps the focus on the same chip.
    await chip('drafts').focus();
    drafts.reject(drafts.list('pending')[0]!.id);
    await poll(() => chip('drafts').getAttribute('aria-label')).toBe('Drafts to approve: 1');
    expect(await focusedChip()).toBe('drafts');
    // The chip that had the focus goes: the focus moves to the next chip.
    drafts.reject(drafts.list('pending')[0]!.id);
    await poll(() => chip('drafts').count()).toBe(0);
    expect(await focusedChip()).toBe('warnings');
    expect(problems).toEqual([]);
  });

  it('gives the focus back to the row after an action fails', async () => {
    await page.route('**/api/sources/lg/real-names', (route) => route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'The archive could not be written.' } } }));
    await page.route('**/api/sources/lg/disable', (route) => route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'The source file could not be written.' } } }));
    await open();
    const label = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
    // A row menu item, from the keyboard.
    await page.getByRole('button', { name: 'Actions for lg forum', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).innerText)).toBe('Show real names to the agent');
    await page.keyboard.press('Enter');
    await has(page.getByRole('alert'), 'The archive could not be written.');
    await poll(label).toBe('Actions for lg forum');
    await page.waitForTimeout(1800);
    expect(await label()).toBe('Actions for lg forum');
    // The switch: it goes back to on and keeps the focus.
    const sw = rowOf(page, 'lg forum').getByRole('switch');
    await sw.focus();
    await page.keyboard.press('Space');
    await has(page.getByRole('alert'), 'The source file could not be written.');
    await poll(() => sw.isChecked()).toBe(true);
    await poll(label).toBe('Switch lg forum on or off');
    expect(problems.filter((p) => !/status of 500/.test(p))).toEqual([]);
  });

  it('leaves an anchor in the address alone and goes to the row it names', async () => {
    fs.cpSync(path.join(PACKAGE_ROOT, 'sources'), path.join(tmp, 'seed'), { recursive: true });
    registry.reload();
    await page.setViewportSize({ width: 1000, height: 600 });
    await open();
    // A fresh load of the address, not a jump within the page that is open.
    await page.goto('about:blank');
    await page.goto(`${origin}/#source-lg`);
    await poll(() => page.locator('tr.source').count()).toBe(33);
    await poll(() => page.evaluate(() => document.activeElement?.id)).toBe('source-lg');
    expect(new URL(page.url()).hash).toBe('#source-lg');
    const box = (await rowOf(page, 'lg forum').boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(600);
    // A poll later the anchor is still there, and a filter still writes its own hash.
    await page.waitForTimeout(1800);
    expect(new URL(page.url()).hash).toBe('#source-lg');
    await page.getByRole('group', { name: 'State' }).getByRole('button', { name: 'Off', exact: true }).click();
    await poll(() => new URL(page.url()).hash).toBe('#state=off');
    // A hash typed by hand that names a row goes to it too.
    await page.getByRole('group', { name: 'State' }).getByRole('button', { name: 'All', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => (location.hash = '#source-fb'));
    await poll(() => page.evaluate(() => document.activeElement?.id)).toBe('source-fb');
    expect(problems).toEqual([]);
  });

  // ---- D51: groups by topic and custom groups, the tri-state switch and bulk switching ----

  const unknownYaml = (id: string, topic: string, quote: string | null) =>
    sourceYaml(id, `${id}.example`, { topics: [topic], enabled: false, automation: { policy: 'unknown', rule_url: `https://${id}.example/tos`, rule_quote: quote, checked_at: '2026-11-08' } });
  /** lg (on) and fb (forbidden, off) under "testing"; al (allowed), uk and uk2 (rules silent), all off, under "cooking". */
  const kitchen = () => {
    fs.writeFileSync(path.join(tmp, 'user', 'al.yaml'), sourceYaml('al', 'al.example', { topics: ['cooking'], enabled: false }));
    fs.writeFileSync(path.join(tmp, 'user', 'uk.yaml'), unknownYaml('uk', 'cooking', 'Be kind to each other.'));
    fs.writeFileSync(path.join(tmp, 'user', 'uk2.yaml'), unknownYaml('uk2', 'cooking', null));
    registry.reload();
    expect(registry.errors()).toEqual([]);
  };
  const head = (name: string) => page.locator('tbody.group-head', { has: page.locator('.group-name', { hasText: new RegExp(`^${name}$`) }) });
  const headSwitch = (name: string) => head(name).locator('input.group-switch');
  const switchState = (name: string) =>
    headSwitch(name).evaluate((el: HTMLInputElement) => (el.indeterminate ? 'mixed' : el.checked ? 'on' : 'off'));
  const acked = (id: string) => new StateStore(db).getOverride(id).acknowledgedAt !== null;
  const on = (id: string) => registry.view(id).enabled;

  it('groups the table by first topic with collapsible headers, on/total counts and a tri-state switch, kept in the hash (D51)', async () => {
    kitchen();
    await open();
    await page.getByLabel('Group the rows', { exact: true }).selectOption('topic');
    expect(new URL(page.url()).hash).toBe('#group=topic');
    await poll(() => page.locator('tbody.group-head .group-name').allInnerTexts()).toEqual(['cooking', 'testing']);
    await has(head('cooking'), '0 of 3 on');
    await has(head('testing'), '1 of 2 on');
    expect(await switchState('cooking')).toBe('off');
    expect(await switchState('testing')).toBe('mixed');
    // The rows sit under their header, in table order.
    const order = await page.locator('tbody.group-head .group-name, tr.source .source-name').allInnerTexts();
    expect(order).toEqual(['cooking', 'al forum', 'uk forum', 'uk2 forum', 'testing', 'fb forum', 'lg forum']);

    // A header hides and shows its rows; the other groups stay as they are.
    const collapse = head('cooking').getByRole('button', { name: 'Sources of cooking' });
    expect(await collapse.getAttribute('aria-expanded')).toBe('true');
    await collapse.click();
    await poll(() => page.locator('tr.source .source-name').allInnerTexts()).toEqual(['fb forum', 'lg forum']);
    expect(await collapse.getAttribute('aria-expanded')).toBe('false');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Sources of cooking');
    await collapse.click();
    await poll(() => page.locator('tr.source').count()).toBe(5);

    // The grouping survives a reload; the filters still look at every topic of a source.
    await page.reload();
    await poll(() => page.locator('tbody.group-head').count()).toBe(2);
    expect(await page.getByLabel('Group the rows', { exact: true }).inputValue()).toBe('topic');
    await page.getByLabel('Group the rows', { exact: true }).selectOption('none');
    expect(new URL(page.url()).hash).toBe('');
    await poll(() => page.locator('tbody.group-head').count()).toBe(0);
    expect(problems).toEqual([]);
  });

  it('switches a group on by the rules: allowed at once, one dialog for the silent ones, forbidden ones named and left off (D51)', async () => {
    kitchen();
    await page.goto(await pageLink(Number(new URL(origin).port), TOKEN));
    await page.goto(`${origin}/#group=topic`);
    await see(head('cooking'));
    const dialog = page.getByRole('dialog');

    // "cooking": al goes on at once; uk and uk2 wait in one dialog with their rule lines and links.
    await headSwitch('cooking').click();
    await see(dialog);
    await poll(() => on('al')).toBe(true);
    expect([on('uk'), on('uk2'), acked('uk'), acked('uk2')]).toEqual([false, false, false, false]);
    expect(await dialog.getByRole('heading').innerText()).toBe('Switch on 2 sources whose rules say nothing about automation?');
    const text = await dialog.innerText();
    expect(text).toContain('Switched on 1 source now: its rules allow automated access, or you accepted it before.');
    expect(text).toContain('uk forum\nBe kind to each other.\nRules of uk forum');
    expect(text).toContain('uk2 forum\nThe rules page has no line that lurkd could quote.');
    // The forbidden source of another group is not in this dialog.
    expect(text).not.toContain('fb forum');
    expect(await dialog.getByRole('link').evaluateAll((els) => els.map((a) => [a.textContent, a.getAttribute('href')]))).toEqual([
      ['Rules of uk forum', 'https://uk.example/tos'],
      ['Rules of uk2 forum', 'https://uk2.example/tos'],
    ]);
    expect(await dialog.getByRole('button').allInnerTexts()).toEqual(['Cancel', 'I accept for these 2']);
    // Cancel accepts nothing; the group now shows as partly on.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await gone(dialog);
    await poll(() => switchState('cooking')).toBe('mixed');
    await has(head('cooking'), '1 of 3 on');
    expect([acked('uk'), acked('uk2')]).toEqual([false, false]);

    // Again, from mixed: "I accept for these 2" acknowledges exactly those two.
    await headSwitch('cooking').click();
    await see(dialog);
    await dialog.getByRole('button', { name: 'I accept for these 2' }).click();
    await gone(dialog);
    await poll(() => [on('uk'), on('uk2'), acked('uk'), acked('uk2')]).toEqual([true, true, true, true]);
    await poll(() => switchState('cooking')).toBe('on');
    await has(head('cooking'), '3 of 3 on');
    expect([on('fb'), acked('fb')]).toEqual([false, false]);

    // "testing": lg is on already, fb is forbidden: named, no accept button, still off.
    await headSwitch('testing').click();
    await see(dialog);
    expect(await dialog.getByRole('heading').innerText()).toBe('fb forum stays off');
    expect(await dialog.innerText()).toContain('This source stays off: its rules forbid automated access, so lurkd never switches it on together with others.');
    expect(await dialog.getByRole('link', { name: 'Rules of fb forum' }).getAttribute('href')).toBe('https://fb.example/rules');
    expect(await dialog.getByRole('button').allInnerTexts()).toEqual(['Close']);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await gone(dialog);
    expect([on('fb'), acked('fb')]).toEqual([false, false]);
    await poll(() => switchState('testing')).toBe('mixed');

    // Off needs no dialog.
    await headSwitch('cooking').click();
    await poll(() => [on('al'), on('uk'), on('uk2')]).toEqual([false, false, false]);
    expect(await dialog.isVisible()).toBe(false);
    await poll(() => switchState('cooking')).toBe('off');
    expect(problems).toEqual([]);
  });

  it('refuses a forged acknowledgment from the page: only the list the dialog showed, once (D51)', async () => {
    kitchen();
    await open();
    const call = (p: string, body: unknown) =>
      page.evaluate(
        async ([p2, b]) => {
          const r = await fetch(p2 as string, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
          return { status: r.status, body: await r.json() };
        },
        [p, body] as const,
      );
    const plan = await call('/api/bulk/enable', { ids: ['uk', 'fb'] });
    expect(plan.status).toBe(200);
    expect(plan.body.acknowledgment.ids).toEqual(['uk']);
    // The forbidden source added to the list, another source in its place, a list of none: refused.
    for (const ids of [['uk', 'fb'], ['fb'], ['uk2'], []]) {
      const fresh = await call('/api/bulk/enable', { ids: ['uk', 'fb'] });
      expect((await call('/api/bulk/acknowledge', { token: fresh.body.acknowledgment.token, ids })).status).toBe(400);
    }
    expect([acked('uk'), acked('uk2'), acked('fb'), on('fb')]).toEqual([false, false, false, false]);
    expect((await call('/api/bulk/acknowledge', { token: plan.body.acknowledgment.token, ids: ['uk'] })).status).toBe(200);
    expect((await call('/api/bulk/acknowledge', { token: plan.body.acknowledgment.token, ids: ['uk'] })).status).toBe(400);
    expect([acked('uk'), acked('fb')]).toEqual([true, false]);
    expect(problems.filter((p) => !/status of 400/.test(p))).toEqual([]);
  });

  it('selects rows and whole groups, and switches, adds to and removes from a group in bulk (D51)', async () => {
    kitchen();
    await open();
    const bar = page.getByRole('region', { name: 'Selected sources' });
    expect(await bar.isVisible()).toBe(false);
    await page.getByRole('checkbox', { name: 'Select lg forum' }).check();
    await page.getByRole('checkbox', { name: 'Select al forum' }).check();
    await see(bar);
    await has(bar, '2 selected');
    // Switch off, then on again: al and lg are allowed, so no dialog.
    await bar.getByRole('button', { name: 'Switch off' }).click();
    await poll(() => [on('lg'), on('al')]).toEqual([false, false]);
    await bar.getByRole('button', { name: 'Switch on' }).click();
    await poll(() => [on('lg'), on('al')]).toEqual([true, true]);
    expect(await page.getByRole('dialog').isVisible()).toBe(false);

    // Add to a new group.
    await bar.getByRole('button', { name: 'Add to group' }).click();
    const dialog = page.getByRole('dialog');
    await see(dialog);
    // An empty name is refused in the dialog.
    await dialog.getByRole('button', { name: 'Add to group' }).click();
    await has(dialog, 'Give the group a name.');
    await dialog.getByLabel('Name of the new group').fill('Kitchen <b>tools</b>');
    await dialog.getByRole('button', { name: 'Add to group' }).click();
    await gone(dialog);
    await has(page.getByRole('status'), 'Added 2 sources to Kitchen <b>tools</b>.');
    // The selection box of the whole table: all, some, none.
    const all = page.getByRole('checkbox', { name: 'Select every source shown' });
    expect(await all.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);
    await all.check();
    await has(bar, '5 selected');
    await all.uncheck();
    await gone(bar);

    // A second group holding lg; by custom group, lg shows under both, with one element id.
    await page.getByRole('checkbox', { name: 'Select lg forum' }).check();
    await bar.getByRole('button', { name: 'Add to group' }).click();
    await dialog.getByLabel('Group', { exact: true }).selectOption({ label: 'A new group' });
    await dialog.getByLabel('Name of the new group').fill('Also');
    await dialog.getByRole('button', { name: 'Add to group' }).click();
    await gone(dialog);
    await bar.getByRole('button', { name: 'Clear selection' }).click();
    await gone(bar);
    await page.getByLabel('Group the rows', { exact: true }).selectOption('custom');
    await poll(() => page.locator('tbody.group-head .group-name').allInnerTexts()).toEqual(['Also', 'Kitchen <b>tools</b>', 'Not in a group']);
    expect(await page.locator('b').count()).toBe(0);
    await poll(() => rowOf(page, 'lg forum').count()).toBe(2);
    expect(await page.locator('[id="source-lg"]').count()).toBe(1);
    const domIds = await page.locator('[id]').evaluateAll((els) => els.map((e) => e.id));
    expect(domIds.length).toBe(new Set(domIds).size);

    // Select all in a group, then remove them from it.
    await head('Kitchen <b>tools</b>').getByRole('checkbox', { name: 'Select the 2 shown in Kitchen <b>tools</b>' }).check();
    await has(bar, '2 selected');
    await bar.getByRole('button', { name: 'Remove from group' }).click();
    await see(dialog);
    await dialog.getByLabel('Group', { exact: true }).selectOption({ label: 'Kitchen <b>tools</b>' });
    await dialog.getByRole('button', { name: 'Remove from group' }).click();
    await gone(dialog);
    await poll(() => page.locator('tbody.group-head .group-name').allInnerTexts()).toEqual(['Also', 'Kitchen <b>tools</b>', 'Not in a group']);
    await has(head('Kitchen <b>tools</b>'), '0 sources');
    expect(problems).toEqual([]);
  });

  // A8 L4: the header switch acts on the rows the group shows, and says so.
  it('names the group header switch and selection box after the sources shown, and the count says "shown" under a filter (A8 L4)', async () => {
    kitchen();
    await page.goto(await pageLink(Number(new URL(origin).port), TOKEN));
    await page.goto(`${origin}/#group=topic`);
    await see(head('cooking'));
    expect(await headSwitch('cooking').getAttribute('aria-label')).toBe('Switch the 3 shown in cooking on or off');
    expect(await head('cooking').locator('input.select').getAttribute('aria-label')).toBe('Select the 3 shown in cooking');
    await has(head('cooking'), '0 of 3 on');
    // A filter hides al: the header counts and switches the two rows it shows, never al.
    await page.getByRole('searchbox', { name: /search/i }).fill('uk');
    await poll(() => page.locator('tr.source .source-name').allInnerTexts()).toEqual(['uk forum', 'uk2 forum']);
    await poll(() => headSwitch('cooking').getAttribute('aria-label')).toBe('Switch the 2 shown in cooking on or off');
    expect(await head('cooking').locator('input.select').getAttribute('aria-label')).toBe('Select the 2 shown in cooking');
    await has(head('cooking'), '0 of 2 shown on');
    await headSwitch('cooking').click();
    const dialog = page.getByRole('dialog');
    await see(dialog);
    expect(await dialog.getByRole('heading').innerText()).toBe('Switch on 2 sources whose rules say nothing about automation?');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await gone(dialog);
    expect([on('al'), on('uk'), on('uk2')]).toEqual([false, false, false]);
    expect(problems).toEqual([]);
  });

  // A8 L5 and L6.
  it('keeps "Add to group" open with the typed name when the server refuses the new name, and announces the selection count (A8 L5, L6)', async () => {
    kitchen();
    await open();
    expect(await page.locator('#bulk-count').getAttribute('aria-live')).toBe('polite');
    expect(
      await page.evaluate(async () => (await fetch('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Kitchen"}' })).status),
    ).toBe(200);
    await page.reload();
    await page.getByText('fb forum', { exact: true }).waitFor();
    await page.getByRole('checkbox', { name: 'Select al forum' }).check();
    const bar = page.getByRole('region', { name: 'Selected sources' });
    await has(bar, '1 selected');
    // Two names the server refuses: one in use, one with a zero-width space only the server catches.
    for (const [typed, why] of [
      ['kitchen', 'exists already'],
      ['Pan​try', 'invisible characters'],
    ] as const) {
      await bar.getByRole('button', { name: 'Add to group' }).click();
      const dialog = page.getByRole('dialog');
      await see(dialog);
      await dialog.getByLabel('Group', { exact: true }).selectOption({ label: 'A new group' });
      const field = dialog.getByLabel('Name of the new group');
      await field.fill(typed);
      await dialog.getByRole('button', { name: 'Add to group' }).click();
      await has(dialog.locator('#dialog-group-error'), why);
      expect(await dialog.isVisible()).toBe(true);
      expect(await field.inputValue()).toBe(typed);
      expect(await field.getAttribute('aria-invalid')).toBe('true');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('dialog-group-name');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await gone(dialog);
    }
    // A name the server takes closes the dialog and adds the source.
    await bar.getByRole('button', { name: 'Add to group' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Group', { exact: true }).selectOption({ label: 'A new group' });
    await dialog.getByLabel('Name of the new group').fill('Pantry');
    await dialog.getByRole('button', { name: 'Add to group' }).click();
    await gone(dialog);
    await has(page.getByRole('status'), 'Added 1 source to Pantry.');
    expect(problems.filter((p) => !/status of 400/.test(p))).toEqual([]);
  });

  it('creates, renames and deletes custom groups from the page, the names as text (D51)', async () => {
    await open();
    const opener = page.getByRole('button', { name: 'Edit groups' });
    await opener.click();
    const panel = page.locator('#panel-groups');
    await see(panel);
    expect(await opener.getAttribute('aria-expanded')).toBe('true');
    await has(panel, 'You have no group yet.');
    const name = panel.getByLabel('New group', { exact: true });
    await name.fill('<img src=x onerror="window.__pwned=1">Smart home');
    await panel.getByRole('button', { name: 'Create' }).click();
    const field = panel.getByLabel('Name of <img src=x onerror="window.__pwned=1">Smart home', { exact: true });
    await see(field);
    // A name in use, whatever its case, is refused next to the field.
    await name.fill('<IMG src=x onerror="window.__pwned=1">smart HOME');
    await panel.getByRole('button', { name: 'Create' }).click();
    await has(panel.locator('#group-new-error'), 'exists already');
    expect(await name.getAttribute('aria-invalid')).toBe('true');
    await field.fill('Home lab');
    await panel.getByRole('button', { name: /^Rename / }).click();
    await see(panel.getByLabel('Name of Home lab', { exact: true }));
    await panel.getByRole('button', { name: 'Delete Home lab' }).click();
    const dialog = page.getByRole('dialog');
    await see(dialog);
    expect((await dialog.innerText()).trim()).toBe('Delete the group Home lab?\n\nThe 0 sources in it stay in lurkd, with their switches as they are. Only the group goes.\n\nCancel\nDelete group');
    await dialog.getByRole('button', { name: 'Delete group' }).click();
    await has(panel, 'You have no group yet.');
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    // Escape closes the panel and the focus goes back to its button.
    await name.focus();
    await page.keyboard.press('Escape');
    await gone(panel);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('open-groups');
    expect(problems.filter((p) => !/status of 400/.test(p))).toEqual([]);
  });

  it('clears the filters for a hand-typed #source-<id> they hide, and opens its group (C3)', async () => {
    kitchen();
    await page.setViewportSize({ width: 1000, height: 600 });
    await open();
    await page.getByRole('group', { name: 'State' }).getByRole('button', { name: 'On', exact: true }).click();
    await poll(() => page.locator('tr.source').count()).toBe(1);
    await page.evaluate(() => (location.hash = '#source-fb'));
    await poll(() => page.evaluate(() => document.activeElement?.id)).toBe('source-fb');
    expect(await page.getByRole('group', { name: 'State' }).getByRole('button', { name: 'All', exact: true }).getAttribute('aria-pressed')).toBe('true');
    expect(new URL(page.url()).hash).toBe('#source-fb');
    await poll(() => page.locator('tr.source').count()).toBe(5);
    // A collapsed group opens for the row it holds.
    await page.getByLabel('Group the rows', { exact: true }).selectOption('topic');
    await head('cooking').getByRole('button', { name: 'Sources of cooking' }).click();
    await poll(() => page.locator('#source-uk').count()).toBe(0);
    await page.evaluate(() => (location.hash = '#source-uk'));
    await poll(() => page.evaluate(() => document.activeElement?.id)).toBe('source-uk');
    expect(await head('cooking').getByRole('button', { name: 'Sources of cooking' }).getAttribute('aria-expanded')).toBe('true');
    expect(problems).toEqual([]);
  });

  it('gives the focus back to the "Add requests from your agent" chip when the Add panel closes (C4)', async () => {
    new AddRequestStore(db).request('a.example', 'https://a.example/');
    await open();
    const chip = page.locator('[data-todo="add"]');
    await see(chip);
    for (const close of ['button', 'escape'] as const) {
      await chip.click();
      await see(page.locator('#add'));
      if (close === 'button') await page.getByRole('button', { name: 'Close Add a forum' }).click();
      else {
        await page.locator('#add-url').focus();
        await page.keyboard.press('Escape');
      }
      await gone(page.locator('#add'));
      expect([close, await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.['todo'])]).toEqual([close, 'add']);
    }
    // Opened from the header button, it goes back there.
    await page.getByRole('button', { name: 'Add a forum', exact: true }).click();
    await page.getByRole('button', { name: 'Close Add a forum' }).click();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('open-add');
    expect(problems).toEqual([]);
  });

  it('fits a 360 px wide screen without sideways scrolling', async () => {
    const long = 'x'.repeat(240);
    await page.route('**/api/state', async (route) => {
      const res = await route.fetch();
      const s = (await res.json()) as Record<string, any>;
      s.browser.lastError = long;
      s.sources[0].topics = [long];
      s.registryErrors = [long];
      await route.fulfill({ response: res, json: s });
    });
    await page.setViewportSize({ width: 360, height: 800 });
    await open();
    await see(page.getByText(long).first());
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

// D45 on the page: a real lurkd server with its real headless Chromium analyses fixture forums on
// 127.0.0.1, which only a test may let it open (allowLoopbackForTests). Each test starts its own
// server in a fresh home, so no draft, source or queued address carries over from another test;
// the fixture forums only serve fixed pages and are shared.
describe('Add a forum on the lurkd page (D45)', () => {
  const hostile = '<img src=x onerror="window.__pwned=1"><b>Bold</b>';
  let chrome: Browser;
  let forums: FixtureServer;
  let home: string;
  let s: Awaited<ReturnType<typeof startServer>>;
  let page: Page;
  let problems: string[];
  let sent: { method: string; path: string; body: string }[];

  const fromAgent = (p: string, body: unknown) =>
    fetch(`http://127.0.0.1:${s.port}${p}`, { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const fromPage = async (p: string, body: unknown = {}) =>
    fetch(`http://127.0.0.1:${s.port}${p}`, {
      method: 'POST',
      headers: { cookie: await pageCookie(s.port, s.token), origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const pageState = async () =>
    (await (await fetch(`http://127.0.0.1:${s.port}/api/state`, { headers: { cookie: await pageCookie(s.port, s.token) } })).json()) as {
      drafts: { id: number; sourceId: string }[];
      addRequests: { host: string; url: string }[];
    };
  const add = () => page.locator('#add');
  const openPage = async () => {
    await page.goto(await pageLink(s.port, s.token));
    await poll(() => page.locator('#directory').getAttribute('aria-busy')).toBe('false');
    // A7: Add a forum opens from the header as a panel at the top of the page.
    await page.getByRole('button', { name: 'Add a forum', exact: true }).click();
    await see(page.getByRole('heading', { name: 'Add a forum' }));
  };
  const analyse = async (url: string) => {
    await add().getByLabel('Forum address').fill(url);
    await add().getByRole('button', { name: 'Analyse', exact: true }).click();
  };

  beforeAll(async () => {
    chrome = await chromium.launch({ headless: true });
    const slow: Handler = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fixture('analyse/discourse.html'));
      }, 2500);
    };
    const challenge: Handler = (_req, res) => {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fixture('detect/cloudflare-challenge.synthetic.html'));
    };
    forums = await startFixtureServer({
      '/': html(fixture('analyse/discourse.html')),
      '/xf': html(fixture('analyse/xenforo.html')),
      '/other': html(fixture('analyse/unknown.html')),
      '/challenge': challenge,
      '/slow': slow,
      '/hostile': html(
        fixture('analyse/discourse.html')
          .replace('content="Plant Growers"', `content="${hostile.replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"`)
          .replace('<a href="/guidelines">Guidelines</a>', `<a href="/guidelines">${hostile.replaceAll('<', '&lt;')} rules</a>`),
      ),
    });
  });

  afterAll(async () => {
    await forums?.close();
    await chrome?.close();
  });

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-ui-add-'));
    const seedDir = path.join(home, 'seed');
    fs.mkdirSync(seedDir);
    s = await startServer({ paths: lurkdPaths({ LURKD_HOME: home }), seedDir, allowLoopbackForTests: true });
    page = await chrome.newPage({ viewport: { width: 1000, height: 900 } });
    problems = [];
    sent = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      // A 400 answer is logged by Chromium as a failed resource; the page shows it instead.
      if ((m.type() === 'error' || m.type() === 'warning') && !/status of 400/.test(m.text())) problems.push(`console ${m.type()}: ${m.text()}`);
    });
    page.on('request', (r) => {
      if (r.method() !== 'GET') sent.push({ method: r.method(), path: new URL(r.url()).pathname, body: r.postData() ?? '' });
    });
  });

  afterEach(async () => {
    await page?.close();
    await s?.close();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it('analyses an address lurkd add queued, checks the form and saves a draft', async () => {
    const url = `${forums.origin}/`;
    expect((await fromAgent('/api/add', { url })).status).toBe(200);
    await openPage();
    // At the top: under the "To do" bar and above the sources table.
    const top = async (sel: string) => (await page.locator(sel).boundingBox())!.y;
    expect(await top('#add')).toBeGreaterThan(await top('#todo'));
    expect(await top('#add')).toBeLessThan(await top('#sources'));
    expect(await page.getByRole('button', { name: 'Add a forum', exact: true }).getAttribute('aria-expanded')).toBe('true');

    const waiting = add().locator('li', { hasText: url });
    await see(waiting);
    await see(waiting.getByRole('button', { name: 'Dismiss 127.0.0.1' }));
    await waiting.getByRole('button', { name: 'Analyse 127.0.0.1' }).click();
    // The address the page shows is the one it sends.
    expect(await add().getByLabel('Forum address').inputValue()).toBe(url);
    const result = add().locator('#add-result');
    await hasName(result, 'Plant Growers');
    expect(sent.filter((r) => r.path === '/api/add/analyse').map((r) => JSON.parse(r.body))).toEqual([{ url }]);
    await has(result, 'Discourse');
    await has(result, '127.0.0.1');
    const guidelines = result.getByRole('link', { name: 'Guidelines' });
    expect(await guidelines.getAttribute('href')).toBe(`${forums.origin}/guidelines`);
    expect(await guidelines.getAttribute('target')).toBe('_blank');
    expect(await guidelines.getAttribute('rel')).toBe('noopener noreferrer');
    await see(result.getByRole('link', { name: 'Terms of Service' }));
    expect(await result.getByLabel('Unknown', { exact: true }).isChecked()).toBe(true);

    // Allowed without a quote: the error sits by the quote field and nothing goes out.
    await result.getByLabel('Allowed', { exact: true }).check();
    await result.getByLabel('Topics').fill('Indoor Plants');
    await result.getByRole('button', { name: 'Save draft' }).click();
    const quote = result.getByLabel('Quote from the rules');
    const quoteError = 'Paste the sentence from the rules that says this. lurkd needs it for Allowed and Forbidden.';
    await see(result.getByText(quoteError));
    expect(await quote.getAttribute('aria-invalid')).toBe('true');
    const quoteErrorId = await result.getByText(quoteError).getAttribute('id');
    expect((await quote.getAttribute('aria-describedby'))?.split(' ')).toContain(quoteErrorId);
    expect(sent.filter((r) => r.path === '/api/add/draft')).toEqual([]);

    // The server's schema error comes back next to the topics field.
    await quote.fill('Automated reading of public threads is allowed.');
    await result.getByLabel('Rules page').selectOption({ label: 'Guidelines' });
    await result.getByRole('button', { name: 'Save draft' }).click();
    const topicsError = result.getByText('Use lowercase letters, digits and hyphens, for example indoor-plants.');
    await see(topicsError);
    expect(await result.getByLabel('Topics').getAttribute('aria-invalid')).toBe('true');
    expect((await result.getByLabel('Topics').getAttribute('aria-describedby'))?.split(' ')).toContain(await topicsError.getAttribute('id'));
    await poll(() => result.getByText(quoteError).count()).toBe(0);
    expect(sent.filter((r) => r.path === '/api/add/draft')).toHaveLength(1);

    // M1: the detected name starts the name field, and the person's correction is what is saved.
    const name = result.getByLabel('Name', { exact: true });
    expect(await name.inputValue()).toBe('Plant Growers');
    expect((await name.getAttribute('aria-describedby'))?.split(' ')).toContain('add-name-hint');
    await name.fill('');
    await result.getByRole('button', { name: 'Save draft' }).click();
    await see(result.getByText('Give the forum a name.'));
    expect(await name.getAttribute('aria-invalid')).toBe('true');
    expect(sent.filter((r) => r.path === '/api/add/draft')).toHaveLength(1);
    await name.fill('  Plant Growers Forum ');
    await result.getByLabel('Topics').fill('gardening, indoor-plants');
    await result.getByRole('button', { name: 'Save draft' }).click();
    await has(add(), 'Draft saved for Plant Growers Forum.');
    const toDrafts = add().getByRole('link', { name: 'Drafts to approve' });
    expect(await toDrafts.getAttribute('href')).toBe('#h-drafts');
    const drafts = sent.filter((r) => r.path === '/api/add/draft');
    expect(drafts).toHaveLength(2);
    expect(JSON.parse(drafts[1]!.body)).toEqual({
      engine: 'discourse',
      name: 'Plant Growers Forum',
      base_url: forums.origin,
      domains: ['127.0.0.1'],
      login_url: `${forums.origin}/login`,
      signup_url: `${forums.origin}/signup`,
      search_url: null,
      topics: ['gardening', 'indoor-plants'],
      automation: { policy: 'allowed', rule_url: `${forums.origin}/guidelines`, rule_quote: 'Automated reading of public threads is allowed.' },
    });
    // The link opens the drafts panel, where the draft waits.
    await toDrafts.click();
    await see(page.locator('li.draft', { hasText: '127-0-0-1' }), 8000);
    expect(await page.locator('#add').isHidden()).toBe(true);
    // The saved draft cleared the request lurkd add had queued.
    await poll(() => waiting.count()).toBe(0);
    expect((await pageState()).addRequests).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('starts the form at Forbidden with the sentence lurkd found on the rules page (D49)', async () => {
    const clause =
      'You may not automate access to the forum, or monitor the forum, such as with a web crawler, browser plug-in or add-on, or other computer program that is not a web browser.';
    const strict = await startFixtureServer({ '/': html(fixture('analyse/discourse.html')), '/tos': html(fixture('analyse/rules/discourse-tos.html')) });
    try {
      await openPage();
      await analyse(`${strict.origin}/`);
      const result = add().locator('#add-result');
      await has(result, `lurkd found this sentence on ${strict.origin}/tos, so Forbidden is chosen. Change the choice if the sentence does not apply.`);
      expect(await result.getByLabel('Forbidden', { exact: true }).isChecked()).toBe(true);
      expect(await result.getByLabel('Quote from the rules').inputValue()).toBe(clause);
      expect(await result.getByLabel('Rules page').inputValue()).toBe(`${strict.origin}/tos`);
      await result.getByLabel('Topics').fill('gardening');
      await result.getByRole('button', { name: 'Save draft' }).click();
      await has(add(), 'Draft saved for Plant Growers.');
      const body = JSON.parse(sent.filter((r) => r.path === '/api/add/draft').at(-1)!.body) as { automation: unknown };
      expect(body.automation).toEqual({ policy: 'forbidden', rule_url: `${strict.origin}/tos`, rule_quote: clause });
      expect(problems).toEqual([]);
    } finally {
      await strict.close();
    }
  });

  it('says what to do for an unknown engine, a human check and an address lurkd refuses', async () => {
    await openPage();
    const result = add().locator('#add-result');
    // Enter in the address field analyses too.
    await add().getByLabel('Forum address').fill(`${forums.origin}/other`);
    await add().getByLabel('Forum address').press('Enter');
    await has(result, UNKNOWN_ENGINE_TEXT);
    await has(result, 'Not recognised');
    await has(result, 'Il Forum dei Modellisti');
    await see(result.getByRole('link', { name: 'Regolamento', exact: true }));
    expect(await result.getByRole('button', { name: 'Save draft' }).count()).toBe(0);

    await analyse(`${forums.origin}/challenge`);
    await has(result, '127.0.0.1 shows a human check, so lurkd could not read the page. lurkd does not try to get past it.');
    expect(await result.getByRole('button', { name: 'Save draft' }).count()).toBe(0);

    await analyse('https://10.0.0.8/');
    await has(add().getByRole('alert'), 'lurkd opens public forums only, not addresses on your own network.');
    expect(problems).toEqual([]);
  });

  it('ties an address error to the address field while it shows', async () => {
    await openPage();
    const field = add().getByLabel('Forum address');
    const alert = add().locator('#add-result').getByRole('alert');
    const describedBy = async () => (await field.getAttribute('aria-describedby'))?.split(' ');
    expect(await describedBy()).toEqual(['add-url-hint']);
    expect(await field.getAttribute('aria-invalid')).toBeNull();

    // An empty address.
    await add().getByRole('button', { name: 'Analyse', exact: true }).click();
    await has(alert, 'Type the address of a forum page first, starting with https://.');
    const id = await alert.getAttribute('id');
    expect(id).toBeTruthy();
    expect(await field.getAttribute('aria-invalid')).toBe('true');
    expect(await describedBy()).toEqual(['add-url-hint', id]);

    // A good analysis takes the error away, and both attributes with it.
    await analyse(`${forums.origin}/other`);
    await has(add().locator('#add-result'), UNKNOWN_ENGINE_TEXT);
    expect(await alert.count()).toBe(0);
    expect(await field.getAttribute('aria-invalid')).toBeNull();
    expect(await describedBy()).toEqual(['add-url-hint']);

    // An analysis lurkd refuses.
    await analyse('https://10.0.0.8/');
    await has(alert, 'lurkd could not analyse this address. lurkd opens public forums only, not addresses on your own network.');
    expect(await field.getAttribute('aria-invalid')).toBe('true');
    expect(await describedBy()).toEqual(['add-url-hint', await alert.getAttribute('id')]);
    // A second error replaces the first without listing its id twice.
    await analyse('');
    await has(alert, 'Type the address of a forum page first');
    expect(await describedBy()).toEqual(['add-url-hint', await alert.getAttribute('id')]);

    await analyse(`${forums.origin}/other`);
    await has(add().locator('#add-result'), UNKNOWN_ENGINE_TEXT);
    expect(await field.getAttribute('aria-invalid')).toBeNull();
    expect(await describedBy()).toEqual(['add-url-hint']);
    expect(problems).toEqual([]);
  });

  it('keeps the busy state while the analysis waits and gives the controls back after', async () => {
    // A forum lurkd add queued: its own Analyse and Dismiss buttons wait too.
    expect((await fromAgent('/api/add', { url: `${forums.origin}/xf` })).status).toBe(200);
    await openPage();
    const waiting = add().locator('#add-requests li');
    await see(waiting);
    const own = [waiting.getByRole('button', { name: 'Analyse 127.0.0.1' }), waiting.getByRole('button', { name: 'Dismiss 127.0.0.1' })];
    for (const b of own) expect(await b.isEnabled()).toBe(true);
    const url = `${forums.origin}/slow`;
    await analyse(url);
    const status = add().locator('#add-status');
    await has(status, 'Analysing');
    expect(await add().getByRole('button', { name: 'Analyse', exact: true }).isDisabled()).toBe(true);
    expect(await add().getByLabel('Forum address').getAttribute('readonly')).not.toBeNull();
    expect(await add().getAttribute('aria-busy')).toBe('true');
    for (const b of own) expect(await b.isDisabled()).toBe(true);
    // Polls of the page state in the meantime do not end it.
    await page.waitForTimeout(1800);
    await has(status, 'Analysing');
    for (const b of own) expect(await b.isDisabled()).toBe(true);
    await hasName(add().locator('#add-result'), 'Plant Growers');
    expect(await add().getByRole('button', { name: 'Analyse', exact: true }).isEnabled()).toBe(true);
    expect(await add().getByLabel('Forum address').getAttribute('readonly')).toBeNull();
    expect(await add().getAttribute('aria-busy')).toBe('false');
    for (const b of own) expect(await b.isEnabled()).toBe(true);
    expect(sent.filter((r) => r.path.startsWith('/api/add/') && r.method === 'DELETE')).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('puts the name and link texts of the page on screen as text', async () => {
    await openPage();
    await analyse(`${forums.origin}/hostile`);
    const result = add().locator('#add-result');
    await see(result.getByRole('button', { name: 'Save draft' }));
    await see(result.getByText(hostile, { exact: false }).first());
    // The page's name starts the name field as its value, never as markup (M1).
    expect(await result.getByLabel('Name', { exact: true }).inputValue()).toBe(hostile);
    expect(await add().locator('img, b').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    for (const a of await result.locator('a').all()) {
      expect(await a.getAttribute('href')).toMatch(/^https?:\/\//);
      expect(await a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect(problems).toEqual([]);
  });

  it('dismisses a forum lurkd add queued', async () => {
    const url = `${forums.origin}/xf`;
    expect((await fromAgent('/api/add', { url })).status).toBe(200);
    await openPage();
    const waiting = add().locator('li', { hasText: url });
    await see(waiting);
    await waiting.getByRole('button', { name: 'Dismiss 127.0.0.1' }).click();
    await poll(() => waiting.count()).toBe(0);
    expect(sent.filter((r) => r.path.startsWith('/api/add'))).toEqual([{ method: 'DELETE', path: '/api/add/127.0.0.1', body: '' }]);
    expect((await pageState()).addRequests).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('shows imported threads as a read-only "Imported" row with its own menu, and labels the engine "Saved files" (C1)', async () => {
    await openPage();
    const name = 'Reddit, saved threads';
    const row = page.locator('tr.source', { hasText: name });
    await see(row);
    expect(await row.getByRole('switch').count()).toBe(0);
    expect(await row.getByRole('checkbox').count()).toBe(0);
    await see(row.getByText('Imported', { exact: true }));
    await see(row.getByText('From saved files', { exact: true }));
    expect(await page.getByLabel('Engine', { exact: true }).locator('option').allInnerTexts()).toContain('Saved files');
    expect(await page.getByLabel('Engine', { exact: true }).locator('option').allInnerTexts()).not.toContain('import');
    await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
    const menu = page.getByRole('menu', { name: `Actions for ${name}`, exact: true });
    await see(menu);
    expect(await menu.locator('[role^=menuitem]').allInnerTexts()).toEqual(['Import a saved Reddit thread', 'Reddit User Agreement', 'Show real names to the agent', 'Delete archive']);
    await page.keyboard.press('Escape');
    // Grouped by topic, the row counts for no switch: its group has none.
    await page.getByLabel('Group the rows', { exact: true }).selectOption('topic');
    const general = page.locator('tbody.group-head', { hasText: 'general' });
    await see(general);
    await has(general, '1 source');
    expect(await general.locator('input.group-switch').count()).toBe(0);
    expect(await general.getByRole('checkbox').isDisabled()).toBe(true);
    expect(problems).toEqual([]);
  });

  it('imports a saved Reddit thread from the page and shows what was kept, then a replacement and a refusal (C1, D50)', async () => {
    const before = forums.requests.length;
    await page.goto(await pageLink(s.port, s.token));
    await poll(() => page.locator('#directory').getAttribute('aria-busy')).toBe('false');
    const name = 'Reddit, saved threads';
    // From the row's menu: Add a forum opens at the import, the file field focused.
    await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Import a saved Reddit thread' }).click();
    await see(add());
    await poll(() => page.evaluate(() => document.activeElement?.id)).toBe('import-file');
    const box = page.locator('#import');
    const hint = await box.locator('#import-hint').innerText();
    for (const words of ['never contacts Reddit', 'for your own use', 'one thread at a time', 'kept on this computer', 'responsibility']) expect(hint).toContain(words);
    // Nothing chosen: said next to the field.
    await box.getByRole('button', { name: 'Import', exact: true }).click();
    await has(box.locator('#import-error'), 'Choose the saved thread file first.');
    const file = box.getByLabel('Saved thread file (.json, at most 20 MB)');
    await file.setInputFiles(path.join(PACKAGE_ROOT, 'test', 'fixtures', 'reddit', 'thread.json'));
    await box.getByRole('button', { name: 'Import', exact: true }).click();
    const result = box.locator('#import-result');
    await has(result, 'Thread imported');
    const text = await result.innerText();
    expect(text).toContain('Zigbee coordinator drops after the update');
    expect(text).toContain('8 posts: the post and 7 comments.');
    expect(text).toContain('11 more comments were not in the saved file.');
    expect(text).not.toContain('alice');
    expect(await box.locator('#import-error').isVisible()).toBe(false);
    expect(sent.filter((r) => r.path.startsWith('/api/import'))).toHaveLength(1);
    expect(sent.find((r) => r.path.startsWith('/api/import'))!.path).toBe('/api/import/reddit/upload');
    // The row's last import shows in its details.
    await page.getByRole('button', { name: `Details of ${name}` }).click();
    await has(page.locator('#detail-reddit-import'), 'Last import');

    // The same thread again replaces the earlier import and names its date.
    await file.setInputFiles(path.join(PACKAGE_ROOT, 'test', 'fixtures', 'reddit', 'thread.json'));
    await box.getByRole('button', { name: 'Import', exact: true }).click();
    await has(result, 'Thread imported again');
    await has(result, 'It replaced the import of ');
    // A listing of a subreddit is not a thread: refused with the server's reason, nothing saved.
    await file.setInputFiles(path.join(PACKAGE_ROOT, 'test', 'fixtures', 'reddit', 'subreddit-listing.json'));
    await box.getByRole('button', { name: 'Import', exact: true }).click();
    await has(box.locator('#import-error'), 'not one thread');
    expect(await file.getAttribute('aria-invalid')).toBe('true');
    expect(forums.requests.length).toBe(before);

    // C4: closing the panel opened from the row's menu gives the focus back to that menu button.
    await page.getByRole('button', { name: 'Close Add a forum' }).click();
    await poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(`Actions for ${name}`);
    expect(problems.filter((p) => !/status of 4\d\d/.test(p))).toEqual([]);
  });

  it('labels every control and fits a 360 px wide screen', async () => {
    expect((await fromAgent('/api/add', { url: `${forums.origin}/xf?${'q'.repeat(200)}` })).status).toBe(200);
    await page.setViewportSize({ width: 360, height: 800 });
    await openPage();
    await analyse(`${forums.origin}/xf`);
    const result = add().locator('#add-result');
    await has(result, 'XenForo');
    await see(result.getByRole('button', { name: 'Save draft' }));
    const unlabelled = await page.evaluate(() =>
      [...document.querySelectorAll('#add input, #add select, #add textarea, #add button')]
        .filter((el) => {
          const named = (el as HTMLInputElement).labels?.length || el.getAttribute('aria-label') || (el.tagName === 'BUTTON' && (el as HTMLElement).innerText.trim());
          return !named;
        })
        .map((el) => el.outerHTML),
    );
    expect(unlabelled).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(problems).toEqual([]);
  });

  it('points to the row of a forum lurkd already has', async () => {
    // This test's own source for 127.0.0.1, drafted and approved through the page's routes.
    const saved = (await (
      await fromPage('/api/add/draft', {
        engine: 'discourse',
        name: 'Plant Growers',
        base_url: forums.origin,
        domains: ['127.0.0.1'],
        login_url: `${forums.origin}/login`,
        topics: ['gardening'],
        automation: { policy: 'allowed', rule_url: `${forums.origin}/guidelines`, rule_quote: 'Automated reading of public threads is allowed.' },
      })
    ).json()) as { status: string; draftId: number; sourceId: string };
    expect(saved).toMatchObject({ status: 'draft_saved', sourceId: '127-0-0-1' });
    expect((await fromPage(`/api/drafts/${saved.draftId}/approve`)).status).toBe(200);
    await openPage();
    await see(page.locator('#source-127-0-0-1'));
    // A search and a state filter that hide the row; the link brings it back.
    await page.getByRole('searchbox', { name: /search/i }).fill('zzzz');
    await page.getByRole('group', { name: 'State' }).getByRole('button', { name: 'Off', exact: true }).click();
    await poll(() => page.locator('#source-127-0-0-1').count()).toBe(0);
    const before = forums.requests.length;
    await analyse(`${forums.origin}/xf`);
    const result = add().locator('#add-result');
    await has(result, 'Already in lurkd as Plant Growers');
    expect(forums.requests.length).toBe(before);
    const row = result.getByRole('link', { name: 'Plant Growers' });
    expect(await row.getAttribute('href')).toBe('#source-127-0-0-1');
    await row.click();
    await poll(() => page.evaluate(() => document.activeElement?.id)).toBe('source-127-0-0-1');
    expect(await page.getByRole('searchbox', { name: /search/i }).inputValue()).toBe('');
    expect(await page.getByRole('group', { name: 'State' }).getByRole('button', { name: 'All', exact: true }).getAttribute('aria-pressed')).toBe('true');
    expect(new URL(page.url()).hash).toBe('');
    expect(problems).toEqual([]);
  });
});
