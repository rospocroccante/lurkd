import crypto from 'node:crypto';
import { formatError } from '../client/format.js';
import { LurkdError } from '../errors.js';

// The serial job queue of the server: one job at a time, in arrival order, for every source.
// Everything that opens the headless browser (fetch, session check, author signals, sample) runs
// as a job, so at most one page and one page worker are alive at any time (Task 12 relies on it).

export type JobKind = 'fetch' | 'session' | 'signals' | 'sample';

export interface JobProgress {
  jobId: string;
  sourceId: string;
  kind: JobKind;
  state: 'queued' | 'running' | 'done' | 'stopped' | 'failed';
  phase: 'queued' | 'search' | 'thread' | 'session' | 'signals' | 'sample' | 'done';
  threadIndex: number;
  threadCount: number;
  postsFetched: number;
  requestsUsed: number;
  requestCap: number;
  message: string | null;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * What a running job reports through. `update` merges progress fields and the message; `state`
 * may only be set to `stopped` (a job that ended early but returned a result). `signal` aborts
 * when the queue closes, so a long job can stop between steps.
 */
export interface ProgressSink {
  readonly jobId: string;
  readonly signal: AbortSignal;
  update(p: Partial<JobProgress>): void;
}

const DEFAULT_HISTORY = 20;
// The fields a job may change about itself; identity and timestamps belong to the queue.
const PROGRESS_FIELDS = ['phase', 'threadIndex', 'threadCount', 'postsFetched', 'requestsUsed', 'requestCap', 'message'] as const;

interface Entry {
  seq: number;
  job: JobProgress;
  controller: AbortController;
  // Set by the task through update({ state: 'stopped' }); applied when the job ends.
  stopped: boolean;
  task: (p: ProgressSink) => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/**
 * The line a failed job shows (the lurkd page prints it): the error as `formatError` prints it for
 * the agent, never a raw message. Anything that is no LurkdError is not echoed.
 */
function messageOf(e: unknown): string {
  return e instanceof LurkdError ? formatError(e).replace(/\s+/g, ' ').trim() : 'Error internal: lurkd hit an unexpected error.';
}

const shuttingDown = () => new LurkdError('server_unavailable', 'lurkd is shutting down, so the job did not run.');

export class FetchQueue {
  private readonly history: number;
  private readonly now: () => Date;
  private readonly waiting: Entry[] = [];
  private current: Entry | null = null;
  private finished: Entry[] = [];
  private seq = 0;
  private closed = false;
  private idle: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(opts: { history?: number; now?: () => Date } = {}) {
    this.history = Math.max(0, Math.floor(opts.history ?? DEFAULT_HISTORY));
    this.now = opts.now ?? (() => new Date());
  }

  /** True while a job runs or waits. */
  get busy(): boolean {
    return this.current !== null || this.waiting.length > 0;
  }

  /**
   * Queues `task` and settles with its result once it has run. Jobs run one at a time in arrival
   * order; a failing job rejects its own promise only. Refused with `server_unavailable` after
   * `close`.
   */
  run<T>(label: { sourceId: string; kind: JobKind }, task: (p: ProgressSink) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(shuttingDown());
    return new Promise<T>((resolve, reject) => {
      const job: JobProgress = {
        jobId: crypto.randomUUID(),
        sourceId: label.sourceId,
        kind: label.kind,
        state: 'queued',
        phase: 'queued',
        threadIndex: 0,
        threadCount: 0,
        postsFetched: 0,
        requestsUsed: 0,
        requestCap: 0,
        message: null,
        queuedAt: this.now().toISOString(),
        startedAt: null,
        endedAt: null,
      };
      this.waiting.push({
        seq: this.seq++,
        job,
        controller: new AbortController(),
        stopped: false,
        task,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  /** Copies of the finished jobs kept in the history, the running job and the queued ones, in arrival order. */
  snapshot(): JobProgress[] {
    const all = [...this.finished, ...(this.current ? [this.current] : []), ...this.waiting];
    return all.sort((a, b) => a.seq - b.seq).map((e) => ({ ...e.job }));
  }

  /**
   * Refuses new jobs, ends the queued ones as `failed` (their promises reject with
   * `server_unavailable`), aborts the running job's signal and resolves once that job has
   * settled. The running job stops at its next request (RunLimiter takes the signal) or between
   * threads; a request already in flight runs to its page timeout, so the caller (Task 15) bounds
   * how long it waits for this before closing the browser.
   */
  close(): Promise<void> {
    this.closed = true;
    for (const e of this.waiting.splice(0)) {
      this.finish(e, 'failed', 'lurkd is shutting down, so the job did not run.');
      e.reject(shuttingDown());
    }
    if (!this.current) return Promise.resolve();
    this.current.controller.abort();
    if (!this.idle) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      this.idle = { promise, resolve };
    }
    return this.idle.promise;
  }

  private pump(): void {
    if (this.current || this.waiting.length === 0) return;
    const e = this.waiting.shift()!;
    this.current = e;
    e.job.state = 'running';
    e.job.startedAt = this.now().toISOString();
    const sink: ProgressSink = {
      jobId: e.job.jobId,
      signal: e.controller.signal,
      update: (p) => this.apply(e, p),
    };
    const settle = (state: JobProgress['state'], message: string | null) => {
      this.finish(e, state, message);
      // The queue is idle (or moves on) before the caller hears the result.
      this.current = null;
      if (this.closed && this.idle) {
        this.idle.resolve();
        this.idle = null;
      }
      this.pump();
    };
    Promise.resolve()
      .then(() => e.task(sink))
      .then(
        (value) => {
          settle(e.stopped ? 'stopped' : 'done', e.job.message);
          e.resolve(value);
        },
        (err: unknown) => {
          settle('failed', messageOf(err));
          e.reject(err);
        },
      );
  }

  private apply(e: Entry, p: Partial<JobProgress>): void {
    if (e.job.endedAt !== null) return;
    const job = e.job as unknown as Record<string, unknown>;
    for (const key of PROGRESS_FIELDS) if (p[key] !== undefined) job[key] = p[key];
    if (p.state === 'stopped') e.stopped = true;
  }

  private finish(e: Entry, state: JobProgress['state'], message: string | null): void {
    e.job.state = state;
    e.job.phase = 'done';
    e.job.message = message;
    e.job.endedAt = this.now().toISOString();
    this.finished.push(e);
    this.finished.sort((a, b) => a.seq - b.seq);
    if (this.finished.length > this.history) this.finished = this.finished.slice(this.finished.length - this.history);
  }
}
