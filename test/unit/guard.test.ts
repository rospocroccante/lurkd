import type { BrowserContext } from 'playwright';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { FetchLogEntry } from '../../src/archive/state.js';
import { HARDEN_SCRIPT, KNOWN_BEACONS, guardDecision, installGuard, type GuardScope, type RedirectViolation } from '../../src/browser/guard.js';
import { testSource } from '../helpers/common.js';

const xf = testSource({
  id: 'xf',
  base_url: 'https://forums.example.net',
  engine: 'xenforo',
  read_endpoints: [{ method: 'POST', path: '/index.php?search/search', note: 'XenForo search form' }],
  deny_paths: ['/account/**'],
});
const xfBeacons = testSource({ ...xf, allow_beacons: true });
const SEARCH = 'https://forums.example.net/index.php?search/search';
const BEACON = 'https://forums.example.net/cdn-cgi/challenge-platform/h/b/jsd/r/0.5:1762600000:abc/8f1e2d3c4b5a6978';
const scope = (over: Partial<GuardScope> = {}): GuardScope => ({ source: xf, jobId: 'j', armed: false, ...over });

describe('guardDecision', () => {
  it('allows GET and HEAD', () => {
    for (const method of ['GET', 'HEAD'])
      expect(guardDecision(scope(), method, 'https://forums.example.net/threads/a.5/')).toEqual({ allow: true, kind: null, disarm: false });
  });

  it('lets one armed POST to a read endpoint through and disarms', () =>
    expect(guardDecision({ source: xf, jobId: 'j', armed: true }, 'POST', SEARCH)).toEqual({ allow: true, kind: 'form', disarm: true }));

  it('blocks an unarmed POST to the same endpoint', () =>
    expect(guardDecision(scope(), 'POST', SEARCH)).toMatchObject({ allow: false, kind: 'blocked', disarm: false }));

  it('blocks an armed POST that is not a read endpoint and stays armed', () => {
    expect(guardDecision(scope({ armed: true }), 'POST', 'https://forums.example.net/posts/1/reply')).toMatchObject({ allow: false, kind: 'blocked', disarm: false });
    expect(guardDecision(scope({ armed: true }), 'POST', 'https://forums.example.net/api/track')).toMatchObject({ allow: false, kind: 'blocked', disarm: false });
  });

  it('blocks the Cloudflare beacon unless allow_beacons is on', () => {
    expect(KNOWN_BEACONS).toEqual([{ name: 'cloudflare-challenge-platform', pathPrefix: '/cdn-cgi/challenge-platform/' }]);
    expect(guardDecision(scope(), 'POST', BEACON)).toEqual({ allow: false, kind: 'blocked', note: 'beacon:cloudflare-challenge-platform', disarm: false });
    expect(guardDecision(scope({ source: xfBeacons }), 'POST', BEACON)).toEqual({ allow: true, kind: 'beacon_allowed', disarm: false });
    // An armed scope does not turn a beacon into the search POST, and the beacon does not disarm it.
    expect(guardDecision(scope({ source: xfBeacons, armed: true }), 'POST', BEACON)).toEqual({ allow: true, kind: 'beacon_allowed', disarm: false });
  });

  it('allows a beacon only on a host of the source', () => {
    const offHost = 'https://evil.example/cdn-cgi/challenge-platform/h/b/jsd/r/1';
    expect(guardDecision(scope({ source: xfBeacons }), 'POST', offHost)).toEqual({ allow: false, kind: 'blocked', note: 'beacon:cloudflare-challenge-platform', disarm: false });
  });

  it('lets a GET to the beacon prefix through like any GET', () =>
    expect(guardDecision(scope(), 'GET', 'https://forums.example.net/cdn-cgi/challenge-platform/scripts/jsd/main.js')).toEqual({ allow: true, kind: null, disarm: false }));

  it('blocks every other method, armed or not', () => {
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'CONNECT', 'TRACE', 'PROPFIND', 'get', 'post', '']) {
      expect(guardDecision(scope({ armed: true }), method, SEARCH)).toEqual({ allow: false, kind: 'blocked', note: `method:${method}`, disarm: false });
    }
  });

  it('blocks requests to hosts outside the source domains, GET included', () => {
    for (const url of ['https://cdn.example.com/a.png', 'https://forums.example.net.evil.example/', 'https://sub.forums.example.net/x']) {
      expect(guardDecision(scope(), 'GET', url)).toEqual({ allow: false, kind: 'blocked', note: 'off_domain', disarm: false });
    }
    expect(guardDecision(scope({ armed: true }), 'POST', 'https://other.example/index.php?search/search')).toMatchObject({ allow: false, kind: 'blocked' });
  });

  it('blocks GETs to denied paths, the source rules and the built-in write words', () => {
    expect(guardDecision(scope(), 'GET', 'https://forums.example.net/account/preferences')).toEqual({ allow: false, kind: 'blocked', note: 'deny:/account/**', disarm: false });
    expect(guardDecision(scope(), 'GET', 'https://forums.example.net/logout/?t=1')).toEqual({ allow: false, kind: 'blocked', note: 'deny:logout', disarm: false });
    expect(guardDecision(scope(), 'HEAD', 'https://forums.example.net/posts/9/react')).toMatchObject({ allow: false, note: 'deny:react' });
  });

  it('blocks data:, blob:, javascript: and other schemes, and URLs that do not parse', () => {
    for (const [url, note] of [
      ['data:text/html,<p>x</p>', 'scheme:data'],
      ['blob:https://forums.example.net/0f1e', 'scheme:blob'],
      ['javascript:alert(1)', 'scheme:javascript'],
      ['ws://forums.example.net/socket', 'scheme:ws'],
      ['file:///etc/passwd', 'scheme:file'],
      ['/relative/path', 'invalid_url'],
      ['', 'invalid_url'],
    ] as const) {
      expect(guardDecision(scope(), 'GET', url)).toEqual({ allow: false, kind: 'blocked', note, disarm: false });
    }
  });

  it('blocks everything when no source is in scope', () => {
    expect(guardDecision({ source: null, jobId: null, armed: true }, 'GET', 'https://forums.example.net/')).toEqual({ allow: false, kind: 'blocked', note: 'no_source', disarm: false });
    expect(guardDecision({ source: null, jobId: null, armed: true }, 'POST', SEARCH)).toMatchObject({ allow: false, kind: 'blocked' });
  });
});

// A BrowserContext stand-in that keeps the handlers installGuard registers.
function fakeContext() {
  const state: {
    route?: (route: unknown) => Promise<void>;
    ws?: (ws: unknown) => unknown;
    request?: (req: unknown) => void;
    initScripts: unknown[];
  } = { initScripts: [] };
  const ctx = {
    on: (event: string, handler: (req: unknown) => void) => {
      if (event === 'request') state.request = handler;
    },
    route: async (_pattern: string, handler: (route: unknown) => Promise<void>) => {
      state.route = handler;
    },
    routeWebSocket: async (_pattern: RegExp, handler: (ws: unknown) => unknown) => {
      state.ws = handler;
    },
    addInitScript: async (script: unknown) => {
      state.initScripts.push(script);
    },
  };
  return { ctx: ctx as unknown as BrowserContext, state };
}

function fakeRoute(method: string, url: string, opts: { continueThrows?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    route: {
      request: () => ({ method: () => method, url: () => url }),
      continue: async () => {
        calls.push('continue');
        if (opts.continueThrows) throw new Error('Target page, context or browser has been closed');
      },
      abort: async (code?: string) => {
        calls.push(`abort:${code}`);
      },
    },
  };
}

describe('installGuard', () => {
  it('routes every request, closes WebSockets and adds the hardening script', async () => {
    const { ctx, state } = fakeContext();
    await installGuard(ctx, () => scope(), () => {});
    expect(state.route).toBeTypeOf('function');
    expect(state.ws).toBeTypeOf('function');
    // Plain text, never a serialised function a transpiler could have rewritten.
    expect(state.initScripts).toEqual([{ content: HARDEN_SCRIPT }]);
  });

  it('continues GETs without logging, aborts and logs the rest', async () => {
    const { ctx, state } = fakeContext();
    const log: FetchLogEntry[] = [];
    await installGuard(ctx, () => scope(), (e) => log.push(e));
    const get = fakeRoute('GET', 'https://forums.example.net/threads/a.5/');
    await state.route!(get.route);
    expect(get.calls).toEqual(['continue']);
    expect(log).toEqual([]);
    const post = fakeRoute('POST', 'https://forums.example.net/api/track');
    await state.route!(post.route);
    expect(post.calls).toEqual(['abort:blockedbyclient']);
    expect(log).toEqual([{ sourceId: 'xf', jobId: 'j', url: 'https://forums.example.net/api/track', method: 'POST', kind: 'blocked', status: null }]);
  });

  it('logs the armed search POST as form, once, and disarms the scope', async () => {
    const { ctx, state } = fakeContext();
    const log: FetchLogEntry[] = [];
    const s = scope({ armed: true });
    await installGuard(ctx, () => s, (e) => log.push(e));
    const first = fakeRoute('POST', SEARCH);
    const second = fakeRoute('POST', SEARCH);
    // Both handlers start before either finishes: the disarm happens before the first await.
    await Promise.all([state.route!(first.route), state.route!(second.route)]);
    expect(first.calls).toEqual(['continue']);
    expect(second.calls).toEqual(['abort:blockedbyclient']);
    expect(s.armed).toBe(false);
    expect(log.map((e) => [e.kind, e.method])).toEqual([
      ['form', 'POST'],
      ['blocked', 'POST'],
    ]);
  });

  it('blocks the request when the scope getter throws', async () => {
    const { ctx, state } = fakeContext();
    const log: FetchLogEntry[] = [];
    await installGuard(ctx, () => {
      throw new Error('boom');
    }, (e) => log.push(e));
    const get = fakeRoute('GET', 'https://forums.example.net/threads/a.5/');
    await state.route!(get.route);
    expect(get.calls).toEqual(['abort:blockedbyclient']);
    expect(log).toMatchObject([{ kind: 'blocked', note: 'guard_error', url: 'https://forums.example.net/threads/a.5/', method: 'GET' }]);
  });

  it('blocks an allowed request whose log entry cannot be written', async () => {
    const { ctx, state } = fakeContext();
    const s = scope({ armed: true });
    await installGuard(ctx, () => s, () => {
      throw new Error('database is closed');
    });
    const post = fakeRoute('POST', SEARCH);
    await state.route!(post.route);
    expect(post.calls).toEqual(['abort:blockedbyclient']);
  });

  it('does not throw when the request went away before it was continued', async () => {
    const { ctx, state } = fakeContext();
    await installGuard(ctx, () => scope(), () => {});
    const get = fakeRoute('GET', 'https://forums.example.net/threads/a.5/', { continueThrows: true });
    await expect(state.route!(get.route)).resolves.toBeUndefined();
  });

  it('closes a WebSocket and logs it with method WS', async () => {
    const { ctx, state } = fakeContext();
    const log: FetchLogEntry[] = [];
    await installGuard(ctx, () => scope(), (e) => log.push(e));
    const calls: string[] = [];
    await state.ws!({ url: () => 'wss://forums.example.net/socket', close: async () => void calls.push('close'), connectToServer: () => calls.push('connect') });
    expect(calls).toEqual(['close']);
    expect(log).toEqual([{ sourceId: 'xf', jobId: 'j', url: 'wss://forums.example.net/socket', method: 'WS', kind: 'blocked', status: null, note: 'websocket' }]);
  });

  it('still closes the WebSocket when logging fails', async () => {
    const { ctx, state } = fakeContext();
    await installGuard(ctx, () => scope(), () => {
      throw new Error('database is closed');
    });
    const calls: string[] = [];
    await state.ws!({ url: () => 'wss://forums.example.net/socket', close: async () => void calls.push('close') });
    expect(calls).toEqual(['close']);
  });
});

// A Playwright Request as the 'request' event hands it over; `from` set means a redirect hop.
const hop = (method: string, url: string, from: string | null) => ({
  method: () => method,
  url: () => url,
  redirectedFrom: () => (from === null ? null : { url: () => from }),
});

describe('installGuard on redirect hops', () => {
  it('logs and reports a hop the guard would have blocked', async () => {
    const { ctx, state } = fakeContext();
    const log: FetchLogEntry[] = [];
    const seen: RedirectViolation[] = [];
    const s = scope();
    await installGuard(ctx, () => s, (e) => log.push(e), (v) => seen.push(v));
    state.request!(hop('GET', 'https://forums.example.net/logout/', 'https://forums.example.net/go'));
    state.request!(hop('GET', 'https://elsewhere.example/x', 'https://forums.example.net/out'));
    state.request!(hop('POST', 'https://forums.example.net/api/track', SEARCH));
    expect(log).toEqual([
      { sourceId: 'xf', jobId: 'j', url: 'https://forums.example.net/logout/', method: 'GET', kind: 'blocked', status: null, note: 'redirect:deny:logout' },
      { sourceId: 'xf', jobId: 'j', url: 'https://elsewhere.example/x', method: 'GET', kind: 'blocked', status: null, note: 'redirect:off_domain' },
      { sourceId: 'xf', jobId: 'j', url: 'https://forums.example.net/api/track', method: 'POST', kind: 'blocked', status: null, note: 'redirect:method:POST' },
    ]);
    expect(seen.map((v) => [v.scope === s, v.method, v.note])).toEqual([
      [true, 'GET', 'deny:logout'],
      [true, 'GET', 'off_domain'],
      [true, 'POST', 'method:POST'],
    ]);
  });

  it('ignores allowed hops and requests that are not redirects', async () => {
    const { ctx, state } = fakeContext();
    const log: FetchLogEntry[] = [];
    const seen: RedirectViolation[] = [];
    await installGuard(ctx, () => scope(), (e) => log.push(e), (v) => seen.push(v));
    state.request!(hop('GET', 'https://forums.example.net/search/123/', SEARCH));
    state.request!(hop('GET', 'https://elsewhere.example/x', null));
    expect(log).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('never disarms the scope while judging a hop', async () => {
    const { ctx, state } = fakeContext();
    const s = scope({ armed: true });
    await installGuard(ctx, () => s, () => {});
    state.request!(hop('POST', SEARCH, 'https://forums.example.net/index.php?search/start'));
    expect(s.armed).toBe(true);
  });

  it('reports the hop even when logging fails, and never throws from the listener', async () => {
    const { ctx, state } = fakeContext();
    const seen: RedirectViolation[] = [];
    await installGuard(ctx, () => scope(), () => {
      throw new Error('database is closed');
    }, (v) => {
      seen.push(v);
      throw new Error('listener broke');
    });
    expect(() => state.request!(hop('GET', 'https://forums.example.net/logout', 'https://forums.example.net/go'))).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

// Runs the init script in a fresh realm with stand-ins for the page APIs.
function hardenedRealm() {
  const sent: { url: string; keepalive: boolean }[] = [];
  const context = vm.createContext({});
  vm.runInContext(
    `class Navigator {}
     Navigator.prototype.sendBeacon = function () { sentLog.push({ url: 'beacon', keepalive: true }); return true; };
     globalThis.Navigator = Navigator;
     globalThis.navigator = new Navigator();
     globalThis.Worker = function Worker() {};
     globalThis.SharedWorker = function SharedWorker() {};
     globalThis.WebTransport = function WebTransport() {};
     globalThis.RTCPeerConnection = function RTCPeerConnection() {};
     globalThis.webkitRTCPeerConnection = function webkitRTCPeerConnection() {};
     globalThis.WebSocketStream = function WebSocketStream() {};
     globalThis.fetchLater = function fetchLater() {};`,
    Object.assign(context, { sentLog: sent }),
  );
  // Node's own Request has the keepalive getter the script reads.
  context.Request = Request;
  context.fetch = async function (this: unknown, input: Request) {
    sent.push({ url: input.url, keepalive: input.keepalive });
    return { status: 200 };
  };
  vm.runInContext(HARDEN_SCRIPT, context);
  return { context, sent, run: (code: string) => vm.runInContext(code, context) as unknown };
}

describe('HARDEN_SCRIPT', () => {
  it('contains no transpiler helper', () => {
    expect(HARDEN_SCRIPT).not.toMatch(/__name|__defProp|require\(/);
  });

  it('removes the APIs whose traffic no route sees', () => {
    const { run } = hardenedRealm();
    expect(run(`['Worker', 'SharedWorker', 'WebTransport', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'WebSocketStream', 'fetchLater'].map((n) => typeof globalThis[n])`)).toEqual(
      Array(7).fill('undefined'),
    );
    expect(run(`typeof navigator.sendBeacon`)).toBe('undefined');
    expect(run(`'sendBeacon' in Navigator.prototype`)).toBe(false);
  });

  it('rejects keepalive fetches without sending them and passes the others through', async () => {
    const { run, sent } = hardenedRealm();
    const outcome = (code: string) => (run(code) as Promise<unknown>).then(() => 'sent', (e: Error) => `${e.name}: ${e.message}`);
    expect(await outcome(`fetch('https://f.example/a', { method: 'POST', keepalive: true, body: 'x' })`)).toBe('TypeError: lurkd does not send keepalive requests.');
    expect(await outcome(`fetch(new Request('https://f.example/b', { keepalive: true }))`)).toBe('TypeError: lurkd does not send keepalive requests.');
    // A getter that answers false first and true later is read once, by the Request constructor.
    expect(
      await outcome(`(() => { let n = 0; return fetch('https://f.example/c', { get keepalive() { return n++ > 0; } }); })()`),
    ).toBe('sent');
    expect(await outcome(`fetch('https://f.example/d')`)).toBe('sent');
    expect(await outcome(`fetch('not a url')`)).toMatch(/^TypeError/);
    expect(sent).toEqual([
      { url: 'https://f.example/c', keepalive: false },
      { url: 'https://f.example/d', keepalive: false },
    ]);
  });

  it('cannot be undone by a page script that patches Request, Reflect or Promise', async () => {
    const { run, sent } = hardenedRealm();
    // The realm shares Node's Request, so put its getter back afterwards.
    const original = Object.getOwnPropertyDescriptor(Request.prototype, 'keepalive')!;
    try {
      run(`Object.defineProperty(Request.prototype, 'keepalive', { get() { return false; }, configurable: true });
           Reflect.apply = () => { throw new Error('patched'); };
           Promise.reject = () => 'patched';`);
      const r = await (run(`fetch('https://f.example/e', { keepalive: true })`) as Promise<unknown>).then(() => 'sent', (e: Error) => e.name);
      expect(r).toBe('TypeError');
      expect(sent).toEqual([]);
    } finally {
      Object.defineProperty(Request.prototype, 'keepalive', original);
    }
  });
});
