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

  it('creates schema version 6 with FTS5', () => {
    const db = openArchive(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(6);
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
    expect(b.pragma('user_version', { simple: true })).toBe(6);
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
    raw.pragma('user_version = 7');
    raw.close();
    expect(() => openArchive(file)).toThrow('archive schema version 7 is newer than this lurkd supports (6)');
  });

  const forbiddenRow = (db: Database.Database) =>
    db
      .prepare(
        "INSERT INTO forbidden_log (host, name, engine, base_url, login_url, signup_url, search_url, rule_url, sentence, found_at) VALUES ('a.example', 'A', 'discourse', 'https://a.example', NULL, NULL, NULL, 'https://a.example/tos', 'You may not use bots.', 'x')",
      )
      .run();

  // The threads table as schema version 1 created it.
  const V1_THREADS = `CREATE TABLE threads (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    engine TEXT NOT NULL, pages INTEGER, posts_expected INTEGER, extraction TEXT NOT NULL,
    quality TEXT NOT NULL CHECK (quality IN ('full','low')), fetched_at TEXT NOT NULL);`;

  it('upgrades a version 1 archive to version 6 and keeps its rows (D45 add requests, D49 forbidden log, D50 import provenance)', () => {
    const file = path.join(tmp, 'archive.db');
    const raw = new Database(file);
    raw.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('marker', 'kept');");
    raw.exec(V1_THREADS);
    raw.pragma('user_version = 1');
    raw.close();
    const db = openArchive(file);
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    expect(getSetting(db, 'marker')).toBe('kept');
    expect(() => db.prepare("INSERT INTO add_requests (host, url, requested_at) VALUES ('a.example', 'https://a.example/', 'x')").run()).not.toThrow();
    expect(() => forbiddenRow(db)).not.toThrow();
    db.close();
  });

  it('upgrades a version 3 archive in place to version 6, keeping its threads without provenance (D50)', () => {
    const file = path.join(tmp, 'archive.db');
    const v3 = openArchive(file);
    // Back to what a version 3 lurkd left on disk.
    v3.exec('DROP TABLE custom_group_members; DROP TABLE custom_groups; ALTER TABLE threads DROP COLUMN imported_via; ALTER TABLE threads DROP COLUMN replaced_import_at;');
    v3.pragma('user_version = 3');
    v3.prepare(
      "INSERT INTO threads (source_id, url, title, engine, extraction, quality, fetched_at) VALUES ('reddit-import', 'https://www.reddit.com/comments/abc/', 'T', 'import', 'x', 'full', 'y')",
    ).run();
    v3.close();
    const db = openArchive(file);
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    expect(db.prepare('SELECT title, imported_via, replaced_import_at FROM threads').all()).toEqual([{ title: 'T', imported_via: null, replaced_import_at: null }]);
    expect(() => db.prepare("UPDATE threads SET imported_via = 'mail'").run()).toThrow();
    db.close();
  });

  it('upgrades a version 2 archive in place to version 6, once (D49)', () => {
    const file = path.join(tmp, 'archive.db');
    const v2 = openArchive(file);
    // Back to what a version 2 lurkd left on disk.
    v2.exec('DROP TABLE custom_group_members; DROP TABLE custom_groups; DROP TABLE forbidden_log; ALTER TABLE threads DROP COLUMN imported_via; ALTER TABLE threads DROP COLUMN replaced_import_at;');
    v2.pragma('user_version = 2');
    v2.prepare("INSERT INTO add_requests (host, url, requested_at) VALUES ('a.example', 'https://a.example/', 'x')").run();
    v2.close();
    const db = openArchive(file);
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    expect(db.prepare('SELECT host FROM add_requests').all()).toEqual([{ host: 'a.example' }]);
    forbiddenRow(db);
    db.close();
    // Opening again migrates nothing and keeps the row.
    const again = openArchive(file);
    expect(again.pragma('user_version', { simple: true })).toBe(6);
    expect(again.prepare('SELECT host, sentence FROM forbidden_log').all()).toEqual([{ host: 'a.example', sentence: 'You may not use bots.' }]);
    again.close();
  });

  const groupRow = (db: Database.Database) => {
    const g = db.prepare("INSERT INTO custom_groups (name, created_at) VALUES ('Home', 'x')").run();
    db.prepare("INSERT INTO custom_group_members (group_id, source_id, added_at) VALUES (?, 'lg', 'x')").run(g.lastInsertRowid);
  };

  it('upgrades a version 4 archive in place to version 6 with the custom groups tables (D51), once', () => {
    const file = path.join(tmp, 'archive.db');
    const v4 = openArchive(file);
    // Back to what a version 4 lurkd left on disk.
    v4.exec('DROP TABLE custom_group_members; DROP TABLE custom_groups;');
    v4.pragma('user_version = 4');
    v4.prepare("INSERT INTO add_requests (host, url, requested_at) VALUES ('a.example', 'https://a.example/', 'x')").run();
    v4.close();
    const db = openArchive(file);
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    expect(db.prepare('SELECT host FROM add_requests').all()).toEqual([{ host: 'a.example' }]);
    groupRow(db);
    db.close();
    const again = openArchive(file);
    expect(again.pragma('user_version', { simple: true })).toBe(6);
    expect(again.prepare('SELECT g.name, m.source_id FROM custom_groups g JOIN custom_group_members m ON m.group_id = g.id').all()).toEqual([{ name: 'Home', source_id: 'lg' }]);
    again.close();
  });

  /** What a lurkd of schema version `to` left on disk: a current archive with the later steps taken out again. */
  const downgrade = (db: Database.Database, to: number) => {
    if (to < 6) db.exec('DROP INDEX threads_source_fetched;');
    if (to < 5) db.exec('DROP TABLE custom_group_members; DROP TABLE custom_groups;');
    if (to < 4) db.exec('ALTER TABLE threads DROP COLUMN imported_via; ALTER TABLE threads DROP COLUMN replaced_import_at;');
    if (to < 3) db.exec('DROP TABLE forbidden_log;');
    if (to < 2) db.exec('DROP TABLE add_requests;');
    db.pragma(`user_version = ${to}`);
  };

  it('upgrades every earlier version to version 6 in place, keeping its rows, and opens it again without a second step', () => {
    for (const from of [1, 2, 3, 4, 5]) {
      const file = path.join(tmp, `v${from}.db`);
      const old = openArchive(file);
      downgrade(old, from);
      setSetting(old, 'marker', `from ${from}`);
      old.close();
      const db = openArchive(file);
      expect([from, db.pragma('user_version', { simple: true })]).toEqual([from, 6]);
      expect(indexes(db)).toContain('threads_source_fetched');
      expect(getSetting(db, 'marker')).toBe(`from ${from}`);
      groupRow(db);
      forbiddenRow(db);
      db.close();
      const again = openArchive(file);
      expect(again.prepare('SELECT count(*) AS n FROM custom_groups').get()).toEqual({ n: 1 });
      again.close();
    }
    // A brand-new file (version 0) gets every table at once.
    const fresh = openArchive(path.join(tmp, 'v0.db'));
    groupRow(fresh);
    fresh.close();
  });

  const indexes = (db: Database.Database) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'threads'").pluck().all() as string[];
  const thread = (db: Database.Database, source: string, at: string) =>
    db
      .prepare("INSERT INTO threads (source_id, url, title, engine, extraction, quality, fetched_at) VALUES (?, ?, 'T', 'discourse', 'x', 'full', ?)")
      .run(source, `https://${source}.example/t/${at}`, at);

  // A8 L7: the page asks for the latest thread of every source on each poll.
  it('upgrades a version 5 archive in place to version 6 with an index for the latest thread per source, keeping its threads', () => {
    const file = path.join(tmp, 'v5.db');
    const v5 = openArchive(file);
    v5.exec('DROP INDEX threads_source_fetched;');
    v5.pragma('user_version = 5');
    thread(v5, 'lg', '2026-11-01T00:00:00.000Z');
    thread(v5, 'lg', '2026-11-03T00:00:00.000Z');
    thread(v5, 'nl', '2026-11-02T00:00:00.000Z');
    v5.close();
    const db = openArchive(file);
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    expect(indexes(db)).toContain('threads_source_fetched');
    expect(db.prepare('SELECT source_id, max(fetched_at) AS at FROM threads GROUP BY source_id ORDER BY source_id').all()).toEqual([
      { source_id: 'lg', at: '2026-11-03T00:00:00.000Z' },
      { source_id: 'nl', at: '2026-11-02T00:00:00.000Z' },
    ]);
    db.close();
    // Opening again changes nothing; a version 5 file that holds the index already finishes too.
    const again = openArchive(file);
    expect(indexes(again).filter((n) => n === 'threads_source_fetched')).toHaveLength(1);
    again.pragma('user_version = 5');
    again.close();
    const half = openArchive(file);
    expect(half.pragma('user_version', { simple: true })).toBe(6);
    expect(half.prepare('SELECT count(*) AS n FROM threads').get()).toEqual({ n: 3 });
    half.close();
  });

  it('answers the latest thread per source from the index, without reading the table or sorting', () => {
    const db = openArchive(':memory:');
    for (let i = 0; i < 50; i++) thread(db, `s${i % 7}`, new Date(T0 + i * HOUR).toISOString());
    db.exec('ANALYZE');
    const plan = (db.prepare('EXPLAIN QUERY PLAN SELECT source_id, max(fetched_at) AS at FROM threads GROUP BY source_id').all() as { detail: string }[]).map((r) => r.detail);
    expect(plan.join('\n')).toMatch(/COVERING INDEX threads_source_fetched/);
    expect(plan.join('\n')).not.toMatch(/TEMP B-TREE/);
    db.close();
  });

  it('finishes a version 4 file whose group tables exist already, as after a step stopped half way', () => {
    const file = path.join(tmp, 'half.db');
    const half = openArchive(file);
    half.pragma('user_version = 4');
    groupRow(half);
    half.close();
    const db = openArchive(file);
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    expect(db.prepare('SELECT name FROM custom_groups').all()).toEqual([{ name: 'Home' }]);
    db.close();
  });

  it('refuses a newer archive with a message that names both versions, and leaves the file as it was', () => {
    const file = path.join(tmp, 'archive.db');
    const db = openArchive(file);
    groupRow(db);
    db.pragma('user_version = 9');
    db.close();
    expect(() => openArchive(file)).toThrow('archive schema version 9 is newer than this lurkd supports (6)');
    const raw = new Database(file);
    expect(raw.pragma('user_version', { simple: true })).toBe(9);
    expect(raw.prepare('SELECT name FROM custom_groups').all()).toEqual([{ name: 'Home' }]);
    raw.close();
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
