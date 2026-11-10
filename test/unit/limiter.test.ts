import { afterEach, describe, expect, it, vi } from 'vitest';
import { LurkdError } from '../../src/errors.js';
import {
  HostPacer,
  PAGE_TIMEOUT_MS,
  RUN_DEADLINE_MS,
  RunLimiter,
  limitsFor,
  realClock,
  type Clock,
  type RunLimits,
} from '../../src/policy/limiter.js';
import { range, testSource } from '../helpers/common.js';

class FakeClock implements Clock {
  t = 0;
  sleeps: number[] = [];
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.sleeps.push(ms);
    this.t += ms;
  }
}

const limits = (over: Partial<RunLimits> = {}): RunLimits => ({
  minIntervalMs: 2000,
  maxRequestsPerRun: 60,
  maxRequestsPerDay: 300,
  deadlineMs: RUN_DEADLINE_MS,
  sourceId: 'alpha',
  ...over,
});

async function rejection(p: Promise<unknown>): Promise<LurkdError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof LurkdError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
}

describe('constants and limitsFor', () => {
  it('uses 45 s per page and 10 minutes per run (D31)', () => {
    expect(PAGE_TIMEOUT_MS).toBe(45_000);
    expect(RUN_DEADLINE_MS).toBe(600_000);
  });

  it('maps the source defaults to milliseconds', () => {
    expect(limitsFor(testSource({ id: 'alpha', base_url: 'https://forum.example.org' }))).toEqual({
      minIntervalMs: 2000,
      maxRequestsPerRun: 60,
      maxRequestsPerDay: 300,
      deadlineMs: 600_000,
      sourceId: 'alpha',
    });
  });

  it('maps a custom rate_limit', () => {
    const s = testSource({
      id: 'bravo',
      base_url: 'https://forum.example.org',
      rate_limit: { min_delay_s: 3.5, max_requests_per_run: 20, max_requests_per_day: 100 },
    });
    expect(limitsFor(s)).toEqual({ minIntervalMs: 3500, maxRequestsPerRun: 20, maxRequestsPerDay: 100, deadlineMs: 600_000, sourceId: 'bravo' });
  });
});

describe('HostPacer', () => {
  it('returns the wait and reserves the next slot', () => {
    const p = new HostPacer();
    expect(p.reserve('a', 2000, 0)).toBe(0);
    expect(p.reserve('a', 2000, 0)).toBe(2000);
    expect(p.reserve('a', 2000, 500)).toBe(3500);
    expect(p.reserve('b', 2000, 500)).toBe(0);
    expect(p.reserve('a', 2000, 100_000)).toBe(0);
  });

  it('peeks at the wait without reserving', () => {
    const p = new HostPacer();
    expect(p.peek('a', 0)).toBe(0);
    p.reserve('a', 2000, 0);
    expect(p.peek('a', 500)).toBe(1500);
    expect(p.peek('a', 500)).toBe(1500);
    expect(p.peek('a', 3000)).toBe(0);
    expect(p.reserve('a', 2000, 500)).toBe(1500);
  });
});

describe('RunLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spaces requests to one host by the interval', async () => {
    const clock = new FakeClock();
    const rl = new RunLimiter(limits(), new HostPacer(), () => 0, clock);
    for (let i = 0; i < 3; i++) await rl.acquire('a.example');
    expect(clock.sleeps).toEqual([2000, 2000]);
    expect(clock.t).toBe(4000);
  });

  it('does not make one host wait for another', async () => {
    const clock = new FakeClock();
    const rl = new RunLimiter(limits(), new HostPacer(), () => 0, clock);
    await rl.acquire('a.example');
    await rl.acquire('b.example');
    expect(clock.sleeps).toEqual([]);
  });

  it('queues concurrent callers instead of letting them through together', async () => {
    const sleeps: number[] = [];
    const clock: Clock = { now: () => 0, sleep: async (ms) => void sleeps.push(ms) };
    const rl = new RunLimiter(limits(), new HostPacer(), () => 0, clock);
    await Promise.all([rl.acquire('a.example'), rl.acquire('a.example'), rl.acquire('a.example')]);
    expect(sleeps).toEqual([2000, 4000]);
  });

  it('refuses the next request once the job signal aborts, also after a host wait', async () => {
    const controller = new AbortController();
    const clock = new FakeClock();
    const rl = new RunLimiter(limits(), new HostPacer(), () => 0, clock, controller.signal);
    await rl.acquire('a.example');
    // The signal aborts while the second request waits for its host slot.
    const sleep = clock.sleep.bind(clock);
    clock.sleep = async (ms: number) => {
      controller.abort();
      await sleep(ms);
    };
    const during = await rejection(rl.acquire('a.example'));
    expect(during).toMatchObject({ code: 'server_unavailable', message: 'lurkd is shutting down.' });
    expect(rl.used).toBe(1);
    expect(await rejection(rl.acquire('b.example'))).toMatchObject({ code: 'server_unavailable' });
    expect(rl.used).toBe(1);
  });

  it('stops at the per-run cap', async () => {
    const rl = new RunLimiter(limits({ minIntervalMs: 0 }), new HostPacer(), () => 0, new FakeClock());
    for (const i of range(1, 60)) await rl.acquire(`h${i}.example`);
    const e = await rejection(rl.acquire('x.example'));
    expect(e.code).toBe('run_cap');
    expect(rl.used).toBe(60);
  });

  it('waits in real time with the real clock', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    expect(realClock.now()).toBe(1_000_000);
    let done = false;
    const p = realClock.sleep(100).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    expect(realClock.now()).toBe(1_000_100);
  });

  it('keeps per-host spacing across runs', async () => {
    const clock = new FakeClock();
    const pacer = new HostPacer();
    const first = new RunLimiter(limits(), pacer, () => 0, clock);
    await first.acquire('a.example');
    expect(clock.sleeps).toEqual([]);
    const second = new RunLimiter(limits(), pacer, () => 0, clock);
    await second.acquire('a.example');
    expect(clock.sleeps).toEqual([2000]);
    expect(second.used).toBe(1);
  });

  it('stops at the daily cap', async () => {
    const rl = new RunLimiter(limits(), new HostPacer(), () => 299, new FakeClock());
    await rl.acquire('a.example');
    const e = await rejection(rl.acquire('a.example'));
    expect(e.code).toBe('daily_cap');
    expect(e.message).toBe('Daily cap reached for alpha: 300 requests in 24 hours.');
    expect(rl.used).toBe(1);
  });

  it('reads usedToday once and counts its own requests on top (P22)', async () => {
    const usedToday = vi.fn(() => 297);
    const rl = new RunLimiter(limits(), new HostPacer(), usedToday, new FakeClock());
    for (let i = 0; i < 3; i++) await rl.acquire('a.example');
    await expect(rl.acquire('a.example')).rejects.toThrow('Daily cap reached for alpha: 300 requests in 24 hours.');
    expect(usedToday).toHaveBeenCalledTimes(1);
  });

  it('refuses the first request when the daily cap is already spent', async () => {
    const rl = new RunLimiter(limits(), new HostPacer(), () => 300, new FakeClock());
    expect((await rejection(rl.acquire('a.example'))).code).toBe('daily_cap');
    expect(rl.used).toBe(0);
  });

  it('stops after the deadline', async () => {
    const clock = new FakeClock();
    const rl = new RunLimiter(limits(), new HostPacer(), () => 0, clock);
    await rl.acquire('a.example');
    clock.t += 600_001;
    const e = await rejection(rl.acquire('a.example'));
    expect(e.code).toBe('timeout');
    expect(e.message).toBe('Run stopped after 10 minutes.');
    expect(rl.used).toBe(1);
  });

  it('refuses before sleeping when the host wait would end past the deadline', async () => {
    const clock = new FakeClock();
    const pacer = new HostPacer();
    const rl = new RunLimiter(limits(), pacer, () => 0, clock);
    await rl.acquire('a.example');
    clock.t = 599_000; // 1000 ms left; the next slot on a.example is at 2000 ms past the last one
    pacer.reserve('a.example', 2000, clock.t); // another run takes the slot at 599_000
    const e = await rejection(rl.acquire('a.example'));
    expect(e.code).toBe('timeout');
    expect(e.message).toBe('Run stopped after 10 minutes.');
    expect(clock.sleeps).toEqual([]);
    expect(rl.used).toBe(1);
    // Nothing was reserved: a later run on the same host waits only for the other run's slot.
    const later = new RunLimiter(limits(), pacer, () => 0, clock);
    await later.acquire('a.example');
    expect(clock.sleeps).toEqual([2000]);
  });

  it('refuses when the remaining time is shorter than the host interval', async () => {
    const clock = new FakeClock();
    const rl = new RunLimiter(limits({ minIntervalMs: 5000 }), new HostPacer(), () => 0, clock);
    clock.t = 597_000;
    await rl.acquire('a.example'); // no wait, 3000 ms left
    await expect(rl.acquire('a.example')).rejects.toThrow('Run stopped after 10 minutes.');
    expect(clock.sleeps).toEqual([]);
    expect(rl.used).toBe(1);
  });

  it('lets a wait through when it ends before the deadline', async () => {
    const clock = new FakeClock();
    const rl = new RunLimiter(limits(), new HostPacer(), () => 0, clock);
    clock.t = 597_000;
    await rl.acquire('a.example');
    await rl.acquire('a.example'); // ends at 599_000, 1000 ms before the deadline
    expect(clock.sleeps).toEqual([2000]);
    expect(rl.used).toBe(2);
  });

  it('re-checks the deadline after sleeping', async () => {
    // A clock whose sleep overshoots, as a suspended laptop would.
    const clock = new FakeClock();
    clock.sleep = async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms + 10_000;
    };
    const rl = new RunLimiter(limits(), new HostPacer(), () => 0, clock);
    clock.t = 590_000;
    await rl.acquire('a.example');
    const e = await rejection(rl.acquire('a.example'));
    expect(e.code).toBe('timeout');
    expect(clock.sleeps).toEqual([2000]);
    expect(rl.used).toBe(1);
  });

  it('counts the deadline from construction and reports the time left', async () => {
    const clock = new FakeClock();
    clock.t = 5000;
    const rl = new RunLimiter(limits(), new HostPacer(), () => 0, clock);
    expect(rl.remainingMs()).toBe(600_000);
    clock.t += 100_000;
    expect(rl.remainingMs()).toBe(500_000);
    clock.t += 600_000;
    expect(rl.remainingMs()).toBe(0);
  });

  it('rejects request 61 with the exact message', async () => {
    const limiter = new RunLimiter(limits({ minIntervalMs: 0 }), new HostPacer(), () => 0, new FakeClock());
    for (let i = 0; i < 60; i++) await limiter.acquire('a');
    await expect(limiter.acquire('a')).rejects.toThrow('Request cap reached: 60 requests in this run.');
  });

  it('does not reserve a host slot for a refused request', async () => {
    const clock = new FakeClock();
    const pacer = new HostPacer();
    const capped = new RunLimiter(limits({ maxRequestsPerRun: 1 }), pacer, () => 0, clock);
    await capped.acquire('a.example');
    await expect(capped.acquire('a.example')).rejects.toThrow('Request cap reached: 1 requests in this run.');
    clock.t += 2000;
    const next = new RunLimiter(limits(), pacer, () => 0, clock);
    await next.acquire('a.example');
    expect(clock.sleeps).toEqual([]);
  });
});
