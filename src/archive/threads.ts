import type Database from 'better-sqlite3';
import { LurkdError } from '../errors.js';
import { eachName, pseudonym, renderNames, stripMarkers } from '../pseudonym.js';
import type { AuthorSignals, Engine, ExtractedPost, ExtractedThread, ImportProvenance, ImportVia } from '../types.js';

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
  /** D50: set for a thread imported from a saved file, null for one read live. */
  imported: ImportProvenance | null;
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
  imported_via: ImportVia | null;
  replaced_import_at: string | null;
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
 * How many names mentioned in the bodies of one thread the authors table remembers, beyond the
 * thread's post authors (who are all remembered). A crafted body can mention millions of distinct
 * names, and each costs a SHA-256 and a row; the names past the cap still render as pseudonyms,
 * only lurkd cannot map those pseudonyms back to a username.
 */
export const MAX_MENTIONED_NAMES = 5000;
// Rows per INSERT when the authors are written: 4 values each, well under SQLite's limit of 32766.
const AUTHOR_ROWS_PER_INSERT = 200;

interface Remembered {
  username: string;
  profileUrl: string | null;
}

/**
 * The names one thread remembers, by pseudonym: every post author, then the first
 * MAX_MENTIONED_NAMES distinct names its bodies mention. The posts are read in number order,
 * whatever order they come in, so a save and a later prune (which reads them by number) remember
 * the same names. The first spelling of a name is kept with the last profile URL given for it.
 * `pseudonymOf` is memoised by the caller.
 */
function rememberedNames(
  posts: Iterable<{ number: number; author: string; authorUrl: string | null; bodyMd: string }>,
  pseudonymOf: (name: string) => string,
): Map<string, Remembered> {
  const out = new Map<string, Remembered>();
  const remember = (username: string, profileUrl: string | null): boolean => {
    const name = stripMarkers(username).trim();
    if (!name) return false;
    const key = pseudonymOf(name);
    const known = out.get(key);
    if (known === undefined) out.set(key, { username: name, profileUrl });
    else if (profileUrl !== null) known.profileUrl = profileUrl;
    return known === undefined;
  };
  const list = [...posts].sort((a, b) => a.number - b.number);
  for (const p of list) remember(p.author, p.authorUrl);
  // Each spelling is looked at once, so a name mentioned a million times costs one lookup.
  const spellings = new Set<string>();
  let mentioned = 0;
  for (const p of list) {
    if (mentioned >= MAX_MENTIONED_NAMES) break;
    // The scan stops at the cap: a body past it is not read to its end.
    eachName(p.bodyMd, (name) => {
      if (!spellings.has(name)) {
        spellings.add(name);
        if (remember(name, null)) mentioned += 1;
      }
      return mentioned < MAX_MENTIONED_NAMES;
    });
  }
  return out;
}

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
    imported: r.imported_via === null ? null : { via: r.imported_via, replacedImportAt: r.replaced_import_at },
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
   * Returns the thread id, which stays the same across re-fetches. `imported` is how a thread from
   * a saved file came in (D50); a save without it clears what an earlier import kept.
   */
  save(sourceId: string, t: ExtractedThread, fetchedAt?: string, imported: ImportProvenance | null = null): number {
    const at = toIso(fetchedAt, 'fetchedAt');
    const replacedAt = imported?.replacedImportAt == null ? null : toIso(imported.replacedImportAt, 'replacedImportAt');
    const db = this.db;
    return db
      .transaction((): number => {
        const { id } = db
          .prepare(
            `INSERT INTO threads (source_id, url, title, engine, pages, posts_expected, extraction, quality, fetched_at, imported_via, replaced_import_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (url) DO UPDATE SET source_id = excluded.source_id, title = excluded.title,
               engine = excluded.engine, pages = excluded.pages, posts_expected = excluded.posts_expected,
               extraction = excluded.extraction, quality = excluded.quality, fetched_at = excluded.fetched_at,
               imported_via = excluded.imported_via, replaced_import_at = excluded.replaced_import_at
             RETURNING id`,
          )
          .get(sourceId, t.url, t.title, t.engine, t.pages, t.postsExpected, t.extraction, t.quality, at, imported?.via ?? null, replacedAt) as {
          id: number;
        };

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

        const rows = [...rememberedNames(t.posts, this.pseudonymOf(sourceId)).entries()];
        const upsert = (count: number) =>
          db.prepare(
            `INSERT INTO authors (source_id, pseudonym, username, profile_url) VALUES ${Array(count).fill('(?, ?, ?, ?)').join(', ')}
             ON CONFLICT (source_id, pseudonym) DO UPDATE SET profile_url = coalesce(excluded.profile_url, authors.profile_url)`,
          );
        const full = rows.length >= AUTHOR_ROWS_PER_INSERT ? upsert(AUTHOR_ROWS_PER_INSERT) : null;
        for (let i = 0; i < rows.length; i += AUTHOR_ROWS_PER_INSERT) {
          const chunk = rows.slice(i, i + AUTHOR_ROWS_PER_INSERT);
          const stmt = chunk.length === AUTHOR_ROWS_PER_INSERT && full !== null ? full : upsert(chunk.length);
          stmt.run(chunk.flatMap(([key, r]) => [sourceId, key, r.username, r.profileUrl]));
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

  /**
   * When each source was last read (D51, the page's "Last read"): the latest `fetched_at` among its
   * archived threads, by source id. A source with no thread is absent. For imported threads it is
   * the time of the latest import. The page asks on every poll; the index threads_source_fetched
   * (schema version 6) answers it without reading the table or sorting.
   */
  lastFetchedBySource(): Map<string, string> {
    const rows = this.db.prepare('SELECT source_id, max(fetched_at) AS at FROM threads GROUP BY source_id').all() as { source_id: string; at: string }[];
    return new Map(rows.map((r) => [r.source_id, r.at]));
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

  /** The pseudonym of a name on a source, memoised for one save or one prune. */
  private pseudonymOf(sourceId: string): (name: string) => string {
    const kept = new Map<string, string>();
    return (name) => {
      const key = name.toLowerCase();
      let p = kept.get(key);
      if (p === undefined) {
        p = pseudonym(sourceId, key, this.salt);
        kept.set(key, p);
      }
      return p;
    };
  }

  // Deletes the authors of a source that no remaining thread remembers: as save does, every post
  // author and the first MAX_MENTIONED_NAMES names each thread's bodies mention.
  private pruneAuthors(sourceId: string): void {
    const kept = new Set<string>();
    const pseudonymOf = this.pseudonymOf(sourceId);
    const threadIds = this.db.prepare('SELECT id FROM threads WHERE source_id = ?').pluck().all(sourceId) as number[];
    const postsOf = this.db.prepare('SELECT number, author, author_url, body_md FROM posts WHERE thread_id = ? ORDER BY number');
    for (const id of threadIds) {
      const posts = (postsOf.all(id) as { number: number; author: string; author_url: string | null; body_md: string }[]).map((p) => ({
        number: p.number,
        author: p.author,
        authorUrl: p.author_url,
        bodyMd: p.body_md,
      }));
      for (const key of rememberedNames(posts, pseudonymOf).keys()) kept.add(key);
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
