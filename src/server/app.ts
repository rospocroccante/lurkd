import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getSetting, setSetting } from '../archive/db.js';
import type { StateStore } from '../archive/state.js';
import type { ThreadStore } from '../archive/threads.js';
import type { BrowserManager } from '../browser/manager.js';
import { HTTP_STATUS, LurkdError, toErrorBody } from '../errors.js';
import type { FetchQueue } from '../fetch/queue.js';
import { parseFetchRequest, type FetchService } from '../fetch/service.js';
import type { DraftStore, SampleStore } from '../sources/drafts.js';
import type { Registry } from '../sources/registry.js';
import { captureSample, finishHandoff, startLoginHandoff, startSampleHandoff } from './handoff.js';

// The local HTTP server (D3). Every route checks the Host header (DNS rebinding), the Origin
// header when there is one (other web pages calling localhost) and the token. Agent routes take
// the token as a Bearer header or the cookie; the lurkd page's routes take the cookie only, and
// its POST and DELETE routes also need the page's Origin. Nothing here returns the fetch log's
// URLs: an author lookup is logged under /u/<username>.json.

export const COOKIE_NOTICE =
  'lurkd keeps your forum cookies in its own browser profile at ~/.lurkd/profiles/default. Playwright starts that browser with a fixed encryption key, so anyone who can read the folder can read the cookies. Only your user account can open the folder (mode 0700).';

export interface AppDeps {
  token: string;
  port: () => number;
  version: string;
  db: Database.Database;
  service: FetchService;
  registry: Registry;
  state: StateStore;
  threads: ThreadStore;
  drafts: DraftStore;
  samples: SampleStore;
  browser: BrowserManager;
  queue: FetchQueue;
  uiDir: string;
  shutdown: () => void;
}

type Env = { Variables: { cookieOk: boolean } };

const COOKIE_NAME = 'lurkd_token';
const MAX_BODY_BYTES = 1024 * 1024;
const DAY_MS = 86_400_000;
const RETENTION_CHOICES: readonly (number | null)[] = [30, 90, 365, null];
const MAX_ARCHIVE_LIMIT = 50;

/** The UI files the page may load, with their content types; nothing else under uiDir is served. */
const UI_FILES: Record<string, string> = {
  'app.js': 'text/javascript; charset=utf-8',
  'view.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'favicon.svg': 'image/svg+xml',
};

// The page loads its own script and stylesheet only, and no other site may frame it.
const PAGE_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function invalid(message: string, details?: Obj): LurkdError {
  return new LurkdError('invalid_request', message, details);
}

function sha256(text: string): Buffer {
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}

/** The stored retention in days, or null for "keep everything" (also for a value lurkd does not offer). */
export function retentionDays(db: Database.Database): number | null {
  const raw = getSetting(db, 'retention_days');
  if (raw === null) return null;
  const n = Number(raw);
  return RETENTION_CHOICES.includes(n) ? n : null;
}

function fail(c: Context, e: unknown): Response {
  const err = e instanceof LurkdError ? e : new LurkdError('internal', 'lurkd hit an unexpected error. The server log has the details.');
  return c.json(toErrorBody(err), HTTP_STATUS[err.code] as ContentfulStatusCode);
}

/** The JSON object of the request body; an empty body reads as `{}`. The body is never echoed. */
async function jsonBody(c: Context): Promise<Obj> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw invalid('The request body must be JSON.');
  }
  if (!isObj(v)) throw invalid('The request body must be a JSON object.');
  return v;
}

function boolField(body: Obj, key: string, fallback?: boolean): boolean {
  const v = body[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'boolean') throw invalid(`${key} must be true or false.`, { field: key });
  return v;
}

function textField(body: Obj, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim() === '') throw invalid(`${key} must be a non-empty string.`, { field: key });
  return v;
}

function intParam(raw: string | undefined, key: string, min: number, max: number): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d{1,15}$/.test(raw)) throw invalid(`${key} must be a whole number from ${min} to ${max}.`, { field: key });
  const n = Number(raw);
  if (n < min || n > max) throw invalid(`${key} must be a whole number from ${min} to ${max}.`, { field: key });
  return n;
}

function boolParam(raw: string | undefined, key: string): boolean {
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  throw invalid(`${key} must be true or false.`, { field: key });
}

function idParam(raw: string, key: string): number {
  const n = intParam(raw, key, 1, Number.MAX_SAFE_INTEGER);
  if (n === undefined) throw invalid(`${key} must be a whole number.`, { field: key });
  return n;
}

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const tokenHash = sha256(deps.token);
  // Both sides hashed first, so the comparison takes the same time whatever the candidate's length.
  const tokenOk = (candidate: string | undefined): boolean => candidate !== undefined && crypto.timingSafeEqual(sha256(candidate), tokenHash);

  app.onError((e, c) => {
    if (!(e instanceof LurkdError)) console.error(`lurkd: ${c.req.method} ${c.req.path} failed:`, e);
    return fail(c, e);
  });
  app.notFound((c) => fail(c, new LurkdError('not_found', 'No such route.')));

  // Headers for every answer, errors included.
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('cache-control', 'no-store');
    c.res.headers.set('x-content-type-options', 'nosniff');
    c.res.headers.set('x-frame-options', 'DENY');
    c.res.headers.set('referrer-policy', 'no-referrer');
  });

  // D3: Host, Origin and token, in that order, on every route.
  app.use('*', async (c, next) => {
    const port = deps.port();
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(new URL(c.req.url).host)) return fail(c, new LurkdError('bad_host', 'lurkd answers only on 127.0.0.1 and localhost.'));
    const origin = c.req.header('origin');
    if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`))
      return fail(c, new LurkdError('bad_host', 'lurkd refuses requests from other web pages.'));

    const cookieOk = tokenOk(getCookie(c, COOKIE_NAME));
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '');
    const bearerOk = tokenOk(bearer?.[1]);
    if (c.req.method === 'GET' && c.req.path === '/') {
      const t = c.req.query('t');
      if (t !== undefined) {
        if (!tokenOk(t)) return fail(c, new LurkdError('unauthorized', 'The token in this address is not the one lurkd started with. Run lurkd start again.'));
        setCookie(c, COOKIE_NAME, deps.token, { httpOnly: true, sameSite: 'Strict', path: '/' });
        return c.redirect('/', 302);
      }
    }
    if (!cookieOk && !bearerOk) return fail(c, new LurkdError('unauthorized', 'A valid lurkd token is required.'));
    c.set('cookieOk', cookieOk);
    await next();
  });

  app.use(
    '/api/*',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, invalid(`The request body is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB.`)) }),
  );

  // The lurkd page's routes: the cookie only, and the page's Origin on anything that changes state.
  const page: MiddlewareHandler<Env> = async (c, next) => {
    if (!c.get('cookieOk')) return fail(c, new LurkdError('unauthorized', 'This route belongs to the lurkd page. Open the address lurkd start printed.'));
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('origin') === undefined)
      return fail(c, new LurkdError('bad_host', 'A change from the lurkd page must carry its Origin header.'));
    await next();
  };

  async function uiFile(c: Context, name: string, type: string): Promise<Response> {
    let data: Buffer;
    try {
      data = await fs.readFile(path.join(deps.uiDir, name));
    } catch {
      return fail(c, new LurkdError('not_found', `The lurkd page file ${name} is missing from this install.`));
    }
    const res = c.body(new Uint8Array(data), 200, { 'content-type': type });
    if (name === 'index.html') res.headers.set('content-security-policy', PAGE_CSP);
    return res;
  }

  // ---- any caller ----

  app.get('/health', (c) => c.json({ ok: true, version: deps.version, pid: process.pid, browser: deps.browser.state }));

  app.get('/api/status', async (c) => {
    const sessions = await deps.service.sessionStatus();
    const attention = sessions.filter((s) => s.state !== 'disabled' && (s.state === 'expired' || s.lastBlock !== null));
    const queueLength = deps.queue.snapshot().filter((j) => j.state === 'queued' || j.state === 'running').length;
    return c.json({
      version: deps.version,
      pid: process.pid,
      browser: { state: deps.browser.state, lastError: deps.browser.lastError },
      queueLength,
      attention,
    });
  });

  app.get('/api/sources', (c) => {
    const topic = c.req.query('topic');
    return c.json(deps.registry.search(c.req.query('q') ?? '', topic === undefined || topic === '' ? undefined : topic));
  });

  app.post('/api/fetch', async (c) => c.json(await deps.service.fetch(parseFetchRequest(await jsonBody(c)))));

  app.get('/api/archive/search', (c) => {
    const q = c.req.query('q') ?? '';
    if (q.trim() === '') throw invalid('q is required: the words to look for in the archive.', { field: 'q' });
    const opts: { sourceId?: string; limit?: number } = {};
    const source = c.req.query('source');
    if (source !== undefined && source !== '') opts.sourceId = source;
    const limit = intParam(c.req.query('limit'), 'limit', 1, MAX_ARCHIVE_LIMIT);
    if (limit !== undefined) opts.limit = limit;
    return c.json(deps.service.archiveSearch(q, opts));
  });

  app.get('/api/session', async (c) => {
    const source = c.req.query('source');
    const check = boolParam(c.req.query('check'), 'check');
    return c.json(await deps.service.sessionStatus(source === undefined || source === '' ? undefined : source, check));
  });

  app.post('/api/sample', async (c) => {
    const body = await jsonBody(c);
    const url = textField(body, 'url');
    const draft = body.draft_yaml;
    if (draft !== undefined && draft !== null && typeof draft !== 'string') throw invalid('draft_yaml must be a string.', { field: 'draft_yaml' });
    return c.json(await deps.service.sample(url, typeof draft === 'string' ? draft : undefined));
  });

  app.post('/api/author-signals', async (c) => {
    const body = await jsonBody(c);
    return c.json(await deps.service.authorSignals(textField(body, 'source'), textField(body, 'author')));
  });

  app.post('/api/shutdown', (c) => {
    // After the answer has gone out.
    setTimeout(() => {
      try {
        deps.shutdown();
      } catch (e) {
        console.error('lurkd: shutdown failed:', e);
      }
    }, 20);
    return c.json({ ok: true }, 202);
  });

  // ---- the lurkd page ----

  app.get('/', page, (c) => uiFile(c, 'index.html', 'text/html; charset=utf-8'));

  app.get('/ui/:file', page, (c) => {
    const name = c.req.param('file');
    const type = Object.hasOwn(UI_FILES, name) ? UI_FILES[name] : undefined;
    if (type === undefined) return fail(c, new LurkdError('not_found', 'No such file.'));
    return uiFile(c, name, type);
  });

  app.get('/api/state', page, (c) => {
    const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
    return c.json({
      version: deps.version,
      browser: { state: deps.browser.state, lastError: deps.browser.lastError, handoff: deps.browser.handoff },
      jobs: deps.queue.snapshot(),
      // counts7d are guard counts (requests the guard stopped, beacons among them) and challenge
      // detections, not requests that reached the forum.
      // `block` is the kind of the last block the source met (never its URL): the page offers
      // "Open window" only for a pending challenge.
      sources: deps.registry.views().map((v) => ({ ...v, counts7d: deps.state.recentCounts(v.id, since), block: deps.state.getSession(v.id).lastBlockKind })),
      drafts: deps.drafts.list('pending'),
      samplesPending: deps.samples.pending(),
      registryErrors: deps.registry.errors(),
      retentionDays: retentionDays(deps.db),
      cookieNotice: COOKIE_NOTICE,
    });
  });

  app.get('/api/threads/:id', page, (c) => c.json({ markdown: deps.service.threadMarkdown(idParam(c.req.param('id'), 'id')) }));

  app.post('/api/sources/:id/enable', page, async (c) => {
    const id = c.req.param('id');
    deps.registry.enable(id, boolField(await jsonBody(c), 'acknowledge', false));
    return c.json({ source: deps.registry.view(id) });
  });

  app.post('/api/sources/:id/disable', page, (c) => {
    const id = c.req.param('id');
    deps.registry.disable(id);
    return c.json({ source: deps.registry.view(id) });
  });

  app.post('/api/sources/:id/real-names', page, async (c) => {
    const id = c.req.param('id');
    deps.registry.setShowRealNames(id, boolField(await jsonBody(c), 'show'));
    return c.json({ source: deps.registry.view(id) });
  });

  app.post('/api/sources/:id/beacons', page, async (c) => {
    const id = c.req.param('id');
    deps.registry.setAllowBeacons(id, boolField(await jsonBody(c), 'allow'));
    return c.json({ source: deps.registry.view(id) });
  });

  app.post('/api/sources/:id/login', page, async (c) => c.json({ handoff: await startLoginHandoff(deps, c.req.param('id')) }));

  app.post('/api/handoff/done', page, async (c) => c.json({ sessions: await finishHandoff(deps, true) }));

  app.post('/api/handoff/cancel', page, async (c) => c.json({ sessions: await finishHandoff(deps, false) }));

  app.post('/api/sample-requests/open', page, async (c) => c.json({ handoff: await startSampleHandoff(deps, textField(await jsonBody(c), 'host')) }));

  app.post('/api/sample-requests/capture', page, async (c) => c.json(await captureSample(deps)));

  app.post('/api/drafts/:id/approve', page, (c) => {
    const source = deps.drafts.approve(idParam(c.req.param('id'), 'id'));
    return c.json({ source: deps.registry.view(source.id) });
  });

  app.post('/api/drafts/:id/reject', page, (c) => {
    deps.drafts.reject(idParam(c.req.param('id'), 'id'));
    return c.json({ ok: true });
  });

  app.delete('/api/sources/:id/archive', page, (c) => c.json({ deleted: deps.threads.deleteSource(c.req.param('id')) }));

  app.post('/api/settings/retention', page, async (c) => {
    const body = await jsonBody(c);
    const days = body.days;
    if (!('days' in body) || !RETENTION_CHOICES.includes(days as number | null))
      throw invalid('days must be 30, 90, 365 or null (keep everything).', { field: 'days' });
    const value = days as number | null;
    setSetting(deps.db, 'retention_days', value === null ? null : String(value));
    const deleted = deps.threads.applyRetention(value, new Date().toISOString());
    return c.json({ retentionDays: value, deleted });
  });

  return app;
}
