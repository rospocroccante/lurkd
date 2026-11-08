import { LurkdError } from '../errors.js';
import type { SourceConfig } from '../sources/schema.js';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** D31: every page, `fetch` inside the page included. */
export const PAGE_TIMEOUT_MS = 45_000;
/** D31: every run. */
export const RUN_DEADLINE_MS = 600_000;

/**
 * One request every `intervalMs` per host, shared by all runs. A slot is reserved before the
 * caller sleeps, so concurrent callers queue up instead of going through together.
 */
export class HostPacer {
  private readonly nextSlot = new Map<string, number>();

  /** How many ms a request to `host` would wait now, without reserving anything. */
  peek(host: string, now: number): number {
    return Math.max(0, (this.nextSlot.get(host) ?? now) - now);
  }

  /** Reserves the next slot for `host` and returns how many ms to wait for it. */
  reserve(host: string, intervalMs: number, now: number): number {
    const slot = Math.max(now, this.nextSlot.get(host) ?? now);
    this.nextSlot.set(host, slot + intervalMs);
    return slot - now;
  }
}

export interface RunLimits {
  minIntervalMs: number;
  maxRequestsPerRun: number;
  maxRequestsPerDay: number;
  deadlineMs: number;
  /** Names the source in the daily cap message; `limitsFor` sets it. */
  sourceId?: string;
}

export function limitsFor(source: SourceConfig): RunLimits {
  const r = source.rate_limit;
  return {
    minIntervalMs: Math.round(r.min_delay_s * 1000),
    maxRequestsPerRun: r.max_requests_per_run,
    maxRequestsPerDay: r.max_requests_per_day,
    deadlineMs: RUN_DEADLINE_MS,
    sourceId: source.id,
  };
}

const timeout = () => new LurkdError('timeout', 'Run stopped after 10 minutes.');

/**
 * The limits of one run: the per-run cap, the daily cap on top of `usedToday` (read once, at
 * construction; requests of this run are counted here), the deadline counted from construction,
 * and per-host spacing through the shared pacer. Every refusal comes before a slot is reserved,
 * except a deadline passed during the host wait, which is re-checked after the sleep.
 */
export class RunLimiter {
  private count = 0;
  private readonly startedAt: number;
  private readonly usedBefore: number;

  constructor(
    private readonly limits: RunLimits,
    private readonly pacer: HostPacer,
    usedToday: () => number,
    private readonly clock: Clock = realClock,
  ) {
    this.startedAt = clock.now();
    this.usedBefore = usedToday();
  }

  get used(): number {
    return this.count;
  }

  remainingMs(): number {
    return this.remainingAt(this.clock.now());
  }

  private remainingAt(now: number): number {
    return Math.max(0, this.startedAt + this.limits.deadlineMs - now);
  }

  async acquire(host: string): Promise<void> {
    const { maxRequestsPerRun, maxRequestsPerDay, minIntervalMs } = this.limits;
    if (this.count >= maxRequestsPerRun)
      throw new LurkdError('run_cap', `Request cap reached: ${maxRequestsPerRun} requests in this run.`);
    if (this.usedBefore + this.count >= maxRequestsPerDay)
      throw new LurkdError(
        'daily_cap',
        `Daily cap reached for ${this.limits.sourceId ?? 'this source'}: ${maxRequestsPerDay} requests in 24 hours.`,
      );
    // The deadline is hard: refuse when the host wait would end at or past it.
    const now = this.clock.now();
    if (this.pacer.peek(host, now) >= this.remainingAt(now)) throw timeout();
    this.count++;
    const wait = this.pacer.reserve(host, minIntervalMs, now);
    if (wait > 0) {
      await this.clock.sleep(wait);
      // The clock may have run past the deadline during the sleep; the reserved slot is wasted.
      if (this.remainingMs() <= 0) {
        this.count--;
        throw timeout();
      }
    }
  }
}
