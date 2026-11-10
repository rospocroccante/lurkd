import http from 'node:http';
import { HTTP_STATUS, LurkdError, type ErrorCode } from '../errors.js';
import { ensureServer } from '../launcher/launcher.js';
import { readRunFile, type RunInfo } from '../launcher/runfile.js';
import type { LurkdPaths } from '../paths.js';

// How the MCP server and the CLI mirror talk to the lurkd server. The run file is read on every
// call, so a restarted server is found again. With `autoStart`, a refused connection or a missing
// or stale run file starts the server once through the launcher (D4), without opening the page.
// The token goes into the Authorization header and nowhere else: no error built here carries it,
// the run file's contents or the answer body of something that is not lurkd. A lurkd-shaped error
// body is copied, but with every occurrence of the run-file token replaced by "<token>" (a process
// on the run-file port could echo it, and the message reaches the model).
// `signal` is the abort path: when it fires, every in-flight request is destroyed and later calls
// fail at once, so a process that closes its input does not wait for a call nobody will read.

export type Query = Record<string, string | number | boolean | undefined>;

export interface ApiClient {
  get<T>(path: string, query?: Query): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface ApiClientOptions {
  /** Start the server through the launcher when it is not running (default false). */
  autoStart?: boolean;
  /** Starts the server; `ensureServer(paths, { open: false })` unless a test passes its own. */
  ensure?: (paths: LurkdPaths) => Promise<unknown>;
  /** How long one call may take (default 30 minutes: a read waits in the queue, then runs up to 10). */
  timeoutMs?: number;
  /** Aborting it destroys the requests in flight and makes later calls fail with server_unavailable. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** The largest answer the client reads; a fetch of 10 threads at 200000 characters is far below. */
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

const ABORTED = 'The call was cancelled before the lurkd server answered.';
const CANNOT_START = 'Could not start the lurkd server. Run lurkd start in a terminal and try again.';
const NOT_RUNNING = 'The lurkd server is not running. Run lurkd start in a terminal and try again.';

/** A connection the server never took: nothing reached it, so the call is safe to repeat. */
class Refused extends Error {}

const isErrorCode = (v: unknown): v is ErrorCode => typeof v === 'string' && Object.hasOwn(HTTP_STATUS, v);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function withQuery(path: string, query: Query | undefined): string {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.append(k, String(v));
  const qs = params.toString();
  return qs === '' ? path : `${path}?${qs}`;
}

const TOKEN_PLACEHOLDER = '<token>';

/** The text with every occurrence of the token replaced. */
function scrubText(text: string, token: string): string {
  return token === '' ? text : text.split(token).join(TOKEN_PLACEHOLDER);
}

/** The value with the token replaced in every string, in keys and values, at any depth. */
function scrubValue(v: unknown, token: string): unknown {
  if (typeof v === 'string') return scrubText(v, token);
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, token));
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrubText(k, token), scrubValue(x, token)]));
  }
  return v;
}

/** The LurkdError of an error body, or null when the body is not one. The token never survives in it. */
function errorOf(body: unknown, token: string): LurkdError | null {
  if (typeof body !== 'object' || body === null) return null;
  const e = (body as { error?: unknown }).error;
  if (typeof e !== 'object' || e === null) return null;
  const { code, message, details } = e as { code?: unknown; message?: unknown; details?: unknown };
  if (typeof message !== 'string') return null;
  const d =
    typeof details === 'object' && details !== null && !Array.isArray(details)
      ? (scrubValue(details, token) as Record<string, unknown>)
      : undefined;
  return new LurkdError(isErrorCode(code) ? code : 'internal', scrubText(message, token), d);
}

function send(
  info: RunInfo,
  method: 'GET' | 'POST',
  path: string,
  body: string | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LurkdError('server_unavailable', ABORTED));
      return;
    }
    const headers: Record<string, string | number> = { authorization: `Bearer ${info.token}`, accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    let connected = false;
    const req = http.request({ host: '127.0.0.1', port: info.port, method, path, headers, agent: false });
    const timer = setTimeout(() => {
      req.destroy(new LurkdError('timeout', `The lurkd server did not answer within ${Math.round(timeoutMs / 60_000)} minutes. Check the queue on the lurkd page.`));
    }, timeoutMs);
    const onAbort = () => {
      // Reject here as well: once the answer has started, destroy() may not raise an error event.
      cleanup();
      reject(new LurkdError('server_unavailable', ABORTED));
      req.destroy();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    req.once('socket', (socket) => socket.once('connect', () => (connected = true)));
    req.on('error', (e: NodeJS.ErrnoException) => {
      cleanup();
      if (e instanceof LurkdError) reject(e);
      else if (!connected && e.code === 'ECONNREFUSED') reject(new Refused());
      else reject(new LurkdError('server_unavailable', 'The lurkd server stopped answering. Run lurkd start in a terminal and try again.'));
    });
    req.once('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_ANSWER_BYTES) {
          req.destroy(new LurkdError('server_unavailable', 'The lurkd server sent an answer larger than lurkd accepts.'));
          return;
        }
        chunks.push(c);
      });
      res.on('error', () => {});
      res.once('end', () => {
        cleanup();
        const status = res.statusCode ?? 0;
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // Not lurkd: the body is not repeated, whatever answered on that port.
          reject(new LurkdError('server_unavailable', `The lurkd server answered with HTTP ${status} and no lurkd answer. Run lurkd stop, then lurkd start.`));
          return;
        }
        if (status >= 200 && status < 300) {
          resolve(parsed);
          return;
        }
        reject(
          errorOf(parsed, info.token) ??
            new LurkdError('server_unavailable', `The lurkd server answered with HTTP ${status} and no lurkd error. Run lurkd stop, then lurkd start.`),
        );
      });
    });
    req.end(body);
  });
}

export function createApiClient(paths: LurkdPaths, opts: ApiClientOptions = {}): ApiClient {
  const autoStart = opts.autoStart ?? false;
  const ensure = opts.ensure ?? ((p: LurkdPaths) => ensureServer(p, { open: false }));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = opts.signal;

  async function start(): Promise<RunInfo> {
    try {
      await ensure(paths);
    } catch (e) {
      // The launcher's own reason (a log path, a stalled pid) stays in the details for the caller.
      const reason = (e instanceof Error ? e.message : String(e)).split('\n')[0]!;
      throw new LurkdError('server_unavailable', CANNOT_START, { reason });
    }
    const info = readRunFile(paths);
    if (info === null) throw new LurkdError('server_unavailable', CANNOT_START);
    return info;
  }

  async function call<T>(method: 'GET' | 'POST', path: string, body: string | undefined): Promise<T> {
    if (signal?.aborted) throw new LurkdError('server_unavailable', ABORTED);
    let info = readRunFile(paths);
    let started = false;
    // A missing run file, or one whose process is gone: the server is down.
    if (info === null || !isAlive(info.pid)) {
      if (!autoStart) throw new LurkdError('server_unavailable', NOT_RUNNING);
      info = await start();
      started = true;
    }
    try {
      return (await send(info, method, path, body, timeoutMs, signal)) as T;
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      if (!autoStart) throw new LurkdError('server_unavailable', NOT_RUNNING);
      if (started) throw new LurkdError('server_unavailable', CANNOT_START);
    }
    // Refused once: start the server and try one more time.
    info = await start();
    try {
      return (await send(info, method, path, body, timeoutMs, signal)) as T;
    } catch (e) {
      if (e instanceof Refused) throw new LurkdError('server_unavailable', CANNOT_START);
      throw e;
    }
  }

  return {
    get: <T>(path: string, query?: Query) => call<T>('GET', withQuery(path, query), undefined),
    post: <T>(path: string, body: unknown) => call<T>('POST', path, JSON.stringify(body ?? {})),
  };
}
