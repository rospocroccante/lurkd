import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openArchive } from '../../src/archive/db.js';
import { MAX_MENTIONED_NAMES, ThreadStore } from '../../src/archive/threads.js';
import { formatImport } from '../../src/client/format.js';
import type { LaunchFn } from '../../src/browser/manager.js';
import {
  MAX_BODY_CHARS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_COMMENTS,
  MAX_TITLE_CHARS,
  parseRedditFile,
  parseRedditImport,
  REDDIT_IMPORT_SOURCE_ID,
} from '../../src/extract/reddit-import.js';
import type { RedditImportOut } from '../../src/fetch/service.js';
import { formatDate, guardBody, nameResolver, renderThread, toRenderInput, type NameMode } from '../../src/output/render.js';
import { findLeaks, markName, namesIn, pseudonym, renderNames } from '../../src/pseudonym.js';
import { lurkdPaths } from '../../src/paths.js';
import { startServer } from '../../src/server/main.js';
import type { ExtractedPost, ExtractedThread } from '../../src/types.js';
import { pageCookie } from '../helpers/common.js';

// R5, fix round 2: what a crafted 20 MB file costs the server's event loop, at parse, save and
// render. Each case asserts under 1 s, well above the typical times, so a loaded machine does not
// fail it; before the fixes these cases took 1 to 6 s. Each case also checks the output.

const SRC = REDDIT_IMPORT_SOURCE_ID;
const SALT = 'b'.repeat(64);
const FETCHED = '2026-11-10T09:00:00.000Z';
const BAR_MS = 1000;
const P = (name: string) => pseudonym(SRC, name, SALT);
const mode = nameResolver({ sourceId: SRC, salt: SALT, realNames: false });

const timed = <T>(f: () => T): { value: T; ms: number } => {
  const t0 = performance.now();
  const value = f();
  return { value, ms: performance.now() - t0 };
};

/** `unit` repeated to just under 20 MB once written into the file as a JSON string. */
const fill = (unit: string): string => unit.repeat(Math.floor((MAX_IMPORT_BYTES - 4096) / (JSON.stringify(unit).length - 2)));

const threadDoc = (post: Record<string, unknown>, comments: unknown[] = []): string =>
  JSON.stringify([
    { kind: 'Listing', data: { children: [{ kind: 't3', data: { id: 'abc123', title: 'A title', author: 'alice', selftext: '', ...post } }] } },
    { kind: 'Listing', data: { children: comments } },
  ]);

const post = (number: number, over: Partial<ExtractedPost> = {}): ExtractedPost => ({
  number,
  page: null,
  author: 'alice',
  authorUrl: null,
  signals: [],
  notes: [],
  postedAt: '2026-11-01T10:00:00.000Z',
  bodyMd: 'hi',
  ...over,
});

const thread = (posts: ExtractedPost[], over: Partial<ExtractedThread> = {}): ExtractedThread => ({
  url: 'https://f.example/t/1',
  title: 'A title',
  engine: 'discourse',
  postsExpected: null,
  pages: null,
  extraction: 'test',
  quality: 'full',
  posts,
  ...over,
});

const render = (t: ExtractedThread, m: NameMode = mode) => renderThread(toRenderInput(SRC, t, FETCHED), m);

/** How often `needle` occurs in `hay`, without building an array of the pieces. */
const occurrences = (hay: string, needle: string): number => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n += 1;
  return n;
};

describe('item 1: a name is turned into its pseudonym once per render', () => {
  const N = 3_500_000;
  const body = `u/${markName('abc')} `.repeat(N);

  it('renders 3,500,000 mentions of one name in under 1 s, each as the pseudonym', () => {
    const { value: r, ms } = timed(() => render(thread([post(1, { bodyMd: body })])));
    expect(ms).toBeLessThan(BAR_MS);
    expect(occurrences(r.markdown, `u/${P('abc')}`)).toBe(N);
    expect(findLeaks(r.markdown.slice(0, 50_000), ['abc'])).toEqual(new Map());
    expect(findLeaks(r.markdown.slice(-50_000), ['abc'])).toEqual(new Map());
  });

  it('calls the name mode once per distinct name in a render', () => {
    const seen: string[] = [];
    const counting: NameMode = { label: 'pseudonyms', nameFor: (u) => (seen.push(u), mode.nameFor(u)) };
    const t = thread([post(1, { bodyMd: `${body} ${markName('bob')}`, signals: [`cc ${markName('bob')}`], notes: [`by ${markName('abc')}`] }), post(2)], {
      title: `thanks ${markName('abc')}`,
    });
    const { markdown } = render(t, counting);
    expect([...seen].sort()).toEqual(['abc', 'alice', 'bob']);
    expect(findLeaks(markdown.slice(0, 50_000), ['abc', 'alice', 'bob'])).toEqual(new Map());
    expect(markdown).toContain(`title: "thanks ${P('abc')}"`);
  });

  it('the name resolver keeps what it worked out, so renderNames alone stays under 1 s', () => {
    const { value: out, ms } = timed(() => renderNames(body, mode.nameFor));
    expect(ms).toBeLessThan(BAR_MS);
    expect(out.length).toBe(N * `u/${P('abc')} `.length);
    expect(mode.nameFor('abc')).toBe(P('abc'));
    expect(mode.nameFor(' ')).toBe('unknown author');
  });

  it('renderNames keeps its meaning: unpaired markers dropped, empty marks rendered, names stripped of markers', () => {
    const O = '\uE000';
    const C = '\uE001';
    const f = (u: string) => `<${u}>`;
    expect(renderNames(`a${O}b${C}c`, f)).toBe('a<b>c');
    expect(renderNames(`${O}${O}x${C}`, f)).toBe('<x>');
    expect(renderNames(`${C}x${O}`, f)).toBe('x');
    expect(renderNames(`${O}${C}`, f)).toBe('<>');
    expect(renderNames(`${O}a${C}${O}b${C}${O}a${C}`, f)).toBe('<a><b><a>');
    expect(renderNames(`${O}a${C}`, () => `${O}x${C}`)).toBe('x');
    expect(renderNames('plain', f)).toBe('plain');
    expect(renderNames(`${O}a${'b'.repeat(1000)}`, f)).toBe(`a${'b'.repeat(1000)}`);
    expect(namesIn(`${O}a${C}${O}${C}${O}b${C}${O}a${C}`)).toEqual(['a', 'b']);
  });
});

describe('item 2: saving remembers every author and at most 5,000 mentioned names per thread', () => {
  let db: Database.Database;
  let store: ThreadStore;
  beforeEach(() => {
    db = openArchive(':memory:');
    store = new ThreadStore(db, SALT);
  });
  afterEach(() => db.close());
  const authors = () => (db.prepare('SELECT count(*) AS n FROM authors').get() as { n: number }).n;

  it('saves a body of 2,570,000 distinct mentions in under 1 s', () => {
    const n = 2_570_000;
    const names = Array.from({ length: n }, (_v, i) => `z${i.toString(36)}`);
    const bodyMd = names.map((name) => markName(name)).join(' ');
    const { ms } = timed(() => store.save(SRC, thread([post(1, { author: 'alice', bodyMd })]), FETCHED));
    expect(ms).toBeLessThan(BAR_MS);
    expect(MAX_MENTIONED_NAMES).toBe(5000);
    expect(authors()).toBe(1 + MAX_MENTIONED_NAMES);
    expect(store.lookupAuthor(SRC, P(names[0]!))?.username).toBe(names[0]);
    expect(store.lookupAuthor(SRC, P(names[MAX_MENTIONED_NAMES - 1]!))?.username).toBe(names[MAX_MENTIONED_NAMES - 1]);
    expect(store.lookupAuthor(SRC, P(names[MAX_MENTIONED_NAMES]!))).toBeNull();
    expect(store.lookupAuthor(SRC, P('alice'))?.username).toBe('alice');
  });

  it('renders the names over the cap as pseudonyms all the same', () => {
    const names = Array.from({ length: MAX_MENTIONED_NAMES + 50 }, (_v, i) => `zuser${i}`);
    store.save(SRC, thread([post(1, { bodyMd: names.map((name) => `u/${markName(name)}`).join(' ') })]), FETCHED);
    expect(authors()).toBe(1 + MAX_MENTIONED_NAMES);
    const stored = store.getByUrl('https://f.example/t/1')!;
    const { markdown } = renderThread({ ...toRenderInput(SRC, thread(stored.posts), FETCHED) }, mode);
    expect(markdown).not.toContain('zuser');
    expect(markdown).toContain(`u/${P(names.at(-1)!)}`);
  });

  it('remembers every post author, beyond the cap too, with the first spelling and the last profile URL', () => {
    const posts = Array.from({ length: MAX_MENTIONED_NAMES + 10 }, (_v, i) => post(i + 1, { author: `poster${i}` }));
    posts.push(post(posts.length + 1, { author: 'Bob', authorUrl: 'https://f.example/u/1' }));
    posts.push(post(posts.length + 1, { author: 'bob', authorUrl: null, bodyMd: markName('BOB') }));
    posts.push(post(posts.length + 1, { author: 'bob', authorUrl: 'https://f.example/u/2' }));
    store.save(SRC, thread(posts), FETCHED);
    expect(authors()).toBe(MAX_MENTIONED_NAMES + 11);
    expect(store.lookupAuthor(SRC, P(`poster${MAX_MENTIONED_NAMES + 9}`))?.username).toBe(`poster${MAX_MENTIONED_NAMES + 9}`);
    expect(store.lookupAuthor(SRC, P('bob'))).toMatchObject({ username: 'Bob', profileUrl: 'https://f.example/u/2' });
    // A later save without a profile URL keeps the known one.
    store.save(SRC, thread([post(1, { author: 'bob' })], { url: 'https://f.example/t/2' }), FETCHED);
    expect(store.lookupAuthor(SRC, P('bob'))).toMatchObject({ username: 'Bob', profileUrl: 'https://f.example/u/2' });
  });

  it('retention keeps the names each remaining thread remembers, and is fast on a thread of 2,570,000 mentions', () => {
    const old = '2026-09-01T00:00:00.000Z';
    store.save(SRC, thread([post(1, { author: 'carol', bodyMd: `${markName('dave')} ${markName('erin')}` })], { url: 'https://f.example/t/old' }), old);
    const many = Array.from({ length: 2_570_000 }, (_v, i) => markName(`z${i.toString(36)}`)).join(' ');
    store.save(SRC, thread([post(1, { author: 'frank', bodyMd: `${markName('erin')} ${many} ${markName('dave')}` })], { url: 'https://f.example/t/new' }), FETCHED);
    const { value: deleted, ms } = timed(() => store.applyRetention(30, FETCHED));
    expect(ms).toBeLessThan(BAR_MS);
    expect(deleted).toBe(1);
    expect(store.lookupAuthor(SRC, P('carol'))).toBeNull();
    expect(store.lookupAuthor(SRC, P('erin'))).not.toBeNull();
    // dave comes after the cap in the remaining thread, so it no longer names him.
    expect(store.lookupAuthor(SRC, P('dave'))).toBeNull();
    expect(store.lookupAuthor(SRC, P('frank'))).not.toBeNull();
    expect(authors()).toBe(1 + MAX_MENTIONED_NAMES);
  });
  it('save and retention remember the same mentioned names when the posts come out of number order', () => {
    // 3,000 distinct names per post, 9,000 in all: the cap of 5,000 falls inside the second post by number.
    const names = (p: number) => Array.from({ length: 3000 }, (_v, i) => `p${p}n${i}`);
    const bodyOf = (p: number) => names(p).map((n) => markName(n)).join(' ');
    const posts = [1, 3, 2].map((n) => post(n, { author: `author${n}`, bodyMd: bodyOf(n) }));
    const keys = (d: Database.Database) => (d.prepare('SELECT pseudonym FROM authors ORDER BY pseudonym').pluck().all() as string[]);
    // A fresh save of the same posts in number order.
    const fresh = openArchive(':memory:');
    let want: string[];
    try {
      new ThreadStore(fresh, SALT).save(SRC, thread([1, 2, 3].map((n) => post(n, { author: `author${n}`, bodyMd: bodyOf(n) }))), FETCHED);
      want = keys(fresh);
    } finally {
      fresh.close();
    }
    expect(want).toHaveLength(3 + MAX_MENTIONED_NAMES);
    expect(want).toContain(P('p2n1999'));
    expect(want).not.toContain(P('p2n2000'));
    expect(want).not.toContain(P('p3n0'));

    store.save(SRC, thread(posts), FETCHED);
    expect(keys(db)).toEqual(want);
    store.save(SRC, thread([post(1, { author: 'olduser', bodyMd: markName('oldname') })], { url: 'https://f.example/t/old' }), '2026-09-01T00:00:00.000Z');
    expect(store.applyRetention(30, FETCHED)).toBe(1);
    expect(keys(db)).toEqual(want);
  });
});

describe('item 3: the title is cut at 300 characters', () => {
  it('cuts a 20 MB title in the file, and parses it in under 1 s', () => {
    const { value: t, ms } = timed(() => parseRedditFile(threadDoc({ title: fill('x ') })));
    expect(ms).toBeLessThan(BAR_MS);
    expect(MAX_TITLE_CHARS).toBe(300);
    expect(t.title).toBe(`${'x '.repeat(150).trimEnd()}...`);
    const { value: r, ms: renderMs } = timed(() => render(t));
    expect(renderMs).toBeLessThan(BAR_MS);
    expect(r.markdown.length).toBeLessThan(2000);
  });

  it('keeps a short title whole, and never cuts through a marked name', () => {
    expect(parseRedditFile(threadDoc({ title: 'x'.repeat(300) })).title).toBe('x'.repeat(300));
    const t = parseRedditFile(threadDoc({ title: `${'t'.repeat(290)} u/carolinathename and more` }));
    expect(namesIn(t.title)).toEqual(['carolinathename']);
    expect(t.title.endsWith('...')).toBe(true);
    const { markdown } = render(t);
    expect(markdown).not.toContain('carolina');
    expect(markdown).toContain(`u/${P('carolinathename')}..."`);
  });

  it('formatImport prints at most 1,000 characters of a title, even when handed a long one', () => {
    const r: RedditImportOut = {
      source: SRC,
      threadId: 1,
      url: 'https://www.reddit.com/comments/abc123/',
      title: 'y '.repeat(1_000_000),
      posts: 1,
      comments: 0,
      notKept: 0,
      notInFile: 0,
      replaced: false,
      replacedImportAt: null,
      importedBy: 'lurkd import / API',
      importedAt: FETCHED,
    };
    const { value: out, ms } = timed(() => formatImport(r));
    expect(ms).toBeLessThan(BAR_MS);
    expect(out.length).toBeLessThan(2000);
    expect(out).toContain(`Title: ${'y '.repeat(500).trimEnd()}...`);
  });
});

describe('item 4: a flair is cut on a bounded prefix', () => {
  for (const [name, flair] of [
    ['mentions', fill('u/abc ')],
    ['carriage returns', fill('f\r')],
    ['spaces', fill('f ')],
  ] as const) {
    it(`parses a 20 MB flair of ${name} in under 1 s and keeps 80 characters`, () => {
      const { value: t, ms } = timed(() => parseRedditFile(threadDoc({ author_flair_text: flair })));
      expect(ms).toBeLessThan(BAR_MS);
      const signal = t.posts[0]!.signals[0]!;
      expect(signal.startsWith('flair: "')).toBe(true);
      expect(signal.endsWith('..."')).toBe(true);
      expect(signal.length).toBeLessThan(200);
    });
  }

  it('still never cuts through a marked name, and keeps it whole', () => {
    const t = parseRedditFile(threadDoc({ author_flair_text: `${'f '.repeat(5_000_000)}`.replace(/^/, `${'f'.repeat(70)} u/carolinathename `) }));
    const signal = t.posts[0]!.signals[0]!;
    expect(namesIn(signal)).toEqual(['carolinathename']);
    expect(render(t).markdown).toContain(`u/${P('carolinathename')}..."`);
  });
});

describe('item 5: a body of up to 20 MB costs little at parse, save and render', () => {
  const shapes: [string, string, (body: string) => void][] = [
    ['headings', fill('# x\n'), (b) => expect(b.startsWith('# x\n# x\n')).toBe(true)],
    ['fences', fill('```\n'), (b) => expect(b.startsWith('```\n```\n')).toBe(true)],
    ['blank lines', fill('a\n\n'), (b) => expect(b.startsWith('a\n\na\n\n')).toBe(true)],
    ['carriage returns', fill('a\r'), (b) => expect(b.startsWith('a\na\na\n')).toBe(true)],
    ['line ends', fill('a\n'), (b) => expect(b.startsWith('a\na\na\n')).toBe(true)],
    ['mentions', fill('u/abc '), (b) => expect(namesIn(b)).toEqual(['abc'])],
  ];

  it.each(shapes)('%s: parse, save and render each under 1 s, the body cut at 100,000 characters', (_name, selftext, check) => {
    const { value: t, ms: parseMs } = timed(() => parseRedditFile(threadDoc({ selftext })));
    expect(parseMs).toBeLessThan(BAR_MS);
    const body = t.posts[0]!.bodyMd;
    expect(MAX_BODY_CHARS).toBe(100_000);
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 20);
    expect(body.length).toBeGreaterThan(MAX_BODY_CHARS - 100);
    expect(t.posts[0]!.notes).toEqual(['Cut at 100,000 characters: the rest of this post is not kept']);
    check(body);
    const db = openArchive(':memory:');
    try {
      const { ms: saveMs } = timed(() => new ThreadStore(db, SALT).save(SRC, t, FETCHED));
      expect(saveMs).toBeLessThan(BAR_MS);
    } finally {
      db.close();
    }
    const { value: r, ms: renderMs } = timed(() => render(t));
    expect(renderMs).toBeLessThan(BAR_MS);
    expect(r.markdown).toContain('_Cut at 100,000 characters: the rest of this post is not kept._');
    expect(findLeaks(r.markdown, ['abc', 'alice'])).toEqual(new Map());
  });

  it('decodes a 20 MB body of entities in under 1 s', () => {
    const { value: t, ms } = timed(() => parseRedditFile(threadDoc({ selftext: fill('&amp;'), selftext_html: '&lt;div&gt;' })));
    expect(ms).toBeLessThan(BAR_MS);
    expect(t.posts[0]!.bodyMd).toBe('&'.repeat(MAX_BODY_CHARS));
  });

  it('keeps a body at the limit whole, and cuts a comment too, never through a marked name', () => {
    const exact = parseRedditFile(threadDoc({ selftext: 'b'.repeat(MAX_BODY_CHARS) }));
    expect([exact.posts[0]!.bodyMd.length, exact.posts[0]!.notes]).toEqual([MAX_BODY_CHARS, []]);
    const body = `${'c'.repeat(MAX_BODY_CHARS - 5)} u/carolinathename and more`;
    const t = parseRedditFile(threadDoc({}, [{ kind: 't1', data: { id: 'c1', parent_id: 't3_abc123', author: 'bob', body } }]));
    expect(namesIn(t.posts[1]!.bodyMd)).toEqual(['carolinathename']);
    expect(t.posts[1]!.notes).toEqual(['Cut at 100,000 characters: the rest of this post is not kept']);
    expect(render(t).markdown).not.toContain('carolina');
  });

  // The renderer is shared by every engine: a heading-dense or fence-dense body that did not
  // come from a saved file must not hold the loop either.
  const generic: [string, string, string][] = [
    ['headings', '# x\n'.repeat(5_000_000), '\\# x\n'.repeat(5_000_000)],
    ['level 2 headings after spaces and tabs', ' ##\tx\n'.repeat(3_000_000), ' \\##\tx\n'.repeat(3_000_000)],
    ['fences', '```\n'.repeat(5_000_000), '```\n'.repeat(5_000_000)],
    ['blank lines', 'a\n\n'.repeat(6_500_000), 'a\n\n'.repeat(6_500_000)],
    ['line ends', 'a\n'.repeat(10_000_000), 'a\n'.repeat(10_000_000)],
  ];

  it.each(generic)('guardBody on 20 MB of %s, under 1 s', (_name, body, want) => {
    const { value: out, ms } = timed(() => guardBody(body));
    expect(ms).toBeLessThan(BAR_MS);
    expect(out === want).toBe(true);
  });

  it('guardBody keeps its meaning on mixed text', () => {
    const body = ['# h', '  ## h2', '### h3', '#nospace', '#', '```sh', '# in code', '```', '~~~~', '# still code', '~~~', '# still', '~~~~~', '# after', '``` a`b', '# not a fence', '```', 'tail'].join('\n');
    expect(guardBody(body)).toBe(
      ['\\# h', '  \\## h2', '### h3', '#nospace', '\\#', '```sh', '# in code', '```', '~~~~', '# still code', '~~~', '# still', '~~~~~', '\\# after', '``` a`b', '\\# not a fence', '```', 'tail', '```'].join('\n'),
    );
    expect(guardBody('```\nx\n```  \n# h')).toBe('```\nx\n```  \n\\# h');
    expect(guardBody('    # indented code')).toBe('    # indented code');
    expect(guardBody('~~~\n# x')).toBe('~~~\n# x\n~~~');
  });
});

describe('item 6: a date is believed only between 2005 and tomorrow', () => {
  const at = (created_utc: unknown, edited: unknown = false) => parseRedditFile(threadDoc({ created_utc, edited, selftext: 'x' })).posts[0]!;
  const START = Date.parse('2005-01-01T00:00:00.000Z') / 1000;

  it('treats a date outside the range as unknown', () => {
    for (const v of [8e12, START - 1, Date.now() / 1000 + 2 * 86_400, -1, 0, Number.MAX_VALUE]) {
      expect([v, at(v).postedAt]).toEqual([v, null]);
    }
    expect(render(thread([{ ...at(8e12), number: 1 }])).markdown).toContain(', unknown date\n');
  });

  it('keeps a date inside the range', () => {
    expect(at(START).postedAt).toBe('2005-01-01T00:00:00.000Z');
    expect(at(1793000000).postedAt).toBe('2026-10-26T07:33:20.000Z');
    const soon = Math.floor(Date.now() / 1000) + 3600;
    expect(at(soon).postedAt).toBe(new Date(soon * 1000).toISOString());
  });

  it('writes an edit date outside the range as a plain edited', () => {
    expect(at(1793000000, 8e12).signals).toContain('edited');
    expect(at(1793000000, 1793100000).signals).toContain('edited 2026-10-27 11:20 UTC');
  });

  it('formatDate keeps the minutes of a year beyond 9999', () => {
    expect(formatDate('+255479-11-28T14:13:20.000Z')).toBe('+255479-11-28 14:13 UTC');
    expect(formatDate('2026-11-01T10:05:42.000Z')).toBe('2026-11-01 10:05 UTC');
  });
});

// R5, fix round 3: a crafted file of about 150,000 tiny comments. Each comment costs a post, an
// author row and a rendered block, so a file of them held the server loop for 0.55 to 1.1 s on
// import and 0.2 to 0.4 s on every page read. The first MAX_IMPORT_COMMENTS are kept.

/**
 * `n` comments in pairs, a top-level comment and one reply, each by its own author, each
 * mentioning its own name and carrying an entity; the file is saved without raw_json=1.
 */
const manyComments = (n: number): string => {
  const kids: unknown[] = [];
  for (let i = 0; i < n; i += 2) {
    const a = i.toString(36);
    const b = (i + 1).toString(36);
    const reply = { kind: 't1', data: { id: `d${b}`, parent_id: `t1_c${a}`, author: `w${b}`, body: `u/mn${b} &amp; x`, score: 1 } };
    kids.push({ kind: 't1', data: { id: `c${a}`, parent_id: 't3_abc123', author: `v${a}`, body: `u/mn${a} &lt;3`, score: 2, replies: { kind: 'Listing', data: { children: [reply] } } } });
  }
  return threadDoc({ selftext_html: '&lt;div&gt;' }, kids);
};

const KEPT_NOTE = (n: string) => `Kept the first 20,000 comments; ${n} more in the file were not kept`;

describe('item 7: a thread keeps at most 20,000 comments', () => {
  const N = 150_000;
  let doc: string;
  beforeAll(() => {
    doc = manyComments(N);
  });

  it('parses, saves and renders a 20 MB file of 150,000 tiny comments, each under 1 s', () => {
    expect(doc.length).toBeGreaterThan(19 * 1024 * 1024);
    expect(Buffer.byteLength(doc)).toBeLessThan(MAX_IMPORT_BYTES);
    expect(MAX_IMPORT_COMMENTS).toBe(20_000);

    const { value: r, ms: parseMs } = timed(() => parseRedditImport(doc));
    expect(parseMs).toBeLessThan(BAR_MS);
    const t = r.thread;
    expect(t.posts).toHaveLength(MAX_IMPORT_COMMENTS + 1);
    expect([r.comments, r.notKept, r.notInFile]).toEqual([MAX_IMPORT_COMMENTS, N - MAX_IMPORT_COMMENTS, 0]);
    expect(t.posts[0]!.notes).toEqual([KEPT_NOTE('130,000')]);
    expect(t.extraction).toBe('saved Reddit JSON, 150000 comments in the file, the first 20,000 kept and 130,000 not kept');
    expect(t.postsExpected).toBe(N + 1);
    // Depth-first in file order: the post, then c0, d1, c2, d3, ...; the last kept is the reply d(19999).
    expect(t.posts[1]).toMatchObject({ number: 2, author: 'v0', bodyMd: `u/${markName('mn0')} <3`, signals: ['in reply to #1', 'score 2'] });
    expect(t.posts[2]).toMatchObject({ number: 3, author: 'w1', bodyMd: `u/${markName('mn1')} & x`, signals: ['in reply to #2', 'score 1'] });
    const last = (MAX_IMPORT_COMMENTS - 1).toString(36);
    expect(t.posts.at(-1)).toMatchObject({ number: MAX_IMPORT_COMMENTS + 1, author: `w${last}`, bodyMd: `u/${markName(`mn${last}`)} & x` });

    const db = openArchive(':memory:');
    try {
      const store = new ThreadStore(db, SALT);
      const { value: id, ms: saveMs } = timed(() => store.save(SRC, t, FETCHED));
      expect(saveMs).toBeLessThan(BAR_MS);
      // Every kept comment's author, the post's author, and the first 5,000 names mentioned.
      expect((db.prepare('SELECT count(*) AS n FROM authors').get() as { n: number }).n).toBe(1 + MAX_IMPORT_COMMENTS + MAX_MENTIONED_NAMES);
      expect((db.prepare('SELECT count(*) AS n FROM posts').get() as { n: number }).n).toBe(MAX_IMPORT_COMMENTS + 1);

      // What a page read does: the stored thread, read back and rendered.
      const { value: r2, ms: readMs } = timed(() => {
        const stored = store.getById(id)!;
        return renderThread(toRenderInput(SRC, { ...t, posts: stored.posts }, FETCHED), mode);
      });
      expect(readMs).toBeLessThan(BAR_MS);
      expect(r2.markdown).toContain(`_${KEPT_NOTE('130,000')}._`);
    } finally {
      db.close();
    }

    const { value: out, ms: renderMs } = timed(() => render(t));
    expect(renderMs).toBeLessThan(BAR_MS);
    expect(out.markdown).toContain(`_${KEPT_NOTE('130,000')}._`);
    expect(out.markdown).toContain(`u/${P('mn0')} <3`);
    expect(findLeaks(out.markdown.slice(0, 50_000), ['alice', 'v0', 'w1', 'mn0', 'mn1'])).toEqual(new Map());
    expect(findLeaks(out.markdown.slice(-50_000), [`w${last}`, `mn${last}`])).toEqual(new Map());
  });

  it('keeps exactly 20,000 comments without a note', () => {
    const r = parseRedditImport(manyComments(MAX_IMPORT_COMMENTS));
    expect([r.thread.posts.length, r.comments, r.notKept]).toEqual([MAX_IMPORT_COMMENTS + 1, MAX_IMPORT_COMMENTS, 0]);
    expect(r.thread.posts[0]!.notes).toEqual([]);
    expect(r.thread.extraction).toBe('saved Reddit JSON, 20000 comments in the file');
  });

  it('drops the comments past the cap with their replies, counts the "more" stubs past it, and checks every comment', () => {
    const c = (id: string, data: Record<string, unknown> = {}) => ({ kind: 't1', data: { id, parent_id: 't3_abc123', author: 'bob', body: 'hi', ...data } });
    const kids: unknown[] = Array.from({ length: MAX_IMPORT_COMMENTS - 1 }, (_v, i) => c(`c${i.toString(36)}`));
    const reply2 = c('r2', { parent_id: 't1_r1', author: 'erin' });
    const reply1 = c('r1', { parent_id: 't1_clast', author: 'dave', replies: { kind: 'Listing', data: { children: [reply2] } } });
    kids.push(c('clast', { replies: { kind: 'Listing', data: { children: [reply1] } } }));
    kids.push({ kind: 'more', data: { id: 'zz', parent_id: 't3_abc123', count: 5, children: ['a'] } });
    kids.push(c('cafter', { author: 'frank' }));
    const r = parseRedditImport(threadDoc({ num_comments: 40_000 }, kids));
    expect([r.thread.posts.length, r.comments, r.notKept, r.notInFile]).toEqual([MAX_IMPORT_COMMENTS + 1, MAX_IMPORT_COMMENTS, 3, 5]);
    expect(r.thread.posts[0]!.notes).toEqual(['Kept the first 20,000 comments; 3 more in the file were not kept']);
    expect(r.thread.posts.at(-1)!.bodyMd).toBe('hi');
    expect(r.thread.posts.some((p) => ['dave', 'erin', 'frank'].includes(p.author))).toBe(false);
    expect(r.thread.extraction).toBe('saved Reddit JSON, 20003 of 40000 comments in the file, the first 20,000 kept and 3 not kept');
    expect(r.thread.postsExpected).toBe(40_001);

    const plain = Array.from({ length: MAX_IMPORT_COMMENTS }, (_v, i) => c(`c${i.toString(36)}`));
    const one = parseRedditImport(threadDoc({}, [...plain, c('cx')]));
    expect(one.thread.posts[0]!.notes).toEqual(['Kept the first 20,000 comments; 1 more in the file was not kept']);
    expect(one.thread.extraction).toBe('saved Reddit JSON, 20001 comments in the file, the first 20,000 kept and 1 not kept');
    expect(one.thread.postsExpected).toBe(MAX_IMPORT_COMMENTS + 2);

    // A comment past the cap is checked as every other: a file with a broken one is refused.
    expect(() => parseRedditImport(threadDoc({}, [...plain, c('cy', { body: 7 })]))).toThrow(`Comment ${MAX_IMPORT_COMMENTS + 1} in the file has no body.`);
  });
});

describe('item 7 through the server: importing 150,000 tiny comments', () => {
  let home: string;
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-import-costs-'));
    for (const dir of ['seed', 'ui-files']) fs.mkdirSync(path.join(home, dir));
    const noBrowser: LaunchFn = async () => {
      throw new Error('no browser here');
    };
    s = await startServer({ paths: lurkdPaths({ LURKD_HOME: home }), seedDir: path.join(home, 'seed'), uiDir: path.join(home, 'ui-files'), launch: noBrowser });
  });
  afterAll(async () => {
    await s?.close();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  /** Wall time of `f`, and the longest the event loop went without running a 5 ms timer meanwhile. */
  const watched = async <T>(f: () => Promise<T>): Promise<{ value: T; ms: number; stallMs: number }> => {
    let last = performance.now();
    let stallMs = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      stallMs = Math.max(stallMs, now - last);
      last = now;
    }, 5);
    const t0 = performance.now();
    try {
      const value = await f();
      const ms = performance.now() - t0;
      stallMs = Math.max(stallMs, performance.now() - last);
      return { value, ms, stallMs };
    } finally {
      clearInterval(tick);
    }
  };

  it('answers the import route and the page read, each under 1 s, keeping 20,000 comments', async () => {
    const doc = manyComments(150_000);
    const base = `http://127.0.0.1:${s.port}`;
    const imported = await watched(async () => {
      const r = await fetch(`${base}/api/import/reddit`, { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: doc });
      return { status: r.status, body: (await r.json()) as { threadId: number; posts: number; comments: number } };
    });
    expect(imported.value.status).toBe(200);
    expect(imported.value.body).toMatchObject({ posts: MAX_IMPORT_COMMENTS + 1, comments: MAX_IMPORT_COMMENTS });
    expect(imported.ms).toBeLessThan(BAR_MS);
    expect(imported.stallMs).toBeLessThan(BAR_MS);

    const cookie = await pageCookie(s.port, s.token);
    const read = await watched(async () => {
      const r = await fetch(`${base}/api/threads/${imported.value.body.threadId}`, { headers: { cookie } });
      return { status: r.status, body: (await r.json()) as { markdown: string } };
    });
    expect(read.value.status).toBe(200);
    expect(read.value.body.markdown).toContain(`_${KEPT_NOTE('130,000')}._`);
    expect(read.ms).toBeLessThan(BAR_MS);
    expect(read.stallMs).toBeLessThan(BAR_MS);
  });
});
