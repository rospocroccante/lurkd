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
import { DraftStore, SampleStore } from '../../src/sources/drafts.js';
import { Registry } from '../../src/sources/registry.js';
import { PACKAGE_ROOT } from '../../src/paths.js';

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
    const deps: AppDeps = {
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
      browser: browser as unknown as BrowserManager,
      queue,
      uiDir: path.join(PACKAGE_ROOT, 'ui'),
      shutdown: () => {},
    };
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
    await page.goto(`${origin}/?t=${TOKEN}`);
    await page.getByText('fb forum', { exact: true }).waitFor();
  };

  it('walks the directory, the acknowledgment, the search and the handoff banner', async () => {
    await open();

    // The token left the address bar, the DOM and storage; the page loaded from /.
    expect(page.url()).toBe(`${origin}/`);
    expect(await page.evaluate(() => document.documentElement.outerHTML.includes('tok') && document.documentElement.outerHTML.includes('?t='))).toBe(false);
    expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).toBe('[{},{}]');

    // A forbidden row shows "Switched off".
    const fb = page.locator('li.source', { hasText: 'fb forum' });
    await see(fb.getByText('Switched off', { exact: true }));
    await see(fb.getByText('Automation forbidden', { exact: true }));
    await see(page.locator('li.source', { hasText: 'lg forum' }).getByText('Not logged in', { exact: true }));

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
    await poll(() => page.locator('li.source').count()).toBe(0);
    await see(page.getByText('No source matches', { exact: false }));
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
    await poll(() => page.locator('li.source').count()).toBe(2);

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
    const notice = page.locator('details.cookie-notice');
    await poll(() => notice.getAttribute('open')).toBe('');
    await has(notice, 'lurkd keeps your forum cookies in its own browser profile at ~/.lurkd/profiles/default.');
    await notice.locator('summary').click();
    await poll(() => notice.getAttribute('open')).toBeNull();
    await notice.locator('summary').click();
    await poll(() => notice.getAttribute('open')).toBe('');

    await see(page.getByText('No jobs yet'));
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
      s.registryErrors = [hostile];
      await route.fulfill({ response: res, json: s });
    });
    await page.goto(`${origin}/?t=${TOKEN}`);
    await see(page.locator('li.source').first());
    await see(page.locator('li.draft'));
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.locator('body script').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')));
    for (const h of hrefs) expect(h).toMatch(/^https?:\/\//);
    expect(hrefs).toContain('https://ok.example/rules');
    // The source whose login address is not http(s) gets no Log in button; the other one does.
    expect(await page.getByRole('button', { name: 'Log in' }).count()).toBe(1);
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
    await page.goto(`${origin}/?t=${TOKEN}`);
    await see(page.getByText('No sources are installed'));

    await page.unroute('**/api/state');
    await page.route('**/api/state', (route) => route.abort());
    await see(page.getByText('lurkd is not running. Run lurkd start in a terminal.'), 10000);
    // It recovers by itself when the server answers again.
    await page.unroute('**/api/state');
    await gone(page.getByText('lurkd is not running. Run lurkd start in a terminal.'), 10000);
    await see(page.locator('li.source').first());
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
    await page.goto(`${origin}/?t=${TOKEN}`);
    await see(page.locator('li.source').first());
    await poll(() => page.getByRole('button', { name: 'Open window' }).count()).toBe(1);
    await see(page.locator('li.source', { hasText: 'lg forum' }).getByRole('button', { name: 'Open window' }));
    await poll(() => page.locator('li.source', { hasText: 'fb forum' }).getByRole('button', { name: 'Open window' }).count()).toBe(0);
    // A pending login block does not offer it either.
    await page.unroute('**/api/state');
    await page.route('**/api/state', async (route) => {
      const res = await route.fetch();
      const s = (await res.json()) as Record<string, any>;
      s.sources[1].block = 'login';
      await route.fulfill({ response: res, json: s });
    });
    await poll(() => page.getByRole('button', { name: 'Open window' }).count()).toBe(0);
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
    await page.goto(`${origin}/?t=${TOKEN}`);
    const row = page.locator('li.source', { hasText: 'lg forum' });
    const beacons = row.getByLabel('Let Cloudflare beacons through', { exact: false });
    await beacons.focus();
    await page.evaluate(() => {
      (window as unknown as { __kept: Element | null }).__kept = document.activeElement;
    });
    const before = await row.locator('.counts').innerText();
    await poll(() => row.locator('.counts').innerText()).not.toBe(before);
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

    const fb = page.locator('li.source', { hasText: 'fb forum' });
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

    const uk = page.locator('li.source', { hasText: 'uk forum' });
    const button = uk.getByRole('button', { name: 'Read the warning for uk forum' });
    await see(button);
    expect(await button.innerText()).toBe('Read the warning');
    // fb (forbidden, not yet accepted) has it too; lg (policy allowed) never does.
    await see(page.locator('li.source', { hasText: 'fb forum' }).getByRole('button', { name: 'Read the warning for fb forum' }));
    await poll(() => page.getByRole('button', { name: /Read the warning/ }).count()).toBe(2);
    expect(await page.locator('li.source', { hasText: 'lg forum' }).getByRole('button', { name: /Read the warning/ }).count()).toBe(0);

    const posts: { url: string; body: string }[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET') posts.push({ url: new URL(r.url()).pathname, body: r.postData() ?? '' });
    });
    await button.click();
    const dialog = page.getByRole('dialog');
    await see(dialog);
    await has(dialog, 'The rules page has no line that lurkd could quote.');
    expect(await dialog.locator('a').getAttribute('href')).toBe('https://uk.example/rules');
    expect(await dialog.innerText()).toContain('You take that decision.');
    // Cancel sends nothing and the button stays.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await gone(dialog);
    expect(posts).toEqual([]);
    await see(button);

    await button.click();
    await page.getByRole('button', { name: 'I accept' }).click();
    await poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ url: '/api/sources/uk/enable' });
    expect(JSON.parse(posts[0]!.body)).toEqual({ acknowledge: true });
    await poll(() => button.count()).toBe(0);
    await poll(() => page.getByRole('button', { name: /Read the warning/ }).count()).toBe(1);
    expect(registry.view('uk').needsAcknowledgment).toBe(false);
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
