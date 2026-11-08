import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSalt, getSetting, openArchive, setSetting } from '../../src/archive/db.js';
import { StateStore } from '../../src/archive/state.js';

const HOUR = 3600_000;
const T0 = Date.parse('2026-11-08T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('openArchive', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-db-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('creates schema version 1 with FTS5', () => {
    const db = openArchive(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(() => db.prepare("INSERT INTO posts_fts(rowid, title, body) VALUES (1, 'a', 'b')").run()).not.toThrow();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('reopens an existing file without migrating twice and keeps it at 0600', () => {
    const file = path.join(tmp, 'archive.db');
    const a = openArchive(file);
    expect(a.pragma('journal_mode', { simple: true })).toBe('wal');
    setSetting(a, 'marker', 'kept');
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    a.close();
    fs.chmodSync(file, 0o644);
    const b = openArchive(file);
    expect(b.pragma('user_version', { simple: true })).toBe(1);
    expect(getSetting(b, 'marker')).toBe('kept');
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    b.close();
  });

  it('creates the WAL sidecar with the same 0600 mode', () => {
    const file = path.join(tmp, 'archive.db');
    const db = openArchive(file);
    setSetting(db, 'k', 'v');
    expect(fs.existsSync(`${file}-wal`)).toBe(true);
    expect((fs.statSync(`${file}-wal`).mode & 0o777).toString(8)).toBe('600');
    db.close();
  });

  it('refuses an archive written by a newer schema version', () => {
    const file = path.join(tmp, 'archive.db');
    const raw = new Database(file);
    raw.pragma('user_version = 2');
    raw.close();
    expect(() => openArchive(file)).toThrow(/schema version 2/);
  });

  it('cascades post deletion from threads', () => {
    const db = openArchive(':memory:');
    db.prepare(
      `INSERT INTO threads (id, source_id, url, title, engine, extraction, quality, fetched_at)
       VALUES (1, 's', 'https://forum.example/t/1', 'T', 'discourse', 'engine', 'full', ?)`,
    ).run(iso(T0));
    db.prepare(
      `INSERT INTO posts (thread_id, number, author, signals, notes, body_md) VALUES (1, 1, 'author-0123456789', '[]', '[]', 'hi')`,
    ).run();
    db.prepare('DELETE FROM threads WHERE id = 1').run();
    expect(db.prepare('SELECT count(*) AS n FROM posts').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('settings', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openArchive(':memory:');
  });
  afterEach(() => db.close());

  it('creates one salt and keeps it', () => {
    const a = getSalt(db);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(getSalt(db)).toBe(a);
    expect(getSetting(db, 'pseudonym_salt')).toBe(a);
  });

  it('gives each archive its own salt', () => {
    const other = openArchive(':memory:');
    expect(getSalt(other)).not.toBe(getSalt(db));
    other.close();
  });

  it('returns null for a missing key, overwrites, and deletes on null', () => {
    expect(getSetting(db, 'k')).toBeNull();
    setSetting(db, 'k', 'one');
    setSetting(db, 'k', 'two');
    expect(getSetting(db, 'k')).toBe('two');
    setSetting(db, 'k', null);
    expect(getSetting(db, 'k')).toBeNull();
    expect(db.prepare("SELECT count(*) AS n FROM settings WHERE key = 'k'").get()).toEqual({ n: 0 });
    expect(() => setSetting(db, 'absent', null)).not.toThrow();
  });
});

describe('StateStore', () => {
  let db: Database.Database;
  let st: StateStore;
  beforeEach(() => {
    db = openArchive(':memory:');
    st = new StateStore(db);
  });
  afterEach(() => db.close());

  it('reports never for an unknown session', () =>
    expect(st.getSession('x')).toEqual({
      sourceId: 'x',
      state: 'never',
      lastLoginAt: null,
      lastCheckAt: null,
      lastBlockUrl: null,
      lastBlockKind: null,
    }));

  it('rejects an unknown session state', () => expect(() => st.setSession('x', { state: 'bogus' as never })).toThrow());

  it('merges session patches and clears fields set to null', () => {
    st.setSession('s', { state: 'logged_in', lastLoginAt: iso(T0) });
    st.setSession('s', { lastCheckAt: iso(T0 + HOUR) });
    expect(st.getSession('s')).toEqual({
      sourceId: 's',
      state: 'logged_in',
      lastLoginAt: iso(T0),
      lastCheckAt: iso(T0 + HOUR),
      lastBlockUrl: null,
      lastBlockKind: null,
    });
    st.setSession('s', { state: 'expired', lastBlockUrl: 'https://forum.example/login', lastBlockKind: 'login' });
    st.setSession('s', { lastBlockUrl: null, lastBlockKind: null });
    expect(st.getSession('s')).toMatchObject({ state: 'expired', lastLoginAt: iso(T0), lastBlockKind: null, lastBlockUrl: null });
    expect(st.getSession('other').state).toBe('never');
  });

  it('counts only tool requests in the window', () => {
    for (const kind of ['navigate', 'fetch', 'form', 'blocked', 'detection'] as const)
      st.logFetch({ sourceId: 's', jobId: 'j1', url: 'https://forum.example/t/1', method: 'GET', kind, status: 200 }, iso(T0));
    st.logFetch({ sourceId: 's', jobId: 'j0', url: 'https://forum.example/t/0', method: 'GET', kind: 'navigate', status: 200 }, iso(T0 - 25 * HOUR));
    st.logFetch({ sourceId: 'other', jobId: 'j2', url: 'https://other.example/', method: 'GET', kind: 'navigate', status: 200 }, iso(T0));
    const since24h = iso(T0 - 24 * HOUR);
    expect(st.countRequests('s', since24h)).toBe(3);
  });

  it('counts blocked requests, blocked beacons and challenges for D35', () => {
    const at = iso(T0);
    const base = { sourceId: 's', jobId: null, url: 'https://forum.example/x', method: 'GET', status: null };
    st.logFetch({ ...base, kind: 'blocked' }, at);
    st.logFetch({ ...base, kind: 'blocked', note: 'beacon:cloudflare-challenge-platform' }, at);
    st.logFetch({ ...base, kind: 'detection', note: 'challenge' }, at);
    st.logFetch({ ...base, kind: 'detection', note: 'login' }, at);
    st.logFetch({ ...base, kind: 'detection', note: 'challenge' }, iso(T0 - 8 * 24 * HOUR));
    st.logFetch({ ...base, sourceId: 'other', kind: 'blocked' }, at);
    const since7d = iso(T0 - 7 * 24 * HOUR);
    expect(st.recentCounts('s', since7d)).toEqual({ blocked: 2, beaconsBlocked: 1, challenges: 1 });
  });

  it('stamps log entries with the current time by default and rejects unknown kinds', () => {
    const before = new Date().toISOString();
    st.logFetch({ sourceId: null, jobId: null, url: 'https://forum.example/', method: 'HEAD', kind: 'navigate', status: 204 });
    const row = db.prepare('SELECT * FROM fetch_log').get() as { at: string; note: string | null; source_id: string | null };
    expect(row.at >= before).toBe(true);
    expect(row.note).toBeNull();
    expect(row.source_id).toBeNull();
    expect(() =>
      st.logFetch({ sourceId: 's', jobId: null, url: 'https://forum.example/', method: 'GET', kind: 'bogus' as never, status: null }),
    ).toThrow();
  });

  it('round-trips overrides with nulls for unset fields', () => {
    const unset = { enabled: null, acknowledgedAt: null, acknowledgedPolicy: null, showRealNames: null, allowBeacons: null };
    expect(st.getOverride('s')).toEqual(unset);
    st.setOverride('s', { enabled: true });
    expect(st.getOverride('s')).toEqual({ ...unset, enabled: true });
    st.setOverride('s', { acknowledgedAt: iso(T0), acknowledgedPolicy: 'unknown', showRealNames: false, allowBeacons: true });
    expect(st.getOverride('s')).toEqual({ enabled: true, acknowledgedAt: iso(T0), acknowledgedPolicy: 'unknown', showRealNames: false, allowBeacons: true });
    st.setOverride('s', { enabled: null });
    expect(st.getOverride('s').enabled).toBeNull();
    expect(st.getOverride('s').allowBeacons).toBe(true);
    expect(st.getOverride('s').acknowledgedPolicy).toBe('unknown');
    st.setOverride('s', { acknowledgedPolicy: 'forbidden' });
    expect(st.getOverride('s').acknowledgedPolicy).toBe('forbidden');
    st.setOverride('s', { acknowledgedPolicy: null });
    expect(st.getOverride('s').acknowledgedPolicy).toBeNull();
    expect(st.getOverride('s').acknowledgedAt).toBe(iso(T0));
  });

  it('stores only a known policy as the acknowledged policy', () => {
    expect(() => st.setOverride('s', { acknowledgedPolicy: 'bogus' as never })).toThrow();
    expect(db.prepare('SELECT acknowledged_policy FROM source_state').all()).toEqual([]);
  });
});
