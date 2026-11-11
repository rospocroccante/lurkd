import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openArchive, setSetting } from '../../src/archive/db.js';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  MAX_REGISTRY_BYTES,
  REGISTRY_LATEST_URL,
  REGISTRY_TIMEOUT_MS,
  UpdateChecker,
  UpdateStore,
  fetchLatestVersion,
  nodeRegistryFetch,
  type RegistryFetch,
} from '../../src/update/check.js';
import { isNewerVersion, parseStableVersion } from '../../src/update/version.js';

// D53: the daily registry check. Every fetch here is injected, or goes to a stub server on
// 127.0.0.1: no test reaches the npm registry.

const T0 = Date.parse('2026-11-11T09:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('versions', () => {
  it('accepts a stable semver only', () => {
    expect(parseStableVersion('0.2.1')).toEqual([0, 2, 1]);
    expect(parseStableVersion('10.20.30')).toEqual([10, 20, 30]);
    for (const bad of ['0.2.1-beta.1', '0.2', 'v0.2.1', '01.2.3', '0.2.1+build', ' 0.2.1', '0.2.1\n', '', '1.2.3.4', '99999999999999999999.0.0', 1, null, undefined, {}])
      expect(parseStableVersion(bad as unknown), String(bad)).toBeNull();
  });

  it('calls only a strictly higher stable version newer', () => {
    expect(isNewerVersion('0.2.1', '0.2.0')).toBe(true);
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.1.9', '0.2.0')).toBe(false);
    // A pre-release is never offered.
    expect(isNewerVersion('0.3.0-beta.1', '0.2.0')).toBe(false);
    // A running pre-release is behind its own release.
    expect(isNewerVersion('0.3.0', '0.3.0-beta.1')).toBe(true);
    expect(isNewerVersion('0.2.9', '0.3.0-beta.1')).toBe(false);
    expect(isNewerVersion('garbage', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.2.1', 'garbage')).toBe(false);
  });
});

describe('fetchLatestVersion', () => {
  it('asks the registry for lurkd/latest as JSON, as lurkd/<version>, with a 5 s timeout and a size cap', async () => {
    const fetch = vi.fn<RegistryFetch>(async () => ({ status: 200, body: JSON.stringify({ name: 'lurkd', version: '0.3.0' }) }));
    expect(await fetchLatestVersion({ version: '0.2.1', fetch })).toBe('0.3.0');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://registry.npmjs.org/lurkd/latest');
    expect(REGISTRY_LATEST_URL).toBe(url);
    expect(init.headers).toEqual({ accept: 'application/json', 'user-agent': 'lurkd/0.2.1' });
    expect(init.timeoutMs).toBe(5000);
    expect(REGISTRY_TIMEOUT_MS).toBe(5000);
    expect(init.maxBytes).toBe(MAX_REGISTRY_BYTES);
  });

  it('refuses an answer that is not a stable version of lurkd', async () => {
    const answer = (status: number, body: string): RegistryFetch => async () => ({ status, body });
    await expect(fetchLatestVersion({ version: '0.2.1', fetch: answer(404, '{}') })).rejects.toThrow('HTTP 404');
    await expect(fetchLatestVersion({ version: '0.2.1', fetch: answer(200, 'not json') })).rejects.toThrow('not JSON');
    await expect(fetchLatestVersion({ version: '0.2.1', fetch: answer(200, '[]') })).rejects.toThrow('no valid version');
    await expect(fetchLatestVersion({ version: '0.2.1', fetch: answer(200, '{"version":"0.3.0-rc.1"}') })).rejects.toThrow('no valid version');
    await expect(fetchLatestVersion({ version: '0.2.1', fetch: answer(200, '{"version":"<script>"}') })).rejects.toThrow('no valid version');
    await expect(fetchLatestVersion({ version: '0.2.1', fetch: answer(200, '{"version":3}') })).rejects.toThrow('no valid version');
  });
});

describe('nodeRegistryFetch (against a stub on 127.0.0.1)', () => {
  let server: http.Server;
  let port: number;
  let seen: http.IncomingHttpHeaders[];
  let respond: (res: http.ServerResponse) => void;

  beforeEach(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      seen.push(req.headers);
      respond(res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('sends the given headers and no cookie, and returns status and body', async () => {
    respond = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"version":"0.3.0"}');
    const r = await nodeRegistryFetch(`http://127.0.0.1:${port}/lurkd/latest`, { headers: { accept: 'application/json', 'user-agent': 'lurkd/0.2.1' }, timeoutMs: 2000, maxBytes: 1024 });
    expect(r).toEqual({ status: 200, body: '{"version":"0.3.0"}' });
    expect(seen[0]!['user-agent']).toBe('lurkd/0.2.1');
    expect(seen[0]!.accept).toBe('application/json');
    expect(seen[0]!.cookie).toBeUndefined();
    expect(seen[0]!.authorization).toBeUndefined();
  });

  it('stops reading past the size cap', async () => {
    respond = (res) => res.writeHead(200).end('x'.repeat(5000));
    await expect(
      nodeRegistryFetch(`http://127.0.0.1:${port}/`, { headers: {}, timeoutMs: 2000, maxBytes: 1024 }),
    ).rejects.toThrow('larger than');
  });

  it('gives up after the timeout', async () => {
    respond = () => {}; // never answers
    const t0 = Date.now();
    await expect(nodeRegistryFetch(`http://127.0.0.1:${port}/`, { headers: {}, timeoutMs: 200, maxBytes: 1024 })).rejects.toThrow('did not answer');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('does not follow a redirect', async () => {
    respond = (res) => res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }).end();
    const r = await nodeRegistryFetch(`http://127.0.0.1:${port}/`, { headers: {}, timeoutMs: 2000, maxBytes: 1024 }).catch((e: Error) => e);
    // Either the redirect comes back as it is, or it fails: it is never followed.
    if (r instanceof Error) expect(r.message).not.toContain('elsewhere');
    else expect(r.status).toBe(302);
    expect(seen).toHaveLength(1);
  });
});

describe('UpdateStore', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openArchive(':memory:');
  });
  afterEach(() => db.close());

  it('is on by default and holds nothing yet', () => {
    const s = new UpdateStore(db, { version: '0.2.1', env: {} });
    expect(s.enabled()).toBe(true);
    expect(s.offByEnv).toBe(false);
    expect(s.userEnabled()).toBe(true);
    expect(s.stored()).toEqual({ latest: null, checkedAt: null, attemptedAt: null });
    expect(s.info()).toBeNull();
  });

  it('reports a newer version with the time of the check, and nothing for the same or an older one', () => {
    const s = new UpdateStore(db, { version: '0.2.1', env: {} });
    s.recordSuccess('0.3.0', iso(T0));
    expect(s.info()).toEqual({ current: '0.2.1', latest: '0.3.0', checkedAt: iso(T0) });
    expect(s.stored()).toEqual({ latest: '0.3.0', checkedAt: iso(T0), attemptedAt: iso(T0) });
    s.recordSuccess('0.2.1', iso(T0 + 1));
    expect(s.info()).toBeNull();
    s.recordSuccess('0.2.0', iso(T0 + 2));
    expect(s.info()).toBeNull();
    // A newer lurkd's archive read by an older one: its own version decides.
    expect(new UpdateStore(db, { version: '0.1.0', env: {} }).info()).toEqual({ current: '0.1.0', latest: '0.2.0', checkedAt: iso(T0 + 2) });
  });

  it('keeps the last good answer when an attempt fails', () => {
    const s = new UpdateStore(db, { version: '0.2.1', env: {} });
    s.recordSuccess('0.3.0', iso(T0));
    s.recordAttempt(iso(T0 + 5));
    expect(s.stored()).toEqual({ latest: '0.3.0', checkedAt: iso(T0), attemptedAt: iso(T0 + 5) });
  });

  it('ignores a stored value that is not a stable version', () => {
    setSetting(db, 'update_check_latest', '9.9.9-x');
    setSetting(db, 'update_check_checked_at', 'a');
    expect(new UpdateStore(db, { version: '0.2.1', env: {} }).info()).toBeNull();
  });

  it('is off with LURKD_NO_UPDATE_CHECK=1, and then reports nothing', () => {
    const s = new UpdateStore(db, { version: '0.2.1', env: { LURKD_NO_UPDATE_CHECK: '1' } });
    s.recordSuccess('0.3.0', iso(T0));
    expect(s.offByEnv).toBe(true);
    expect(s.enabled()).toBe(false);
    expect(s.info()).toBeNull();
    // Only the value 1 turns it off.
    expect(new UpdateStore(db, { version: '0.2.1', env: { LURKD_NO_UPDATE_CHECK: '0' } }).enabled()).toBe(true);
  });

  it('is off when the page setting is off, and on again when it is switched back', () => {
    const s = new UpdateStore(db, { version: '0.2.1', env: {} });
    s.recordSuccess('0.3.0', iso(T0));
    s.setUserEnabled(false);
    expect(s.userEnabled()).toBe(false);
    expect(s.enabled()).toBe(false);
    expect(s.info()).toBeNull();
    s.setUserEnabled(true);
    expect(s.enabled()).toBe(true);
    expect(s.info()).not.toBeNull();
    // Any stored value other than "off" reads as on.
    setSetting(db, 'update_check', 'weird');
    expect(s.userEnabled()).toBe(true);
  });
});

describe('UpdateChecker', () => {
  let db: Database.Database;
  let now: number;
  let store: UpdateStore;
  let lines: string[];
  beforeEach(() => {
    db = openArchive(':memory:');
    now = T0;
    store = new UpdateStore(db, { version: '0.2.1', env: {} });
    lines = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  const checker = (fetchLatest: () => Promise<string>) => new UpdateChecker({ store, fetchLatest, now: () => now, log: (l) => lines.push(l) });

  it('checks at most once per 24 hours', async () => {
    const fetchLatest = vi.fn(async () => '0.3.0');
    const c = checker(fetchLatest);
    expect(await c.maybeCheck()).toBe('checked');
    expect(store.info()).toEqual({ current: '0.2.1', latest: '0.3.0', checkedAt: iso(T0) });
    now = T0 + CHECK_INTERVAL_MS - 1;
    expect(await c.maybeCheck()).toBe('skipped');
    now = T0 + CHECK_INTERVAL_MS;
    expect(await c.maybeCheck()).toBe('checked');
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(CHECK_INTERVAL_MS).toBe(24 * 3600_000);
  });

  it('counts a check stored by an earlier server run', async () => {
    store.recordSuccess('0.3.0', iso(T0 - 3600_000));
    const fetchLatest = vi.fn(async () => '0.3.0');
    expect(await checker(fetchLatest).maybeCheck()).toBe('skipped');
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it('makes no request when off, by the environment or by the page setting', async () => {
    const fetchLatest = vi.fn(async () => '0.3.0');
    store.setUserEnabled(false);
    expect(await checker(fetchLatest).maybeCheck()).toBe('skipped');
    const offEnv = new UpdateStore(db, { version: '0.2.1', env: { LURKD_NO_UPDATE_CHECK: '1' } });
    expect(await new UpdateChecker({ store: offEnv, fetchLatest, now: () => now, log: () => {} }).maybeCheck()).toBe('skipped');
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it('is silent on errors, logs once, and tries again at the next interval', async () => {
    const fetchLatest = vi.fn(async (): Promise<string> => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    });
    const c = checker(fetchLatest);
    expect(await c.maybeCheck()).toBe('failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('update check failed');
    expect(store.info()).toBeNull();
    // Not again within the interval.
    now = T0 + 3600_000;
    expect(await c.maybeCheck()).toBe('skipped');
    now = T0 + CHECK_INTERVAL_MS;
    expect(await c.maybeCheck()).toBe('failed');
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    // Logged once only.
    expect(lines).toHaveLength(1);
    // A success, then a new failure, logs again.
    fetchLatest.mockImplementationOnce(async () => '0.3.0');
    now += CHECK_INTERVAL_MS;
    expect(await c.maybeCheck()).toBe('checked');
    now += CHECK_INTERVAL_MS;
    expect(await c.maybeCheck()).toBe('failed');
    expect(lines).toHaveLength(2);
  });

  it('runs one check at a time', async () => {
    let release!: (v: string) => void;
    const fetchLatest = vi.fn(() => new Promise<string>((r) => (release = r)));
    const c = checker(fetchLatest);
    const first = c.maybeCheck();
    expect(await c.maybeCheck()).toBe('skipped');
    release('0.3.0');
    expect(await first).toBe('checked');
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('checks shortly after start when the last check is older than 24 hours, then once a day', async () => {
    vi.useFakeTimers({ now: T0 });
    now = T0;
    const fetchLatest = vi.fn(async () => '0.3.0');
    const c = new UpdateChecker({ store, fetchLatest, now: () => Date.now(), log: () => {} });
    c.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(fetchLatest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    c.stop();
    await vi.advanceTimersByTimeAsync(3 * CHECK_INTERVAL_MS);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it('does not check at start when the last check is recent', async () => {
    vi.useFakeTimers({ now: T0 });
    store.recordSuccess('0.3.0', iso(T0 - 3600_000));
    const fetchLatest = vi.fn(async () => '0.3.0');
    const c = new UpdateChecker({ store, fetchLatest, now: () => Date.now(), log: () => {} });
    c.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 1000);
    expect(fetchLatest).not.toHaveBeenCalled();
    c.stop();
  });

  it('checks soon after the page switches the setting back on (nudge)', async () => {
    vi.useFakeTimers({ now: T0 });
    store.setUserEnabled(false);
    const fetchLatest = vi.fn(async () => '0.3.0');
    const c = new UpdateChecker({ store, fetchLatest, now: () => Date.now(), log: () => {} });
    c.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 1000);
    expect(fetchLatest).not.toHaveBeenCalled();
    store.setUserEnabled(true);
    c.nudge();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    c.stop();
  });
});

describe('update check storage', () => {
  it('keeps its data in the settings table, with no table of its own and no schema step', () => {
    const db = openArchive(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    const s = new UpdateStore(db, { version: '0.2.1', env: {} });
    s.recordSuccess('0.3.0', 'a');
    s.recordAttempt('b');
    expect(db.prepare("SELECT key, value FROM settings WHERE key LIKE 'update_check%' ORDER BY key").all()).toEqual([
      { key: 'update_check_attempted_at', value: 'b' },
      { key: 'update_check_checked_at', value: 'a' },
      { key: 'update_check_latest', value: '0.3.0' },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'update_check'").pluck().get()).toBeUndefined();
    db.close();
  });
});
