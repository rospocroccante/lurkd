import type Database from 'better-sqlite3';
import { LurkdError } from '../errors.js';
import { namesIn, pseudonym, renderNames, stripMarkers } from '../pseudonym.js';
import type { AuthorSignals, Engine, ExtractedPost, ExtractedThread } from '../types.js';

export interface StoredThread {
  id: number;
  sourceId: string;
  url: string;
  title: string;
  engine: Engine;
  pages: number | null;
  postsExpected: number | null;
  extraction: string;
  quality: 'full' | 'low';
  fetchedAt: string;
}

/** One matching post. `author` is the real username and `bodyMd` keeps the name markers. */
export interface ArchiveHit {
  sourceId: string;
  threadId: number;
  threadUrl: string;
  threadTitle: string;
  postNumber: number;
  author: string;
  postedAt: string | null;
  bodyMd: string;
  // The author signals stored with the post (C6).
  signals: string[];
}

export interface AuthorRecord {
  username: string;
  profileUrl: string | null;
  signals: AuthorSignals | null;
  signalsFetchedAt: string | null;
}

interface ThreadRow {
  id: number;
  source_id: string;
  url: string;
  title: string;
  engine: Engine;
  pages: number | null;
  posts_expected: number | null;
  extraction: string;
  quality: 'full' | 'low';
  fetched_at: string;
}

interface PostRow {
  number: number;
  page: number | null;
  author: string;
  author_url: string | null;
  signals: string;
  notes: string;
  posted_at: string | null;
  body_md: string;
}

interface HitRow {
  source_id: string;
  thread_id: number;
  url: string;
  title: string;
  number: number;
  author: string;
  posted_at: string | null;
  body_md: string;
  signals: string;
}

const MAX_LIMIT = 50;
// Used when the limit is not a finite number (NaN, Infinity).
const DEFAULT_LIMIT = 10;
const DAY_MS = 86_400_000;
// unicode61 token characters: letters, numbers and private-use characters. A token without
// any of these yields no FTS5 terms, so it is dropped rather than sent as an empty phrase.
const TOKEN_CHAR = /[\p{L}\p{N}\p{Co}]/u;

function toIso(at: string | undefined, what = 'timestamp'): string {
  const d = at === undefined ? new Date() : new Date(at);
  if (Number.isNaN(d.getTime())) throw new LurkdError('invalid_request', `invalid ${what}: ${JSON.stringify(at)}`);
  return d.toISOString();
}
// What the FTS index sees: marked names removed entirely, so no search matches a username.
const indexText = (text: string): string => renderNames(text, () => '');

/**
 * Turns user input into an FTS5 query that cannot carry FTS5 syntax: each whitespace-separated
 * token becomes a quoted string (inner double quotes doubled), so operators, column filters,
 * prefixes, NEAR and parentheses are plain text; tokens are ANDed. Null when nothing searchable
 * remains, in which case the caller must not query.
 */
export function toFtsQuery(input: string): string | null {
  // Markers are stripped because the index holds no marked names, so a marker in a query only adds noise.
  // NUL separates tokens: FTS5 reads the MATCH string as a C string and would see an unterminated quote.
  const tokens = stripMarkers(input)
    .split(/[\s\u0000]+/u)
    .filter((t) => TOKEN_CHAR.test(t))
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return tokens.length > 0 ? tokens.join(' ') : null;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function toThread(r: ThreadRow): StoredThread {
  return {
    id: r.id,
    sourceId: r.source_id,
    url: r.url,
    title: r.title,
    engine: r.engine,
    pages: r.pages,
    postsExpected: r.posts_expected,
    extraction: r.extraction,
    quality: r.quality,
    fetchedAt: r.fetched_at,
  };
}

function toPost(r: PostRow): ExtractedPost {
  return {
    number: r.number,
    page: r.page,
    author: r.author,
    authorUrl: r.author_url,
    signals: JSON.parse(r.signals) as string[],
    notes: JSON.parse(r.notes) as string[],
    postedAt: r.posted_at,
    bodyMd: r.body_md,
  };
}

/** Threads, posts, their FTS rows and the pseudonym-to-author map, in the archive database. */
export class ThreadStore {
  constructor(
    private readonly db: Database.Database,
    private readonly salt: string,
  ) {}

  /**
   * Stores a thread, replacing the posts (and their FTS rows) of an earlier fetch of the same URL.
   * Returns the thread id, which stays the same across re-fetches.
   */
  save(sourceId: string, t: ExtractedThread, fetchedAt?: string): number {
    const at = toIso(fetchedAt, 'fetchedAt');
    const db = this.db;
    return db
      .transaction((): number => {
        const { id } = db
          .prepare(
            `INSERT INTO threads (source_id, url, title, engine, pages, posts_expected, extraction, quality, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (url) DO UPDATE SET source_id = excluded.source_id, title = excluded.title,
               engine = excluded.engine, pages = excluded.pages, posts_expected = excluded.posts_expected,
               extraction = excluded.extraction, quality = excluded.quality, fetched_at = excluded.fetched_at
             RETURNING id`,
          )
          .get(sourceId, t.url, t.title, t.engine, t.pages, t.postsExpected, t.extraction, t.quality, at) as { id: number };

        db.prepare('DELETE FROM posts_fts WHERE rowid IN (SELECT id FROM posts WHERE thread_id = ?)').run(id);
        db.prepare('DELETE FROM posts WHERE thread_id = ?').run(id);

        const insertPost = db.prepare(
          `INSERT INTO posts (thread_id, number, page, author, author_url, signals, notes, posted_at, body_md)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const insertFts = db.prepare('INSERT OR REPLACE INTO posts_fts (rowid, title, body) VALUES (?, ?, ?)');
        const title = indexText(t.title);
        for (const p of t.posts) {
          const { lastInsertRowid } = insertPost.run(
            id,
            p.number,
            p.page,
            p.author,
            p.authorUrl,
            JSON.stringify(p.signals),
            JSON.stringify(p.notes),
            p.postedAt,
            p.bodyMd,
          );
          insertFts.run(lastInsertRowid, title, indexText(p.bodyMd));
        }

        const upsertAuthor = db.prepare(
          `INSERT INTO authors (source_id, pseudonym, username, profile_url) VALUES (?, ?, ?, ?)
           ON CONFLICT (source_id, pseudonym) DO UPDATE SET profile_url = coalesce(excluded.profile_url, authors.profile_url)`,
        );
        const remember = (username: string, profileUrl: string | null) => {
          const name = stripMarkers(username).trim();
          if (name) upsertAuthor.run(sourceId, pseudonym(sourceId, name, this.salt), name, profileUrl);
        };
        for (const p of t.posts) {
          remember(p.author, p.authorUrl);
          for (const name of namesIn(p.bodyMd)) remember(name, null);
        }
        return id;
      })
      .immediate();
  }

  getByUrl(url: string): { thread: StoredThread; posts: ExtractedPost[] } | null {
    return this.load(this.db.prepare('SELECT * FROM threads WHERE url = ?').get(url) as ThreadRow | undefined);
  }

  getById(id: number): { thread: StoredThread; posts: ExtractedPost[] } | null {
    return this.load(this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined);
  }

  private load(row: ThreadRow | undefined): { thread: StoredThread; posts: ExtractedPost[] } | null {
    if (!row) return null;
    const posts = this.db
      .prepare(
        `SELECT number, page, author, author_url, signals, notes, posted_at, body_md
         FROM posts WHERE thread_id = ? ORDER BY number`,
      )
      .all(row.id) as PostRow[];
    return { thread: toThread(row), posts: posts.map(toPost) };
  }

  /** Full-text search over titles and bodies; the limit is clamped to 1..50. */
  search(query: string, opts: { sourceId?: string; limit: number }): ArchiveHit[] {
    const match = toFtsQuery(query);
    if (match === null) return [];
    const params: unknown[] = [match];
    let sourceFilter = '';
    if (opts.sourceId !== undefined) {
      sourceFilter = 'AND threads.source_id = ?';
      params.push(opts.sourceId);
    }
    params.push(clampLimit(opts.limit));
    const rows = this.db
      .prepare(
        `SELECT threads.source_id, threads.id AS thread_id, threads.url, threads.title, posts.number, posts.author,
                posts.posted_at, posts.body_md, posts.signals
         FROM posts_fts
         JOIN posts ON posts.id = posts_fts.rowid
         JOIN threads ON threads.id = posts.thread_id
         WHERE posts_fts MATCH ? ${sourceFilter}
         ORDER BY bm25(posts_fts), threads.fetched_at DESC, posts.id
         LIMIT ?`,
      )
      .all(...params) as HitRow[];
    return rows.map((r) => ({
      sourceId: r.source_id,
      threadId: r.thread_id,
      threadUrl: r.url,
      threadTitle: r.title,
      postNumber: r.number,
      author: r.author,
      postedAt: r.posted_at,
      bodyMd: r.body_md,
      signals: JSON.parse(r.signals) as string[],
    }));
  }

  /** Deletes every thread, post, FTS row and author of a source; returns the number of threads deleted. */
  deleteSource(sourceId: string): number {
    const db = this.db;
    return db
      .transaction((): number => {
        db.prepare(
          `DELETE FROM posts_fts WHERE rowid IN
             (SELECT posts.id FROM posts JOIN threads ON threads.id = posts.thread_id WHERE threads.source_id = ?)`,
        ).run(sourceId);
        db.prepare('DELETE FROM posts WHERE thread_id IN (SELECT id FROM threads WHERE source_id = ?)').run(sourceId);
        const { changes } = db.prepare('DELETE FROM threads WHERE source_id = ?').run(sourceId);
        db.prepare('DELETE FROM authors WHERE source_id = ?').run(sourceId);
        return changes;
      })
      .immediate();
  }

  /**
   * Deletes threads fetched more than `days` days before `nowIso`, with their posts and FTS rows,
   * and the authors no remaining post of their source names. Null keeps everything. Returns the
   * number of threads deleted.
   */
  applyRetention(days: number | null, nowIso: string): number {
    if (days === null) return 0;
    if (!Number.isFinite(days) || days < 0) throw new LurkdError('invalid_request', `retention must be a non-negative number of days, got ${days}`);
    const cutoff = new Date(Date.parse(toIso(nowIso, 'nowIso')) - days * DAY_MS).toISOString();
    const db = this.db;
    return db
      .transaction((): number => {
        const expired = db.prepare('SELECT id, source_id FROM threads WHERE fetched_at < ?').all(cutoff) as {
          id: number;
          source_id: string;
        }[];
        if (expired.length === 0) return 0;
        const deleteFts = db.prepare('DELETE FROM posts_fts WHERE rowid IN (SELECT id FROM posts WHERE thread_id = ?)');
        const deletePosts = db.prepare('DELETE FROM posts WHERE thread_id = ?');
        const deleteThread = db.prepare('DELETE FROM threads WHERE id = ?');
        for (const { id } of expired) {
          deleteFts.run(id);
          deletePosts.run(id);
          deleteThread.run(id);
        }
        for (const sourceId of new Set(expired.map((e) => e.source_id))) this.pruneAuthors(sourceId);
        return expired.length;
      })
      .immediate();
  }

  // Deletes the authors of a source that no remaining post has as author or names in its body.
  private pruneAuthors(sourceId: string): void {
    const kept = new Set<string>();
    const keep = (username: string) => {
      const name = stripMarkers(username).trim();
      if (name) kept.add(pseudonym(sourceId, name, this.salt));
    };
    const posts = this.db
      .prepare('SELECT posts.author, posts.body_md FROM posts JOIN threads ON threads.id = posts.thread_id WHERE threads.source_id = ?')
      .iterate(sourceId) as IterableIterator<{ author: string; body_md: string }>;
    for (const p of posts) {
      keep(p.author);
      for (const name of namesIn(p.body_md)) keep(name);
    }
    const stored = this.db.prepare('SELECT pseudonym FROM authors WHERE source_id = ?').pluck().all(sourceId) as string[];
    const del = this.db.prepare('DELETE FROM authors WHERE source_id = ? AND pseudonym = ?');
    for (const p of stored) if (!kept.has(p)) del.run(sourceId, p);
  }

  lookupAuthor(sourceId: string, pseudonymId: string): AuthorRecord | null {
    const row = this.db
      .prepare('SELECT username, profile_url, signals, signals_fetched_at FROM authors WHERE source_id = ? AND pseudonym = ?')
      .get(sourceId, pseudonymId) as
      | { username: string; profile_url: string | null; signals: string | null; signals_fetched_at: string | null }
      | undefined;
    if (!row) return null;
    return {
      username: row.username,
      profileUrl: row.profile_url,
      signals: row.signals === null ? null : (JSON.parse(row.signals) as AuthorSignals),
      signalsFetchedAt: row.signals_fetched_at,
    };
  }

  /** Caches profile signals for a known author; `not_found` when the pseudonym has no author row. */
  saveAuthorSignals(sourceId: string, pseudonymId: string, s: AuthorSignals, at?: string): void {
    const when = toIso(at, 'at');
    const { changes } = this.db
      .prepare('UPDATE authors SET signals = ?, signals_fetched_at = ? WHERE source_id = ? AND pseudonym = ?')
      .run(JSON.stringify(s), when, sourceId, pseudonymId);
    if (changes === 0) throw new LurkdError('not_found', `no author ${pseudonymId} in source ${sourceId}`);
  }
}
