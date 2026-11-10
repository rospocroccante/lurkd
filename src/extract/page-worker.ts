import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { LurkdError, type ErrorCode } from '../errors.js';
import type { Selectors, SourceConfig } from '../sources/schema.js';
import type { ExtractedPost, ExtractedThread, SearchHit } from '../types.js';

// The synchronous page work (linkedom parse, the source's selectors in css-select, Readability,
// the converter) runs in a worker thread with a hard deadline, so no page or selector can stall
// the server: static checks (src/extract/bounds.ts) cannot bound css-select (`i:first-of-type` on
// 49 000 siblings took 49 s). One worker per page: it is started for the call, terminated when
// the call ends, and the call settles only after the worker has exited, so none outlives it.

/** How long one page may take in the worker, from the moment it has the page. */
export const PAGE_DEADLINE_MS = 3_000;
/** How long the worker may take to start and load its modules. */
const STARTUP_MS = 20_000;
/** Heap of one page worker; a page over it ends as `extraction_failed`, not as a crash of the server. */
const WORKER_HEAP_MB = 768;

export type PageTask =
  | { kind: 'thread'; html: string; pageUrl: string; sel: Selectors; source: SourceConfig; pageNo: number; previous: number }
  | { kind: 'list'; html: string; pageUrl: string; sel: Selectors; source: SourceConfig }
  | { kind: 'readability'; html: string; url: string };

export interface ThreadPageResult {
  title: string;
  next: string | null;
  posts: ExtractedPost[];
  /** A fingerprint of the page's posts: a page that repeats one already read ends the read. */
  fingerprint: string;
}

export interface PageResults {
  thread: ThreadPageResult;
  list: SearchHit[];
  readability: ExtractedThread;
}

/** A message from the worker. */
export type WorkerReply =
  | { ready: true }
  | { ok: true; result: unknown }
  | { ok: false; code: ErrorCode; message: string; details?: Record<string, unknown> };

let running = 0;

/** Page workers alive right now; 0 whenever no page call is in flight. */
export function activePageWorkers(): number {
  return running;
}

/**
 * The worker module next to this one and the options to start it: the built `.js` under dist, or
 * the `.ts` source with the tsx loader when lurkd runs from source (tsx, vitest), since the
 * sources import each other with `.js` suffixes that plain Node cannot map to `.ts` files.
 */
export function workerEntry(moduleUrl: string = import.meta.url): { url: URL; execArgv: string[] } {
  const fromSource = new URL(moduleUrl).pathname.endsWith('.ts');
  const url = new URL(fromSource ? './page-worker-entry.ts' : './page-worker-entry.js', moduleUrl);
  if (!fromSource) return { url, execArgv: [] };
  const tsx = createRequire(moduleUrl).resolve('tsx');
  return { url, execArgv: ['--import', pathToFileURL(tsx).href] };
}

/**
 * Runs `task` in a fresh worker. Rejects with `timeout()` when the worker holds the page longer
 * than `deadlineMs`, with the worker's own LurkdError when the page work failed, and with
 * `extraction_failed` when the worker could not start or crashed (out of memory, for example).
 */
export function runPageTask<K extends PageTask['kind']>(
  task: Extract<PageTask, { kind: K }>,
  timeout: () => LurkdError,
  deadlineMs: number = PAGE_DEADLINE_MS,
): Promise<PageResults[K]> {
  return new Promise<PageResults[K]>((resolve, reject) => {
    const { url, execArgv } = workerEntry();
    const worker = new Worker(url, { execArgv, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    running++;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Settle only once the worker is gone: no worker outlives the call that started it.
      void worker
        .terminate()
        .catch(() => undefined)
        .finally(() => {
          running--;
          settle();
        });
    };
    const failed = (why: string) => new LurkdError('extraction_failed', `The page reader worker ${why}.`, {});
    timer = setTimeout(() => finish(() => reject(failed(`did not start within ${STARTUP_MS / 1000} s`))), STARTUP_MS);
    worker.on('message', (m: WorkerReply) => {
      if ('ready' in m) {
        clearTimeout(timer);
        timer = setTimeout(() => finish(() => reject(timeout())), deadlineMs);
        worker.postMessage(task);
      } else if (m.ok) {
        finish(() => resolve(m.result as PageResults[K]));
      } else {
        finish(() => reject(new LurkdError(m.code, m.message, m.details)));
      }
    });
    worker.on('error', (e) => finish(() => reject(failed(`failed: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`))));
    worker.on('exit', (code) => finish(() => reject(failed(`stopped (exit code ${code})`))));
  });
}
