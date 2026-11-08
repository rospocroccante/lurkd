import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchLogEntry } from '../../src/archive/state.js';
import { BrowserManager, playwrightLaunch } from '../../src/browser/manager.js';
import { lurkdPaths } from '../../src/paths.js';
import type { SourceConfig } from '../../src/sources/schema.js';
import { testSource } from '../helpers/common.js';
import { html, startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

// Real Chromium, always headless: BrowserManager only launches headed inside beginHandoff,
// which no integration test calls.

let server: FixtureServer;
let home: string;
let browser: BrowserManager;
let src: SourceConfig;
const log: FetchLogEntry[] = [];
let localhostOrigin = '';

// What a sandboxed frame tries: a plain POST, an XHR POST, keepalive, sendBeacon, fetchLater, a
// worker and a WebSocket; then an image GET that reports which APIs its realm still had.
const sandboxDoc = (origin: string, tag: string) => `<!doctype html><body><p>${tag}</p><script>
  const o = '${origin}';
  const report = ['beacon=' + typeof navigator.sendBeacon, 'later=' + typeof fetchLater, 'worker=' + typeof Worker, 'nativeFetch=' + String(fetch).includes('[native code]')];
  try { fetch(o + '/posts/1/like?via=${tag}-plain', { method: 'POST', mode: 'no-cors', body: 'x' }).catch(() => {}); } catch (e) {}
  try { const x = new XMLHttpRequest(); x.open('POST', o + '/posts/1/like?via=${tag}-xhr'); x.send('x'); } catch (e) {}
  try { fetch(o + '/posts/1/like?via=${tag}-keepalive', { method: 'POST', mode: 'no-cors', keepalive: true, body: 'x' }).catch(() => {}); } catch (e) {}
  try { navigator.sendBeacon(o + '/posts/1/like?via=${tag}-beacon', 'x'); } catch (e) {}
  try { fetchLater(o + '/posts/1/like?via=${tag}-later', { method: 'POST' }); } catch (e) {}
  try { new Worker(URL.createObjectURL(new Blob(["fetch('" + o + "/posts/1/like?via=${tag}-worker', { method: 'POST', mode: 'no-cors' })"]))); } catch (e) {}
  try { const ws = new WebSocket(o.replace('http', 'ws') + '/ws-${tag}'); ws.onopen = () => ws.send('x'); } catch (e) {}
  new Image().src = o + '/report-${tag}?' + report.join('&');
</script></body>`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nonGet = () => server.requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
const blockedFor = (jobId: string) => log.filter((e) => e.jobId === jobId && e.kind === 'blocked');

beforeAll(async () => {
  server = await startFixtureServer({
    '/track': html(`<!doctype html><body>
      <form id="reply" method="post" action="/posts/1/reply"><input name="message" value="hello"></form>
      <script>
        fetch('/api/track', { method: 'POST', body: 'x' }).catch(() => {}).finally(() => {
          // sendBeacon no longer exists in a guarded page; an XHR stands in for the third POST.
          const x = new XMLHttpRequest(); x.open('POST', '/b'); x.send('beacon');
          setTimeout(() => document.getElementById('reply').submit(), 200);
        });
      </script></body>`),
    '/search': html(`<!doctype html><body>
      <form id="s" method="post" action="/search/search"><input name="q"><button>Search</button></form></body>`),
    '/search/search': (_req, res, body) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><body><p id="result">results for ${new URLSearchParams(body).get('q') ?? ''}</p>
        <form id="s" method="post" action="/search/search"><input name="q"><button>Search</button></form></body>`);
    },
    '/kinds': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><body>
        <form id="pop" method="post" action="/posts/2/reply" target="_blank"><input name="m" value="x"></form>
        <iframe srcdoc="<form id=g method=post action='/iframe-post'></form><script>document.getElementById('g').submit()<\/script>"></iframe>
        <img src="/session/logout">
        <img src="${localhostOrigin}/pixel.gif">
        <link rel="prefetch" href="/prefetched">
        <a id="p" href="/landing" ping="/pinged">next</a>
        <script>
          fetch('/put', { method: 'PUT', body: 'p' }).catch(() => {});
          fetch('/del', { method: 'DELETE' }).catch(() => {});
          fetch('/keep', { method: 'POST', keepalive: true, body: 'k' }).catch(() => {});
          const x = new XMLHttpRequest(); x.open('POST', '/xhr'); x.send('x');
          navigator.serviceWorker.register('/svc.js').catch(() => {});
          document.getElementById('pop').submit();
          setTimeout(() => document.getElementById('p').click(), 800);
        </script></body>`);
    },
    '/svc.js': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end("self.addEventListener('fetch', () => {}); fetch('/from-service-worker', { method: 'POST' });");
    },
    '/socket-page': html(`<!doctype html><body><script>
      window.ws = new WebSocket('ws://' + location.host + '/socket');
      window.ws.onopen = () => window.ws.send('hello');
    </script></body>`),
    '/apis': html(`<!doctype html><body><script>
      const f = document.createElement('iframe');
      document.body.append(f);
      const names = ['Worker', 'SharedWorker', 'WebTransport', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'WebSocketStream'];
      window.apis = names.map((n) => [n, typeof window[n], typeof f.contentWindow[n]]);
    </script></body>`),
    '/beacon-page': html(`<!doctype html><body><script>
      fetch('/cdn-cgi/challenge-platform/h/b/jsd/r/0.5:1762600000:abc/8f1e', { method: 'POST', body: 'precursor' }).catch(() => {});
    </script></body>`),
    '/plain': html('<!doctype html><body><p>plain</p></body>'),
    // Redirects decided by the forum's own server: Playwright follows them without routing.
    '/go-logout': (_req, res) => {
      res.writeHead(302, { location: '/session/logout' });
      res.end();
    },
    '/session/logout': html('<!doctype html><body><p>logged out</p></body>'),
    '/go-off': (_req, res) => {
      res.writeHead(302, { location: `${localhostOrigin}/elsewhere` });
      res.end();
    },
    '/elsewhere': html('<!doctype html><body><p>elsewhere</p></body>'),
    '/search307': html(`<!doctype html><body>
      <form id="s" method="post" action="/search/redirect"><input name="q"><button>Search</button></form></body>`),
    '/search/redirect': (_req, res) => {
      res.writeHead(307, { location: '/posts/1/reply' });
      res.end();
    },
    '/posts/1/reply': html('<!doctype html><body><p>replied</p></body>'),
    // Keepalive-class requests at page teardown, to denied paths and to another host.
    '/unload': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><body><p>unload</p><script>
        const send = (tag) => {
          try { navigator.sendBeacon('/posts/1/reply?via=beacon-' + tag, 'message=hello'); } catch (e) {}
          try { fetch('/posts/1/like?via=' + tag, { method: 'POST', keepalive: true, body: 'x' }).catch(() => {}); } catch (e) {}
          try { fetch('/session/logout?via=' + tag, { keepalive: true }).catch(() => {}); } catch (e) {}
          try { fetch(new Request('/posts/1/like?via=request-' + tag, { method: 'POST', keepalive: true, body: 'x' })).catch(() => {}); } catch (e) {}
          try { fetch('${localhostOrigin}/off-keepalive?via=' + tag, { method: 'POST', keepalive: true, body: 'x', mode: 'no-cors' }).catch(() => {}); } catch (e) {}
          try { fetchLater('/posts/1/like?via=later-' + tag, { method: 'POST' }); } catch (e) {}
        };
        addEventListener('pagehide', () => send('pagehide'));
        addEventListener('visibilitychange', () => send('hidden'));
        addEventListener('beforeunload', () => send('beforeunload'));
      </script></body>`);
    },
    '/popup-beacon': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><body><script>
        for (let i = 0; i < 5; i++) {
          const w = window.open('');
          if (!w) continue;
          try { w.navigator.sendBeacon('/posts/1/reply?via=popup-beacon', 'x'); } catch (e) {}
          try { w.fetch('/posts/1/like?via=popup-keepalive', { method: 'POST', keepalive: true, body: 'x' }).catch(() => {}); } catch (e) {}
          try { w.fetch('${localhostOrigin}/off-keepalive?via=popup', { keepalive: true, mode: 'no-cors' }).catch(() => {}); } catch (e) {}
        }
      </script></body>`);
    },
    // Sandboxed srcdoc frames without allow-same-origin: an opaque origin, its own target under
    // IsolateSandboxedIframes. The frame tries every exit and reports what its realm looks like.
    '/sandbox-static': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><body><p>host</p>
        <iframe sandbox="allow-scripts" srcdoc="${sandboxDoc(`http://${req.headers.host}`, 'static').replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe></body>`);
    },
    '/sandbox-dynamic': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><body><p>host</p><script>
        const f = document.createElement('iframe');
        f.setAttribute('sandbox', 'allow-scripts');
        f.srcdoc = ${JSON.stringify(sandboxDoc(`http://${req.headers.host}`, 'dynamic')).replaceAll('</', '<\\/')};
        document.body.append(f);
      </script></body>`);
    },
    // Preloading the browser process fetches by itself: speculation rules and <link rel=prerender>.
    '/preload': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><head>
        <script type="speculationrules">${JSON.stringify({
          prefetch: [{ source: 'list', urls: ['/session/logout?via=prefetch', `${localhostOrigin}/off-prefetch`] }],
          prerender: [{ source: 'list', urls: ['/session/logout?via=prerender', `${localhostOrigin}/off-prerender`] }],
        })}</script>
        <link rel="prerender" href="${localhostOrigin}/off-link-prerender">
        <link rel="prerender" href="/session/logout?via=link-prerender">
        </head><body><p>preload</p><script>
          const s = document.createElement('script');
          s.type = 'speculationrules';
          s.textContent = JSON.stringify({ prefetch: [{ source: 'list', urls: ['/session/logout?via=dynamic-prefetch'] }], prerender: [{ source: 'list', urls: ['${localhostOrigin}/off-dynamic-prerender'] }] });
          document.head.append(s);
        </script></body>`);
    },
  });
  // Same server under another hostname: a request there must never arrive.
  localhostOrigin = server.origin.replace('127.0.0.1', 'localhost');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-guard-'));
  src = testSource({ id: 'fixture', base_url: server.origin, read_endpoints: [{ method: 'POST', path: '/search/search', note: 'search form' }] });
  browser = new BrowserManager({ profileDir: lurkdPaths({ LURKD_HOME: home }).profileDir, log: (e) => log.push(e) });
  await browser.start();
  expect(browser.state).toBe('ready');
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('read-only guard in headless Chromium', () => {
  it('blocks the POSTs a page sends and logs them', async () => {
    await browser.withPage({ source: src, jobId: 'track' }, async (page) => {
      await page.goto(`${server.origin}/track`);
      await expect.poll(() => blockedFor('track').length, { timeout: 5000 }).toBe(3);
      await wait(300);
    });
    expect(server.requests.filter((r) => r.method === 'POST')).toEqual([]);
    expect(log.filter((e) => e.jobId === 'track' && e.kind === 'blocked')).toHaveLength(3);
    expect(blockedFor('track').map((e) => `${e.method} ${new URL(e.url).pathname}`).sort()).toEqual(['POST /api/track', 'POST /b', 'POST /posts/1/reply']);
    expect(blockedFor('track').every((e) => e.sourceId === 'fixture' && e.status === null)).toBe(true);
  });

  it('lets the armed search POST through exactly once', async () => {
    const before = server.requests.length;
    await browser.withPage({ source: src, jobId: 'search' }, async (page, arm) => {
      await page.goto(`${server.origin}/search`);
      arm();
      await page.fill('input[name=q]', 'gpu');
      await Promise.all([page.waitForURL('**/search/search'), page.evaluate(() => (document.getElementById('s') as HTMLFormElement).requestSubmit())]);
      expect(await page.textContent('#result')).toBe('results for gpu');
      // The same form again, on the results page: the guard is disarmed now.
      await page.fill('input[name=q]', 'again');
      await page.evaluate(() => (document.getElementById('s') as HTMLFormElement).requestSubmit());
      await expect.poll(() => blockedFor('search').length, { timeout: 5000 }).toBe(1);
    });
    const posts = server.requests.slice(before).filter((r) => r.method === 'POST');
    expect(posts).toEqual([{ method: 'POST', url: '/search/search', body: 'q=gpu' }]);
    expect(log.filter((e) => e.jobId === 'search' && e.kind === 'form')).toEqual([
      { sourceId: 'fixture', jobId: 'search', url: `${server.origin}/search/search`, method: 'POST', kind: 'form', status: null },
    ]);
  });

  it('does not carry an arm over to the next call', async () => {
    const before = server.requests.length;
    await browser.withPage({ source: src, jobId: 'arm1' }, async (page, arm) => {
      await page.goto(`${server.origin}/search`);
      arm();
    });
    await browser.withPage({ source: src, jobId: 'arm2' }, async (page) => {
      await page.goto(`${server.origin}/search`);
      await page.fill('input[name=q]', 'x');
      await page.evaluate(() => (document.getElementById('s') as HTMLFormElement).requestSubmit());
      await expect.poll(() => blockedFor('arm2').length, { timeout: 5000 }).toBe(1);
    });
    expect(server.requests.slice(before).filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('blocks every other request type: PUT, DELETE, keepalive, XHR, ping, popup and iframe forms, denied and off-domain GETs', async () => {
    const before = server.requests.length;
    await browser.withPage({ source: src, jobId: 'kinds' }, async (page) => {
      await page.goto(`${server.origin}/kinds`);
      await expect
        .poll(() => blockedFor('kinds').map((e) => `${e.method} ${new URL(e.url).pathname}`), { timeout: 5000 })
        .toEqual(expect.arrayContaining(['PUT /put', 'DELETE /del', 'POST /xhr', 'POST /posts/2/reply', 'POST /iframe-post', 'GET /session/logout', 'GET /pixel.gif', 'POST /pinged']));
      expect(page.context().serviceWorkers()).toEqual([]);
    });
    const seen = server.requests.slice(before);
    expect(seen.filter((r) => r.method !== 'GET' && r.method !== 'HEAD')).toEqual([]);
    const paths = seen.map((r) => r.url);
    expect(paths).not.toContain('/session/logout');
    expect(paths).not.toContain('/pixel.gif');
    expect(paths).not.toContain('/svc.js');
    expect(blockedFor('kinds').find((e) => e.url.endsWith('/session/logout'))?.note).toBe('deny:logout');
    expect(blockedFor('kinds').find((e) => e.url.endsWith('/pixel.gif'))?.note).toBe('off_domain');
    // A plain GET prefetch on the source's host is still allowed.
    expect(paths).toContain('/prefetched');
  });

  it('closes WebSockets', async () => {
    const before = server.requests.length;
    await browser.withPage({ source: src, jobId: 'ws' }, async (page) => {
      await page.goto(`${server.origin}/socket-page`);
      await expect.poll(() => page.evaluate(() => (window as unknown as { ws: WebSocket }).ws.readyState), { timeout: 2000 }).toBe(3);
    });
    expect(server.requests.slice(before).filter((r) => r.method === 'WS')).toEqual([]);
    expect(log.filter((e) => e.jobId === 'ws' && e.kind === 'blocked' && e.method === 'WS')).toEqual([
      { sourceId: 'fixture', jobId: 'ws', url: `${server.origin.replace('http:', 'ws:')}/socket`, method: 'WS', kind: 'blocked', status: null, note: 'websocket' },
    ]);
  });

  it('removes the page APIs whose traffic the guard cannot see, also in child frames', async () => {
    const apis = await browser.withPage({ source: src, jobId: 'apis' }, async (page) => {
      await page.goto(`${server.origin}/apis`);
      return page.evaluate(() => (window as unknown as { apis: [string, string, string][] }).apis);
    });
    expect(apis.filter(([, top, frame]) => top !== 'undefined' || frame !== 'undefined')).toEqual([]);
  });

  it('blocks the Cloudflare beacon by default and lets it through with allow_beacons', async () => {
    const beaconPath = '/cdn-cgi/challenge-platform/h/b/jsd/r/0.5:1762600000:abc/8f1e';
    await browser.withPage({ source: src, jobId: 'beacon-off' }, async (page) => {
      await page.goto(`${server.origin}/beacon-page`);
      await expect.poll(() => blockedFor('beacon-off').length, { timeout: 5000 }).toBe(1);
    });
    expect(blockedFor('beacon-off')[0]).toMatchObject({ method: 'POST', note: 'beacon:cloudflare-challenge-platform' });
    expect(server.requests.filter((r) => r.url === beaconPath)).toEqual([]);

    const withBeacons = testSource({ ...src, allow_beacons: true });
    await browser.withPage({ source: withBeacons, jobId: 'beacon-on' }, async (page) => {
      await page.goto(`${server.origin}/beacon-page`);
      await expect.poll(() => server.requests.filter((r) => r.url === beaconPath).length, { timeout: 5000 }).toBe(1);
    });
    expect(log.filter((e) => e.jobId === 'beacon-on').map((e) => [e.kind, e.method, new URL(e.url).pathname])).toEqual([['beacon_allowed', 'POST', beaconPath]]);
  });

  it('refuses a blob: navigation from the page', async () => {
    await expect(
      browser.withPage({ source: src, jobId: 'blob' }, async (page) => {
        await page.goto(`${server.origin}/plain`);
        await page.evaluate(() => {
          location.href = URL.createObjectURL(new Blob(['<p>made up</p>'], { type: 'text/html' }));
        });
        await page.waitForEvent('close', { timeout: 5000 }).catch(() => {});
        return 'read';
      }),
    ).rejects.toMatchObject({ code: 'off_domain' });
    expect(log.filter((e) => e.jobId === 'blob')).toMatchObject([{ kind: 'blocked', method: 'GET', note: 'scheme:blob' }]);
    // The browser is still usable afterwards.
    await expect(browser.withPage({ source: src, jobId: 'after-blob' }, async (page) => (await page.goto(`${server.origin}/plain`))?.status())).resolves.toBe(200);
  });

  it('fails the read on a same-host 302 to a denied path and logs the hop', async () => {
    const before = server.requests.length;
    await expect(
      browser.withPage({ source: src, jobId: 'redir-deny' }, async (page) => (await page.goto(`${server.origin}/go-logout`))?.status()),
    ).rejects.toMatchObject({ code: 'denied_path', details: { url: `${server.origin}/session/logout`, rule: 'logout', redirect: true } });
    // The hop has already happened: the limit this test pins down.
    expect(server.requests.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual(['GET /go-logout', 'GET /session/logout']);
    expect(log.filter((e) => e.jobId === 'redir-deny')).toEqual([
      { sourceId: 'fixture', jobId: 'redir-deny', url: `${server.origin}/session/logout`, method: 'GET', kind: 'blocked', status: null, note: 'redirect:deny:logout' },
    ]);
  });

  it('fails the read on a 302 to another host', async () => {
    await expect(
      browser.withPage({ source: src, jobId: 'redir-off' }, async (page) => (await page.goto(`${server.origin}/go-off`))?.status()),
    ).rejects.toMatchObject({ code: 'off_domain', details: { url: `${localhostOrigin}/elsewhere`, redirect: true } });
    expect(log.filter((e) => e.jobId === 'redir-off')).toMatchObject([{ kind: 'blocked', method: 'GET', url: `${localhostOrigin}/elsewhere`, note: 'redirect:off_domain' }]);
  });

  it('fails the read when the site answers the allowed search POST with a 307', async () => {
    const before = server.requests.length;
    const searchSrc = testSource({ ...src, read_endpoints: [{ method: 'POST', path: '/search/redirect', note: 'search form' }] });
    await expect(
      browser.withPage({ source: searchSrc, jobId: 'redir-307' }, async (page, arm) => {
        await page.goto(`${server.origin}/search307`);
        arm();
        await page.fill('input[name=q]', 'gpu');
        await Promise.all([page.waitForURL('**/posts/1/reply'), page.evaluate(() => (document.getElementById('s') as HTMLFormElement).requestSubmit())]);
        return page.textContent('p');
      }),
    ).rejects.toMatchObject({ code: 'denied_path', details: { url: `${server.origin}/posts/1/reply`, rule: 'reply', redirect: true } });
    expect(server.requests.slice(before).filter((r) => r.method === 'POST').map((r) => r.url)).toEqual(['/search/redirect', '/posts/1/reply']);
    expect(log.filter((e) => e.jobId === 'redir-307').map((e) => [e.kind, e.method, new URL(e.url).pathname, e.note ?? null])).toEqual([
      ['form', 'POST', '/search/redirect', null],
      ['blocked', 'POST', '/posts/1/reply', 'redirect:deny:reply'],
    ]);
  });

  const teardownPaths = (since: number) =>
    server.requests
      .slice(since)
      .map((r) => new URL(r.url, 'http://x').pathname)
      .filter((p) => ['/posts/1/reply', '/posts/1/like', '/session/logout', '/off-keepalive'].includes(p));

  it('drops beacons and keepalive fetches sent while the page unloads on a navigation', async () => {
    const before = server.requests.length;
    const probe = await browser.withPage({ source: src, jobId: 'unload-nav' }, async (page) => {
      await page.goto(`${server.origin}/unload`);
      const apis = await page.evaluate(async () => {
        const rejected = async (p: () => Promise<unknown>) => {
          try {
            await p();
            return 'sent';
          } catch (e) {
            return (e as Error).name;
          }
        };
        return {
          sendBeacon: typeof (navigator as unknown as { sendBeacon?: unknown }).sendBeacon,
          fetchLater: typeof (window as unknown as { fetchLater?: unknown }).fetchLater,
          keepaliveInit: await rejected(() => fetch('/plain', { keepalive: true })),
          keepaliveRequest: await rejected(() => fetch(new Request('/plain', { keepalive: true }))),
          plainFetch: (await fetch('/plain')).status,
        };
      });
      await page.goto(`${server.origin}/plain`);
      await wait(800);
      return apis;
    });
    await wait(300);
    expect(probe).toEqual({ sendBeacon: 'undefined', fetchLater: 'undefined', keepaliveInit: 'TypeError', keepaliveRequest: 'TypeError', plainFetch: 200 });
    expect(teardownPaths(before)).toEqual([]);
  });

  it('drops beacons and keepalive fetches sent while withPage closes its page', async () => {
    const before = server.requests.length;
    await browser.withPage({ source: src, jobId: 'unload-close' }, async (page) => {
      await page.goto(`${server.origin}/unload`);
    });
    await wait(1000);
    expect(teardownPaths(before)).toEqual([]);
  });

  it('drops a beacon or keepalive fetch sent from a fresh window.open popup', async () => {
    const before = server.requests.length;
    await browser.withPage({ source: src, jobId: 'popup-beacon' }, async (page) => {
      await page.goto(`${server.origin}/popup-beacon`);
      await wait(1000);
    });
    await wait(300);
    expect(teardownPaths(before)).toEqual([]);
  });

  it('never lets speculation rules or link rel=prerender fetch a denied path or another host', async () => {
    const before = server.requests.length;
    await browser.withPage({ source: src, jobId: 'preload' }, async (page) => {
      await page.goto(`${server.origin}/preload`);
      await wait(3000);
    });
    await wait(300);
    expect(server.requests.slice(before).map((r) => new URL(r.url, 'http://x').pathname).filter((p) => p !== '/favicon.ico')).toEqual(['/preload']);
  });

  for (const variant of ['static', 'dynamic'] as const) {
    it(`blocks every exit of a ${variant} sandboxed srcdoc frame without allow-same-origin`, async () => {
      const before = server.requests.length;
      const jobId = `sandbox-${variant}`;
      await browser.withPage({ source: src, jobId }, async (page) => {
        await page.goto(`${server.origin}/sandbox-${variant}`);
        await expect.poll(() => server.requests.slice(before).some((r) => r.url.startsWith(`/report-${variant}`)), { timeout: 5000 }).toBe(true);
        await expect.poll(() => blockedFor(jobId).some((e) => e.url.includes(`via=${variant}-plain`)), { timeout: 5000 }).toBe(true);
        await wait(500);
      });
      await wait(300);
      const seen = server.requests.slice(before);
      expect(seen.filter((r) => r.method !== 'GET')).toEqual([]);
      expect(seen.filter((r) => r.url.startsWith('/posts/'))).toEqual([]);
      expect(seen.find((r) => r.url.startsWith(`/report-${variant}`))?.url).toBe(`/report-${variant}?beacon=undefined&later=undefined&worker=undefined&nativeFetch=false`);
      expect(blockedFor(jobId).find((e) => e.url.includes(`via=${variant}-plain`))).toMatchObject({ method: 'POST', kind: 'blocked', note: 'deny:like' });
    });
  }

  it('keeps the profile folder at 0700', async () => {
    const profileDir = lurkdPaths({ LURKD_HOME: home }).profileDir;
    expect(fs.statSync(profileDir).mode & 0o777).toBe(0o700);
    // A folder someone opened up is closed again on the next launch.
    const other = path.join(home, 'other-profile');
    fs.mkdirSync(other, { mode: 0o755 });
    fs.chmodSync(other, 0o755);
    const ctx = await playwrightLaunch(other, { headless: true });
    try {
      expect(fs.statSync(other).mode & 0o777).toBe(0o700);
    } finally {
      await ctx.close();
    }
  });
});
