import { describe, expect, it } from 'vitest';
import type { JsonResult, PageReader } from '../../src/browser/reader.js';
import { LurkdError } from '../../src/errors.js';
import { adapterFor, type ExtractContext } from '../../src/extract/engine.js';
import {
  assembleThread,
  discourseAdapter,
  discourseNotes,
  discourseSignals,
  missingPostIds,
  parseTopicUrl,
  type DiscoursePost,
  type DiscourseTopic,
} from '../../src/extract/discourse.js';
import { nameResolver, renderThread, toRenderInput } from '../../src/output/render.js';
import { withoutAuthor } from '../../src/extract/scrub.js';
import { findLeaks } from '../../src/pseudonym.js';
import { checkNavigable } from '../../src/policy/urls.js';
import { canSearch } from '../../src/sources/registry.js';
import { fixture, range, testSource } from '../helpers/common.js';

const SALT = 'd'.repeat(64);
const source = testSource({ id: 'test-discourse', engine: 'discourse', base_url: 'https://forum.example.org' });
const topic = (): DiscourseTopic => JSON.parse(fixture('discourse/topic-100.json')) as DiscourseTopic;
const chunk = (): DiscoursePost[] => (JSON.parse(fixture('discourse/posts-100.json')) as { post_stream: { posts: DiscoursePost[] } }).post_stream.posts;
const parsed = parseTopicUrl(source.base_url, 'https://forum.example.org/t/test-topic/100');

function post(n: number, extra: Partial<DiscoursePost> = {}): DiscoursePost {
  return { id: 500 + n, post_number: n, username: 'bob', created_at: '2026-10-01T10:00:00.000Z', cooked: `<p>post ${n}</p>`, post_type: 1, ...extra };
}

describe('parseTopicUrl', () => {
  it('parses topic URLs with slug, post number and subfolder', () => {
    expect(parseTopicUrl('https://f.example', 'https://f.example/t/b12-algae/4812/7')).toEqual({ canonical: 'https://f.example/t/b12-algae/4812', id: '4812', slug: 'b12-algae' });
    expect(parseTopicUrl('https://f.example/community', 'https://f.example/community/t/4812').id).toBe('4812');
    expect(() => parseTopicUrl('https://f.example', 'https://f.example/c/hardware/5')).toThrow();
  });

  it('reads a numeric first segment as the topic id (Discourse slugs are never all digits)', () =>
    expect(parseTopicUrl('https://f.example', 'https://f.example/t/4812/7')).toEqual({ canonical: 'https://f.example/t/4812', id: '4812', slug: null }));

  it('drops the query, the fragment, a trailing slash and .json', () => {
    expect(parseTopicUrl('https://f.example/', 'https://f.example/t/b12-algae/4812/?page=2#post_3').canonical).toBe('https://f.example/t/b12-algae/4812');
    expect(parseTopicUrl('https://f.example', 'https://f.example/t/b12-algae/4812.json').canonical).toBe('https://f.example/t/b12-algae/4812');
  });

  it('keeps the subfolder of base_url in the canonical URL', () =>
    expect(parseTopicUrl('https://f.example/community/', 'https://f.example/community/t/b12-algae/4812/3').canonical).toBe('https://f.example/community/t/b12-algae/4812'));

  it('refuses a topic path outside the base path and non-topic paths, with invalid_request', () => {
    expect(() => parseTopicUrl('https://f.example/community', 'https://f.example/t/b12-algae/4812')).toThrow(/Not a Discourse topic URL/);
    for (const bad of ['https://f.example/t/', 'https://f.example/t/slug', 'https://f.example/t/slug/x', 'https://f.example/t/a/1/2/3', 'not a url']) {
      expect(() => parseTopicUrl('https://f.example', bad), bad).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    }
  });
});

describe('discourseSignals (D33)', () => {
  it('builds D33 signals', () =>
    expect(discourseSignals({ username: 'alice', trust_level: 4, admin: true, user_title: 'Level1Crew' } as DiscoursePost, new Map([['alice', 43]])))
      .toEqual(['trust level 4', 'admin', 'title "Level1Crew"', '43 posts in this topic']));

  it('names one role, the group, and looks the participant up without case', () => {
    expect(discourseSignals({ username: 'Bob', trust_level: 0, moderator: true, staff: true, primary_group_name: 'testers' } as DiscoursePost, new Map([['bob', 1]])))
      .toEqual(['trust level 0', 'moderator', 'group testers', '1 post in this topic']);
    expect(discourseSignals({ username: 'carol', staff: true } as DiscoursePost, new Map())).toEqual(['staff']);
    expect(discourseSignals({ username: null } as DiscoursePost, new Map())).toEqual([]);
  });
});

describe('discourseNotes', () => {
  it('builds notes without a page', () =>
    expect(discourseNotes({ like_count: 27, version: 3, reply_to_post_number: 2 } as DiscoursePost)).toEqual(['27 likes', 'reply to #2', 'edited (version 3)']));

  it('prefers the like action count, then lists reactions, accepted answers and hidden posts', () => {
    expect(
      discourseNotes({
        like_count: 9,
        actions_summary: [{ id: 2, count: 1 }],
        reactions: [{ id: 'heart', count: 2 }, { id: '+1', count: 1 }],
        accepted_answer: true,
        cooked_hidden: true,
        version: 1,
      } as DiscoursePost),
    ).toEqual(['1 like', 'reactions: heart 2, +1 1', 'accepted answer', 'hidden by community flags']);
    expect(discourseNotes({} as DiscoursePost)).toEqual([]);
    expect(discourseNotes({ like_count: 0, actions_summary: [] } as unknown as DiscoursePost)).toEqual([]);
  });

  it('marks a topic event first (C8)', () =>
    expect(discourseNotes({ post_type: 3, action_code: 'split_topic' } as DiscoursePost)).toEqual(['topic event split_topic']));
});

describe('assembleThread on the fixtures', () => {
  it('asks only for the posts the first payload lacks, in stream order', () => {
    const ids = missingPostIds(topic());
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe(1026);
    expect(ids.at(-1)).toBe(1045);
  });

  it('reads all 45 posts in stream order, whatever order the chunk answer has', () => {
    const t = assembleThread(source, parsed, topic(), chunk().reverse());
    expect(t.posts.map((p) => p.number)).toEqual(range(1, 45));
    expect(t).toMatchObject({ url: 'https://forum.example.org/t/test-topic/100', title: 'Board resets after the update (synthetic fixture)', engine: 'discourse', postsExpected: 45, pages: null, extraction: 'json', quality: 'full' });
    expect(t.posts.every((p) => p.page === null && !p.notes.some((n) => /page/.test(n)))).toBe(true);
    expect(t.posts[0]).toMatchObject({ author: 'alice', authorUrl: 'https://forum.example.org/u/alice', postedAt: '2026-10-01T10:00:00.000Z' });
    expect(t.posts[0]!.signals).toEqual(['trust level 4', 'admin', 'title "Fixture Crew"', '9 posts in this topic']);
    expect(t.posts[1]!.notes).toEqual(['reply to #1', 'edited (version 3)', 'accepted answer']);
    expect(t.posts[2]!.notes).toEqual(['4 likes', 'reactions: heart 2']);
  });

  it('leaks only the documented free-text name', () => {
    const t = assembleThread(source, parsed, topic(), chunk());
    const md = renderThread(toRenderInput('test-discourse', t, '2026-11-08T00:00:00.000Z'), nameResolver({ sourceId: 'test-discourse', salt: SALT, realNames: false })).markdown;
    expect([...findLeaks(md, ['alice', 'bob', 'carol', 'erin'])]).toEqual([['erin', 1]]);
    expect(t.posts.some((p) => /thanks erin/.test(p.bodyMd))).toBe(true);
  });

  it('keeps a topic event as its own post and marks it (C8: 3 items, 2 expected)', () => {
    const data: DiscourseTopic = {
      id: 7,
      title: 'Split',
      posts_count: 2,
      post_stream: { stream: [501, 503, 502], posts: [post(1), post(3, { post_type: 3, action_code: 'split_topic', cooked: '', username: 'dave' }), post(2)] },
    };
    const t = assembleThread(source, parseTopicUrl(source.base_url, 'https://forum.example.org/t/split/7'), data, []);
    expect(t.posts.map((p) => p.number)).toEqual([1, 3, 2]);
    expect(t.postsExpected).toBe(2);
    expect(t.posts[1]!.notes[0]).toBe('topic event split_topic');
    expect(t.posts[1]!.bodyMd).toBe('_Topic event: split_topic_');
  });

  it('never duplicates a post: repeated stream ids and chunk posts count once', () => {
    const data: DiscourseTopic = { id: 7, title: 'Dup', posts_count: 2, post_stream: { stream: [501, 502, 501], posts: [post(1)] } };
    expect(missingPostIds(data)).toEqual([502]);
    const t = assembleThread(source, parseTopicUrl(source.base_url, 'https://forum.example.org/t/dup/7'), data, [post(2), post(2), post(1)]);
    expect(t.posts.map((p) => p.number)).toEqual([1, 2]);
    expect(t.extraction).toBe('json');
  });

  it('says so in extraction when the server held back posts of the stream', () => {
    const data: DiscourseTopic = { id: 7, title: 'Gap', posts_count: 3, post_stream: { stream: [501, 502, 503], posts: [post(1)] } };
    const t = assembleThread(source, parseTopicUrl(source.base_url, 'https://forum.example.org/t/gap/7'), data, [post(3)]);
    expect(t.posts.map((p) => p.number)).toEqual([1, 3]);
    expect(t.extraction).toBe('json (2 of 3 posts in the stream)');
  });

  it('builds profile URLs and converter links under a subfolder base_url', () => {
    const sub = testSource({ id: 'test-discourse', engine: 'discourse', base_url: 'https://forum.example.org/community' });
    const data: DiscourseTopic = {
      id: 7,
      title: 'Sub',
      posts_count: 1,
      post_stream: { stream: [501], posts: [post(1, { username: 'carol', cooked: '<p>ask <a href="/community/u/dave">dave</a></p>' })] },
    };
    const t = assembleThread(sub, parseTopicUrl(sub.base_url, 'https://forum.example.org/community/t/sub/7'), data, []);
    expect(t.url).toBe('https://forum.example.org/community/t/sub/7');
    expect(t.posts[0]!.authorUrl).toBe('https://forum.example.org/community/u/carol');
    expect(t.posts[0]!.bodyMd).not.toMatch(/dave(?!)/u);
  });
});

describe('adapterFor and the Discourse adapter', () => {
  it('returns the Discourse adapter for discourse sources', () => {
    expect(adapterFor(source)).toBe(discourseAdapter);
    expect(discourseAdapter.engine).toBe('discourse');
  });

  it('refuses engines this version has no adapter for', () => {
    const bb = testSource({ id: 'bb', engine: 'phpbb', base_url: 'https://bb.example.org' });
    expect(() => adapterFor(bb)).toThrow(expect.objectContaining({ code: 'extraction_failed', message: 'Engine phpbb is not supported in this version.' }));
  });

  it('can always search, as Registry.canSearch says (P15, D6)', () => {
    for (const s of [source, testSource({ id: 'with-url', engine: 'discourse', base_url: 'https://forum.example.org', search_url: 'https://forum.example.org/search?q={query}' })]) {
      expect(discourseAdapter.canSearch(s)).toBe(true);
      expect(discourseAdapter.canSearch(s)).toBe(canSearch(s));
    }
  });

  it('canonicalises topic URLs of the source and refuses other hosts', () => {
    expect(discourseAdapter.canonicalUrl(source, 'https://forum.example.org/t/test-topic/100/12?u=bob')).toBe('https://forum.example.org/t/test-topic/100');
    expect(() => discourseAdapter.canonicalUrl(source, 'https://other.example.org/t/test-topic/100')).toThrow(expect.objectContaining({ code: 'off_domain' }));
  });
});

// A stand-in reader: records what the adapter asks for and answers from a table. No browser.
function stubCtx(answer: (url: string) => JsonResult | Error, pageHtml = '<!doctype html><body></body>') {
  const calls: string[] = [];
  const progress: { postsFetched: number; page?: number }[] = [];
  let at = 'about:blank';
  const reader = {
    page: { url: () => at },
    open: async (url: string) => {
      calls.push(`open ${url}`);
      at = url;
    },
    evaluate: async () => {
      calls.push('evaluate');
      return pageHtml;
    },
    getJson: async (url: string) => {
      calls.push(`json ${url}`);
      const a = answer(url);
      if (a instanceof Error) throw a;
      return a;
    },
  } as unknown as PageReader;
  const ctx: ExtractContext = { reader, source, onProgress: (p) => progress.push(p) };
  return { ctx, calls, progress };
}
const ok = (json: unknown): JsonResult => ({ status: 200, contentType: 'application/json', json, text: JSON.stringify(json) });

describe('discourseAdapter.fetchThread with a stub reader', () => {
  const big = (): DiscourseTopic => ({
    id: 9,
    title: 'Big',
    posts_count: 50,
    post_stream: { stream: range(1, 50).map((n) => 500 + n), posts: range(1, 5).map((n) => post(n)) },
  });

  it('fetches the missing posts in chunks of 20 and reports progress after each', async () => {
    const { ctx, calls, progress } = stubCtx((url) => {
      if (url.endsWith('/t/big/9.json')) return ok(big());
      const ids = new URL(url).searchParams.getAll('post_ids[]').map(Number);
      return ok({ post_stream: { posts: ids.map((id) => post(id - 500)) } });
    });
    const t = await discourseAdapter.fetchThread(ctx, 'https://forum.example.org/t/big/9/3');
    expect(t.posts.map((p) => p.number)).toEqual(range(1, 50));
    expect(calls.map((c) => c.replace(/\?.*/, ''))).toEqual([
      'open https://forum.example.org/t/big/9',
      'json https://forum.example.org/t/big/9.json',
      'json https://forum.example.org/t/9/posts.json',
      'json https://forum.example.org/t/9/posts.json',
      'json https://forum.example.org/t/9/posts.json',
    ]);
    const sizes = calls.slice(2).map((c) => new URL(c.slice(5)).searchParams.getAll('post_ids[]').length);
    expect(sizes).toEqual([20, 20, 5]);
    expect(progress).toEqual([{ postsFetched: 5 }, { postsFetched: 25 }, { postsFetched: 45 }, { postsFetched: 50 }]);
  });

  it('stops with extraction_failed when a chunk is not served, instead of dropping its posts', async () => {
    const { ctx } = stubCtx((url) => (url.endsWith('.json') && !url.includes('posts.json') ? ok(big()) : { status: 500, contentType: 'text/html', json: null, text: '' }));
    await expect(discourseAdapter.fetchThread(ctx, 'https://forum.example.org/t/big/9')).rejects.toMatchObject({ code: 'extraction_failed' });
  });

  it('answers not_found for a 404 topic and reads the open page through readability when the JSON is missing', async () => {
    const missing = stubCtx(() => ({ status: 404, contentType: 'application/json', json: { errors: ['x'] }, text: '' }));
    await expect(discourseAdapter.fetchThread(missing.ctx, 'https://forum.example.org/t/gone/9')).rejects.toMatchObject({ code: 'not_found' });
    const html = stubCtx(() => ({ status: 200, contentType: 'text/html', json: null, text: '<p>x</p>' }), fixture('generic/article.html'));
    const t = await discourseAdapter.fetchThread(html.ctx, 'https://forum.example.org/t/page/9/4?u=erin');
    expect(t).toMatchObject({ url: 'https://forum.example.org/t/page/9', engine: 'discourse', quality: 'low', extraction: 'readability (names not pseudonymised; topic JSON not served, HTTP 200)' });
    expect(t.posts.map((p) => [p.number, p.author])).toEqual([[1, '']]);
    // The page opened for the JSON is the one read: no second navigation, no further request.
    expect(html.calls).toEqual(['open https://forum.example.org/t/page/9', 'json https://forum.example.org/t/page/9.json', 'evaluate']);
    expect(html.progress).toEqual([{ postsFetched: 1 }]);
  });

  it('stops with extraction_failed when neither the JSON nor the page has anything to read', async () => {
    const empty = stubCtx(() => ({ status: 403, contentType: 'text/html', json: null, text: '' }));
    await expect(discourseAdapter.fetchThread(empty.ctx, 'https://forum.example.org/t/page/9')).rejects.toMatchObject({
      code: 'extraction_failed',
      message: expect.stringContaining('HTTP 403'),
    });
  });
});

describe('discourseAdapter session, search and author lookups with a stub reader', () => {
  it('treats a login wall on the session check as logged out, and passes a challenge on', async () => {
    expect(await discourseAdapter.checkSession(stubCtx(() => new LurkdError('needs_login', 'login')).ctx)).toBe(false);
    expect(await discourseAdapter.checkSession(stubCtx(() => ok({ current_user: null })).ctx)).toBe(false);
    await expect(discourseAdapter.checkSession(stubCtx(() => new LurkdError('challenge', 'check')).ctx)).rejects.toMatchObject({ code: 'challenge' });
  });

  it('orders search hits by the matching posts, then the remaining topics, up to the limit', async () => {
    const { ctx, calls } = stubCtx(() => ok(JSON.parse(fixture('discourse/search.json'))));
    const hits = await discourseAdapter.search(ctx, 'delete me?', 2);
    expect(hits.map((h) => h.url)).toEqual(['https://forum.example.org/t/topic-102/102', 'https://forum.example.org/t/test-topic/100']);
    expect(calls).toEqual(['open https://forum.example.org/search?q=delete%20me%3F', 'json https://forum.example.org/search.json?q=delete%20me%3F']);
    expect(await discourseAdapter.search(stubCtx(() => ok({ grouped_search_result: {} })).ctx, 'x', 10)).toEqual([]);
  });

  it('reads author signals from one profile request and leaves missing fields null', async () => {
    const { ctx, calls } = stubCtx(() => ok({ user: { username: 'erin', trust_level: 1, badge_count: 1 } }));
    expect(await discourseAdapter.authorSignals(ctx, { username: 'erin', profileUrl: null })).toEqual({ postCount: null, joinedAt: null, extra: ['trust level 1', '1 badge'] });
    expect(calls).toEqual(['json https://forum.example.org/u/erin.json']);
  });
});

describe('authorSignals errors carry no username', () => {
  const leaksName = (e: unknown, name: string): boolean => {
    const err = e as LurkdError;
    const all = `${err.message}\n${JSON.stringify(err.details ?? {})}`;
    return all.toLowerCase().includes(name.toLowerCase());
  };
  const thrown = async (answer: (url: string) => JsonResult | Error, username = 'erin', src = source): Promise<LurkdError> => {
    const { ctx } = stubCtx(answer);
    const c = { ...ctx, source: src };
    try {
      await discourseAdapter.authorSignals(c, { username, profileUrl: `${src.base_url}/u/${username}` });
    } catch (e) {
      return e as LurkdError;
    }
    throw new Error('authorSignals did not throw');
  };

  it('keeps the code and replaces the profile URL in message and details (timeout, needs_login, net errors)', async () => {
    const cases: Array<(url: string) => Error> = [
      (url) => new LurkdError('timeout', `${url} did not answer within 45 s.`, { url, timeoutMs: 45000 }),
      (url) =>
        new LurkdError('needs_login', `Test source asks for a login at https://forum.example.org/login?return=%2Fu%2FErin.json (login-like path /login).`, {
          url,
          finalUrl: 'https://forum.example.org/login?return=%252Fu%252Ferin.json',
          reasons: ['login-like path /u/erin/login'],
        }),
      (url) => new LurkdError('server_unavailable', `Test source could not be reached at ${url} (net::ERR_CONNECTION_REFUSED).`, { url, error: 'net::ERR_CONNECTION_REFUSED' }),
      () => new Error('Execution context was destroyed while reading /u/erin.json'),
    ];
    const codes: string[] = [];
    for (const make of cases) {
      const e = await thrown(make);
      expect(e).toBeInstanceOf(LurkdError);
      expect(leaksName(e, 'erin'), `${e.message} ${JSON.stringify(e.details)}`).toBe(false);
      codes.push(e.code);
    }
    expect(codes).toEqual(['timeout', 'needs_login', 'server_unavailable', 'extraction_failed']);
    const e = await thrown((url) => new LurkdError('timeout', `${url} did not answer.`, { url }));
    expect(e.message).toBe('https://forum.example.org/u/<author>.json did not answer.');
    expect(e.details).toEqual({ url: 'https://forum.example.org/u/<author>.json' });
  });

  it('takes the name out of a denied_path from the URL policy and out of not_found', async () => {
    const denying = testSource({ id: 'test-discourse', engine: 'discourse', base_url: 'https://forum.example.org', deny_paths: ['/u/**'] });
    const denied = await thrown((url) => {
      try {
        checkNavigable(denying, url);
      } catch (e) {
        return e as Error;
      }
      return ok({});
    }, 'erin', denying);
    expect(denied.code).toBe('denied_path');
    expect(leaksName(denied, 'erin')).toBe(false);
    const missing = await thrown(() => ({ status: 404, contentType: 'text/plain', json: null, text: 'not found' }));
    expect(missing.code).toBe('not_found');
    expect(leaksName(missing, 'erin')).toBe(false);
  });

  it('keeps share-link usernames out of fetchThread errors', async () => {
    const { ctx } = stubCtx(() => ok({}));
    for (const url of ['https://other.example.org/t/x/100/3?u=erin', 'https://forum.example.org/c/x/5?u=erin#erin']) {
      const e = await discourseAdapter.fetchThread(ctx, url).then(() => null, (err: unknown) => err as LurkdError);
      expect(e).not.toBeNull();
      expect(leaksName(e, 'erin'), e!.message).toBe(false);
    }
  });

  it('redacts percent-encoded names and leaves other words alone', () => {
    const e = withoutAuthor(new LurkdError('timeout', 'https://f.example/u/d%C3%A9j%C3%A0.json and /u/déjà.json, carol stays', { u: ['déjà'] }), 'déjà');
    expect(e.message).toBe('https://f.example/u/<author>.json and /u/<author>.json, carol stays');
    expect(e.details).toEqual({ u: ['<author>'] });
  });
});

describe('review fix round 1', () => {
  it('stores five URL forms of one topic under one URL after fetchThread', async () => {
    const urls = new Set<string>();
    for (const form of [
      'https://forum.example.org/t/100',
      'https://forum.example.org/t/test-topic/100/7?u=bob',
      'https://forum.example.org/t/Test-Topic/100',
      'https://forum.example.org/t/topic/100',
      'https://forum.example.org/t/-/100',
    ]) {
      const { ctx } = stubCtx((url) => (url.includes('posts.json') ? ok({ post_stream: { posts: chunk() } }) : ok(topic())));
      const t = await discourseAdapter.fetchThread(ctx, form);
      expect(t.posts).toHaveLength(45);
      urls.add(t.url);
    }
    expect([...urls]).toEqual(['https://forum.example.org/t/test-topic/100']);
  });

  it('builds the stored URL from a cleaned, encoded slug under the base path', () => {
    const sub = testSource({ id: 'test-discourse', engine: 'discourse', base_url: 'https://forum.example.org/community/' });
    const data: DiscourseTopic = { id: 7, slug: 'caf%C3%A9 x', title: 't', post_stream: { stream: [501], posts: [post(1)] } };
    expect(assembleThread(sub, parseTopicUrl(sub.base_url, 'https://forum.example.org/community/t/7'), data, []).url).toBe('https://forum.example.org/community/t/caf%C3%A9%20x/7');
  });

  it('cleans markers and whitespace out of topic and search titles', async () => {
    const data: DiscourseTopic = { id: 7, title: ' Ask bob\n about  it ', post_stream: { stream: [501], posts: [post(1)] } };
    expect(assembleThread(source, parseTopicUrl(source.base_url, 'https://forum.example.org/t/x/7'), data, []).title).toBe('Ask bob about it');
    const hits = await discourseAdapter.search(stubCtx(() => ok({ topics: [{ id: 7, slug: 'x', title: 'carol  says\thi', posts_count: 1 }] })).ctx, 'q', 5);
    expect(hits).toEqual([{ url: 'https://forum.example.org/t/x/7', title: 'carol says hi', posts: 1 }]);
  });

  it('notes deleted posts and whispers', () => {
    expect(discourseNotes({ post_type: 4, deleted_at: '2026-10-01T10:00:00.000Z' } as DiscoursePost)).toEqual(['whisper', 'deleted']);
    expect(discourseNotes({ post_type: 1, deleted_at: null } as DiscoursePost)).toEqual([]);
  });

  it('keeps one post per post number and drops posts of another topic', () => {
    const data: DiscourseTopic = { id: 7, title: 'Dup numbers', posts_count: 3, post_stream: { stream: [501, 502, 503, 504], posts: [post(1)] } };
    const t = assembleThread(source, parseTopicUrl(source.base_url, 'https://forum.example.org/t/dup/7'), data, [
      post(2, { topic_id: 7 }),
      { ...post(1), id: 503 },
      post(4, { topic_id: 8 }),
    ]);
    expect(t.posts.map((p) => [p.number, p.bodyMd])).toEqual([[1, 'post 1'], [2, 'post 2']]);
  });
});

describe('review fix round 2', () => {
  it('falls back to the parsed canonical URL for a slug of only dots', async () => {
    for (const slug of ['.', '..', '%2e%2e', '...', ' %2E. ']) {
      const data: DiscourseTopic = { id: 7, slug, title: 't', post_stream: { stream: [501], posts: [post(1)] } };
      const t = assembleThread(source, parseTopicUrl(source.base_url, 'https://forum.example.org/t/7'), data, []);
      expect(t.url, slug).toBe('https://forum.example.org/t/7');
      expect(parseTopicUrl(source.base_url, t.url).id).toBe('7');
      const hits = await discourseAdapter.search(stubCtx(() => ok({ topics: [{ id: 7, slug, title: 't' }] })).ctx, 'q', 5);
      expect(hits[0]!.url, slug).toBe('https://forum.example.org/t/7');
    }
    const dotted: DiscourseTopic = { id: 7, slug: 'v1.2', title: 't', post_stream: { stream: [501], posts: [post(1)] } };
    expect(assembleThread(source, parseTopicUrl(source.base_url, 'https://forum.example.org/t/7'), dotted, []).url).toBe('https://forum.example.org/t/v1.2/7');
  });
});
