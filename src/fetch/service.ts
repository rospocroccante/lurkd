import { lookup } from 'node:dns/promises';
import type { StateStore } from '../archive/state.js';
import type { StoredThread, ThreadStore } from '../archive/threads.js';
import type { BrowserManager } from '../browser/manager.js';
import { PageReader } from '../browser/reader.js';
import { formatError } from '../client/format.js';
import { LurkdError, type ErrorCode } from '../errors.js';
import { adapterFor as defaultAdapterFor, type EngineAdapter, type ExtractContext } from '../extract/engine.js';
import { isRedditUrl, parseRedditImport, REDDIT_IMPORT_SOURCE_ID, redditThreadId, redditThreadUrl, redditUnsupported } from '../extract/reddit-import.js';
import { formatStructure, reduceStructure, SAMPLE_LIMITS, type StructNode } from '../extract/sample.js';
import { withoutAuthor } from '../extract/scrub.js';
import { quotedName } from '../output/quoted.js';
import { excerpt, IMPORTED_BY, nameResolver, renderThread, toRenderInput, type NameMode, type RenderInput } from '../output/render.js';
import { limitsFor, realClock, RunLimiter, type Clock, type HostPacer } from '../policy/limiter.js';
import { checkNavigable, isAllowedHost, isRedditHost } from '../policy/urls.js';
import { renderNames, stripMarkers } from '../pseudonym.js';
import {
  analysableUrl,
  analyseSource,
  automationPrefill,
  checkResolvesPublic,
  detectForum,
  findAutomationClause,
  PAGE_TEXT_SCRIPT,
  readSignals,
  rulesPageUrls,
  SIGNALS_SCRIPT,
  type AnalyseOut,
  type ForumDetection,
  type ResolveHost,
  type RulesCheck,
  type RulesPageOutcome,
} from '../sources/analyse.js';
import { draftRefused, type DraftStore, type SampleStore } from '../sources/drafts.js';
import type { Registry, SessionView } from '../sources/registry.js';
import type { SourceConfig } from '../sources/schema.js';
import type { AuthorSignals, ExtractedPost, ImportVia, SearchHit } from '../types.js';
import type { FetchQueue, JobKind, ProgressSink } from './queue.js';

// The one place where a request from an agent turns into browser work. Every read runs as one job
// of the serial queue, inside one `withPage` call, with one RunLimiter: the per-run cap, the daily
// cap and the deadline apply once per job. Threads are written to the archive through ThreadStore
// as each one arrives. What goes back to the agent carries pseudonyms unless the user switched
// real names on for the source (D20), and every error carries `details.source` (P30).

export interface FetchRequest {
  source: string;
  query?: string;
  url?: string;
  maxThreads: number;
  refresh: boolean;
  fromPost: number;
  maxChars: number;
}

export interface FetchedThreadOut {
  url: string;
  title: string;
  markdown: string;
  truncated: boolean;
  nextFromPost: number | null;
  quality: 'full' | 'low';
  fromArchive: boolean;
}

export interface FetchResponse {
  jobId: string | null;
  source: string;
  threads: FetchedThreadOut[];
  otherResults: SearchHit[];
  stopped: { code: ErrorCode; message: string } | null;
  requestsUsed: number;
  /**
   * D48: set when the source's session had expired, so the forum was read without login. Absent
   * for an archive answer, a source never logged in and a session that is still logged in.
   */
  readWithoutLogin?: 'session_expired';
}

export interface SessionStatusOut {
  id: string;
  name: string;
  state: SessionView;
  loginUrl: string | null;
  lastLoginAt: string | null;
  lastCheckAt: string | null;
  needsAcknowledgment: boolean;
  lastBlock: { kind: 'login' | 'challenge'; url: string } | null;
  /** Set by `sessionStatus(undefined, true)` when this source's check could not run or failed. */
  checkError?: ErrorCode;
}

export interface ArchiveHitOut {
  source: string;
  // The archive's id of the thread: the lurkd page opens the stored copy with it (GET /api/threads/:id).
  threadId: number;
  threadUrl: string;
  threadTitle: string;
  postNumber: number;
  author: string;
  postedAt: string | null;
  excerpt: string;
  // The reputation signals stored with the post (C6).
  signals: string[];
}

export interface AuthorSignalsOut {
  source: string;
  author: string;
  postCount: number | null;
  joinedAt: string | null;
  extra: string[];
  cached: boolean;
}

/** D50: what `lurkd import reddit` and the page's upload saved. `title` is rendered with the source's name mode. */
export interface RedditImportOut {
  source: string;
  threadId: number;
  url: string;
  title: string;
  /** The post and its comments, as numbered in the archive. */
  posts: number;
  comments: number;
  /** Comments the file holds past the first MAX_IMPORT_COMMENTS, which the import did not keep (C5). */
  notKept: number;
  /** Comments the file's "more" stubs stand for; the file does not hold them. */
  notInFile: number;
  /** True when the archive held this thread already and the import replaced it. */
  replaced: boolean;
  /** When the import this one replaced was made; null when nothing was replaced. */
  replacedImportAt: string | null;
  /** The route the file came through, as the thread's front matter says it: "page upload" or "lurkd import / API". */
  importedBy: string;
  importedAt: string;
}

export type SampleOut =
  | { status: 'sampled'; host: string; url: string; structure: string; sampledAt: string }
  | { status: 'needs_user'; host: string; message: string }
  | { status: 'draft_saved'; draftId: number; warnings: string[] };

export interface FetchServiceDeps {
  registry: Registry;
  state: StateStore;
  threads: ThreadStore;
  samples: SampleStore;
  drafts: DraftStore;
  browser: BrowserManager;
  queue: FetchQueue;
  /** One per server process (Task 8 carry): the per-host spacing spans every job. */
  pacer: HostPacer;
  salt: string;
  clock?: Clock;
  adapterFor?: (s: SourceConfig) => EngineAdapter;
  /** The page timeout handed to PageReader (D31: 45 s); tests shorten it. */
  pageTimeoutMs?: number;
  /**
   * Tests only: `analyse` may open 127.0.0.1 and localhost, where the fixture forums run
   * (`AddressRules.allowLoopback`). lurkd start never sets it.
   */
  allowLoopbackForTests?: boolean;
  /**
   * Resolves the host `analyse` is about to open (default node:dns `lookup` with `all: true`).
   * Unit tests pass their own, so they need no network.
   */
  resolveHost?: ResolveHost;
}

/** Errors on a rules page after which "Analyse" reads no further page (D49). */
const RULES_STOP: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['challenge', 'run_cap', 'daily_cap', 'server_unavailable', 'browser_unavailable']);

const defaultResolveHost: ResolveHost = (host) => lookup(host, { all: true });

const MINUTE = 60_000;
const DAY = 86_400_000;
/** C2: the session is checked before a read at most this often. */
const SESSION_CHECK_EVERY_MS = 15 * MINUTE;
/** D33: cached author signals are served this long. */
const SIGNALS_TTL_MS = 7 * DAY;
const SEARCH_LIMIT = 10;
/** D48: the front matter note of a thread read without login because the session had expired. */
export const READ_WITHOUT_LOGIN_NOTE = 'read without login: the session expired';
const DEFAULT_ARCHIVE_LIMIT = 10;

const FETCH_LIMITS = {
  maxThreads: { min: 1, max: 10, default: 3 },
  maxChars: { min: 2000, max: 200_000, default: 40_000 },
};

// reduceStructure as a self-contained expression: the page gets no function reference from Node,
// and tsx's name helper cannot leak into it (Task 8 carry).
const SAMPLE_SCRIPT = `(${reduceStructure.toString()})(${JSON.stringify(SAMPLE_LIMITS)})`;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function invalid(message: string, details?: Obj): LurkdError {
  return new LurkdError('invalid_request', message, details);
}

function intField(body: Obj, key: string, range: { min: number; max: number; default: number }): number {
  const v = body[key];
  if (v === undefined || v === null) return range.default;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < range.min || v > range.max)
    throw invalid(`${key} must be a whole number from ${range.min} to ${range.max}.`, { field: key });
  return v;
}

function textField(body: Obj, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.trim() === '') throw invalid(`${key} must be a non-empty string.`, { field: key });
  return v.trim();
}

/**
 * The fetch request from a snake_case body (`source`, `query`, `url`, `max_threads`, `refresh`,
 * `from_post`, `max_chars`). Exactly one of `query` and `url`; `max_threads` 1 to 10 (3),
 * `max_chars` 2000 to 200000 (40000), `from_post` 1 or more (1), `refresh` false. Anything else
 * is `invalid_request`.
 */
export function parseFetchRequest(body: unknown): FetchRequest {
  if (!isObj(body)) throw invalid('The request body must be a JSON object.');
  const source = textField(body, 'source');
  if (source === undefined) throw invalid('source is required: the id of a lurkd source.', { field: 'source' });
  const query = textField(body, 'query');
  const url = textField(body, 'url');
  if ((query === undefined) === (url === undefined)) throw invalid('Give exactly one of query and url.');
  const refresh = body.refresh ?? false;
  if (typeof refresh !== 'boolean') throw invalid('refresh must be true or false.', { field: 'refresh' });
  const req: FetchRequest = {
    source,
    maxThreads: intField(body, 'max_threads', FETCH_LIMITS.maxThreads),
    refresh,
    fromPost: intField(body, 'from_post', { min: 1, max: Number.MAX_SAFE_INTEGER, default: 1 }),
    maxChars: intField(body, 'max_chars', FETCH_LIMITS.maxChars),
  };
  if (query !== undefined) req.query = query;
  if (url !== undefined) req.url = url;
  return req;
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0]!.trim() || 'unknown error';
}

/**
 * A LurkdError as it is; anything else becomes `internal` with a fixed message. What was thrown
 * can be text a forum chose (a page script's error), so it is kept only in `details.error`, which
 * no formatter prints, never on the line the agent reads.
 */
function asLurkd(e: unknown): LurkdError {
  return e instanceof LurkdError ? e : new LurkdError('internal', 'lurkd hit an unexpected error while reading the page.', { error: firstLine(e) });
}

/** P30: the error with `details.source` set, so the agent-facing text can name the source. */
function withSource(e: unknown, sourceId: string): LurkdError {
  const err = asLurkd(e);
  if (err.details?.source === sourceId) return err;
  return new LurkdError(err.code, err.message, { ...(err.details ?? {}), source: sourceId });
}

function searchUnsupported(source: SourceConfig): LurkdError {
  return new LurkdError('search_unsupported', `${quotedName(source.name)} cannot be searched through lurkd. Give the url of a thread instead.`, {
    sourceId: source.id,
  });
}

const isBlock = (e: LurkdError): boolean => e.code === 'needs_login' || e.code === 'challenge';

/** A block whose only reasons are HTTP 401 or 403: the forum refused that one address, nothing else asked for a human. */
function isPlainRefusal(e: LurkdError): boolean {
  const reasons = e.details?.reasons;
  return e.code === 'needs_login' && Array.isArray(reasons) && reasons.length > 0 && reasons.every((r) => r === 'HTTP 401' || r === 'HTTP 403');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export class FetchService {
  private readonly registry: Registry;
  private readonly state: StateStore;
  private readonly threads: ThreadStore;
  private readonly samples: SampleStore;
  private readonly drafts: DraftStore;
  private readonly browser: BrowserManager;
  private readonly queue: FetchQueue;
  private readonly pacer: HostPacer;
  private readonly salt: string;
  private readonly clock: Clock;
  private readonly adapterFor: (s: SourceConfig) => EngineAdapter;
  private readonly pageTimeoutMs: number | undefined;
  private readonly allowLoopback: boolean;
  private readonly resolveHost: ResolveHost;

  constructor(deps: FetchServiceDeps) {
    this.registry = deps.registry;
    this.state = deps.state;
    this.threads = deps.threads;
    this.samples = deps.samples;
    this.drafts = deps.drafts;
    this.browser = deps.browser;
    this.queue = deps.queue;
    this.pacer = deps.pacer;
    this.salt = deps.salt;
    this.clock = deps.clock ?? realClock;
    this.adapterFor = deps.adapterFor ?? defaultAdapterFor;
    this.pageTimeoutMs = deps.pageTimeoutMs;
    this.allowLoopback = deps.allowLoopbackForTests === true;
    this.resolveHost = deps.resolveHost ?? defaultResolveHost;
  }

  // ---- source.fetch ----

  /**
   * Reads threads for the agent. With `url`, the archive copy answers when there is one and
   * `refresh` is false (no browser, `jobId` null). Otherwise one queue job: an optional session
   * check, the search (with `query`), then each thread read and saved before the next starts.
   * A stop after at least one thread returns what was read with `stopped`; before, it throws.
   */
  async fetch(req: FetchRequest): Promise<FetchResponse> {
    try {
      return await this.fetchFor(req);
    } catch (e) {
      throw withSource(e, req.source);
    }
  }

  private async fetchFor(req: FetchRequest): Promise<FetchResponse> {
    // D50: a Reddit address is never opened, whatever source it is asked of. An imported copy answers.
    if (req.url !== undefined && isRedditUrl(req.url)) return this.importedReddit(req, req.url);
    const source = this.registry.assertUsable(req.source);
    const adapter = this.adapterFor(source);
    let threadUrl: string | null = null;
    if (req.url !== undefined) {
      checkNavigable(source, req.url);
      threadUrl = adapter.canonicalUrl(source, req.url);
      // Task 10 carry: the thread may be stored under the URL built from its JSON slug, which a
      // short form misses; that costs a re-fetch, nothing worse.
      const stored = req.refresh ? null : this.threads.getByUrl(threadUrl);
      if (stored) {
        return {
          jobId: null,
          source: source.id,
          threads: [this.renderStored(source, stored.thread, stored.posts, req.fromPost, req.maxChars)],
          otherResults: [],
          stopped: null,
          requestsUsed: 0,
        };
      }
    } else if (!adapter.canSearch(source)) {
      throw searchUnsupported(source);
    }
    this.refuseDuringHandoff();
    return this.queue.run({ sourceId: source.id, kind: 'fetch' }, (sink) => this.runFetch(sink, req, threadUrl));
  }

  private async runFetch(sink: ProgressSink, req: FetchRequest, threadUrl: string | null): Promise<FetchResponse> {
    // The user may have switched the source off, changed its rules or its name mode while the job
    // waited: everything below comes from the config as it is now.
    const source = this.registry.assertUsable(req.source);
    const adapter = this.adapterFor(source);
    if (threadUrl !== null) checkNavigable(source, threadUrl);
    else if (!adapter.canSearch(source)) throw searchUnsupported(source);
    const out: FetchedThreadOut[] = [];
    let planned: SearchHit[] = [];
    let rest: SearchHit[] = [];
    let read = 0;
    let used = (): number => 0;
    let withoutLogin = false;
    const mode = this.nameMode(source);
    try {
      await this.withReader(source, sink, async (ctx, limiter) => {
        used = () => limiter.used;
        withoutLogin = await this.checkSessionBeforeRead(ctx, adapter, sink);
        const note = withoutLogin ? READ_WITHOUT_LOGIN_NOTE : null;
        if (threadUrl !== null) {
          planned = [{ url: threadUrl, title: threadUrl, posts: null }];
        } else {
          sink.update({ phase: 'search' });
          const hits = await adapter.search(ctx, req.query ?? '', SEARCH_LIMIT);
          planned = hits.slice(0, req.maxThreads);
          rest = hits.slice(req.maxThreads);
        }
        const share = Math.max(1, Math.floor(req.maxChars / Math.max(1, planned.length)));
        const fromPost = threadUrl !== null ? req.fromPost : 1;
        sink.update({ phase: 'thread', threadCount: planned.length, requestsUsed: limiter.used });
        for (const [i, hit] of planned.entries()) {
          if (sink.signal.aborted) throw new LurkdError('server_unavailable', 'lurkd is shutting down, so the read stopped.');
          sink.update({ threadIndex: i + 1, postsFetched: 0, requestsUsed: limiter.used });
          const t = await adapter.fetchThread(ctx, hit.url);
          const fetchedAt = this.nowIso();
          this.threads.save(source.id, t, fetchedAt);
          read = i + 1;
          const r = renderThread({ ...toRenderInput(source.id, t, fetchedAt), note }, mode, { fromPost, maxChars: share });
          out.push({ url: t.url, title: oneLine(renderNames(t.title, mode.nameFor)), ...r, quality: t.quality, fromArchive: false });
          sink.update({ requestsUsed: limiter.used });
        }
      }, threadUrl !== null && req.url !== undefined ? [req.url, threadUrl] : []);
    } catch (e) {
      const err = withSource(e, source.id);
      this.noteBlock(source, 'fetch', err);
      sink.update({ requestsUsed: used() });
      if (out.length === 0) throw err;
      sink.update({ state: 'stopped', message: formatError(err).replace(/\s+/g, ' ').trim() });
      // The planned hits that were not read go back with the other results.
      const unread = threadUrl === null ? planned.slice(read) : [];
      return {
        jobId: sink.jobId,
        source: source.id,
        threads: out,
        otherResults: [...unread, ...rest],
        stopped: { code: err.code, message: err.message },
        requestsUsed: used(),
        ...(withoutLogin ? { readWithoutLogin: 'session_expired' as const } : {}),
      };
    }
    this.clearBlock(source.id);
    const done = `${plural(out.length, 'thread', 'threads')} read with ${plural(used(), 'request', 'requests')}.`;
    sink.update({ requestsUsed: used(), message: withoutLogin ? `${done} Read without login: the session expired.` : done });
    return {
      jobId: sink.jobId,
      source: source.id,
      threads: out,
      otherResults: rest,
      stopped: null,
      requestsUsed: used(),
      ...(withoutLogin ? { readWithoutLogin: 'session_expired' as const } : {}),
    };
  }

  /**
   * C2: a logged-in session is checked before a read when the last check is older than 15
   * minutes. D48: an expired session no longer stops the read. The check marks it expired and the
   * read goes on as a reader without login would; a login wall during it still stops it with
   * `needs_login` (noteBlock). Returns true when the read runs on an expired session, found now
   * or earlier; a session never logged in returns false, as before.
   */
  private async checkSessionBeforeRead(ctx: ExtractContext, adapter: EngineAdapter, sink: ProgressSink): Promise<boolean> {
    const { source } = ctx;
    const s = this.state.getSession(source.id);
    if (source.login_url === null) return false;
    if (s.state !== 'logged_in') return s.state === 'expired';
    const last = s.lastCheckAt === null ? Number.NaN : Date.parse(s.lastCheckAt);
    if (Number.isFinite(last) && this.clock.now() - last < SESSION_CHECK_EVERY_MS) return false;
    sink.update({ phase: 'session' });
    return !(await this.checkSessionOnce(ctx, adapter));
  }

  /** Runs `checkSession` and stores what it found: logged in, or expired (a `never` session stays `never`). */
  private async checkSessionOnce(ctx: ExtractContext, adapter: EngineAdapter): Promise<boolean> {
    const id = ctx.source.id;
    let ok: boolean;
    try {
      ok = await adapter.checkSession(ctx);
    } catch (e) {
      // A login wall on the check itself means logged out.
      if (!(e instanceof LurkdError) || e.code !== 'needs_login') throw e;
      ok = false;
    }
    const at = this.nowIso();
    const before = this.state.getSession(id);
    if (ok) {
      this.state.setSession(id, { state: 'logged_in', lastCheckAt: at, ...(before.state === 'logged_in' ? {} : { lastLoginAt: at }) });
    } else {
      this.state.setSession(id, { state: before.state === 'logged_in' ? 'expired' : before.state, lastCheckAt: at });
    }
    return ok;
  }

  /**
   * D50: the archived copy of an imported Reddit thread, found by its thread id, rendered with the
   * name mode of the source it was imported under. With `refresh`, or when nothing was imported,
   * `unsupported` with the import steps. No browser, no request.
   */
  private importedReddit(req: FetchRequest, url: string): FetchResponse {
    const id = redditThreadId(url);
    const stored = id === null || req.refresh ? null : this.threads.getByUrl(redditThreadUrl(id));
    if (!stored) throw redditUnsupported(id);
    const t = stored.thread;
    const mode = this.nameModeById(t.sourceId);
    const r = renderThread(this.storedInput(t, stored.posts), mode, { fromPost: req.fromPost, maxChars: req.maxChars });
    return {
      jobId: null,
      source: t.sourceId,
      threads: [{ url: t.url, title: oneLine(renderNames(t.title, mode.nameFor)), ...r, quality: t.quality, fromArchive: true }],
      otherResults: [],
      stopped: null,
      requestsUsed: 0,
    };
  }

  // ---- lurkd import reddit and the page's upload (D50) ----

  /**
   * Parses the text of a saved Reddit thread file and stores it in the archive under reddit-import,
   * replacing an earlier import of the same thread. The thread keeps the route the file came
   * through (`via`) and, when it replaced one, the date of the earlier import. A file that is not
   * one Reddit thread is refused with `invalid_request` and nothing is stored. No browser, no
   * request: the text is all lurkd reads.
   */
  importReddit(text: string, via: ImportVia): RedditImportOut {
    const { thread, comments, notKept, notInFile } = parseRedditImport(text);
    const importedAt = this.nowIso();
    const earlier = this.threads.getByUrl(thread.url)?.thread ?? null;
    const replacedImportAt = earlier === null ? null : earlier.fetchedAt;
    const threadId = this.threads.save(REDDIT_IMPORT_SOURCE_ID, thread, importedAt, { via, replacedImportAt });
    const mode = this.nameModeById(REDDIT_IMPORT_SOURCE_ID);
    return {
      source: REDDIT_IMPORT_SOURCE_ID,
      threadId,
      url: thread.url,
      title: oneLine(renderNames(thread.title, mode.nameFor)),
      posts: thread.posts.length,
      comments,
      notKept,
      notInFile,
      replaced: earlier !== null,
      replacedImportAt,
      importedBy: IMPORTED_BY[via],
      importedAt,
    };
  }

  // ---- session.status ----

  /**
   * The session of one source, or of every source. With `check`, one `session` job per usable
   * source that has a `login_url` runs `checkSession`; the others are skipped. For a single source
   * a failed check throws; across all sources it leaves that source's status as it was.
   */
  async sessionStatus(sourceId?: string, check = false): Promise<SessionStatusOut[]> {
    try {
      return await this.sessionStatusFor(sourceId, check);
    } catch (e) {
      throw sourceId === undefined ? e : withSource(e, sourceId);
    }
  }

  private async sessionStatusFor(sourceId: string | undefined, check: boolean): Promise<SessionStatusOut[]> {
    const ids = sourceId === undefined ? this.registry.ids() : [this.registry.view(sourceId).id];
    const failed = new Map<string, ErrorCode>();
    if (check) {
      const due = ids.map((id) => this.registry.get(id)).filter((s) => s.login_url !== null && this.usableOrNull(s.id) !== null);
      if (due.length > 0) {
        try {
          this.refuseDuringHandoff();
        } catch (e) {
          throw withSource(e, due[0]!.id);
        }
      }
      for (const s of due) {
        try {
          await this.checkSessionJob(s.id);
        } catch (e) {
          if (sourceId !== undefined) throw withSource(e, s.id);
          failed.set(s.id, asLurkd(e).code);
        }
      }
    }
    return ids.map((id) => {
      const out = this.statusOf(id);
      const code = failed.get(id);
      return code === undefined ? out : { ...out, checkError: code };
    });
  }

  /**
   * One `session` job. The source is read again when the job starts: one switched off, made
   * unusable or left without a `login_url` while it waited is skipped.
   */
  private async checkSessionJob(id: string): Promise<void> {
    await this.queue.run({ sourceId: id, kind: 'session' }, async (sink) => {
      const source = this.usableOrNull(id);
      if (source === null || source.login_url === null) {
        sink.update({ message: 'Skipped: the source is switched off or has no login page.' });
        return;
      }
      const adapter = this.adapterFor(source);
      sink.update({ phase: 'session' });
      try {
        const ok = await this.withReader(source, sink, (ctx) => this.checkSessionOnce(ctx, adapter));
        if (ok) this.clearBlock(source.id);
        sink.update({ message: ok ? 'Logged in.' : 'Not logged in.' });
      } catch (e) {
        const err = withSource(e, source.id);
        this.noteBlock(source, 'session', err);
        throw err;
      }
    });
  }

  private statusOf(id: string): SessionStatusOut {
    const v = this.registry.view(id);
    const s = this.state.getSession(id);
    return {
      id: v.id,
      name: v.name,
      state: v.session,
      loginUrl: v.loginUrl,
      lastLoginAt: s.lastLoginAt,
      lastCheckAt: s.lastCheckAt,
      needsAcknowledgment: v.needsAcknowledgment,
      lastBlock: s.lastBlockKind !== null && s.lastBlockUrl !== null ? { kind: s.lastBlockKind, url: s.lastBlockUrl } : null,
    };
  }

  // ---- archive.search and the UI thread view ----

  /** Full-text search over the archive; each hit rendered with the name mode of its source. */
  archiveSearch(query: string, opts: { sourceId?: string; limit?: number }): ArchiveHitOut[] {
    const search: { sourceId?: string; limit: number } = { limit: opts.limit ?? DEFAULT_ARCHIVE_LIMIT };
    if (opts.sourceId !== undefined) search.sourceId = opts.sourceId;
    const modes = new Map<string, NameMode>();
    const modeOf = (id: string): NameMode => {
      let m = modes.get(id);
      if (!m) {
        m = this.nameModeById(id);
        modes.set(id, m);
      }
      return m;
    };
    return this.threads.search(query, search).map((h) => {
      const mode = modeOf(h.sourceId);
      const author = oneLine(stripMarkers(h.author));
      return {
        source: h.sourceId,
        threadId: h.threadId,
        threadUrl: h.threadUrl,
        threadTitle: oneLine(renderNames(h.threadTitle, mode.nameFor)),
        postNumber: h.postNumber,
        author: oneLine(stripMarkers(mode.nameFor(author))),
        postedAt: h.postedAt,
        excerpt: excerpt(renderNames(h.bodyMd, mode.nameFor), query),
        signals: h.signals.map((s) => oneLine(renderNames(s, mode.nameFor))),
      };
    });
  }

  /** A stored thread in full, for the lurkd page; `not_found` for an unknown id. */
  threadMarkdown(threadId: number): string {
    const stored = this.threads.getById(threadId);
    if (!stored) throw new LurkdError('not_found', `No thread has the id ${threadId}.`, { threadId });
    return renderThread(this.storedInput(stored.thread, stored.posts), this.nameModeById(stored.thread.sourceId)).markdown;
  }

  // ---- author.signals ----

  /**
   * Total posts and join date of one author, by pseudonym (D33). The cache answers for 7 days;
   * otherwise one `signals` job asks the forum. No error names the author.
   */
  async authorSignals(sourceId: string, pseudonymId: string): Promise<AuthorSignalsOut> {
    try {
      return await this.authorSignalsFor(sourceId, pseudonymId);
    } catch (e) {
      throw withSource(e, sourceId);
    }
  }

  private async authorSignalsFor(sourceId: string, pseudonymId: string): Promise<AuthorSignalsOut> {
    const source = this.registry.get(sourceId);
    if (!source.author_signals.profile_lookup)
      throw invalid(`${quotedName(source.name)} does not allow profile lookups (author_signals.profile_lookup is false).`, { sourceId });
    const id = pseudonymId.trim();
    // The input is never echoed: it could be a real name.
    const author = this.threads.lookupAuthor(sourceId, id);
    if (!author)
      throw new LurkdError('not_found', `No thread lurkd has read from ${quotedName(source.name)} has this author. Use an author pseudonym from a thread lurkd has read.`, {
        sourceId,
      });
    // The name mode is read when the answer is built, so a switch made while the job waited applies.
    const shown = (s: AuthorSignals, cached: boolean): AuthorSignalsOut => ({
      source: sourceId,
      author: oneLine(stripMarkers(this.nameModeById(sourceId).nameFor(author.username))),
      postCount: s.postCount,
      joinedAt: s.joinedAt,
      extra: [...s.extra],
      cached,
    });
    const fetchedAt = author.signalsFetchedAt === null ? Number.NaN : Date.parse(author.signalsFetchedAt);
    if (author.signals !== null && Number.isFinite(fetchedAt) && this.clock.now() - fetchedAt < SIGNALS_TTL_MS) return shown(author.signals, true);

    this.registry.assertUsable(sourceId);
    this.refuseDuringHandoff();
    const signals = await this.queue.run({ sourceId, kind: 'signals' }, async (sink) => {
      // Read again: the source may have been switched off or lost profile lookups while queued.
      const usable = this.registry.assertUsable(sourceId);
      if (!usable.author_signals.profile_lookup)
        throw invalid(`${quotedName(usable.name)} does not allow profile lookups (author_signals.profile_lookup is false).`, { sourceId });
      const adapter = this.adapterFor(usable);
      sink.update({ phase: 'signals' });
      try {
        const s = await this.withReader(usable, sink, (ctx) => adapter.authorSignals(ctx, { username: author.username, profileUrl: author.profileUrl }));
        this.clearBlock(sourceId);
        return s;
      } catch (e) {
        // The adapters scrub their own errors; a guard failure raised by withPage after the
        // adapter returned has not been through that, so scrub again before anything sees it.
        const err = withSource(withoutAuthor(e, author.username), sourceId);
        // A forum may refuse one profile (Discourse answers 403 for a hidden one) while the session
        // is fine: that is "no signals", not a login wall, and the session state stays as it is.
        if (isPlainRefusal(err))
          throw new LurkdError('not_found', `${quotedName(usable.name)} did not serve this author's profile, so author signals are unavailable.`, { sourceId });
        this.noteBlock(usable, 'signals', err);
        throw err;
      }
    });
    this.threads.saveAuthorSignals(sourceId, id, signals, this.nowIso());
    return shown(signals, false);
  }

  // ---- source.sample ----

  /**
   * D15 with the C3 amendment. With `draftYaml`: the draft is stored for the host of `url` (a
   * refused draft throws `invalid_request` with `details.errors`, P36). Otherwise a stored sample
   * of the host is returned first; a host that has a source gets one headless `sample` job; an
   * unknown host is queued for the user to open in the lurkd page, once the address passes
   * `analysableUrl` and `checkResolvesPublic` (M2), as for "Analyse".
   */
  async sample(url: string, draftYaml?: string): Promise<SampleOut> {
    let u: URL;
    // The input is not echoed in these errors: it could carry credentials or a query.
    try {
      u = new URL(url);
    } catch {
      throw invalid('source.sample needs an absolute http or https URL.');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw invalid('source.sample needs an absolute http or https URL.');
    // Credentials in the URL are never stored, shown in the lurkd page or opened.
    u.username = '';
    u.password = '';
    // The bare hostname, never host:port (Task 13 carry).
    const host = u.hostname;
    // D50: no sample, draft or window for Reddit.
    if (isRedditHost(host)) throw redditUnsupported(redditThreadId(u.href));
    if (draftYaml !== undefined) {
      const r = this.drafts.submit(draftYaml, host);
      if (!r.ok) throw draftRefused(r.errors);
      return { status: 'draft_saved', draftId: r.draft.id, warnings: r.draft.warnings };
    }
    const stored = this.samples.get(host);
    if (stored && stored.structure !== null && stored.sampledAt !== null)
      return { status: 'sampled', host: stored.host, url: stored.url, structure: stored.structure, sampledAt: stored.sampledAt };
    const known = this.registry.sourceForHost(host);
    if (!known) {
      // M2: the sample window is an ordinary browser window the user drives, outside the guard,
      // so an address joins its queue only under the rules of "Analyse": no local or private
      // host, https only, and a name that resolves to public addresses alone. The same messages.
      const rules = { allowLoopback: this.allowLoopback };
      const checked = analysableUrl(u.href, rules);
      await checkResolvesPublic(checked, this.resolveHost, rules);
      this.samples.request(host, checked.href);
      return {
        status: 'needs_user',
        host,
        message: `Open the lurkd page and press "Open window" next to ${host} under "Sites waiting for a sample".`,
      };
    }
    try {
      return await this.sampleHeadless(known.id, host, u.href);
    } catch (e) {
      throw withSource(e, known.id);
    }
  }

  private async sampleHeadless(sourceId: string, host: string, url: string): Promise<SampleOut> {
    checkNavigable(this.registry.assertUsable(sourceId), url);
    this.refuseDuringHandoff();
    const structure = await this.queue.run({ sourceId, kind: 'sample' }, async (sink) => {
      // Read again: the source may have been switched off or its domains changed while queued.
      const source = this.registry.assertUsable(sourceId);
      checkNavigable(source, url);
      sink.update({ phase: 'sample' });
      try {
        const text = await this.withReader(source, sink, async (ctx) => {
          await ctx.reader.open(url);
          // Bounded by the page timeout: a page script can make the walk hang (Task 13 carry).
          const tree = await ctx.reader.evaluate<unknown>(SAMPLE_SCRIPT);
          // Only formatStructure output is stored or returned: it prints well-formed names only.
          return formatStructure(tree as StructNode);
        }, [url]);
        this.clearBlock(sourceId);
        return text;
      } catch (e) {
        const err = withSource(e, sourceId);
        this.noteBlock(source, 'sample', err);
        throw err;
      }
    });
    this.samples.save(host, url, structure);
    const saved = this.samples.get(host);
    return { status: 'sampled', host, url, structure, sampledAt: saved?.sampledAt ?? this.nowIso() };
  }

  // ---- "Add a forum" (D45) ----

  /**
   * For the lurkd page only (the route takes the page's cookie and Origin): an agent never gets
   * here, so lurkd loads only an address the user gave or chose to analyse. A host a source
   * already claims answers with its id and loads nothing. Otherwise one `analyse` job opens the
   * address once through the guarded PageReader, with a throwaway read-only source for its host
   * (`analyseSource`: engine generic, draft limits, the built-in deny rules), reads the signals
   * with one `evaluate` and returns `detectForum`'s guess. A login wall still has the forum's
   * markup, so its signals are read and the block comes back with them; a human check comes back
   * as `blocked` with nothing read. Then the rules pages are read (`readRulesPages`, D49) and a
   * clause that forbids automated access prefills `automation`. Nothing is stored here: no sample,
   * no session state; the route writes a found clause to the forbidden log.
   *
   * Before the job, the host is looked up and refused when any of its addresses is not public
   * (`checkResolvesPublic`), so a public name that points at 127.0.0.1 or a private network is
   * not opened. DNS rebinding between this lookup and the browser's own is a known residual gap.
   */
  async analyse(rawUrl: string): Promise<AnalyseOut> {
    const rules = { allowLoopback: this.allowLoopback };
    const u = analysableUrl(rawUrl, rules);
    const host = u.hostname;
    // D50: Reddit is imported from saved files, never opened.
    if (isRedditHost(host)) throw redditUnsupported(redditThreadId(u.href));
    const known = this.registry.sourceForHost(host);
    if (known) return { status: 'known', host, sourceId: known.id };
    const source = analyseSource(u, this.nowIso().slice(0, 10));
    checkNavigable(source, u.href);
    await checkResolvesPublic(u, this.resolveHost, rules);
    this.refuseDuringHandoff();
    return this.queue.run({ sourceId: source.id, kind: 'analyse' }, async (sink) => {
      sink.update({ phase: 'analyse' });
      return this.withReader(
        source,
        sink,
        async (ctx): Promise<AnalyseOut> => {
          let login: { kind: 'login'; message: string } | null = null;
          try {
            await ctx.reader.open(u.href);
          } catch (e) {
            if (!(e instanceof LurkdError) || !isBlock(e)) throw e;
            if (e.code === 'challenge')
              return {
                status: 'blocked',
                host,
                block: { kind: 'challenge', message: `${host} shows a human check, so lurkd could not read the page. lurkd does not try to get past it.` },
              };
            login = { kind: 'login', message: `${host} asks for a login on this page. Check the details below; after approval, log in from the lurkd page.` };
          }
          // The address comes from Playwright, not from the page; the rest is page text, checked by readSignals.
          const raw = await ctx.reader.evaluate<unknown>(SIGNALS_SCRIPT);
          const pageUrl = ctx.reader.page.url();
          const forum = detectForum(readSignals(raw, pageUrl));
          const rules = await this.readRulesPages(ctx, forum, pageUrl);
          return { status: 'analysed', host, forum, block: login, rules, automation: automationPrefill(rules) };
        },
        [u.href],
      );
    });
  }

  /**
   * D49: after the analysed page, at most two rules pages of its host (`rulesPageUrls`, behind the
   * deny rules of the throwaway source), opened through the same reader, so the guard, the pacing
   * and the request count apply to them as to any request. Each page's text is searched with
   * `findAutomationClause`; the first clause found ends the reading. No rules page can fail the
   * analysis: a login wall, an HTTP error, another host or a timeout is noted and the next page is
   * tried; a human check, a request cap or a shutdown ends the reading at once (D8: no retry).
   */
  private async readRulesPages(ctx: ExtractContext, forum: ForumDetection, pageUrl: string): Promise<RulesCheck> {
    const allowed = (url: string): boolean => {
      try {
        checkNavigable(ctx.source, url);
        return true;
      } catch {
        return false;
      }
    };
    const out: RulesCheck = { pages: [], clause: null };
    for (const url of rulesPageUrls(forum, pageUrl, allowed, { allowLoopback: this.allowLoopback })) {
      let outcome: RulesPageOutcome = 'read';
      let stop = false;
      try {
        const nav = await ctx.reader.open(url);
        if (nav.status !== null && (nav.status < 200 || nav.status >= 300)) outcome = 'unavailable';
        else {
          const text = await ctx.reader.evaluate<unknown>(PAGE_TEXT_SCRIPT);
          const sentence = findAutomationClause(typeof text === 'string' ? text : '');
          if (sentence !== null) out.clause = { url, sentence };
        }
      } catch (e) {
        if (!(e instanceof LurkdError)) throw e;
        outcome = e.code === 'needs_login' ? 'login' : e.code === 'challenge' ? 'challenge' : e.code === 'off_domain' ? 'off_domain' : 'failed';
        stop = RULES_STOP.has(e.code);
      }
      out.pages.push({ url, outcome });
      if (out.clause !== null || stop) break;
    }
    return out;
  }

  // ---- internals ----

  /**
   * One `withPage` call with a PageReader and a fresh RunLimiter. The daily usage is read once,
   * when the job starts (P22): requests this run makes are counted by the limiter itself.
   */
  private withReader<T>(
    source: SourceConfig,
    sink: ProgressSink,
    fn: (ctx: ExtractContext, limiter: RunLimiter) => Promise<T>,
    /** The addresses the agent gave for this job: messages may show their path. Addresses read from pages never go here. */
    asked: readonly string[] = [],
  ): Promise<T> {
    const limits = limitsFor(source);
    const base = this.state.countRequests(source.id, new Date(this.clock.now() - DAY).toISOString());
    sink.update({ requestCap: limits.maxRequestsPerRun });
    return this.browser.withPage({ source, jobId: sink.jobId }, (page, arm) => {
      // The queue's signal stops the run at its next request when lurkd shuts down.
      const limiter = new RunLimiter(limits, this.pacer, () => base, this.clock, sink.signal);
      const reader = new PageReader(page, source, {
        limiter,
        log: (e) => this.state.logFetch(e, this.nowIso()),
        jobId: sink.jobId,
        arm,
        ...(this.pageTimeoutMs !== undefined ? { timeoutMs: this.pageTimeoutMs } : {}),
      });
      for (const u of asked) reader.ask(u);
      const ctx: ExtractContext = {
        reader,
        source,
        onProgress: (p) => sink.update({ postsFetched: p.postsFetched, requestsUsed: limiter.used }),
      };
      // Every message that leaves the job has its addresses cut down to what the agent asked for.
      return fn(ctx, limiter).catch((e: unknown) => {
        throw e instanceof LurkdError ? reader.scrubbed(e) : e;
      });
    });
  }

  /**
   * A login wall or a challenge: a logged-in session becomes expired, and the block is recorded
   * with a URL of the source. An author lookup records `base_url`, never the profile URL, which
   * holds the real username (Task 19 carry).
   */
  private noteBlock(source: SourceConfig, kind: JobKind, e: LurkdError): void {
    if (!isBlock(e)) return;
    const s = this.state.getSession(source.id);
    const requested = e.details?.url;
    const url = kind !== 'signals' && typeof requested === 'string' && isAllowedHost(source, requested) ? requested : source.base_url;
    this.state.setSession(source.id, {
      state: s.state === 'logged_in' ? 'expired' : s.state,
      lastBlockKind: e.code === 'needs_login' ? 'login' : 'challenge',
      lastBlockUrl: url,
    });
  }

  private clearBlock(sourceId: string): void {
    const s = this.state.getSession(sourceId);
    if (s.lastBlockKind !== null || s.lastBlockUrl !== null) this.state.setSession(sourceId, { lastBlockKind: null, lastBlockUrl: null });
  }

  private refuseDuringHandoff(): void {
    if (this.browser.handoff !== null)
      throw new LurkdError('handoff_in_progress', 'A browser window is open for a handoff. Finish it on the lurkd page, then try again.');
  }

  private usableOrNull(id: string): SourceConfig | null {
    try {
      return this.registry.assertUsable(id);
    } catch {
      return null;
    }
  }

  private nameMode(source: SourceConfig): NameMode {
    return nameResolver({ sourceId: source.id, salt: this.salt, realNames: source.show_real_names });
  }

  /** The name mode of a source id; pseudonyms when the source is gone from the registry. */
  private nameModeById(id: string): NameMode {
    let realNames = false;
    try {
      realNames = this.registry.get(id).show_real_names;
    } catch {
      // an archived thread of a source that no longer exists keeps pseudonyms
    }
    return nameResolver({ sourceId: id, salt: this.salt, realNames });
  }

  private storedInput(t: StoredThread, posts: ExtractedPost[]): RenderInput {
    return {
      sourceId: t.sourceId,
      url: t.url,
      title: t.title,
      engine: t.engine,
      fetchedAt: t.fetchedAt,
      postsExpected: t.postsExpected,
      pages: t.pages,
      extraction: t.extraction,
      quality: t.quality,
      posts,
      imported: t.imported,
    };
  }

  private renderStored(source: SourceConfig, t: StoredThread, posts: ExtractedPost[], fromPost: number, maxChars: number): FetchedThreadOut {
    const mode = this.nameMode(source);
    const r = renderThread(this.storedInput(t, posts), mode, { fromPost, maxChars });
    return { url: t.url, title: oneLine(renderNames(t.title, mode.nameFor)), ...r, quality: t.quality, fromArchive: true };
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}
