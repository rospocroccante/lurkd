import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { openArchive } from '../../src/archive/db.js';
import { StateStore } from '../../src/archive/state.js';
import { ThreadStore } from '../../src/archive/threads.js';
import type { BrowserManager } from '../../src/browser/manager.js';
import { guardDecision } from '../../src/browser/guard.js';
import { formatError, formatFetch, formatSources } from '../../src/client/format.js';
import { LurkdError } from '../../src/errors.js';
import {
  MAX_BODY_CHARS,
  MAX_COMMENT_COUNT,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_COMMENTS,
  parseRedditFile,
  parseRedditImport,
  parseRedditThread,
  REDDIT_IMPORT_SOURCE_ID,
  redditThreadId,
  redditThreadUrl,
} from '../../src/extract/reddit-import.js';
import { FetchQueue } from '../../src/fetch/queue.js';
import { FetchService, parseFetchRequest } from '../../src/fetch/service.js';
import { nameResolver, renderThread, toRenderInput } from '../../src/output/render.js';
import { HostPacer } from '../../src/policy/limiter.js';
import { isRedditHost } from '../../src/policy/urls.js';
import { findLeaks, markName, namesIn, pseudonym } from '../../src/pseudonym.js';
import { REDDIT_IMPORT_SOURCE } from '../../src/sources/builtin.js';
import type { ResolveHost } from '../../src/sources/analyse.js';
import { DraftStore, SampleStore } from '../../src/sources/drafts.js';
import { Registry } from '../../src/sources/registry.js';
import { parseSource } from '../../src/sources/schema.js';
import { fixture } from '../helpers/common.js';

// D50: a Reddit thread the user saved by hand (the thread address with .json added) becomes an
// archived thread under the built-in source reddit-import. Nothing here touches the network.

const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin'];
const SALT = 'b'.repeat(64);
const pseudo = (name: string) => pseudonym(REDDIT_IMPORT_SOURCE_ID, name, SALT);

const raw = () => fixture('reddit/thread.json');
const escaped = () => fixture('reddit/thread-escaped.json');

describe('parseRedditFile', () => {
  const t = parseRedditFile(raw());
  const n = (k: number) => t.posts[k - 1]!;

  it('opens with the post as #1 and numbers the comments depth-first in file order', () => {
    expect(t.posts.map((p) => [p.number, p.author])).toEqual([
      [1, 'alice'],
      [2, 'bob'],
      [3, 'alice'],
      [4, 'carol'],
      [5, ''],
      [6, 'dave'],
      [7, ''],
      [8, 'erin'],
    ]);
    expect(t.engine).toBe('import');
    expect(t.url).toBe('https://www.reddit.com/comments/1k2m3n4/');
    expect(t.title).toBe(`Zigbee coordinator drops after the update (thanks u/${markName('erin')} for the first hint)`);
    expect(t.postsExpected).toBe(21);
    expect(t.pages).toBeNull();
    expect(t.quality).toBe('full');
    expect(t.extraction).toBe('saved Reddit JSON, r/homeassistant, 7 of 20 comments in the file');
    expect(t.posts.every((p) => p.page === null && p.authorUrl === null)).toBe(true);
    expect(n(1).postedAt).toBe(new Date(1793000000 * 1000).toISOString());
  });

  it('says which post each comment answers, from parent_id', () => {
    const replyTo = t.posts.slice(1).map((p) => p.signals.find((s) => s.startsWith('in reply to')));
    expect(replyTo).toEqual(['in reply to #1', 'in reply to #2', 'in reply to #3', 'in reply to #2', 'in reply to #1', 'in reply to #1', 'in reply to #7']);
  });

  it('carries score, OP, flair, distinguished, pinned and edited as signals', () => {
    expect(n(1).signals).toEqual(['r/homeassistant', 'score 42', 'post flair: "Support"']);
    expect(n(2).signals).toEqual(['in reply to #1', 'score 15', 'flair: "Z2M user"']);
    expect(n(3).signals).toEqual(['in reply to #2', 'score 8', 'OP', 'edited 2026-10-27 11:20 UTC']);
    expect(n(6).signals).toEqual(['in reply to #1', 'score hidden', 'flair: "Mod"', 'moderator', 'pinned']);
    expect(n(8).signals).toEqual(['in reply to #7', 'score 5', 'edited']);
  });

  it('keeps removed and deleted comments as placeholders without an author', () => {
    expect([n(5).author, n(5).bodyMd]).toEqual(['', '[deleted]']);
    expect([n(7).author, n(7).bodyMd]).toEqual(['', '[removed]']);
  });

  it('turns "more" stubs into notes on the post they answer', () => {
    expect(n(1).notes).toEqual(['7 more comments are not in the saved file']);
    expect(n(3).notes).toEqual(['4 more comments are not in the saved file']);
    expect(n(8).notes).toEqual(['Further replies are not in the saved file']);
    expect(n(2).notes).toEqual([]);
  });

  it('marks u/ and /u/ mentions, in text and in Reddit profile links, and leaves subreddits alone', () => {
    expect(n(1).bodyMd).toContain(`u/${markName('erin')} suggested`);
    expect(n(1).bodyMd).toContain(`/u/${markName('dave')} pinned`);
    expect(n(4).bodyMd).toContain(`/u/${markName('dave')} wrote a guide`);
    expect(n(4).bodyMd).toContain(`https://www.reddit.com/user/${markName('dave')}/comments/1k0zzzz/`);
    expect(n(4).bodyMd).toContain('(https://www.reddit.com/r/homeassistant/wiki/zigbee)');
    expect(namesIn(n(2).bodyMd)).toEqual(['alice']);
    expect(namesIn(n(3).bodyMd)).toEqual(['bob']);
  });

  it('keeps raw_json text as it is and drops the zero-width filler Reddit writes', () => {
    expect(n(1).bodyMd).toContain('AT&T fibre router');
    expect(n(1).bodyMd).toContain('channel 11 & Zigbee');
    expect(n(1).bodyMd).toContain('x < y here.');
    expect(n(1).bodyMd).not.toMatch(/&#x200B;|​/i);
    expect(n(1).bodyMd).not.toMatch(/\n{3,}/);
  });

  it('unescapes the entities of a file saved without raw_json', () => {
    const e = parseRedditFile(escaped());
    expect(e.title).toBe(`Backups & restores: what u/${markName('dave')} uses <3`);
    expect(e.posts[0]!.bodyMd).toBe('Link: https://example.org/backups?a=1&b=2');
    expect(e.posts[0]!.signals).toEqual(['r/selfhosted', 'score 120', 'post flair: "Guide"', 'flair: "Tom & Jerry fan"']);
    expect(e.posts[1]!.bodyMd).toBe(`R&D at work uses restic > borg. Ask u/${markName('bob')} or u/${markName('erin')}.`);
    expect(e.posts[1]!.signals).toContain('Reddit admin');
    expect(e.extraction).toBe('saved Reddit JSON, r/selfhosted, 1 of 1 comment in the file');
  });

  it('strips name markers that arrive in the file, so only its mentions come out marked', () => {
    const doc = JSON.parse(raw()) as any;
    doc[1].data.children[1].data.body = 'Hidden carol name.';
    const p = parseRedditThread(doc).posts[5]!;
    expect(p.bodyMd).toBe('Hidden carol name.');
  });

  it('marks the profile name of a post made on a user profile', () => {
    const doc = JSON.parse(raw()) as any;
    doc[0].data.children[0].data.subreddit = 'u_carol';
    const p = parseRedditThread(doc);
    expect(p.posts[0]!.signals[0]).toBe(`u/${markName('carol')}`);
    expect(p.extraction).toBe('saved Reddit JSON, a user profile, 7 of 20 comments in the file');
  });

  it('leaves out a subreddit name Reddit would not allow, so it cannot add front matter lines', () => {
    const doc = JSON.parse(raw()) as any;
    doc[0].data.children[0].data.subreddit = 'x\nsource: other';
    const p = parseRedditThread(doc);
    expect(p.extraction).toBe('saved Reddit JSON, 7 of 20 comments in the file');
    expect(p.posts[0]!.signals[0]).toBe('score 42');
  });

  it('reads a link post: the link opens the body', () => {
    const e = parseRedditFile(escaped());
    expect(e.posts[0]!.author).toBe('bob');
  });

  it('accepts a byte order mark', () => {
    expect(parseRedditFile(`﻿${raw()}`).posts).toHaveLength(8);
  });

  it('nests a deep reply chain without recursion limits', () => {
    const doc = JSON.parse(raw()) as any;
    const leaf = (id: string, parent: string, replies: unknown) => ({
      kind: 't1',
      data: { id, name: `t1_${id}`, parent_id: parent, author: 'bob', body: 'deep', score: 1, created_utc: 1793000000, replies },
    });
    let node: unknown = '';
    for (let i = 5000; i >= 1; i--) node = { kind: 'Listing', data: { children: [leaf(`d${i}`, i === 1 ? 't3_1k2m3n4' : `t1_d${i - 1}`, node)] } };
    doc[1].data.children = (node as any).data.children;
    const p = parseRedditThread(doc);
    expect(p.posts).toHaveLength(5001);
    expect(p.posts[5000]!.signals[0]).toBe('in reply to #5000');
  });
});

describe('parseRedditFile refuses what is not one Reddit thread', () => {
  const refused = (text: string) => {
    try {
      parseRedditFile(text);
    } catch (e) {
      expect(e).toBeInstanceOf(LurkdError);
      expect((e as LurkdError).code).toBe('invalid_request');
      return (e as LurkdError).message;
    }
    throw new Error('parseRedditFile accepted the input');
  };

  it('refuses text that is not JSON, without echoing it', () => {
    const m = refused('-----BEGIN OPENSSH PRIVATE KEY----- secret');
    expect(m).toMatch(/^The file is not JSON\./);
    expect(m).not.toContain('secret');
    expect(m).not.toContain('BEGIN');
    expect(refused('')).toMatch(/^The file is empty\./);
  });

  it('refuses a saved web page with a hint to save the .json address', () => {
    expect(refused('<!doctype html><html><body>alice</body></html>')).toMatch(/^The file is a web page, not JSON\./);
  });

  it('refuses a subreddit or search listing', () => {
    expect(refused(fixture('reddit/subreddit-listing.json'))).toMatch(/^The file holds a list of posts, not one thread\./);
  });

  it('refuses other JSON and broken thread shapes, naming the part and never the content', () => {
    const doc = () => JSON.parse(raw()) as any;
    const cases: [unknown, RegExp][] = [
      [{ a: 1 }, /not a Reddit thread/],
      [[1, 2], /not a Reddit thread/],
      [[], /not a Reddit thread/],
      [(() => { const d = doc(); d.pop(); return d; })(), /not a Reddit thread/],
      [(() => { const d = doc(); d[0].data.children = []; return d; })(), /has no post/],
      [(() => { const d = doc(); d[0].data.children[0].kind = 't1'; return d; })(), /has no post/],
      [(() => { const d = doc(); d[0].data.children[0].data.id = '../x'; return d; })(), /The post .*id/],
      [(() => { const d = doc(); delete d[0].data.children[0].data.title; return d; })(), /The post .*title/],
      [(() => { const d = doc(); d[0].data.children[0].data.author = 7; return d; })(), /The post .*author/],
      [(() => { const d = doc(); delete d[1].data.children[0].data.body; return d; })(), /Comment 1 .*body/],
      [(() => { const d = doc(); d[1].data.children[0].data.parent_id = 'zzz'; return d; })(), /Comment 1 .*parent_id/],
      [(() => { const d = doc(); d[1].data.children[0].data.replies = 'yes'; return d; })(), /Comment 1 .*replies/],
      [(() => { const d = doc(); d[1].data.children[1].kind = 't5'; return d; })(), /unknown kind/],
      [(() => { const d = doc(); d[1].data.children[3].data.count = 'many'; return d; })(), /"more" entry/],
    ];
    for (const [value, re] of cases) {
      const m = refused(JSON.stringify(value));
      expect(m).toMatch(re);
      for (const name of NAMES) expect(m).not.toContain(name);
    }
  });

  it('refuses a file over 20 MB', () => {
    expect(MAX_IMPORT_BYTES).toBe(20 * 1024 * 1024);
    expect(refused(' '.repeat(MAX_IMPORT_BYTES + 1))).toMatch(/larger than 20 MB/);
  });
});

// A thread file whose post has the given fields over a minimal valid post, and these comments.
const threadDoc = (post: Record<string, unknown>, comments: unknown[] = []): string =>
  JSON.stringify([
    { kind: 'Listing', data: { children: [{ kind: 't3', data: { id: 'abc123', title: 'A title', author: 'alice', selftext: '', ...post } }] } },
    { kind: 'Listing', data: { children: comments } },
  ]);
const comment = (id: string, data: Record<string, unknown> = {}) => ({
  kind: 't1',
  data: { id, parent_id: 't3_abc123', author: 'bob', body: 'hi', ...data },
});
const more = (data: Record<string, unknown>) => ({ kind: 'more', data: { id: 'zz', parent_id: 't3_abc123', ...data } });

describe('"more" stubs on one post become one note each kind (C5)', () => {
  it('adds up the counts of several stubs under the same post into one note', () => {
    const r = parseRedditImport(threadDoc({}, [comment('c1'), more({ count: 3, children: ['a'] }), more({ count: 4, children: ['b'] }), more({ count: 1, children: ['c'] })]));
    expect(r.thread.posts[0]!.notes).toEqual(['8 more comments are not in the saved file']);
    expect(r.notInFile).toBe(8);
  });

  it('keeps one "further replies" note however many empty stubs a post has, next to its count note', () => {
    const r = parseRedditImport(threadDoc({}, [more({ count: 0 }), more({ count: 2, children: ['a', 'b'] }), more({ count: 0 }), more({ count: 1, children: ['c'] })]));
    expect(r.thread.posts[0]!.notes).toEqual(['Further replies are not in the saved file', '3 more comments are not in the saved file']);
  });

  it('keeps the notes of each post apart', () => {
    const r = parseRedditImport(
      threadDoc({}, [
        comment('c1', { replies: { kind: 'Listing', data: { children: [more({ parent_id: 't1_c1', count: 2, children: ['a'] }), more({ parent_id: 't1_c1', count: 5, children: ['b'] })] } } }),
        more({ count: 1, children: ['c'] }),
      ]),
    );
    expect(r.thread.posts[0]!.notes).toEqual(['1 more comment is not in the saved file']);
    expect(r.thread.posts[1]!.notes).toEqual(['7 more comments are not in the saved file']);
  });

  it('holds the number of notes to at most two per post for thousands of stubs', () => {
    const stubs = Array.from({ length: 5000 }, (_, i) => more({ id: `m${i}`, count: i % 3, children: i % 3 === 0 ? [] : ['x'] }));
    const r = parseRedditImport(threadDoc({}, stubs));
    expect(r.thread.posts[0]!.notes).toEqual(['Further replies are not in the saved file', `${r.notInFile} more comments are not in the saved file`]);
    expect(r.notInFile).toBe(Array.from({ length: 5000 }, (_, i) => i % 3).reduce((a, b) => a + b, 0));
  });
});

describe('parseRedditFile runs in linear time on pathological text (H1)', () => {
  const M = 1_000_000;
  const timed = <T>(f: () => T): { value: T; ms: number } => {
    const t0 = performance.now();
    const value = f();
    return { value, ms: performance.now() - t0 };
  };
  const body = (selftext: string): string => timed(() => parseRedditFile(threadDoc({ selftext }))).value.posts[0]!.bodyMd;
  // R5 round 2: a body is kept to MAX_BODY_CHARS (cut, then trimmed at its end); the cleaning
  // before the cut still runs over the whole text, so these cases still measure it.
  const capped = (s: string): string => (s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS).trimEnd() : s);
  const same = (want: string) => (o: string) => expect(o === capped(want)).toBe(true);
  const cases: [string, string, (out: string) => void][] = [
    ['1,000,000 spaces then x', `${' '.repeat(M)}x`, (o) => expect(o).toBe('x')],
    ['1,000,000 tabs then x', `${'\t'.repeat(M)}x`, (o) => expect(o).toBe('x')],
    ['spaces and tabs mixed, then x', `${' \t'.repeat(M / 2)}x`, (o) => expect(o).toBe('x')],
    ['a word, 1,000,000 spaces, a word', `a${' '.repeat(M)}b`, (o) => expect(o).toBe('a')],
    ['lines with trailing spaces', 'line   \n'.repeat(M / 8), same(Array(M / 8).fill('line').join('\n'))],
    ['lines of one space', `${' \n'.repeat(M / 2)}x`, (o) => expect(o).toBe('x')],
    ['1,000,000 line ends inside text', `a${'\n'.repeat(M)}b`, (o) => expect(o).toBe('a\n\nb')],
    ['1,000,000 carriage returns', `a${'\r'.repeat(M)}b`, (o) => expect(o).toBe('a\n\nb')],
    ['pairs of line ends', `${'a\n\n'.repeat(M / 3)}b`, same(`${'a\n\n'.repeat(M / 3)}b`)],
    ['zero-width filler', `${'​'.repeat(M)}x`, (o) => expect(o).toBe('x')],
    ['zero-width entities', `${'&#x200b;'.repeat(M / 8)}x`, (o) => expect(o).toBe('x')],
    ['name markers from the file', `${''.repeat(M / 2)}x`, (o) => expect(o).toBe('x')],
    ['an unclosed marker before a long run', `${'a'.repeat(M)}`, same('a'.repeat(M))],
    ['u/ prefixes without names', `${'u/'.repeat(M / 2)}x`, same(`${'u/'.repeat(M / 2)}x`)],
    ['/user/ prefixes without names', `${'/user/'.repeat(M / 6)}x`, same(`${'/user/'.repeat(M / 6)}x`)],
    ['an overlong escaped name', `u/${'a\\_'.repeat(M / 3)}`, (o) => expect(namesIn(o)).toEqual([])],
    ['many mentions', 'u/abc '.repeat(M / 6), (o) => expect(namesIn(o)).toEqual(['abc'])],
    ['r/u_ prefixes', `${'r/u_'.repeat(M / 4)}x`, same(`${'r/u_'.repeat(M / 4)}x`)],
    ['entities in a file saved without raw_json', '&amp;'.repeat(M / 5), same('&'.repeat(M / 5))],
    ['ampersands that are no entity', `${'&amp'.repeat(M / 4)}x`, same(`${'&amp'.repeat(M / 4)}x`)],
    ['a numeric entity that never ends', `&amp; &#${'1'.repeat(M)}`, same(`&amp; &#${'1'.repeat(M)}`)],
    ['hex entities that never end', `&amp; ${'&#x'.repeat(M / 6)}${'a'.repeat(M / 2)}`, (o) => expect(o.startsWith('&amp; &#x')).toBe(true)],
    ['backticks and hashes', `${'`'.repeat(M / 2)}${'#'.repeat(M / 2)}`, same(`${'`'.repeat(M / 2)}${'#'.repeat(M / 2)}`)],
  ];

  it.each(cases)('%s', (_name, selftext, check) => {
    const { value: out, ms } = timed(() => body(selftext));
    check(out);
    expect(ms).toBeLessThan(2000);
  });

  it('a title, a link and a flair of 1,000,000 spaces', () => {
    const doc = threadDoc({ title: `${' '.repeat(M)}T${' '.repeat(M)}`, is_self: false, url: `${' '.repeat(M)}https://example.org/x${' '.repeat(M)}`, author_flair_text: `${' '.repeat(M)}F` });
    const { value: t, ms } = timed(() => parseRedditFile(doc));
    expect(ms).toBeLessThan(2000);
    expect(t.title).toBe('T');
    expect(t.posts[0]!.bodyMd).toBe('Link: https://example.org/x');
    expect(t.posts[0]!.signals).toContain('flair: "F"');
  });

  it('many small comments, up to the 20 MB limit', () => {
    const n = 150_000;
    const doc = threadDoc({}, Array.from({ length: n }, (_v, i) => comment(`c${i}`, { body: `reply   \n\n\n${i}`, score: i })));
    expect(doc.length).toBeLessThan(MAX_IMPORT_BYTES);
    const { value: t, ms } = timed(() => parseRedditFile(doc));
    expect(ms).toBeLessThan(2000);
    // R5 round 3: the first MAX_IMPORT_COMMENTS are kept, the rest counted in a note on #1.
    expect(t.posts).toHaveLength(MAX_IMPORT_COMMENTS + 1);
    expect(t.posts[MAX_IMPORT_COMMENTS]!.bodyMd).toBe(`reply\n\n${MAX_IMPORT_COMMENTS - 1}`);
    expect(t.posts[0]!.notes).toEqual(['Kept the first 20,000 comments; 130,000 more in the file were not kept']);
  });

  it('renders a pathological body in linear time too', () => {
    const t = parseRedditFile(threadDoc({ selftext: `a${' '.repeat(M)}\n${'`'.repeat(M)}x\n${'# '.repeat(M / 2)}` }));
    const mode = nameResolver({ sourceId: REDDIT_IMPORT_SOURCE_ID, salt: SALT, realNames: false });
    const { value: r, ms } = timed(() => renderThread(toRenderInput(REDDIT_IMPORT_SOURCE_ID, t, '2026-11-10T09:00:00.000Z'), mode));
    expect(ms).toBeLessThan(2000);
    expect(r.markdown).toContain(`a\n${'`'.repeat(MAX_BODY_CHARS - 2)}\n`);
    expect(r.markdown).toContain('_Cut at 100,000 characters: the rest of this post is not kept._');
  });
});

describe('numbers in the file are taken only when they are sane (L4)', () => {
  it('ignores a comment count that is not a non-negative safe integer within the cap', () => {
    for (const num_comments of [1e300, Number.MAX_SAFE_INTEGER + 2, MAX_COMMENT_COUNT + 1, -1, 2.5, '7']) {
      const t = parseRedditFile(threadDoc({ num_comments }, [comment('c1')]));
      expect([num_comments, t.extraction, t.postsExpected]).toEqual([num_comments, 'saved Reddit JSON, 1 comment in the file', null]);
    }
    const ok = parseRedditFile(threadDoc({ num_comments: MAX_COMMENT_COUNT }, [comment('c1')]));
    expect([ok.extraction, ok.postsExpected]).toEqual([`saved Reddit JSON, 1 of ${MAX_COMMENT_COUNT} comments in the file`, MAX_COMMENT_COUNT + 1]);
  });

  it('ignores a "more" count beyond the cap and falls back to its children', () => {
    const r = parseRedditImport(threadDoc({}, [comment('c1'), more({ count: 1e300, children: ['a', 'b'] })]));
    expect(r.notInFile).toBe(2);
    expect(r.thread.posts[0]!.notes).toEqual(['2 more comments are not in the saved file']);
    expect(r.thread.postsExpected).toBe(4);
    const big = parseRedditImport(threadDoc({}, [more({ count: MAX_COMMENT_COUNT + 1 })]));
    expect([big.notInFile, big.thread.posts[0]!.notes]).toEqual([0, ['Further replies are not in the saved file']]);
    const unsafe = parseRedditImport(threadDoc({}, [more({ count: Number.MAX_SAFE_INTEGER + 2, children: ['a'] })]));
    expect(unsafe.notInFile).toBe(1);
  });

  it('caps the total of "more" counts', () => {
    const r = parseRedditImport(threadDoc({}, [more({ count: MAX_COMMENT_COUNT }), more({ count: MAX_COMMENT_COUNT }), more({ count: 5 })]));
    expect(r.notInFile).toBe(MAX_COMMENT_COUNT);
    expect(Number.isSafeInteger(r.thread.postsExpected)).toBe(true);
  });

  it('still refuses a "more" count that is not a whole number', () => {
    expect(() => parseRedditFile(threadDoc({}, [more({ count: -1 })]))).toThrow(/"more" entry/);
    expect(() => parseRedditFile(threadDoc({}, [more({ count: 1.5 })]))).toThrow(/"more" entry/);
  });

  it('leaves out a score that is not a safe integer within the cap', () => {
    for (const score of [1e300, -1e300, Number.MAX_SAFE_INTEGER + 2, 2.5]) {
      const t = parseRedditFile(threadDoc({ score }, [comment('c1', { score })]));
      expect([score, t.posts[0]!.signals, t.posts[1]!.signals]).toEqual([score, [], ['in reply to #1']]);
    }
    const t = parseRedditFile(threadDoc({ score: -12 }, [comment('c1', { score: 30_000 })]));
    expect([t.posts[0]!.signals, t.posts[1]!.signals]).toEqual([['score -12'], ['in reply to #1', 'score 30000']]);
  });
});

describe('flair text cannot pose as other signals (L5)', () => {
  it('quotes the flair, so commas in it stay inside one signal', () => {
    const t = parseRedditFile(
      threadDoc({ link_flair_text: 'Solved, pinned', author_flair_text: 'x, moderator, OP' }, [comment('c1', { author_flair_text: 'Reddit admin, OP' })]),
    );
    expect(t.posts[0]!.signals).toEqual(['post flair: "Solved, pinned"', 'flair: "x, moderator, OP"']);
    expect(t.posts[1]!.signals).toEqual(['in reply to #1', 'flair: "Reddit admin, OP"']);
    const mode = nameResolver({ sourceId: REDDIT_IMPORT_SOURCE_ID, salt: SALT, realNames: false });
    const { markdown } = renderThread(toRenderInput(REDDIT_IMPORT_SOURCE_ID, t, '2026-11-10T09:00:00.000Z'), mode);
    expect(markdown).toContain(`## #2, ${pseudo('bob')} (in reply to #1, flair: "Reddit admin, OP"), `);
  });

  it('escapes quotes and backslashes inside the flair', () => {
    const t = parseRedditFile(threadDoc({ author_flair_text: 'say "hi", OP\\' }));
    expect(t.posts[0]!.signals).toEqual(['flair: "say \\"hi\\", OP\\\\"']);
  });

  it('cuts a long flair inside the quotes and never through a marked name', () => {
    const long = parseRedditFile(threadDoc({ author_flair_text: 'f'.repeat(200) }));
    expect(long.posts[0]!.signals).toEqual([`flair: "${'f'.repeat(80)}..."`]);
    // The cut at 80 characters would fall inside the marked name: the whole name is kept.
    const named = parseRedditFile(threadDoc({ author_flair_text: `${'f'.repeat(70)} u/carolinathename and more` }));
    const signal = named.posts[0]!.signals[0]!;
    expect(namesIn(signal)).toEqual(['carolinathename']);
    const mode = nameResolver({ sourceId: REDDIT_IMPORT_SOURCE_ID, salt: SALT, realNames: false });
    const { markdown } = renderThread(toRenderInput(REDDIT_IMPORT_SOURCE_ID, named, '2026-11-10T09:00:00.000Z'), mode);
    expect(markdown).not.toContain('carolina');
    expect(markdown).toContain(`u/${pseudo('carolinathename')}..."`);
  });
});

describe('rendering an imported thread', () => {
  const t = parseRedditFile(raw());
  const input = toRenderInput(REDDIT_IMPORT_SOURCE_ID, t, '2026-11-10T09:00:00.000Z');

  it('leaves no real name in the output with pseudonyms (findLeaks), in author lines, mentions and the title', () => {
    const { markdown } = renderThread(input, nameResolver({ sourceId: REDDIT_IMPORT_SOURCE_ID, salt: SALT, realNames: false }));
    expect(findLeaks(markdown, NAMES)).toEqual(new Map());
    expect(markdown).toContain(`## #2, ${pseudo('bob')} (in reply to #1, score 15, flair: "Z2M user"), `);
    expect(markdown).toContain(`## #5, unknown author (in reply to #2, score 1), `);
    expect(markdown).toContain(`u/${pseudo('erin')} suggested`);
    expect(markdown).toContain(`title: "Zigbee coordinator drops after the update (thanks u/${pseudo('erin')} for the first hint)"`);
    expect(markdown).toContain(`# Zigbee coordinator drops after the update (thanks u/${pseudo('erin')} for the first hint)`);
    expect(markdown).toContain('_7 more comments are not in the saved file._');
  });

  it('shows real names when the user switched them on', () => {
    const { markdown } = renderThread(input, nameResolver({ sourceId: REDDIT_IMPORT_SOURCE_ID, salt: SALT, realNames: true }));
    expect(findLeaks(markdown, NAMES).size).toBe(5);
  });

  it('says in the front matter that the thread came from a saved file, and only what lurkd knows', () => {
    const { markdown } = renderThread(input, nameResolver({ sourceId: REDDIT_IMPORT_SOURCE_ID, salt: SALT, realNames: false }));
    const front = markdown.split('\n---\n')[0]!;
    expect(front).toContain('engine: import');
    expect(front).toContain('imported: "from a saved file; lurkd did not contact the site"');
    expect(front).not.toContain('the user saved');
    expect(front).not.toContain('imported_by:');
    expect(front).not.toContain('replaced:');
    expect(front).toContain('extraction: saved Reddit JSON, r/homeassistant, 7 of 20 comments in the file');
    expect(front).toContain('posts_expected: 21');
  });

  it('cuts at max_chars and resumes at from_post like any thread', () => {
    const mode = nameResolver({ sourceId: REDDIT_IMPORT_SOURCE_ID, salt: SALT, realNames: false });
    const first = renderThread(input, mode, { maxChars: 1200 });
    expect(first.truncated).toBe(true);
    const next = renderThread(input, mode, { fromPost: first.nextFromPost! });
    expect(next.markdown).toContain(`## #${first.nextFromPost},`);
  });
});

describe('Reddit addresses', () => {
  it('knows the Reddit hosts', () => {
    for (const h of ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'np.reddit.com', 'm.reddit.com', 'redd.it', 'i.redd.it', 'v.redd.it', 'www.redditmedia.com', 'www.redditstatic.com', 'redditinc.com', 'www.redditinc.com', 'REDDITINC.COM.', 'REDDIT.COM', 'reddit.com.'])
      expect([h, isRedditHost(h)]).toEqual([h, true]);
    for (const h of ['notreddit.com', 'reddit.com.example', 'example.org', 'redd.it.example', 'reddit.co', 'notredditinc.com', 'redditinc.com.example']) expect([h, isRedditHost(h)]).toEqual([h, false]);
  });

  it('reads the thread id from every thread address form', () => {
    expect(redditThreadId('https://www.reddit.com/r/homeassistant/comments/1k2m3n4/zigbee/')).toBe('1k2m3n4');
    expect(redditThreadId('https://old.reddit.com/r/homeassistant/comments/1k2m3n4/zigbee/m1aaaa1/?context=3')).toBe('1k2m3n4');
    expect(redditThreadId('https://reddit.com/comments/1k2m3n4')).toBe('1k2m3n4');
    expect(redditThreadId('https://www.reddit.com/r/homeassistant/comments/1k2m3n4/zigbee.json')).toBe('1k2m3n4');
    expect(redditThreadId('https://redd.it/1k2m3n4')).toBe('1k2m3n4');
    expect(redditThreadId('https://www.reddit.com/r/homeassistant/s/AbCdEf')).toBeNull();
    expect(redditThreadId('https://www.reddit.com/r/homeassistant/')).toBeNull();
    expect(redditThreadId('https://forum.example/comments/1k2m3n4')).toBeNull();
    expect(redditThreadId('not a url')).toBeNull();
    expect(redditThreadUrl('1k2m3n4')).toBe('https://www.reddit.com/comments/1k2m3n4/');
  });

  it('the guard refuses every Reddit request, whatever the source lists', () => {
    const source = { ...REDDIT_IMPORT_SOURCE, enabled: true };
    for (const url of ['https://www.reddit.com/comments/1k2m3n4.json', 'https://i.redd.it/x.png', 'https://www.redditstatic.com/a.js', 'https://redditinc.com/policies/user-agreement', 'https://www.redditinc.com/'])
      expect(guardDecision({ source, jobId: null, armed: false }, 'GET', url)).toMatchObject({ allow: false, kind: 'blocked', note: 'reddit' });
  });
});

describe('source YAML cannot claim Reddit', () => {
  const yaml = (domain: string) =>
    YAML.stringify({
      id: 'my-reddit',
      name: 'My Reddit',
      topics: ['general'],
      engine: 'generic',
      base_url: `https://${domain}/`,
      domains: [domain],
      automation: { policy: 'unknown', rule_url: `https://${domain}/rules`, checked_at: '2026-11-10' },
    });

  it('refuses a Reddit host in domains, subdomains included', () => {
    for (const d of ['www.reddit.com', 'reddit.com', 'm.reddit.com', 'redd.it', 'redditinc.com', 'www.redditinc.com']) {
      const r = parseSource(yaml(d), { file: 'my-reddit.yaml' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain(`my-reddit.yaml: domains[0] is a Reddit host: lurkd does not read Reddit live, so no source can list it. Import saved threads with lurkd import reddit <file>.`);
    }
  });

  it('refuses import as an engine in a file', () => {
    const r = parseSource(yaml('forum.example').replace('engine: generic', 'engine: import'), { file: 'my-reddit.yaml' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('engine must be discourse, xenforo, phpbb, vbulletin, generic or custom, not "import"');
  });
});

describe('the built-in reddit-import source', () => {
  let tmp: string;
  let db: Database.Database;
  let state: StateStore;
  let opts: { seedDir: string; userDir: string; state: StateStore; builtins: boolean };
  let reg: Registry;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-reddit-reg-'));
    opts = { seedDir: path.join(tmp, 'seed'), userDir: path.join(tmp, 'user'), state: undefined as unknown as StateStore, builtins: true };
    fs.mkdirSync(opts.seedDir);
    fs.mkdirSync(opts.userDir);
    db = openArchive(':memory:');
    state = new StateStore(db);
    opts.state = state;
    reg = Registry.load(opts);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is in the registry only when the caller asks for built-ins', () => {
    expect(reg.ids()).toEqual(['reddit-import']);
    expect(Registry.load({ ...opts, builtins: false }).ids()).toEqual([]);
    expect(reg.errors()).toEqual([]);
  });

  it('is shown switched off, without a session, search or acknowledgment, and as non-removable', () => {
    expect(reg.view('reddit-import')).toMatchObject({
      engine: 'import',
      enabled: false,
      needsAcknowledgment: false,
      session: 'disabled',
      searchSupported: false,
      seed: true,
      policy: 'forbidden',
      loginUrl: null,
      signupUrl: null,
    });
    expect(reg.get('reddit-import').author_signals.profile_lookup).toBe(false);
  });

  it('cannot be switched on, read live or removed', () => {
    expect(() => reg.enable('reddit-import', true)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => reg.enable('reddit-import', false)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    // A stored "on" from any path is ignored.
    state.setOverride('reddit-import', { enabled: true, acknowledgedAt: '2026-11-10T00:00:00.000Z', acknowledgedPolicy: 'forbidden' });
    expect(reg.get('reddit-import').enabled).toBe(false);
    expect(() => reg.assertUsable('reddit-import')).toThrow(expect.objectContaining({ code: 'unsupported' }));
    expect(() => reg.removeUserSource('reddit-import')).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('claims the Reddit hosts, so drafts and lookups point at it', () => {
    for (const h of ['www.reddit.com', 'reddit.com', 'old.reddit.com', 'redd.it']) expect(reg.sourceForHost(h)?.id).toBe('reddit-import');
  });

  it('keeps a user file from claiming a Reddit host or reusing the id', () => {
    fs.writeFileSync(
      path.join(opts.userDir, 'reddit-import.yaml'),
      YAML.stringify({
        id: 'reddit-import',
        name: 'Mine',
        topics: ['general'],
        engine: 'generic',
        base_url: 'https://forum.example/',
        domains: ['forum.example'],
        automation: { policy: 'unknown', rule_url: 'https://forum.example/rules', checked_at: '2026-11-10' },
      }),
    );
    reg.reload();
    expect(reg.errors()).toEqual([
      'reddit-import.yaml: id "reddit-import" belongs to a seed source (built in), so this file is skipped; give it another id',
    ]);
    expect(reg.get('reddit-import').engine).toBe('import');
  });

  it('is described to the agent as imported threads, not as a source to switch on', () => {
    const text = formatSources([reg.view('reddit-import')]);
    expect(text).toContain('reddit-import (name "Reddit, saved threads"): import');
    expect(text).toContain('Reddit threads the user saved and imported with lurkd import reddit <file>. lurkd does not read Reddit live; find these threads with archive.search.');
    expect(text).not.toContain('switched on');
    expect(text).not.toContain('Needs acknowledgment');
  });
});

describe('FetchService and Reddit', () => {
  let tmp: string;
  let db: Database.Database;
  let state: StateStore;
  let registry: Registry;
  let threads: ThreadStore;
  let queue: FetchQueue;
  let withPage: ReturnType<typeof vi.fn>;
  let resolveHost: Mock<ResolveHost>;
  let svc: FetchService;
  let now: number;

  beforeEach(() => {
    now = Date.parse('2026-11-10T09:00:00.000Z');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-reddit-svc-'));
    const seedDir = path.join(tmp, 'seed');
    const userDir = path.join(tmp, 'user');
    fs.mkdirSync(seedDir);
    fs.mkdirSync(userDir);
    fs.writeFileSync(
      path.join(userDir, 'open.yaml'),
      YAML.stringify({
        id: 'open',
        name: 'open forum',
        topics: ['testing'],
        engine: 'discourse',
        base_url: 'https://open.example',
        domains: ['open.example'],
        automation: { policy: 'allowed', rule_url: 'https://open.example/rules', rule_quote: 'Bots welcome.', checked_at: '2026-11-08' },
      }),
    );
    db = openArchive(':memory:');
    state = new StateStore(db);
    registry = Registry.load({ seedDir, userDir, state, builtins: true });
    threads = new ThreadStore(db, SALT);
    queue = new FetchQueue();
    withPage = vi.fn(async () => {
      throw new Error('no browser in this test');
    });
    resolveHost = vi.fn<ResolveHost>(async () => [{ address: '93.184.215.14', family: 4 }]);
    svc = new FetchService({
      registry,
      state,
      threads,
      samples: new SampleStore(db),
      drafts: new DraftStore(db, registry, { state }),
      browser: { handoff: null, withPage } as unknown as BrowserManager,
      queue,
      pacer: new HostPacer(),
      salt: SALT,
      resolveHost,
      clock: { now: () => now, sleep: async () => {} },
    });
  });

  afterEach(async () => {
    await queue.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const unsupported = async (p: Promise<unknown>): Promise<LurkdError> => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(LurkdError);
      expect((e as LurkdError).code).toBe('unsupported');
      return e as LurkdError;
    }
    throw new Error('expected unsupported');
  };

  it('imports a saved thread into the archive and archive.search finds it under pseudonyms', () => {
    const out = svc.importReddit(raw(), 'api');
    expect(out).toMatchObject({
      source: 'reddit-import',
      url: 'https://www.reddit.com/comments/1k2m3n4/',
      title: `Zigbee coordinator drops after the update (thanks u/${pseudo('erin')} for the first hint)`,
      posts: 8,
      comments: 7,
      notKept: 0,
      notInFile: 11,
      replaced: false,
      replacedImportAt: null,
      importedBy: 'lurkd import / API',
    });
    expect(out.threadId).toBeGreaterThan(0);
    const hits = svc.archiveSearch('extension cable', {});
    expect(hits.map((h) => [h.source, h.postNumber])).toEqual(expect.arrayContaining([['reddit-import', 8]]));
    for (const h of hits) expect(findLeaks(`${h.author} ${h.excerpt} ${h.threadTitle} ${h.signals.join(' ')}`, NAMES)).toEqual(new Map());
    expect(svc.archiveSearch('alice', {})).toEqual([]);
    const md = svc.threadMarkdown(out.threadId);
    expect(md).toContain('imported: "from a saved file; lurkd did not contact the site"');
    expect(md).toContain('imported_by: "lurkd import / API"');
    expect(md).not.toContain('replaced:');
    expect(findLeaks(md, NAMES)).toEqual(new Map());
    expect(withPage).not.toHaveBeenCalled();
    expect(state.countRequests('reddit-import', '1970-01-01T00:00:00.000Z')).toBe(0);
  });

  it('replaces an earlier import of the same thread, and keeps the date of the earlier import in the thread', () => {
    now = Date.parse('2026-11-10T09:00:00.000Z');
    const first = svc.importReddit(raw(), 'page');
    expect(first).toMatchObject({ replaced: false, replacedImportAt: null, importedBy: 'page upload', importedAt: '2026-11-10T09:00:00.000Z' });
    expect(svc.threadMarkdown(first.threadId)).toContain('imported_by: "page upload"');
    now = Date.parse('2026-11-11T10:30:00.000Z');
    const again = svc.importReddit(raw(), 'api');
    expect([again.threadId, again.replaced, again.replacedImportAt, again.importedBy]).toEqual([first.threadId, true, '2026-11-10T09:00:00.000Z', 'lurkd import / API']);
    const front = svc.threadMarkdown(again.threadId).split('\n---\n')[0]!;
    expect(front).toContain('fetched_at: 2026-11-11T10:30:00.000Z');
    expect(front).toContain('imported_by: "lurkd import / API"');
    expect(front).toContain('replaced: "2026-11-10T09:00:00.000Z"');
    // The line names the import just before this one.
    now = Date.parse('2026-11-12T08:00:00.000Z');
    const third = svc.importReddit(raw(), 'page');
    expect(third.replacedImportAt).toBe('2026-11-11T10:30:00.000Z');
    expect(svc.threadMarkdown(third.threadId)).toContain('replaced: "2026-11-11T10:30:00.000Z"');
  });

  it('answers an import with a title cut at 300 characters, whatever the file holds (R5 round 2, item 3)', () => {
    const title = `u/erin ${'x '.repeat(5_000_000)}`;
    const out = svc.importReddit(threadDoc({ title }), 'api');
    expect(out.title).toBe(`u/${pseudo('erin')} ${'x '.repeat(146).trimEnd()}...`);
    const front = svc.threadMarkdown(out.threadId).split('\n---\n')[0]!;
    expect(front).toContain(`title: "u/${pseudo('erin')} ${'x '.repeat(146).trimEnd()}..."`);
    expect(findLeaks(svc.threadMarkdown(out.threadId), ['erin'])).toEqual(new Map());
  });

  it('saves nothing when the file is refused', () => {
    expect(() => svc.importReddit('{"kind":"Listing"', 'api')).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => svc.importReddit(fixture('reddit/subreddit-listing.json'), 'page')).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(svc.archiveSearch('thread', {})).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM threads').get()).toEqual({ n: 0 });
  });

  it('answers source.fetch on a Reddit address with the import steps, for any source, and opens nothing', async () => {
    for (const source of ['open', 'reddit-import', 'no-such-source']) {
      for (const url of ['https://www.reddit.com/r/homeassistant/comments/1k2m3n4/zigbee/', 'https://redd.it/1k2m3n4']) {
        const e = await unsupported(svc.fetch(parseFetchRequest({ source, url })));
        expect(e.message).toContain('lurkd does not read Reddit.');
        expect(e.message).toContain('https://www.reddit.com/comments/1k2m3n4.json');
        expect(e.message).toContain('lurkd import reddit <file>');
      }
    }
    const share = await unsupported(svc.fetch(parseFetchRequest({ source: 'open', url: 'https://www.reddit.com/r/homeassistant/s/AbCdEf' })));
    expect(share.message).toContain('https://www.reddit.com/r/sub/comments/abc123/title.json');
    const q = await unsupported(svc.fetch(parseFetchRequest({ source: 'reddit-import', query: 'zigbee' })));
    expect(formatError(q)).toMatch(/^Error unsupported: lurkd does not read Reddit\./);
    expect(withPage).not.toHaveBeenCalled();
  });

  it('answers source.fetch from the archive once the thread was imported, and never refreshes it', async () => {
    svc.importReddit(raw(), 'api');
    const r = await svc.fetch(parseFetchRequest({ source: 'open', url: 'https://old.reddit.com/r/homeassistant/comments/1k2m3n4/zigbee/' }));
    expect(r).toMatchObject({ jobId: null, source: 'reddit-import', requestsUsed: 0, stopped: null });
    expect(r.threads[0]).toMatchObject({ url: 'https://www.reddit.com/comments/1k2m3n4/', fromArchive: true, truncated: false });
    expect(findLeaks(formatFetch(r), NAMES)).toEqual(new Map());
    const cut = await svc.fetch(parseFetchRequest({ source: 'reddit-import', url: 'https://redd.it/1k2m3n4', max_chars: 2000 }));
    expect(cut.threads[0]!.truncated).toBe(true);
    await unsupported(svc.fetch(parseFetchRequest({ source: 'reddit-import', url: 'https://redd.it/1k2m3n4', refresh: true })));
    expect(withPage).not.toHaveBeenCalled();
  });

  it('refuses source.sample, Analyse and author lookups for Reddit before any lookup or page', async () => {
    await unsupported(svc.sample('https://www.reddit.com/r/homeassistant/'));
    await unsupported(svc.sample('https://old.reddit.com/r/x/', 'id: x'));
    await unsupported(svc.analyse('https://www.reddit.com/r/homeassistant/'));
    await unsupported(svc.analyse('https://new.reddit.com/'));
    expect(resolveHost).not.toHaveBeenCalled();
    svc.importReddit(raw(), 'api');
    await expect(svc.authorSignals('reddit-import', pseudo('bob'))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(withPage).not.toHaveBeenCalled();
  });
});
