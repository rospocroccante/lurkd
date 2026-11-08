import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { LurkdError } from '../errors.js';

const SCHEMA_VERSION = 1;

// Schema version 1. `signals` and `notes` hold JSON arrays; `posts.page` stays null on Discourse (D32);
// `fetch_log.note` holds `beacon:<name>` for blocked beacons and `login` or `challenge` for detections.
const SCHEMA_V1 = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sessions (source_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('logged_in','expired','never')),
  last_login_at TEXT, last_check_at TEXT, last_block_url TEXT,
  last_block_kind TEXT CHECK (last_block_kind IN ('login','challenge')));
CREATE TABLE source_state (source_id TEXT PRIMARY KEY, enabled INTEGER, acknowledged_at TEXT,
  acknowledged_policy TEXT CHECK (acknowledged_policy IN ('allowed','forbidden','unknown')),
  show_real_names INTEGER, allow_beacons INTEGER);
CREATE TABLE threads (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  engine TEXT NOT NULL, pages INTEGER, posts_expected INTEGER, extraction TEXT NOT NULL,
  quality TEXT NOT NULL CHECK (quality IN ('full','low')), fetched_at TEXT NOT NULL);
CREATE TABLE posts (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  number INTEGER NOT NULL, page INTEGER, author TEXT NOT NULL, author_url TEXT, signals TEXT NOT NULL,
  notes TEXT NOT NULL, posted_at TEXT, body_md TEXT NOT NULL, UNIQUE (thread_id, number));
CREATE VIRTUAL TABLE posts_fts USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE authors (source_id TEXT NOT NULL, pseudonym TEXT NOT NULL, username TEXT NOT NULL, profile_url TEXT,
  signals TEXT, signals_fetched_at TEXT, PRIMARY KEY (source_id, pseudonym));
CREATE TABLE fetch_log (id INTEGER PRIMARY KEY, source_id TEXT, job_id TEXT, url TEXT NOT NULL, method TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('navigate','fetch','form','blocked','beacon_allowed','detection')),
  status INTEGER, note TEXT, at TEXT NOT NULL);
CREATE INDEX fetch_log_source_at ON fetch_log (source_id, at);
CREATE TABLE drafts (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, host TEXT NOT NULL, yaml TEXT NOT NULL,
  warnings TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','approved','rejected')), created_at TEXT NOT NULL);
CREATE TABLE samples (host TEXT PRIMARY KEY, url TEXT NOT NULL, structure TEXT, requested_at TEXT NOT NULL, sampled_at TEXT);
`;

function isOnDisk(file: string): boolean {
  return file !== ':memory:' && file !== '' && !file.startsWith('file:');
}

/**
 * Opens (and on first use creates) the archive. A file on disk is created at 0600 before SQLite
 * touches it, so the WAL and shared-memory files SQLite derives from it get the same mode, and
 * it is forced back to 0600 on every open.
 */
export function openArchive(file: string): Database.Database {
  const onDisk = isOnDisk(file);
  if (onDisk) fs.closeSync(fs.openSync(file, 'a', 0o600));
  const db = new Database(file);
  try {
    if (onDisk) fs.chmodSync(file, 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

function migrate(db: Database.Database): void {
  db.transaction(() => {
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version === SCHEMA_VERSION) return;
    if (version !== 0) {
      throw new LurkdError('internal', `archive schema version ${version} is newer than this lurkd supports (${SCHEMA_VERSION})`);
    }
    db.exec(SCHEMA_V1);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }).immediate();
}

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

/** Stores `value` under `key`; null deletes the row. */
export function setSetting(db: Database.Database, key: string, value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

/** The per-install pseudonym salt: 32 random bytes in hex, created on first call and never changed. */
export function getSalt(db: Database.Database): string {
  return db
    .transaction(() => {
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('pseudonym_salt', ?)").run(
        crypto.randomBytes(32).toString('hex'),
      );
      return getSetting(db, 'pseudonym_salt') as string;
    })
    .immediate();
}
