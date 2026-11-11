import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getSetting, setSetting } from '../archive/db.js';
import type { StateStore } from '../archive/state.js';
import type { ThreadStore } from '../archive/threads.js';
import type { BrowserManager } from '../browser/manager.js';
import { HTTP_STATUS, LurkdError, toErrorBody } from '../errors.js';
import type { FetchQueue } from '../fetch/queue.js';
import { MAX_IMPORT_BYTES, redditThreadId, redditUnsupported } from '../extract/reddit-import.js';
import { parseFetchRequest, type FetchService } from '../fetch/service.js';
import { quotedName } from '../output/quoted.js';
import { isRedditHost } from '../policy/urls.js';
import { analysableUrl, parseAddDraft, type AddDraftOut, type AddOut } from '../sources/analyse.js';
import { draftRefused, type AddRequestStore, type DraftStore, type ForbiddenLog, type SampleStore } from '../sources/drafts.js';
import { GroupStore, planBulkEnable, withoutHiddenFormat, type BulkPlan } from '../sources/groups.js';
import type { Registry, SourceView } from '../sources/registry.js';
import { captureSample, finishHandoff, startLoginHandoff, startSampleHandoff, startSignupHandoff } from './handoff.js';

// The local HTTP server (D3). Every route checks the Host header (DNS rebinding), the Origin
// header when there is one (other web pages calling localhost) and a credential. Two secrets
// (D52): the token, which the run file holds for the CLI and the MCP server, and the page secret,
// which this app makes when it is created and keeps in memory only. The browser never gets the
// token: `lurkd start` and `lurkd open` ask POST /api/page-link, with the token as a Bearer header
// and no Origin, for a one-time link `/?n=<nonce>` (32 random bytes, 60 seconds, used once), and
// opening it answers the page itself with the page secret in an HttpOnly, SameSite=Strict cookie.
// Agent routes take the token as a Bearer header, or the page's cookie (the page searches the
// archive too); the lurkd page's routes take the page's cookie only. The page's POST and DELETE
// routes also need its Origin. This is hygiene, not a boundary: a program that runs as the user
// can read the run file, mint a link and open it. What it buys is that the live token stays out of
// the browser's history and out of the command line of `open`, which `ps` shows.
// Nothing here returns the fetch log's URLs: an author lookup is logged under /u/<username>.json.

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
  addRequests: AddRequestStore;
  /** D49: forums whose rules forbid automated access; only the page's routes read or change it. */
  forbidden: ForbiddenLog;
  browser: BrowserManager;
  queue: FetchQueue;
  uiDir: string;
  shutdown: () => void;
  /**
   * Tests only: `lurkd add` may queue 127.0.0.1 and localhost (`AddressRules.allowLoopback`).
   * `startServer` passes it only when its caller does; lurkd start never does.
   */
  allowLoopbackForTests?: boolean;
  /** D51: the user's groups; by default a store on `db`. */
  groups?: GroupStore;
  /** The clock of the bulk acknowledgment lists and of the one-time page links; tests set it. */
  now?: () => number;
}

type Env = { Variables: { cookieOk: boolean; bearerOk: boolean } };

/** D52: the cookie that holds the page secret. Never the token. */
const PAGE_COOKIE = 'lurkd_page';
/** L2: the cookie an earlier lurkd set with the token itself; a link that opens the page clears it. */
const OLD_TOKEN_COOKIE = 'lurkd_token';
/** D52: a one-time page link is good for this long, once, and at most this many wait at a time. */
export const PAGE_LINK_TTL_MS = 60_000;
export const MAX_PAGE_LINKS = 5;
/** The page upload route: its page check runs before the 20 MB body limit (L4). */
const UPLOAD_ROUTE = '/api/import/reddit/upload';
const MAX_BODY_BYTES = 1024 * 1024;
/** D50: the two routes that take a saved Reddit thread file, with the file's own cap (20 MB). */
const IMPORT_ROUTES: ReadonlySet<string> = new Set(['/api/import/reddit', UPLOAD_ROUTE]);
const DAY_MS = 86_400_000;
const RETENTION_CHOICES: readonly (number | null)[] = [30, 90, 365, null];
const MAX_ARCHIVE_LIMIT = 50;
/** D51: at most this many sources in one bulk change or group change. */
const MAX_BULK_IDS = 500;
/** D51: how long the list a bulk switch-on dialog shows can be accepted, and how many may wait. */
const ACK_LIST_TTL_MS = 10 * 60_000;
const MAX_ACK_LISTS = 16;
/** The longest group name an error echoes back to an agent. */
const MAX_ECHOED_NAME = 60;
const MAX_LISTED_GROUPS = 30;

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

// D52, M1: what GET / answers a browser without the page's cookie. No script, nothing loaded.
const SIGN_IN_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function signInPage(used: boolean): string {
  const why = used
    ? 'This link has been used or has expired.'
    : 'This browser has not opened lurkd from a link yet, or lurkd has restarted since. A plain link to lurkd from another page does not open it either, even in a browser that opened it before.';
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lurkd: open it from the terminal</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:3rem 1rem;background:#fff;color:#1a1a1a}main{max-width:34rem;margin:0 auto}code{font:0.95em ui-monospace,monospace;background:#f1f1f1;padding:0.1em 0.3em;border-radius:3px}@media (prefers-color-scheme:dark){body{background:#151515;color:#e8e8e8}code{background:#2a2a2a}}</style>
</head>
<body>
<main>
<h1>Open lurkd from the terminal</h1>
<p>${why}</p>
<p>Run <code>lurkd open</code> in a terminal. It opens this page with a new link. If lurkd is not running, run <code>lurkd start</code> instead.</p>
<p>Each link works once, within 60 seconds, so an old one from your browser history does not open the page.</p>
</main>
</body>
</html>
`;
}

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

/** The text of a saved thread file sent as the request body; the body is never echoed. */
async function importText(c: Context): Promise<string> {
  const text = await c.req.text();
  if (text.trim() === '') throw invalid('The request body is empty: send the content of the saved Reddit thread file.');
  return text;
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

/**
 * A list of source ids from the body: 1 to MAX_BULK_IDS non-empty strings of at most 100
 * characters, repeats dropped, order kept. Whether each is a source is the caller's check.
 */
function idsField(body: Obj, key: string): string[] {
  const v = body[key];
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BULK_IDS || !v.every((x) => typeof x === 'string' && x !== '' && x.length <= 100))
    throw invalid(`${key} must be a list of 1 to ${MAX_BULK_IDS} source ids.`, { field: key });
  return [...new Set(v as string[])];
}

/**
 * The name as an error may print it back: one line, cut short, with control and private-use
 * characters made spaces and hidden format characters (bidirectional controls, zero-width spaces)
 * dropped. The joiners stay (A9 M2), so an emoji ZWJ sequence or a Persian word comes back whole.
 */
function echoName(name: string): string {
  const flat = withoutHiddenFormat(name.toWellFormed()).replace(/[\p{Cc}\p{Co}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return [...flat].length > MAX_ECHOED_NAME ? `${[...flat].slice(0, MAX_ECHOED_NAME).join('')}...` : flat;
}

/** A source as the bulk dialog lists it: its name, its rules line and the page that holds it. */
function ruleLine(v: SourceView): { id: string; name: string; policy: SourceView['policy']; ruleUrl: string; ruleQuote: string | null } {
  return { id: v.id, name: v.name, policy: v.policy, ruleUrl: v.ruleUrl, ruleQuote: v.ruleQuote };
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
  // D52: the page secret lives here only, for the life of this app: never in AppDeps, the run
  // file, a log line or an answer other than the Set-Cookie of a one-time link.
  const pageSecret = crypto.randomBytes(32).toString('hex');
  const pageHash = sha256(pageSecret);
  const pageOk = (candidate: string | undefined): boolean => candidate !== undefined && crypto.timingSafeEqual(sha256(candidate), pageHash);
  const groups = deps.groups ?? new GroupStore(deps.db);
  const now = deps.now ?? Date.now;
  // D52: the one-time page links waiting to be opened, by the SHA-256 of the nonce (the nonce
  // itself is kept nowhere), oldest first, each with the time it stops working.
  const pageLinks = new Map<string, number>();
  const prunePageLinks = () => {
    const t = now();
    for (const [k, expires] of pageLinks) if (expires < t) pageLinks.delete(k);
  };
  const mintPageLink = (): string => {
    prunePageLinks();
    while (pageLinks.size >= MAX_PAGE_LINKS) pageLinks.delete(pageLinks.keys().next().value as string);
    const nonce = crypto.randomBytes(32).toString('base64url');
    pageLinks.set(sha256(nonce).toString('hex'), now() + PAGE_LINK_TTL_MS);
    return nonce;
  };
  /** True once for a nonce lurkd minted less than PAGE_LINK_TTL_MS ago; the nonce is used up. */
  const takePageLink = (nonce: string): boolean => {
    prunePageLinks();
    const key = sha256(nonce).toString('hex');
    if (!pageLinks.has(key)) return false;
    pageLinks.delete(key);
    return true;
  };
  // D51: the lists bulk switch-on dialogs showed, by a random key, each with the policy every
  // listed source had then. "I accept for these N" names its list and exactly its ids; a list is
  // used once and lasts ACK_LIST_TTL_MS. Only sources the server itself put in a list can be
  // acknowledged in bulk, so no request can acknowledge a forbidden source or one it did not show.
  const ackLists = new Map<string, { ids: string[]; policies: Map<string, SourceView['policy']>; expires: number }>();
  const pruneAckLists = () => {
    const t = now();
    for (const [k, v] of ackLists) if (v.expires < t) ackLists.delete(k);
    while (ackLists.size >= MAX_ACK_LISTS) ackLists.delete(ackLists.keys().next().value as string);
  };

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

  // D3: Host, Origin and credential, in that order, on every route.
  app.use('*', async (c, next) => {
    const port = deps.port();
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(new URL(c.req.url).host)) return fail(c, new LurkdError('bad_host', 'lurkd answers only on 127.0.0.1 and localhost.'));
    const origin = c.req.header('origin');
    if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`))
      return fail(c, new LurkdError('bad_host', 'lurkd refuses requests from other web pages.'));

    // Only the page secret counts in a cookie: the token there opens nothing (D52).
    let cookieOk = pageOk(getCookie(c, PAGE_COOKIE));
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '');
    const bearerOk = tokenOk(bearer?.[1]);
    // D52: the page itself. A one-time link sets the page's cookie and answers the page at once,
    // with no redirect: a redirect would belong to the same navigation, and a link followed from
    // another site would then reach / without the SameSite=Strict cookie (M1). HEAD uses no link.
    // A browser without the cookie gets a small HTML page that says how to get a link; the token,
    // as Bearer, in a cookie or in the address, never opens the page.
    // M1: a GET uses the link up on first sight, whatever the cookie. A browser that already holds
    // the cookie (a second `lurkd open`) gets the page and nothing new, and the link it opened is
    // dead for everyone else, so a copy from `ps` or the history opens nothing.
    if ((c.req.method === 'GET' || c.req.method === 'HEAD') && c.req.path === '/') {
      const n = c.req.query('n');
      let used = false;
      if (n !== undefined && c.req.method === 'GET') {
        const fresh = takePageLink(n);
        if (!cookieOk) {
          if (fresh) {
            setCookie(c, PAGE_COOKIE, pageSecret, { httpOnly: true, sameSite: 'Strict', path: '/' });
            deleteCookie(c, OLD_TOKEN_COOKIE, { path: '/' });
            cookieOk = true;
          } else used = true;
        }
      }
      if (!cookieOk) return c.html(signInPage(used), 401, { 'content-security-policy': SIGN_IN_CSP });
    }
    if (!cookieOk && !bearerOk) return fail(c, new LurkdError('unauthorized', 'A valid lurkd token is required.'));
    c.set('cookieOk', cookieOk);
    c.set('bearerOk', bearerOk);
    await next();
  });

  // The lurkd page's routes: the page secret's cookie only (D52), and the page's Origin on
  // anything that changes state.
  const page: MiddlewareHandler<Env> = async (c, next) => {
    if (!c.get('cookieOk')) return fail(c, new LurkdError('unauthorized', 'This route belongs to the lurkd page. Run lurkd open to open it.'));
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('origin') === undefined)
      return fail(c, new LurkdError('bad_host', 'A change from the lurkd page must carry its Origin header.'));
    await next();
  };

  // L4: the page upload takes up to 20 MB, so who may send it is checked before its body is read.
  app.use(UPLOAD_ROUTE, page);
  const smallBody = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, invalid(`The request body is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB.`)) });
  const importBody = bodyLimit({ maxSize: MAX_IMPORT_BYTES, onError: (c) => fail(c, invalid(`The request body is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`)) });
  app.use('/api/*', (c, next) => (IMPORT_ROUTES.has(c.req.path) ? importBody(c, next) : smallBody(c, next)));

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

  // D51: `group` keeps the sources of one of the user's groups, by its name. The agent can read a
  // group this way; making or changing one is for the page only.
  app.get('/api/sources', (c) => {
    const topic = c.req.query('topic');
    const list = deps.registry.search(c.req.query('q') ?? '', topic === undefined || topic === '' ? undefined : topic);
    const group = c.req.query('group');
    if (group === undefined || group.trim() === '') return c.json(list);
    const g = groups.byName(group);
    if (!g) {
      const names = groups.list().map((x) => x.name);
      const shown = names.slice(0, MAX_LISTED_GROUPS).join(', ') + (names.length > MAX_LISTED_GROUPS ? ` and ${names.length - MAX_LISTED_GROUPS} more` : '');
      throw new LurkdError(
        'not_found',
        `The user has no group named "${echoName(group)}". ${names.length === 0 ? 'They have made no group yet; groups are made on the lurkd page.' : `Their groups: ${shown}.`}`,
      );
    }
    const members = new Set(g.sourceIds);
    return c.json(list.filter((v) => members.has(v.id)));
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

  // D45, `lurkd add`: an agent may queue an address for the lurkd page, never open one. Nothing
  // here reaches the browser; the user presses "Analyse" on the page (/api/add/analyse).
  // A host already waiting keeps the address the page shows: the agent cannot change it under the user.
  app.post('/api/add', async (c) => {
    const u = analysableUrl(textField(await jsonBody(c), 'url'), { allowLoopback: deps.allowLoopbackForTests === true });
    const host = u.hostname;
    // D50: Reddit is imported from saved files, never queued for "Analyse".
    if (isRedditHost(host)) throw redditUnsupported(redditThreadId(u.href));
    const known = deps.registry.sourceForHost(host);
    if (known) return c.json({ status: 'known', host, sourceId: known.id } satisfies AddOut);
    const waiting = deps.addRequests.request(host, u.href);
    return c.json({ status: waiting.kept ? 'already_queued' : 'queued', host, url: waiting.url } satisfies AddOut);
  });

  // D50, `lurkd import reddit <file>`: the body is the content of the saved thread file, which the
  // CLI read itself. The route takes content only, never a path: nothing here opens a local file,
  // so an agent cannot use it to read files through lurkd. Nothing reaches the browser or the network.
  // The CLI and an agent both hold the token, so the thread records "lurkd import / API", not which.
  app.post('/api/import/reddit', async (c) => c.json(deps.service.importReddit(await importText(c), 'api')));

  app.post('/api/author-signals', async (c) => {
    const body = await jsonBody(c);
    return c.json(await deps.service.authorSignals(textField(body, 'source'), textField(body, 'author')));
  });

  // D52: a one-time link to the page, for `lurkd start` and `lurkd open`. The token as Bearer
  // only, never the page's cookie, and no Origin: a browser sends one with every POST, the CLI
  // none, so no web page can mint a link, lurkd's own included. The answer holds the link alone.
  app.post('/api/page-link', (c) => {
    if (c.req.header('origin') !== undefined) return fail(c, new LurkdError('bad_host', 'Page links are made for the lurkd command, not for web pages.'));
    if (!c.get('bearerOk')) return fail(c, new LurkdError('unauthorized', 'A page link needs the lurkd token as a Bearer header.'));
    return c.json({ url: `http://127.0.0.1:${deps.port()}/?n=${mintPageLink()}`, expiresInSeconds: PAGE_LINK_TTL_MS / 1000 });
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
    const lastRead = deps.threads.lastFetchedBySource();
    const loaded = new Set(deps.registry.ids());
    return c.json({
      version: deps.version,
      browser: { state: deps.browser.state, lastError: deps.browser.lastError, handoff: deps.browser.handoff },
      jobs: deps.queue.snapshot(),
      // counts7d are guard counts (requests the guard stopped, beacons among them) and challenge
      // detections, not requests that reached the forum.
      // `block` is the kind of the last block the source met (never its URL): the page offers
      // "Open window" only for a pending challenge.
      // `lastReadAt`: the latest archived thread of the source (D51), null when it has none.
      sources: deps.registry.views().map((v) => ({
        ...v,
        counts7d: deps.state.recentCounts(v.id, since),
        block: deps.state.getSession(v.id).lastBlockKind,
        lastReadAt: lastRead.get(v.id) ?? null,
      })),
      // D51: the user's groups, by name; members are the ids of sources loaded now. Names are the user's text.
      groups: groups.list().map((g) => ({ id: g.id, name: g.name, sourceIds: g.sourceIds.filter((id) => loaded.has(id)) })),
      drafts: deps.drafts.list('pending'),
      samplesPending: deps.samples.pending(),
      // Addresses `lurkd add` queued; the page offers "Analyse" for each (D45). They are the agent's text.
      addRequests: deps.addRequests.pending(),
      // D49: forums whose rules forbid automated access, latest first. `name` and `sentence` are
      // forum text; `sourceId` names the source that claims the host by now, if any.
      forbidden: deps.forbidden.list().map((e) => ({
        host: e.host,
        name: e.name,
        engine: e.engine,
        baseUrl: e.baseUrl,
        ruleUrl: e.ruleUrl,
        sentence: e.sentence,
        foundAt: e.foundAt,
        sourceId: deps.registry.sourceForHost(e.host)?.id ?? null,
      })),
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

  app.post('/api/sources/:id/signup', page, async (c) => c.json({ handoff: await startSignupHandoff(deps, c.req.param('id')) }));

  app.post('/api/handoff/done', page, async (c) => c.json({ sessions: await finishHandoff(deps, true) }));

  app.post('/api/handoff/cancel', page, async (c) => c.json({ sessions: await finishHandoff(deps, false) }));

  app.post('/api/sample-requests/open', page, async (c) => c.json({ handoff: await startSampleHandoff(deps, textField(await jsonBody(c), 'host')) }));

  app.post('/api/sample-requests/capture', page, async (c) => c.json(await captureSample(deps)));

  // D45 "Add a forum". Only this route makes lurkd load an address for a new forum: the page's
  // cookie and Origin, never the agent's token.
  // D49: a clause the analysis found on a rules page goes to the forbidden log, replacing the
  // host's earlier one; an analysis without a clause leaves the log as it is.
  app.post('/api/add/analyse', page, async (c) => {
    const out = await deps.service.analyse(textField(await jsonBody(c), 'url'));
    if (out.status === 'known') deps.addRequests.remove(out.host);
    if (out.status === 'analysed' && out.rules.clause !== null) {
      const f = out.forum;
      deps.forbidden.record({
        host: out.host,
        name: f.name,
        engine: f.engine,
        baseUrl: f.base_url,
        loginUrl: f.login_url,
        signupUrl: f.signup_url,
        searchUrl: f.search_url,
        ruleUrl: out.rules.clause.url,
        sentence: out.rules.clause.sentence,
      });
    }
    return c.json(out);
  });

  // "Dismiss" next to a forum `lurkd add` queued: the page's cookie and Origin only, so an agent
  // cannot clear the queue to make room. The host is never echoed in an error.
  app.delete('/api/add/:host', page, (c) => {
    const host = c.req.param('host').trim().toLowerCase();
    if (!deps.addRequests.remove(host)) throw new LurkdError('not_found', 'No forum with this host is waiting under "Add a forum".');
    return c.json({ dismissed: host });
  });

  // The page's form as a draft. Every DraftStore rule applies: status untested, enabled,
  // show_real_names and allow_beacons false, limits clamped, the schema's errors field by field.
  app.post('/api/add/draft', page, async (c) => {
    const draft = parseAddDraft(await jsonBody(c), new Date().toISOString().slice(0, 10));
    const known = deps.registry.sourceForHost(draft.host);
    if (known) {
      deps.addRequests.remove(draft.host);
      return c.json({ status: 'known', host: draft.host, sourceId: known.id } satisfies AddDraftOut);
    }
    const r = deps.drafts.submit(draft.yaml, draft.host);
    if (!r.ok) throw draftRefused(r.errors);
    deps.addRequests.remove(draft.host);
    return c.json({ status: 'draft_saved', host: draft.host, draftId: r.draft.id, sourceId: r.draft.sourceId, warnings: r.draft.warnings } satisfies AddDraftOut);
  });

  // D49 "Add anyway": the source drafted from a forbidden-log entry, through DraftStore like the
  // form. Policy forbidden, the sentence and its page come from the entry, never from the body,
  // which gives only the topics and the name the person checked (M1: the logged name came from the
  // forum's page; without a name in the body it is kept); the source lands switched off and needs
  // "I accept" (D6). The
  // entry goes once the draft is saved, or once a source claims the host. The host is never
  // echoed in an error.
  app.post('/api/forbidden/:host/draft', page, async (c) => {
    const entry = deps.forbidden.get(c.req.param('host').trim().toLowerCase());
    if (!entry) throw new LurkdError('not_found', 'No forum with this host is listed among the forums that forbid automated access.');
    const body = await jsonBody(c);
    const draft = parseAddDraft(
      {
        engine: entry.engine,
        name: body.name === undefined ? entry.name : body.name,
        base_url: entry.baseUrl,
        domains: [entry.host],
        login_url: entry.loginUrl,
        signup_url: entry.signupUrl,
        search_url: entry.searchUrl,
        topics: body.topics,
        automation: { policy: 'forbidden', rule_url: entry.ruleUrl, rule_quote: entry.sentence },
      },
      new Date().toISOString().slice(0, 10),
    );
    const known = deps.registry.sourceForHost(draft.host);
    if (known) {
      deps.forbidden.remove(entry.host);
      deps.addRequests.remove(draft.host);
      return c.json({ status: 'known', host: draft.host, sourceId: known.id } satisfies AddDraftOut);
    }
    const r = deps.drafts.submit(draft.yaml, draft.host);
    if (!r.ok) throw draftRefused(r.errors);
    deps.forbidden.remove(entry.host);
    deps.addRequests.remove(draft.host);
    return c.json({ status: 'draft_saved', host: draft.host, draftId: r.draft.id, sourceId: r.draft.sourceId, warnings: r.draft.warnings } satisfies AddDraftOut);
  });

  // D49 "Dismiss": the entry leaves the log. The page's cookie and Origin only.
  app.delete('/api/forbidden/:host', page, (c) => {
    const host = c.req.param('host').trim().toLowerCase();
    if (!deps.forbidden.remove(host)) throw new LurkdError('not_found', 'No forum with this host is listed among the forums that forbid automated access.');
    return c.json({ dismissed: host });
  });

  app.post('/api/drafts/:id/approve', page, (c) => {
    const source = deps.drafts.approve(idParam(c.req.param('id'), 'id'));
    return c.json({ source: deps.registry.view(source.id) });
  });

  // A rejected draft also clears what `lurkd add` queued for its host, so the forum does not come back on the page.
  app.post('/api/drafts/:id/reject', page, (c) => {
    const draft = deps.drafts.reject(idParam(c.req.param('id'), 'id'));
    deps.addRequests.remove(draft.host);
    return c.json({ ok: true });
  });

  app.delete('/api/sources/:id/archive', page, (c) => c.json({ deleted: deps.threads.deleteSource(c.req.param('id')) }));

  // D46: a user source only; its archive stays until "Delete archive".
  app.delete('/api/sources/:id', page, (c) => {
    const id = c.req.param('id');
    // The window's "Done" would check the session of a source that no longer exists. A window
    // still launching counts too: `handoff` is set only once it is open.
    if (deps.browser.handoff?.sourceId === id || deps.browser.pendingHandoffSourceId === id)
      throw new LurkdError('handoff_in_progress', 'A browser window is open for this source. Finish it on the lurkd page first.', { sourceId: id });
    deps.registry.removeUserSource(id);
    groups.forgetSource(id);
    return c.json({ removed: id });
  });

  // ---- D51: groups and bulk switching, the page only ----

  app.post('/api/groups', page, async (c) => c.json({ group: groups.create((await jsonBody(c)).name as string) }));

  app.post('/api/groups/:id/rename', page, async (c) => {
    const id = idParam(c.req.param('id'), 'id');
    return c.json({ group: groups.rename(id, (await jsonBody(c)).name as string) });
  });

  app.delete('/api/groups/:id', page, (c) => {
    const id = idParam(c.req.param('id'), 'id');
    if (!groups.remove(id)) throw new LurkdError('not_found', 'No group has this id. Reload the lurkd page.');
    return c.json({ deleted: id });
  });

  // Every id must be a source lurkd has now; nothing is added otherwise.
  app.post('/api/groups/:id/add', page, async (c) => {
    const id = idParam(c.req.param('id'), 'id');
    const ids = idsField(await jsonBody(c), 'ids');
    for (const s of ids) deps.registry.view(s);
    return c.json({ group: groups.addMembers(id, ids) });
  });

  // An id that is not loaded now may still leave the group.
  app.post('/api/groups/:id/remove', page, async (c) => {
    const id = idParam(c.req.param('id'), 'id');
    return c.json({ group: groups.removeMembers(id, idsField(await jsonBody(c), 'ids')) });
  });

  // D51 bulk switch-on, step one: the sources the rules allow, or that the user acknowledged under
  // their current rules, go on now. The others come back for the dialog: those with silent rules
  // in one acknowledgment list, the forbidden ones by name only. Every id is checked before
  // anything changes.
  app.post('/api/bulk/enable', page, async (c) => {
    const ids = idsField(await jsonBody(c), 'ids');
    const views = ids.map((id) => deps.registry.view(id));
    const plan: BulkPlan = planBulkEnable(views);
    for (const id of plan.enableNow) deps.registry.enable(id, false);
    const byId = new Map(views.map((v) => [v.id, v]));
    let acknowledgment: { token: string; ids: string[] } | null = null;
    if (plan.needsAcknowledgment.length > 0) {
      pruneAckLists();
      const token = crypto.randomBytes(16).toString('hex');
      ackLists.set(token, {
        ids: plan.needsAcknowledgment,
        policies: new Map(plan.needsAcknowledgment.map((id) => [id, byId.get(id)!.policy])),
        expires: now() + ACK_LIST_TTL_MS,
      });
      acknowledgment = { token, ids: plan.needsAcknowledgment };
    }
    return c.json({
      enabled: plan.enableNow,
      alreadyOn: plan.alreadyOn,
      needsAcknowledgment: plan.needsAcknowledgment.map((id) => ruleLine(byId.get(id)!)),
      forbidden: plan.forbidden.map((id) => {
        const { policy: _policy, ...rest } = ruleLine(byId.get(id)!);
        return rest;
      }),
      notSwitchable: plan.notSwitchable,
      acknowledgment,
    });
  });

  // D51 step two, "I accept for these N": the list's key and exactly its ids, once. A list that
  // expired, another set of ids, or a listed source whose rules changed since: nothing changes.
  app.post('/api/bulk/acknowledge', page, async (c) => {
    const body = await jsonBody(c);
    const token = body.token;
    if (typeof token !== 'string' || token === '') throw invalid('token must name the list the dialog showed.', { field: 'token' });
    const list = ackLists.get(token);
    ackLists.delete(token);
    if (!list || list.expires < now()) throw invalid('This list of sources is no longer valid. Switch the sources on again to see it afresh.', { field: 'token' });
    const raw = body.ids;
    const ids = Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? (raw as string[]) : null;
    const same = ids !== null && ids.length === list.ids.length && new Set(ids).size === ids.length && ids.every((id) => list.policies.has(id));
    if (!same) throw invalid('These are not the sources the dialog listed, so none was switched on.', { field: 'ids' });
    for (const id of list.ids) {
      const v = deps.registry.view(id);
      if (v.engine === 'import' || v.policy === 'forbidden' || v.policy !== list.policies.get(id))
        throw new LurkdError('needs_acknowledgment', `The rules of ${quotedName(v.name)} changed after the dialog opened, so none of the sources was switched on. Switch them on again.`, {
          sourceId: id,
        });
    }
    for (const id of list.ids) deps.registry.enable(id, true);
    return c.json({ enabled: list.ids });
  });

  // D51: switching off needs no dialog. A source of imported threads is off already and stays out.
  app.post('/api/bulk/disable', page, async (c) => {
    const ids = idsField(await jsonBody(c), 'ids');
    const views = ids.map((id) => deps.registry.view(id));
    const disabled: string[] = [];
    const notSwitchable: string[] = [];
    for (const v of views) {
      if (v.engine === 'import') notSwitchable.push(v.id);
      else {
        deps.registry.disable(v.id);
        disabled.push(v.id);
      }
    }
    return c.json({ disabled, notSwitchable });
  });

  // D50: "Import a saved Reddit thread" on the page. The same content as the CLI route, under the
  // page's cookie and Origin; the Bearer token is refused, as on every page route.
  app.post('/api/import/reddit/upload', page, async (c) => c.json(deps.service.importReddit(await importText(c), 'page')));

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
