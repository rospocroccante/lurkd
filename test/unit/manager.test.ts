import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLogEntry } from '../../src/archive/state.js';
import { BrowserManager, DISABLED_FEATURES, createPlaywrightLaunch, ENABLED_FEATURES, PLAYWRIGHT_DISABLED_FEATURES, NO_PRELOADING, PLAYWRIGHT_ENABLED_FEATURES, disablePreloading, type LaunchFn } from '../../src/browser/manager.js';
import { PAGE_TIMEOUT_MS } from '../../src/policy/limiter.js';
import { testSource } from '../helpers/common.js';

const src = testSource({ id: 'alpha', base_url: 'https://f.example' });

class FakePage extends EventEmitter {
  closed = false;
  timeout: number | null = null;
  current = 'about:blank';
  readonly frame = { url: () => this.current };
  constructor(readonly ctx: FakeContext) {
    super();
  }
  setDefaultTimeout(ms: number) {
    this.timeout = ms;
  }
  mainFrame() {
    return this.frame;
  }
  url() {
    return this.current;
  }
  async goto(url: string) {
    this.navigate(url);
    return null;
  }
  navigate(url: string) {
    this.current = url;
    this.emit('framenavigated', this.frame);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.ctx.pagesList = this.ctx.pagesList.filter((p) => p !== this);
    this.emit('close', this);
  }
  isClosed() {
    return this.closed;
  }
}

class FakeContext extends EventEmitter {
  closed = false;
  pagesList: FakePage[] = [];
  routes = 0;
  wsRoutes = 0;
  initScripts = 0;
  routeHandler: ((route: unknown) => Promise<void>) | null = null;
  constructor(readonly headless: boolean) {
    super();
    this.pagesList.push(new FakePage(this));
  }
  async route(_p: string, h: (route: unknown) => Promise<void>) {
    this.routes++;
    this.routeHandler = h;
  }
  async routeWebSocket() {
    this.wsRoutes++;
  }
  async addInitScript() {
    this.initScripts++;
  }
  pages() {
    return [...this.pagesList];
  }
  async newPage() {
    if (this.closed) throw new Error('Target page, context or browser has been closed');
    const p = new FakePage(this);
    this.pagesList.push(p);
    // Playwright emits 'page' for pages created with newPage too, before newPage returns.
    this.emit('page', p);
    return p;
  }
  /** The site opens a page by itself (window.open, target=_blank). */
  popup() {
    const p = new FakePage(this);
    this.pagesList.push(p);
    this.emit('page', p);
    return p;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of [...this.pagesList]) await p.close();
    this.emit('close', this);
  }
  /** Chromium went away without anyone asking. */
  crash() {
    this.closed = true;
    this.emit('close', this);
  }
}

function fakeLauncher(opts: { failWhen?: (n: number, headless: boolean) => boolean } = {}) {
  const calls: { headless: boolean }[] = [];
  const contexts: FakeContext[] = [];
  const launch: LaunchFn = async (_profileDir, o) => {
    calls.push({ headless: o.headless });
    if (opts.failWhen?.(calls.length, o.headless)) throw new Error('Executable does not exist');
    const c = new FakeContext(o.headless);
    contexts.push(c);
    return c as unknown as BrowserContext;
  };
  return { launch, calls, contexts, last: () => contexts.at(-1)! };
}

const managers: BrowserManager[] = [];
function manager(f: ReturnType<typeof fakeLauncher>, extra: { handoffTimeoutMs?: number; log?: (e: FetchLogEntry) => void } = {}) {
  const m = new BrowserManager({ profileDir: '/nonexistent/profile', log: extra.log ?? (() => {}), launch: f.launch, handoffTimeoutMs: extra.handoffTimeoutMs });
  managers.push(m);
  return m;
}
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scope = { source: src, jobId: 'j1' };

describe('BrowserManager', () => {
  it('launches headless on start', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    expect(m.state).toBe('down');
    await m.start();
    expect(f.calls).toEqual([{ headless: true }]);
    expect(m.state).toBe('ready');
    expect(m.lastError).toBeNull();
  });

  it('installs the guard on every headless context', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    expect(f.last()).toMatchObject({ routes: 1, wsRoutes: 1, initScripts: 1 });
  });

  it('starts only once when start is called twice', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await Promise.all([m.start(), m.start()]);
    await m.start();
    expect(f.calls).toHaveLength(1);
  });

  it('leaves state error with lastError when the launch fails, without throwing', async () => {
    const f = fakeLauncher({ failWhen: () => true });
    const m = manager(f);
    await expect(m.start()).resolves.toBeUndefined();
    expect(m.state).toBe('error');
    expect(m.lastError).toContain('Executable does not exist');
  });

  it('throws browser_unavailable from withPage when the state is error and its one relaunch fails (P1)', async () => {
    const f = fakeLauncher({ failWhen: () => true });
    const m = manager(f);
    await m.start();
    let ran = false;
    await expect(m.withPage(scope, async () => (ran = true))).rejects.toMatchObject({ code: 'browser_unavailable' });
    expect(ran).toBe(false);
    expect(f.calls).toHaveLength(2);
    expect(m.state).toBe('error');
  });

  it('recovers from error when the relaunch succeeds', async () => {
    const f = fakeLauncher({ failWhen: (n) => n === 1 });
    const m = manager(f);
    await m.start();
    expect(m.state).toBe('error');
    await expect(m.withPage(scope, async () => 'ok')).resolves.toBe('ok');
    expect(m.state).toBe('ready');
    expect(m.lastError).toBeNull();
  });

  it('opens a fresh page with the page timeout and closes it at the end', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    let seen: FakePage | null = null;
    const r = await m.withPage(scope, async (page) => {
      seen = page as unknown as FakePage;
      expect(seen.timeout).toBe(PAGE_TIMEOUT_MS);
      expect(seen.closed).toBe(false);
      return 42;
    });
    expect(r).toBe(42);
    expect(seen!.closed).toBe(true);
  });

  it('closes its page when fn throws and passes the error on', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    let seen: FakePage | null = null;
    await expect(
      m.withPage(scope, async (page) => {
        seen = page as unknown as FakePage;
        throw new Error('extractor broke');
      }),
    ).rejects.toThrow('extractor broke');
    expect(seen!.closed).toBe(true);
  });

  it('dismisses dialogs', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    const dismissed: string[] = [];
    await m.withPage(scope, async (p) => {
      const page = p as unknown as FakePage;
      page.emit('dialog', { type: () => 'alert', dismiss: async () => void dismissed.push('alert') });
      page.emit('dialog', { type: () => 'beforeunload', dismiss: async () => void dismissed.push('beforeunload') });
    });
    expect(dismissed).toEqual(['alert', 'beforeunload']);
  });

  it('closes pages the site opens by itself', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    let popup: FakePage | null = null;
    await m.withPage(scope, async () => {
      popup = f.last().popup();
      await wait(0);
      expect(popup.closed).toBe(true);
    });
  });

  it('closes a page the site opens after its call has ended', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    await m.withPage(scope, async () => {});
    const late = f.last().popup();
    await wait(0);
    expect(late.closed).toBe(true);
    // A popup arriving while the next call opens its page is closed, the new page is kept.
    const ctx = f.last();
    const origNewPage = ctx.newPage.bind(ctx);
    let stray: FakePage | null = null;
    ctx.newPage = async () => {
      stray = ctx.popup();
      return origNewPage();
    };
    await m.withPage(scope, async (page) => {
      await wait(0);
      expect(stray!.closed).toBe(true);
      expect((page as unknown as FakePage).closed).toBe(false);
    });
    expect(f.calls).toHaveLength(1);
  });

  it('sets the guard scope for the call, arms it on request and resets it afterwards', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    const ctx = f.last();
    const decisions: string[] = [];
    // Feed a request through the guard installed on the fake context and record what it did.
    const send = async (method: string, url: string) => {
      await ctx.routeHandler!({
        request: () => ({ method: () => method, url: () => url }),
        continue: async () => void decisions.push(`allow ${method} ${url}`),
        abort: async () => void decisions.push(`block ${method} ${url}`),
      });
    };
    const withEndpoint = testSource({ id: 'alpha', base_url: 'https://f.example', read_endpoints: [{ method: 'POST', path: '/search/search', note: 'search' }] });
    let lateArm: (() => void) | null = null;
    await m.withPage({ source: withEndpoint, jobId: 'j1' }, async (_page, arm) => {
      await send('GET', 'https://f.example/t/a/1');
      await send('POST', 'https://f.example/search/search');
      arm();
      await send('POST', 'https://f.example/search/search');
      await send('POST', 'https://f.example/search/search');
      lateArm = arm;
    });
    lateArm!();
    await send('GET', 'https://f.example/t/a/1');
    await send('POST', 'https://f.example/search/search');
    expect(decisions).toEqual([
      'allow GET https://f.example/t/a/1',
      'block POST https://f.example/search/search',
      'allow POST https://f.example/search/search',
      'block POST https://f.example/search/search',
      'block GET https://f.example/t/a/1',
      'block POST https://f.example/search/search',
    ]);
  });

  it('refuses a blob: or data: navigation of its page with off_domain and logs it', async () => {
    const f = fakeLauncher();
    const log: FetchLogEntry[] = [];
    const m = manager(f, { log: (e) => log.push(e) });
    await m.start();
    let seen: FakePage | null = null;
    await expect(
      m.withPage(scope, async (page) => {
        seen = page as unknown as FakePage;
        seen.navigate('blob:https://f.example/0f1e2d');
        return 'content from a blob document';
      }),
    ).rejects.toMatchObject({ code: 'off_domain' });
    expect(seen!.closed).toBe(true);
    expect(log).toEqual([{ sourceId: 'alpha', jobId: 'j1', url: 'blob:https://f.example/0f1e2d', method: 'GET', kind: 'blocked', status: null, note: 'scheme:blob' }]);
  });

  it('fails a call whose redirect hop the guard would have blocked, even when fn succeeds', async () => {
    const f = fakeLauncher();
    const log: FetchLogEntry[] = [];
    const m = manager(f, { log: (e) => log.push(e) });
    await m.start();
    const hop = (url: string) => ({ method: () => 'GET', url: () => url, redirectedFrom: () => ({ url: () => 'https://f.example/go' }) });
    await expect(
      m.withPage(scope, async () => {
        f.last().emit('request', hop('https://f.example/session/logout'));
        return 'read';
      }),
    ).rejects.toMatchObject({ code: 'denied_path', details: { rule: 'logout', redirect: true } });
    await expect(
      m.withPage(scope, async () => {
        f.last().emit('request', hop('https://elsewhere.example/x'));
        f.last().emit('request', hop('https://f.example/session/logout'));
        throw new Error('the extractor failed too');
      }),
    ).rejects.toMatchObject({ code: 'off_domain', details: { url: 'https://elsewhere.example/x' } });
    expect(log.map((e) => e.note)).toEqual(['redirect:deny:logout', 'redirect:off_domain', 'redirect:deny:logout']);
    // The next call starts clean, and an allowed hop does not fail it.
    await expect(
      m.withPage(scope, async () => {
        f.last().emit('request', hop('https://f.example/t/a/1'));
        return 'ok';
      }),
    ).resolves.toBe('ok');
  });

  it('runs the handoff headed and goes back to headless', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    await m.beginHandoff({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' });
    expect(m.state).toBe('handoff');
    expect(m.handoff).toMatchObject({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' });
    expect(Date.parse(m.handoff!.startedAt)).not.toBeNaN();
    expect(f.contexts[0]!.closed).toBe(true);
    const headed = f.last();
    expect(headed.headless).toBe(false);
    // The person drives the headed window: no guard there.
    expect(headed).toMatchObject({ routes: 0, wsRoutes: 0, initScripts: 0 });
    expect(m.handoffPage()?.url()).toBe('https://f.example/login');
    await m.endHandoff();
    expect(f.calls.map((c) => c.headless)).toEqual([true, false, true]);
    expect(m.state).toBe('ready');
    expect(m.handoff).toBeNull();
    expect(m.handoffPage()).toBeNull();
    expect(headed.closed).toBe(true);
    expect(f.last()).toMatchObject({ headless: true, routes: 1 });
  });

  it('returns the last URL of the handoff window from endHandoff', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    await m.beginHandoff({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' });
    (m.handoffPage() as unknown as FakePage).navigate('https://f.example/');
    await expect(m.endHandoff()).resolves.toEqual({ finalUrl: 'https://f.example/' });
    await expect(m.endHandoff()).resolves.toEqual({ finalUrl: null });
  });

  it('follows every tab of the headed window and ends when the last one closes', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    await m.beginHandoff({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' });
    const headed = f.last();
    const first = m.handoffPage() as unknown as FakePage;
    // The login page opens a second tab (an identity provider, say) and the person works there.
    const second = headed.popup();
    second.navigate('https://idp.example/authorize');
    expect(m.handoffPage()).toBe(second);
    await first.close();
    await wait(10);
    expect(m.state).toBe('handoff');
    expect(m.handoffPage()).toBe(second);
    second.navigate('https://f.example/');
    await second.close();
    await wait(10);
    expect(m.state).toBe('ready');
    expect(f.calls.map((c) => c.headless)).toEqual([true, false, true]);
  });

  it('reports the URL of the tab used last as finalUrl', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    await m.beginHandoff({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' });
    const first = m.handoffPage() as unknown as FakePage;
    const second = f.last().popup();
    second.navigate('https://f.example/help');
    first.navigate('https://f.example/');
    expect(m.handoffPage()).toBe(first);
    await expect(m.endHandoff()).resolves.toEqual({ finalUrl: 'https://f.example/' });
  });

  it('refuses withPage during a handoff', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    await m.beginHandoff({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' });
    await expect(m.withPage(scope, async () => 1)).rejects.toMatchObject({ code: 'handoff_in_progress' });
    expect(f.calls).toHaveLength(2);
  });

  it('refuses withPage while a handoff is starting', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    const begin = m.beginHandoff({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' });
    await expect(m.withPage(scope, async () => 1)).rejects.toMatchObject({ code: 'handoff_in_progress' });
    await begin;
  });

  it('refuses a handoff while a page is in use', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const job = m.withPage(scope, () => held);
    await wait(0);
    await expect(m.beginHandoff({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' })).rejects.toMatchObject({ code: 'handoff_in_progress' });
    release();
    await job;
    expect(f.calls.map((c) => c.headless)).toEqual([true]);
  });

  it('refuses a second handoff', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    await m.beginHandoff({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' });
    await expect(m.beginHandoff({ sourceId: 'b', url: 'https://g.example/login', purpose: 'challenge' })).rejects.toMatchObject({ code: 'handoff_in_progress' });
  });

  it('ends the handoff after the timeout', async () => {
    const f = fakeLauncher();
    const m = manager(f, { handoffTimeoutMs: 50 });
    await m.start();
    await m.beginHandoff({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' });
    await wait(150);
    expect(m.state).toBe('ready');
    expect(m.handoff).toBeNull();
    expect(f.calls.at(-1)).toEqual({ headless: true });
  });

  it('ends the handoff when the person closes the window', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    await m.beginHandoff({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' });
    await (m.handoffPage() as unknown as FakePage).close();
    await wait(10);
    expect(m.state).toBe('ready');
    expect(f.calls.map((c) => c.headless)).toEqual([true, false, true]);
  });

  it('ends the handoff when the person quits the headed browser', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    await m.beginHandoff({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' });
    f.last().crash();
    await wait(10);
    expect(m.state).toBe('ready');
    expect(f.calls.map((c) => c.headless)).toEqual([true, false, true]);
  });

  it('goes back to headless when the headed launch fails', async () => {
    const f = fakeLauncher({ failWhen: (_n, headless) => !headless });
    const m = manager(f);
    await m.start();
    await expect(m.beginHandoff({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' })).rejects.toMatchObject({ code: 'browser_unavailable' });
    expect(m.handoff).toBeNull();
    expect(m.state).toBe('ready');
    expect(f.calls.map((c) => c.headless)).toEqual([true, false, true]);
  });

  it('relaunches after the context closes', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    f.last().crash();
    expect(m.state).toBe('error');
    expect(m.lastError).not.toBeNull();
    await expect(m.withPage(scope, async () => 'ok')).resolves.toBe('ok');
    expect(f.calls).toEqual([{ headless: true }, { headless: true }]);
    expect(m.state).toBe('ready');
  });

  it('relaunches once when the context died without a close event', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    f.last().closed = true;
    await expect(m.withPage(scope, async () => 'ok')).resolves.toBe('ok');
    expect(f.calls).toHaveLength(2);
  });

  it('runs withPage calls one at a time', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    const order: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        m.withPage({ source: testSource({ id: `src-${id}`, base_url: 'https://f.example' }), jobId: id }, async () => {
          order.push(`start ${id}`);
          await wait(5);
          order.push(`end ${id}`);
        }),
      ),
    );
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('never launches headed outside beginHandoff', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    for (let i = 0; i < 3; i++) await m.withPage(scope, async () => i);
    f.last().crash();
    await m.withPage(scope, async () => 'after crash');
    await m.close();
    await m.start();
    expect(f.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.calls.every((c) => c.headless)).toBe(true);
  });

  it('closes the browser and goes down', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    await m.close();
    expect(m.state).toBe('down');
    expect(f.last().closed).toBe(true);
  });

  it('closes a running handoff on close without relaunching', async () => {
    const f = fakeLauncher();
    const m = manager(f, { handoffTimeoutMs: 50 });
    await m.start();
    await m.beginHandoff({ sourceId: 'a', url: 'https://f.example/login', purpose: 'login' });
    await m.close();
    await wait(100);
    expect(m.state).toBe('down');
    expect(m.handoff).toBeNull();
    expect(f.calls.map((c) => c.headless)).toEqual([true, false]);
  });
});

describe('launch settings', () => {
  it('repeats Playwright 1.65.0 --enable-features list and adds NoStatePrefetchHoldback', () => {
    // Chromium keeps only the last --enable-features switch, so ours must carry Playwright's too.
    const bundle = fs.readFileSync(path.join(import.meta.dirname, '../../node_modules/playwright-core/lib/coreBundle.js'), 'utf8');
    const block = /enabledFeatures = \(\) => \[([\s\S]*?)\]\.filter\(Boolean\)/.exec(bundle)?.[1] ?? '';
    const names = [...block.matchAll(/"([A-Za-z0-9]+)"/g)].map((x) => x[1]);
    expect(names).toEqual([...PLAYWRIGHT_ENABLED_FEATURES]);
    expect(ENABLED_FEATURES).toEqual([...PLAYWRIGHT_ENABLED_FEATURES, 'NoStatePrefetchHoldback']);
  });

  it('repeats Playwright 1.65.0 --disable-features list and adds IsolateSandboxedIframes', () => {
    const bundle = fs.readFileSync(path.join(import.meta.dirname, '../../node_modules/playwright-core/lib/coreBundle.js'), 'utf8');
    const block = /disabledFeatures = \[([\s\S]*?)\]\.filter\(Boolean\)/.exec(bundle)?.[1] ?? '';
    const names = [...block.replace(/\/\/.*$/gm, '').matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([...PLAYWRIGHT_DISABLED_FEATURES]);
    expect(DISABLED_FEATURES).toEqual([...PLAYWRIGHT_DISABLED_FEATURES, 'IsolateSandboxedIframes']);
  });

  it('closes every page that existed before the guard', async () => {
    const f = fakeLauncher();
    const m = manager(f);
    await m.start();
    expect(f.last().pages()).toEqual([]);
  });

  it('gives the lurkd feature switches to the headless launch only and rewrites the preference on both', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-launch-'));
    try {
      const profile = path.join(dir, 'profiles', 'default');
      const seen: { headless: unknown; args: unknown; preloading: unknown }[] = [];
      const launch = createPlaywrightLaunch(async (profileDir, options) => {
        const prefs = JSON.parse(fs.readFileSync(path.join(profileDir, 'Default', 'Preferences'), 'utf8'));
        seen.push({ headless: options.headless, args: options.args, preloading: prefs.net.network_prediction_options });
        // The person switches "Preload pages" back on in the headed window.
        if (!options.headless) fs.writeFileSync(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify({ net: { network_prediction_options: 0 } }));
        return new FakeContext(options.headless ?? true) as unknown as BrowserContext;
      });
      await launch(profile, { headless: true });
      await launch(profile, { headless: false });
      await launch(profile, { headless: true });
      const headlessArgs = [`--enable-features=${ENABLED_FEATURES.join(',')}`, `--disable-features=${DISABLED_FEATURES.join(',')}`];
      expect(seen).toEqual([
        { headless: true, args: headlessArgs, preloading: NO_PRELOADING },
        { headless: false, args: undefined, preloading: NO_PRELOADING },
        { headless: true, args: headlessArgs, preloading: NO_PRELOADING },
      ]);
      expect(fs.statSync(profile).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('switches preloading off in the profile and keeps the other preferences', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-prefs-'));
    try {
      const file = path.join(dir, 'Default', 'Preferences');
      disablePreloading(dir);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ net: { network_prediction_options: NO_PRELOADING } });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      // The person switched preloading back on during a handoff, Chromium kept other settings.
      fs.writeFileSync(file, JSON.stringify({ net: { network_prediction_options: 0, http_server_properties: { x: 1 } }, profile: { name: 'Person 1' } }));
      disablePreloading(dir);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ net: { network_prediction_options: 2, http_server_properties: { x: 1 } }, profile: { name: 'Person 1' } });
      fs.writeFileSync(file, '{ not json');
      disablePreloading(dir);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ net: { network_prediction_options: 2 } });
      expect(fs.readdirSync(path.join(dir, 'Default'))).toEqual(['Preferences']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
