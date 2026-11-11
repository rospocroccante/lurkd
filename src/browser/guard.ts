import type { BrowserContext, Request, Route, WebSocketRoute } from 'playwright';
import type { FetchKind, FetchLogEntry } from '../archive/state.js';
import { deniedBy, isAllowedHost, isRedditHost, matchesReadEndpoint } from '../policy/urls.js';
import type { SourceConfig } from '../sources/schema.js';

// The read-only guard (D5, D14, D35). Every request of the headless browser passes through
// `guardDecision`: GET and HEAD to the source's own hosts leave, plus one armed form POST to a
// read endpoint, plus the listed beacons when the source switches them on. Everything else is
// aborted before it reaches the network. Every doubt blocks: an unknown method, a host outside
// `domains`, a scheme other than http(s), a URL that does not parse, no source in scope, or an
// exception anywhere in the route handler.
//
// The host check covers GETs too, so images, styles and scripts on a CDN host do not load. That is
// intended: extraction needs none of them. Do not list CDN hosts in a source's `domains`; that
// field names the forum's own hosts.
//
// Playwright never routes a redirect hop: the browser follows a 3xx answer of the forum's own
// server by itself. The guard checks each hop after the fact against the same decision, logs the
// ones it would have blocked (note `redirect:<note>`) and reports them through `onRedirectBlocked`,
// so the manager fails the read. The hop itself has already left the browser.

/**
 * What the guard applies right now. The manager owns one mutable scope and swaps it per
 * `withPage` call; the guard sets `armed` back to false when the armed POST goes through.
 */
export interface GuardScope {
  source: SourceConfig | null;
  jobId: string | null;
  armed: boolean;
}

export interface GuardDecision {
  allow: boolean;
  kind: FetchKind | null;
  note?: string;
  disarm: boolean;
}

/** Beacons a source may let through with `allow_beacons: true` (D35). POST only, own hosts only. */
export const KNOWN_BEACONS: readonly { name: string; pathPrefix: string }[] = Object.freeze([
  Object.freeze({ name: 'cloudflare-challenge-platform', pathPrefix: '/cdn-cgi/challenge-platform/' }),
]);

function block(note?: string): GuardDecision {
  return note === undefined ? { allow: false, kind: 'blocked', disarm: false } : { allow: false, kind: 'blocked', note, disarm: false };
}

/**
 * The guard's verdict on one request. `kind` is null for an allowed GET or HEAD (the reader logs
 * those itself), `form` for the armed search POST (logged only by the guard, P12),
 * `beacon_allowed` for a listed beacon, and `blocked` for everything else.
 */
export function guardDecision(scope: GuardScope, method: string, url: string): GuardDecision {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return block('invalid_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return block(`scheme:${u.protocol.replace(/:$/, '')}`);
  // D50: Reddit is never contacted, not even for an image a forum post embeds.
  if (isRedditHost(u.hostname)) return block('reddit');
  const beacon = method === 'POST' ? KNOWN_BEACONS.find((b) => u.pathname.startsWith(b.pathPrefix)) : undefined;
  const blocked = (note?: string) => block(beacon ? `beacon:${beacon.name}` : note);

  const source = scope.source;
  if (!source) return blocked('no_source');
  if (!isAllowedHost(source, url)) return blocked('off_domain');
  let rule: string | null;
  try {
    rule = deniedBy(source, url);
  } catch {
    // deniedBy throws on a URL that is not absolute: never read that as "no rule matched".
    return blocked('invalid_url');
  }
  if (rule !== null) return blocked(`deny:${rule}`);

  if (method === 'GET' || method === 'HEAD') return { allow: true, kind: null, disarm: false };
  if (method !== 'POST') return blocked(`method:${method}`);
  if (scope.armed && matchesReadEndpoint(source, method, url)) return { allow: true, kind: 'form', disarm: true };
  if (beacon && source.allow_beacons) return { allow: true, kind: 'beacon_allowed', disarm: false };
  return blocked();
}

// Page APIs whose traffic Playwright's routes never see: requests from shared workers, WebSockets
// opened inside workers (routeWebSocket only patches pages), WebTransport, WebRTC and
// WebSocketStream. Keepalive-class requests are a second family: `navigator.sendBeacon`,
// `fetch(..., { keepalive: true })` and `fetchLater` sent at page teardown (pagehide,
// visibilitychange, page.close) or from a fresh `window.open('')` popup leave without passing the
// route. sendBeacon and fetchLater are removed, and `fetch` is wrapped so a keepalive request
// rejects with a TypeError and is never sent. The route guard stays as the second layer.
// The script runs in a page, popup or iframe realm before any page script whenever Playwright has
// attached to the frame's target before the frame's scripts run: true for frames in the page's
// own target and for cross-origin out-of-process frames, false for frames Chromium isolates
// because they are sandboxed (hence IsolateSandboxedIframes off in manager.ts). This reveals
// automation rather than hiding it, so it is not an evasion measure (D8).
const UNGUARDED_APIS = ['Worker', 'SharedWorker', 'WebTransport', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'WebSocketStream', 'fetchLater'];

// The script is plain JavaScript text, never a serialised TypeScript function. A transpiler that
// keeps names (tsx, used by `npm run smoke`) wraps named inner functions in a `__name` helper that
// does not exist in the page; a serialised function with such helpers would throw before removing
// anything. Plain text cannot be rewritten that way.
// Everything the fetch wrapper uses is captured when the script runs, so a page script that later
// replaces Request.prototype.keepalive, Reflect or Promise cannot reach the native fetch.
export const HARDEN_SCRIPT: string = `(() => {
  'use strict';
  const g = globalThis;
  const remove = (target, name) => {
    if (!target) return;
    try { delete target[name]; } catch (e) {}
    if (name in target) {
      try { Object.defineProperty(target, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
    }
  };
  for (const name of ${JSON.stringify(UNGUARDED_APIS)}) remove(g, name);
  const nav = g.navigator;
  if (nav && Object.prototype.hasOwnProperty.call(nav, 'sendBeacon')) remove(nav, 'sendBeacon');
  if (g.Navigator) remove(g.Navigator.prototype, 'sendBeacon');
  const nativeFetch = g.fetch;
  const NativeRequest = g.Request;
  if (typeof nativeFetch !== 'function' || typeof NativeRequest !== 'function') return;
  const desc = Object.getOwnPropertyDescriptor(NativeRequest.prototype, 'keepalive');
  if (!desc || typeof desc.get !== 'function') { remove(g, 'fetch'); return; }
  const readKeepalive = Function.prototype.call.bind(desc.get);
  const apply = Reflect.apply;
  const reject = Promise.reject.bind(Promise);
  const NativeTypeError = TypeError;
  const wrapped = {
    fetch(input, init) {
      let req;
      try { req = new NativeRequest(input, init); } catch (e) { return reject(e); }
      if (readKeepalive(req)) return reject(new NativeTypeError('lurkd does not send keepalive requests.'));
      return apply(nativeFetch, this, [req]);
    },
  }.fetch;
  try {
    Object.defineProperty(g, 'fetch', { value: wrapped, writable: true, configurable: true, enumerable: true });
  } catch (e) {
    remove(g, 'fetch');
  }
})();`;

function entry(scope: GuardScope | null, method: string, url: string, kind: FetchKind, note?: string): FetchLogEntry {
  const e: FetchLogEntry = { sourceId: scope?.source?.id ?? null, jobId: scope?.jobId ?? null, url, method, kind, status: null };
  if (note !== undefined) e.note = note;
  return e;
}

/** A redirect hop the guard would have blocked, reported after it happened. */
export interface RedirectViolation {
  scope: GuardScope;
  method: string;
  url: string;
  /** The guard's own note, e.g. `off_domain` or `deny:logout`; `method:<METHOD>` when it gave none. */
  note: string;
}

/**
 * Routes every request of `ctx` through `guardDecision`, closes every WebSocket without ever
 * connecting it to a server, and removes the page APIs that would bypass both. Allowed GETs and
 * HEADs are not logged here; every other decision is. An exception anywhere blocks the request.
 * Redirect hops, which no route sees, are judged when Playwright reports them: a hop the guard
 * would have blocked is logged and passed to `onRedirectBlocked`.
 */
export async function installGuard(
  ctx: BrowserContext,
  getScope: () => GuardScope,
  log: (e: FetchLogEntry) => void,
  onRedirectBlocked?: (v: RedirectViolation) => void,
): Promise<void> {
  await ctx.addInitScript({ content: HARDEN_SCRIPT });

  ctx.on('request', (req: Request) => {
    let scope: GuardScope | null = null;
    let method = '';
    let url = '';
    let note: string;
    try {
      if (!req.redirectedFrom()) return;
      method = req.method();
      url = req.url();
      scope = getScope();
      // Observation only: a copy, so a hop can never disarm the running call.
      const d = guardDecision({ ...scope }, method, url);
      if (d.allow) return;
      note = d.note ?? `method:${method}`;
    } catch {
      note = 'guard_error';
    }
    try {
      log(entry(scope, method, url, 'blocked', `redirect:${note}`));
    } catch {
      // the read still fails below
    }
    try {
      if (scope) onRedirectBlocked?.({ scope, method, url, note });
    } catch {
      // nothing else to do from an event listener
    }
  });

  await ctx.routeWebSocket(/.*/, async (ws: WebSocketRoute) => {
    try {
      const scope = getScope();
      log(entry(scope, 'WS', ws.url(), 'blocked', 'websocket'));
    } catch {
      // the socket closes whether or not the row was written
    }
    await ws.close().catch(() => {});
  });

  await ctx.route('**/*', async (route: Route) => {
    let allow = false;
    let method = '';
    let url = '';
    let scope: GuardScope | null = null;
    try {
      const req = route.request();
      method = req.method();
      url = req.url();
      scope = getScope();
      const d = guardDecision(scope, method, url);
      // Synchronous, before the first await: a second POST racing this one sees the disarmed scope.
      if (d.disarm) scope.armed = false;
      if (d.kind !== null) log(entry(scope, method, url, d.kind, d.note));
      allow = d.allow;
    } catch {
      allow = false;
      try {
        log(entry(scope, method, url, 'blocked', 'guard_error'));
      } catch {
        // the request stays blocked
      }
    }
    // A request can go away (page closed, navigation replaced) before it is answered.
    if (allow) await route.continue().catch(() => {});
    else await route.abort('blockedbyclient').catch(() => {});
  });
}
