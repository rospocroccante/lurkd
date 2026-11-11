import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSalt, openArchive } from '../../src/archive/db.js';
import { ThreadStore, toFtsQuery } from '../../src/archive/threads.js';
import { LurkdError } from '../../src/errors.js';
import { renderThread, nameResolver } from '../../src/output/render.js';
import { markName, pseudonym } from '../../src/pseudonym.js';
import type { ExtractedPost, ExtractedThread } from '../../src/types.js';

const SRC = 'alpha';
const NOW = '2026-11-08T12:00:00.000Z';
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * DAY).toISOString();

function post(number: number, over: Partial<ExtractedPost> = {}): ExtractedPost {
  return {
    number,
    page: 1,
    author: 'alice',
    authorUrl: 'https://f.example/u/alice',
    signals: ['Member'],
    notes: [],
    postedAt: '2026-11-01T10:00:00.000Z',
    bodyMd: `Post ${number} body`,
    ...over,
  };
}

function thread(over: Partial<ExtractedThread> = {}): ExtractedThread {
  return {
    url: 'https://f.example/t/1',
    title: 'Zigbee coordinator choices',
    engine: 'discourse',
    postsExpected: 3,
    pages: null,
    extraction: 'discourse-json',
    quality: 'full',
    posts: [post(1)],
    ...over,
  };
}

const ftsCount = (db: Database.Database) => (db.prepare('SELECT count(*) AS n FROM posts_fts').get() as { n: number }).n;
const count = (db: Database.Database, table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('ThreadStore', () => {
  let db: Database.Database;
  let salt: string;
  let store: ThreadStore;
  beforeEach(() => {
    db = openArchive(':memory:');
    salt = getSalt(db);
    store = new ThreadStore(db, salt);
  });
  afterEach(() => db.close());

  it('saves and reads back a thread in post order', () => {
    const id = store.save(SRC, thread({ posts: [post(3), post(1), post(2)] }), NOW);
    const got = store.getByUrl('https://f.example/t/1');
    expect(got).not.toBeNull();
    expect(got!.thread).toEqual({
      id,
      sourceId: SRC,
      url: 'https://f.example/t/1',
      title: 'Zigbee coordinator choices',
      engine: 'discourse',
      pages: null,
      postsExpected: 3,
      extraction: 'discourse-json',
      quality: 'full',
      fetchedAt: NOW,
      imported: null,
    });
    expect(got!.posts.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(got!.posts[0]).toEqual(post(1));
    expect(store.getById(id)).toEqual(got);
    expect(store.getByUrl('https://f.example/t/none')).toBeNull();
    expect(store.getById(id + 99)).toBeNull();
  });

  it('stores fetchedAt as UTC ISO and defaults it to now', () => {
    store.save(SRC, thread(), '2026-11-08T13:00:00+01:00');
    expect(store.getByUrl('https://f.example/t/1')!.thread.fetchedAt).toBe(NOW);
    const before = Date.now();
    store.save(SRC, thread({ url: 'https://f.example/t/2' }));
    const at = store.getByUrl('https://f.example/t/2')!.thread.fetchedAt;
    expect(at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Date.parse(at)).toBeGreaterThanOrEqual(before);
  });

  it('rejects an invalid fetchedAt or nowIso with invalid_request', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof LurkdError ? e.code : String(e);
      }
      return 'no error';
    };
    expect(code(() => store.save(SRC, thread(), 'not a date'))).toBe('invalid_request');
    expect(count(db, 'threads')).toBe(0);
    expect(code(() => store.applyRetention(30, 'yesterday-ish'))).toBe('invalid_request');
    expect(code(() => store.applyRetention(-1, NOW))).toBe('invalid_request');
    store.save(SRC, thread(), NOW);
    expect(code(() => store.saveAuthorSignals(SRC, pseudonym(SRC, 'alice', salt), { postCount: 1, joinedAt: null, extra: [] }, 'bad'))).toBe(
      'invalid_request',
    );
  });

  it('recovers from FTS rows orphaned by an out-of-band thread delete', () => {
    store.save(SRC, thread({ posts: [post(1, { bodyMd: 'ghost words' }), post(2)] }), NOW);
    db.prepare('DELETE FROM threads').run();
    expect(count(db, 'posts')).toBe(0);
    expect(ftsCount(db)).toBe(2);
    expect(() => store.save(SRC, thread({ posts: [post(1, { bodyMd: 'live words' }), post(2, { bodyMd: 'live too' })] }), NOW)).not.toThrow();
    expect(count(db, 'posts')).toBe(2);
    expect(ftsCount(db)).toBe(2);
    expect(store.search('ghost', { limit: 10 })).toEqual([]);
    expect(store.search('live', { limit: 10 })).toHaveLength(2);
  });

  it('gives a stored thread plus its posts the shape renderThread takes', () => {
    store.save(SRC, thread({ posts: [post(1, { bodyMd: `Thanks ${markName('bob')}` })] }), NOW);
    const got = store.getByUrl('https://f.example/t/1')!;
    const { markdown: md } = renderThread({ ...got.thread, posts: got.posts }, nameResolver({ sourceId: SRC, salt, realNames: false }));
    expect(md).toContain(pseudonym(SRC, 'bob', salt));
    expect(md).not.toMatch(/\bbob\b/);
  });

  it('replaces the posts of a re-fetched thread', () => {
    const id = store.save(SRC, thread({ posts: [post(1, { bodyMd: 'oldword one' }), post(2), post(3)] }), daysAgo(5));
    const id2 = store.save(
      SRC,
      thread({ title: 'Renamed', posts: [post(1, { bodyMd: 'fresh text' }), post(2, { bodyMd: 'more fresh text' })] }),
      NOW,
    );
    expect(id2).toBe(id);
    const got = store.getByUrl('https://f.example/t/1')!;
    expect(got.thread.title).toBe('Renamed');
    expect(got.thread.fetchedAt).toBe(NOW);
    expect(got.posts).toHaveLength(2);
    expect(store.search('oldword', { limit: 10 })).toEqual([]);
    expect(store.search('fresh', { limit: 10 })).toHaveLength(2);
    expect(ftsCount(db)).toBe(2);
    expect(count(db, 'posts')).toBe(2);
    expect(count(db, 'threads')).toBe(1);
  });

  it('keeps who imported a thread and the date of the import it replaced, and clears both on a save without them (D50)', () => {
    store.save('reddit-import', thread({ engine: 'import' }), NOW, { via: 'page', replacedImportAt: null });
    expect(store.getByUrl('https://f.example/t/1')!.thread.imported).toEqual({ via: 'page', replacedImportAt: null });
    store.save('reddit-import', thread({ engine: 'import' }), NOW, { via: 'api', replacedImportAt: daysAgo(1) });
    expect(store.getByUrl('https://f.example/t/1')!.thread.imported).toEqual({ via: 'api', replacedImportAt: daysAgo(1) });
    store.save(SRC, thread(), NOW);
    expect(store.getByUrl('https://f.example/t/1')!.thread.imported).toBeNull();
  });

  it('rolls back a save that fails half way', () => {
    store.save(SRC, thread({ posts: [post(1, { bodyMd: 'original words' })] }), NOW);
    expect(() => store.save(SRC, thread({ title: 'Broken', posts: [post(1), post(1)] }), NOW)).toThrow();
    const got = store.getByUrl('https://f.example/t/1')!;
    expect(got.thread.title).toBe('Zigbee coordinator choices');
    expect(got.posts.map((p) => p.bodyMd)).toEqual(['original words']);
    expect(store.search('original', { limit: 10 })).toHaveLength(1);
    expect(ftsCount(db)).toBe(1);
  });

  describe('search', () => {
    beforeEach(() => {
      store.save(
        SRC,
        thread({
          posts: [
            post(1, { bodyMd: 'I moved to zigbee-herdsman last year and the c++ build broke' }),
            post(2, { bodyMd: 'The rtx 5090 runs hot, a:b testing showed it' }),
            post(3, { bodyMd: 'Unrelated herdsman zigbee words in another order' }),
          ],
        }),
        NOW,
      );
    });

    it.each(['c++', '"rtx 5090', 'zigbee-herdsman', 'NOT', 'a:b', '*', '(gpu', 'AND OR', '   '])(
      'search(%j) never throws (Review Focus 2)',
      (q) => expect(() => store.search(q, { limit: 10 })).not.toThrow(),
    );

    it.each(['NEAR(a b)', 'x OR', '"', '""', 'body:zigbee', '-zigbee', '^zigbee', 'zigbee*', '{title}: x', '\u0000', ')', 'zig\u0000bee', 'zigbee\u0000', 'zigbee\u0000 OR x'])(
      'search(%j) never throws on other FTS5 syntax',
      (q) => expect(() => store.search(q, { limit: 10 })).not.toThrow(),
    );

    it('finds zigbee-herdsman as a phrase', () => expect(store.search('zigbee-herdsman', { limit: 10 })).toHaveLength(1));

    it('treats operator words as plain terms', () => {
      store.save(SRC, thread({ url: 'https://f.example/t/ops', posts: [post(1, { bodyMd: 'do NOT reflash it' })] }), NOW);
      const hits = store.search('NOT reflash', { limit: 10 });
      expect(hits).toHaveLength(1);
      expect(hits[0].threadUrl).toBe('https://f.example/t/ops');
    });

    it('ANDs the tokens of a multi-word query', () => {
      expect(store.search('herdsman unrelated', { limit: 10 }).map((h) => h.postNumber)).toEqual([3]);
      expect(store.search('"rtx 5090', { limit: 10 }).map((h) => h.postNumber)).toEqual([2]);
    });

    it('returns [] for empty or punctuation-only queries', () => {
      for (const q of ['', '   ', '*', '"', '()', '- : ^']) expect(store.search(q, { limit: 10 })).toEqual([]);
    });

    it('matches the thread title', () => {
      expect(store.search('coordinator', { limit: 10 })).toHaveLength(3);
    });

    it('returns hits with real author, marked body and stored signals', () => {
      store.save(
        SRC,
        thread({
          url: 'https://f.example/t/9',
          title: 'Quote test',
          posts: [post(4, { author: 'carol', signals: ['Moderator', '1.2k posts'], bodyMd: `quoting ${markName('dave')} here` })],
        }),
        NOW,
      );
      const hits = store.search('quoting', { limit: 10 });
      expect(hits).toEqual([
        {
          sourceId: SRC,
          threadId: store.getByUrl('https://f.example/t/9')!.thread.id,
          threadUrl: 'https://f.example/t/9',
          threadTitle: 'Quote test',
          postNumber: 4,
          author: 'carol',
          postedAt: '2026-11-01T10:00:00.000Z',
          bodyMd: `quoting ${markName('dave')} here`,
          signals: ['Moderator', '1.2k posts'],
        },
      ]);
    });
  });

  it('matches Italian text without accents', () => {
    store.save(SRC, thread({ posts: [post(1, { bodyMd: 'perché la B12 non basta' })] }), NOW);
    expect(store.search('perche', { limit: 10 })).toHaveLength(1);
    expect(store.search('perché', { limit: 10 })).toHaveLength(1);
  });

  it('keeps author names out of the index', () => {
    store.save(SRC, thread({ posts: [post(1, { author: 'alice', bodyMd: `As ${markName('bob')} said, flash it` })] }), NOW);
    expect(store.search('flash', { limit: 10 })).toHaveLength(1);
    expect(store.search('alice', { limit: 10 })).toEqual([]);
    expect(store.search('bob', { limit: 10 })).toEqual([]);
  });

  it('maps a pseudonym back to the username and profile URL', () => {
    store.save(SRC, thread({ posts: [post(1, { bodyMd: `cc ${markName('bob')}` })] }), NOW);
    expect(store.lookupAuthor(SRC, pseudonym(SRC, 'alice', salt))).toEqual({
      username: 'alice',
      profileUrl: 'https://f.example/u/alice',
      signals: null,
      signalsFetchedAt: null,
    });
    expect(store.lookupAuthor(SRC, pseudonym(SRC, 'bob', salt))).toEqual({
      username: 'bob',
      profileUrl: null,
      signals: null,
      signalsFetchedAt: null,
    });
    expect(store.lookupAuthor('other', pseudonym(SRC, 'alice', salt))).toBeNull();
    expect(store.lookupAuthor(SRC, 'author-0000000000')).toBeNull();
  });

  it('keeps a known profile URL when a later save lacks one', () => {
    store.save(SRC, thread({ posts: [post(1, { author: 'bob', authorUrl: 'https://f.example/u/bob' })] }), NOW);
    store.save(
      SRC,
      thread({ url: 'https://f.example/t/2', posts: [post(1, { bodyMd: `hi ${markName('bob')}` }), post(2, { author: 'bob', authorUrl: null })] }),
      NOW,
    );
    expect(store.lookupAuthor(SRC, pseudonym(SRC, 'bob', salt))!.profileUrl).toBe('https://f.example/u/bob');
  });

  it('skips blank author names', () => {
    store.save(SRC, thread({ posts: [post(1, { author: '  ', authorUrl: null })] }), NOW);
    expect(count(db, 'authors')).toBe(0);
  });

  it('saves and reads back author signals', () => {
    store.save(SRC, thread(), NOW);
    const p = pseudonym(SRC, 'alice', salt);
    const s = { postCount: 120, joinedAt: '2020-01-01', extra: ['Trusted'] };
    store.saveAuthorSignals(SRC, p, s, '2026-11-08T13:00:00+01:00');
    expect(store.lookupAuthor(SRC, p)).toEqual({
      username: 'alice',
      profileUrl: 'https://f.example/u/alice',
      signals: s,
      signalsFetchedAt: NOW,
    });
    expect(() => store.saveAuthorSignals(SRC, 'author-0000000000', s)).toThrow(LurkdError);
  });

  it('deletes a source with its FTS rows', () => {
    store.save(SRC, thread({ posts: [post(1, { bodyMd: `zigbee ${markName('bob')}` }), post(2)] }), NOW);
    store.save('beta', thread({ url: 'https://g.example/t/1', posts: [post(1, { author: 'erin', bodyMd: 'zigbee too' })] }), NOW);
    expect(store.deleteSource(SRC)).toBe(1);
    expect(store.search('zigbee', { limit: 10, sourceId: SRC })).toEqual([]);
    expect(store.search('zigbee', { limit: 10 })).toHaveLength(1);
    expect(ftsCount(db)).toBe(1);
    expect(count(db, 'posts')).toBe(1);
    expect(store.lookupAuthor(SRC, pseudonym(SRC, 'alice', salt))).toBeNull();
    expect(store.lookupAuthor(SRC, pseudonym(SRC, 'bob', salt))).toBeNull();
    expect(store.lookupAuthor('beta', pseudonym('beta', 'erin', salt))).not.toBeNull();
    expect(store.deleteSource(SRC)).toBe(0);
    store.deleteSource('beta');
    expect(ftsCount(db)).toBe(0);
    expect(count(db, 'authors')).toBe(0);
  });

  it('applies retention by fetched_at', () => {
    store.save(SRC, thread({ url: 'https://f.example/t/old', posts: [post(1, { author: 'carol', bodyMd: `old ${markName('dave')} ${markName('alice')}` })] }), daysAgo(40));
    store.save(SRC, thread({ url: 'https://f.example/t/new', posts: [post(1, { author: 'alice', bodyMd: 'new' })] }), daysAgo(10));
    expect(store.applyRetention(null, NOW)).toBe(0);
    expect(store.applyRetention(30, NOW)).toBe(1);
    expect(store.getByUrl('https://f.example/t/old')).toBeNull();
    expect(store.getByUrl('https://f.example/t/new')).not.toBeNull();
    expect(store.search('old', { limit: 10 })).toEqual([]);
    expect(ftsCount(db)).toBe(1);
    expect(count(db, 'posts')).toBe(1);
    expect(store.lookupAuthor(SRC, pseudonym(SRC, 'carol', salt))).toBeNull();
    expect(store.lookupAuthor(SRC, pseudonym(SRC, 'dave', salt))).toBeNull();
    expect(store.lookupAuthor(SRC, pseudonym(SRC, 'alice', salt))).not.toBeNull();
    expect(store.applyRetention(30, NOW)).toBe(0);
  });

  it('keeps an author mentioned only in a remaining body', () => {
    store.save(SRC, thread({ url: 'https://f.example/t/old', posts: [post(1, { author: 'carol' })] }), daysAgo(40));
    store.save(SRC, thread({ url: 'https://f.example/t/new', posts: [post(1, { author: 'alice', bodyMd: `hi ${markName('Carol')}` })] }), NOW);
    expect(store.applyRetention(30, NOW)).toBe(1);
    expect(store.lookupAuthor(SRC, pseudonym(SRC, 'carol', salt))).not.toBeNull();
  });

  it('filters by source and clamps the limit to 1..50', () => {
    const posts = Array.from({ length: 60 }, (_, i) => post(i + 1, { bodyMd: `gpu note ${i + 1}` }));
    store.save(SRC, thread({ posts }), NOW);
    store.save('beta', thread({ url: 'https://g.example/t/1', posts: [post(1, { bodyMd: 'gpu elsewhere' })] }), NOW);
    expect(store.search('gpu', { limit: 500 })).toHaveLength(50);
    expect(store.search('gpu', { limit: 0 })).toHaveLength(1);
    expect(store.search('gpu', { limit: -3 })).toHaveLength(1);
    expect(store.search('gpu', { limit: Number.NaN })).toHaveLength(10);
    expect(store.search('gpu', { limit: Number.POSITIVE_INFINITY })).toHaveLength(10);
    expect(store.search('gpu', { limit: Number.NEGATIVE_INFINITY })).toHaveLength(10);
    expect(store.search('gpu', { limit: 2.7 })).toHaveLength(2);
    const beta = store.search('gpu', { limit: 10, sourceId: 'beta' });
    expect(beta.map((h) => h.sourceId)).toEqual(['beta']);
    expect(store.search('gpu', { limit: 50, sourceId: SRC }).every((h) => h.sourceId === SRC)).toBe(true);
    expect(store.search('gpu', { limit: 10, sourceId: 'nobody' })).toEqual([]);
  });

  it('ranks the better match first and breaks ties by newer fetch', () => {
    store.save(SRC, thread({ url: 'https://f.example/t/a', title: 'A', posts: [post(1, { bodyMd: 'flux flux flux capacitor' })] }), daysAgo(2));
    store.save(SRC, thread({ url: 'https://f.example/t/b', title: 'B', posts: [post(1, { bodyMd: 'a long post that says flux once among many other words here' })] }), NOW);
    expect(store.search('flux', { limit: 10 }).map((h) => h.threadUrl)).toEqual(['https://f.example/t/a', 'https://f.example/t/b']);
    store.save(SRC, thread({ url: 'https://f.example/t/c', title: 'C', posts: [post(1, { bodyMd: 'same words' })] }), daysAgo(3));
    store.save(SRC, thread({ url: 'https://f.example/t/d', title: 'C', posts: [post(1, { bodyMd: 'same words' })] }), NOW);
    expect(store.search('same words', { limit: 10 }).map((h) => h.threadUrl)).toEqual(['https://f.example/t/d', 'https://f.example/t/c']);
  });
});

describe('toFtsQuery', () => {
  it('quotes each whitespace token and joins with spaces', () => {
    expect(toFtsQuery('zigbee herdsman')).toBe('"zigbee" "herdsman"');
    expect(toFtsQuery('  c++   NOT ')).toBe('"c++" "NOT"');
    expect(toFtsQuery('(gpu')).toBe('"(gpu"');
  });

  it('neutralises double quotes inside tokens', () => {
    expect(toFtsQuery('"rtx 5090')).toBe('"""rtx" "5090"');
    expect(toFtsQuery('a"b')).toBe('"a""b"');
  });

  it('treats NUL as a token separator', () => {
    expect(toFtsQuery('zig\u0000bee')).toBe('"zig" "bee"');
    expect(toFtsQuery('zigbee\u0000')).toBe('"zigbee"');
    expect(toFtsQuery('\u0000')).toBeNull();
  });

  it('returns null for an empty or punctuation-only query', () => {
    for (const q of ['', '   ', '*', '"', '"" ""', '() - :', '\t\n']) expect(toFtsQuery(q)).toBeNull();
  });

  it('drops punctuation-only tokens and name markers', () => {
    expect(toFtsQuery('* gpu -')).toBe('"gpu"');
    expect(toFtsQuery(markName('bob'))).toBe('"bob"');
  });
});
