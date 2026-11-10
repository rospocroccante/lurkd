import { describe, expect, it } from 'vitest';
import type { PageReader } from '../../src/browser/reader.js';
import type { ExtractContext } from '../../src/extract/engine.js';
import { makeConverter } from '../../src/extract/markdown.js';
import {
  customAdapter,
  extractWithSelectors,
  MAX_POSTS_PER_PAGE,
  nextSelectorPage,
  parseSelectorPage,
  parseThreadList,
  selectorPosts,
} from '../../src/extract/selectors.js';
import { nameResolver, renderThread, toRenderInput } from '../../src/output/render.js';
import { findLeaks, NAME_CLOSE, NAME_OPEN } from '../../src/pseudonym.js';
import type { Selectors } from '../../src/sources/schema.js';
import { canSearch } from '../../src/sources/registry.js';
import { fixture, testSource } from '../helpers/common.js';

const SALT = 'c'.repeat(64);
const BASE = 'https://forum.example.org';
const THREAD = `${BASE}/thread/42`;
const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin'];
const SEL: Selectors = {
  title: 'h1.thread-title',
  post: 'article.post',
  author: '.post-author .name',
  author_signals: '.post-author .stats',
  date: 'time',
  body: '.post-body',
  quote: 'div.quote',
  next_page: 'a[rel=next]',
  thread_list: 'ol.results li a.thread-title',
};
const source = testSource({ id: 'test-custom', engine: 'custom', base_url: BASE, selectors: SEL });

function noReaderCtx(src = source): ExtractContext {
  const reader = new Proxy({}, { get: (_t, key) => { throw new Error(`the reader was used: ${String(key)}`); } }) as unknown as PageReader;
  return { reader, source: src, onProgress: () => {} };
}

const page1 = () => parseSelectorPage(fixture('custom/thread-1.html'), THREAD, SEL, source);

describe('parseSelectorPage', () => {
  it('reads title, posts and the next link', () => {
    const p = page1();
    expect(p.title).toBe('Sourdough starter smells of acetone');
    expect(p.posts.map((x) => x.author)).toEqual(['alice', 'bob', 'carol']);
    expect(p.posts[0]).toMatchObject({ authorHref: `${BASE}/user/alice`, date: '2026-10-01T09:00:00Z', signal: 'Regular member, 312 posts' });
    expect(p.posts[2]!.date).toBe('2 Oct 2026');
    expect(p.next).toBe(`${BASE}/thread/42?page=2`);
  });

  it('turns quote matches into blockquotes, nested ones too', () => {
    const p = parseSelectorPage(fixture('custom/thread-2.html'), `${THREAD}?page=2`, SEL, source);
    expect(p.posts[1]!.html).toMatch(
      /<blockquote (?:data-quote="dave" class="bbCodeBlock--quote"|class="bbCodeBlock--quote" data-quote="dave")><div class="bbCodeBlock-content"><p>Rye works faster for me.<\/p><blockquote><p>Feed it twice a day.<\/p><\/blockquote><\/div><\/blockquote>/,
    );
    expect(p.posts[1]!.html).not.toContain('class="quote"');
    expect(p.posts[1]!.html).not.toContain('<cite>');
  });

  it('defaults the body to the post element, without the author, signals and date', () => {
    const { body: _b, ...rest } = SEL;
    const p = parseSelectorPage(fixture('custom/thread-1.html'), THREAD, rest, source);
    expect(p.posts[0]!.html).toContain('nail polish remover');
    expect(p.posts[0]!.html).not.toContain('alice');
    expect(p.posts[0]!.html).not.toContain('312 posts');
    expect(p.posts[0]!.html).not.toContain('1 Oct 2026');
    // The author is still read from the post element.
    expect(p.posts[0]!.author).toBe('alice');
  });

  it('keeps the author avatar and other profile links out of the default body', () => {
    const html =
      '<article class="post"><div class="post-author"><a href="/user/alice"><span class="name">alice</span></a></div>' +
      '<img class="pic" src="/avatars/alice.png" alt="pic"><a href="/user/alice">my profile</a> <img src="/img/bread.jpg" alt="bread"> Hello.</article>';
    const { body: _b, ...rest } = SEL;
    const p = parseSelectorPage(html, THREAD, rest, source);
    expect(p.posts[0]!.html).not.toContain('alice');
    expect(p.posts[0]!.html).toContain('bread.jpg');
    expect(p.posts[0]!.html).toContain('Hello.');
  });

  it('keeps only top-level posts', () => {
    const html =
      '<div><article class="post"><div class="post-author"><span class="name">alice</span></div><div class="post-body"><article class="post"><div class="post-author"><span class="name">bob</span></div></article> text</div></article></div>';
    expect(parseSelectorPage(html, THREAD, SEL, source).posts.map((p) => p.author)).toEqual(['alice']);
  });

  it('caps the posts per page and the text per field', () => {
    const long = 'x'.repeat(1000);
    const one = `<article class="post"><div class="post-author"><span class="name">${long}</span><span class="stats">${long}</span></div><time>2026 ${long}</time><div class="post-body">b</div></article>`;
    const p = parseSelectorPage(`<body><h1 class="thread-title">${long}</h1>${one.repeat(MAX_POSTS_PER_PAGE + 20)}</body>`, THREAD, SEL, source);
    expect(p.posts).toHaveLength(MAX_POSTS_PER_PAGE);
    expect(p.posts[0]!.author.length).toBeLessThanOrEqual(100);
    expect(p.posts[0]!.signal!.length).toBeLessThanOrEqual(200);
    expect(p.posts[0]!.date!.length).toBeLessThanOrEqual(100);
    expect(p.title.length).toBeLessThanOrEqual(300);
  });

  it('reports an invalid selector as extraction_failed naming its key', () => {
    for (const key of ['post', 'author', 'author_signals', 'date', 'body', 'quote', 'next_page', 'title'] as const) {
      const sel = { ...SEL, [key]: 'div[[' };
      expect(() => parseSelectorPage(fixture('custom/thread-1.html'), THREAD, sel, source)).toThrow(
        expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining(`selectors.${key}`) }),
      );
    }
  });

  it('reports an overlong selector as extraction_failed', () => {
    expect(() => parseSelectorPage('<p></p>', THREAD, { ...SEL, author: `${'div '.repeat(400)}span` }, source)).toThrow(
      expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('selectors.author') }),
    );
  });
});

describe('selectorPosts', () => {
  it('numbers posts after the previous page, notes the page and keeps the author out of signals', () => {
    const posts = selectorPosts(page1(), 2, source, 10, makeConverter({ baseUrl: BASE }));
    expect(posts.map((p) => p.number)).toEqual([11, 12, 13]);
    expect(posts[0]).toMatchObject({
      page: 2,
      author: 'alice',
      authorUrl: `${BASE}/user/alice`,
      signals: ['Regular member, 312 posts'],
      notes: ['page 2'],
      postedAt: '2026-10-01T09:00:00.000Z',
    });
    // "carol's kitchen, 40 posts" names the post's own author: dropped.
    expect(posts[2]!.signals).toEqual([]);
    expect(posts[1]!.bodyMd).toMatch(/^> My starter smells/m);
  });

  it('drops an author link off the source hosts', () => {
    const html = '<article class="post"><a href="https://elsewhere.example.net/u/alice"><span class="name">alice</span></a><div class="post-body">hi</div></article>';
    const posts = selectorPosts(parseSelectorPage(html, THREAD, SEL, source), 1, source);
    expect(posts[0]!.authorUrl).toBeNull();
  });

  it('renders without leaking a test name', () => {
    const posts = selectorPosts(page1(), 1, source);
    const t = { url: THREAD, title: 't', engine: 'custom' as const, postsExpected: null, pages: 1, extraction: 'selectors', quality: 'full' as const, posts };
    const md = renderThread(toRenderInput('test-custom', t, '2026-11-09T00:00:00.000Z'), nameResolver({ sourceId: 'test-custom', salt: SALT, realNames: false })).markdown;
    expect([...findLeaks(md, NAMES)]).toEqual([]);
  });
});

describe('quote headers (D34)', () => {
  const quoted = (quotes: string) =>
    `<article class="post"><div class="post-author"><span class="name">carol</span></div><div class="post-body">${quotes}<p>Agreed.</p></div></article>`;
  const bodyOf = (quotes: string) => selectorPosts(parseSelectorPage(quoted(quotes), THREAD, SEL, source), 1, source)[0]!.bodyMd;
  const render = (bodyMd: string) => {
    const posts = [{ number: 1, page: 1, author: 'carol', authorUrl: null, signals: [], notes: [], postedAt: null, bodyMd }];
    const t = { url: THREAD, title: 't', engine: 'custom' as const, postsExpected: null, pages: 1, extraction: 'selectors', quality: 'full' as const, posts };
    return renderThread(toRenderInput('test-custom', t, '2026-11-09T00:00:00.000Z'), nameResolver({ sourceId: 'test-custom', salt: SALT, realNames: false })).markdown;
  };

  it('marks the name of a "<name> said:" header on the first text line', () => {
    const md = bodyOf('<div class="quote">bob said: It is hungry, not ruined.</div>');
    expect(md).toContain(`> ${NAME_OPEN}bob${NAME_CLOSE} wrote:`);
    expect(md).toMatch(/^> It is hungry, not ruined\.$/m);
    const out = render(md);
    expect(out).toMatch(/^> author-[0-9a-f]{10} wrote:$/m);
    expect([...findLeaks(out, ['bob'])]).toEqual([]);
  });

  it('reads the header from the first child element, in every listed language and case', () => {
    for (const [header, name] of [
      ['<cite>dave wrote:</cite>', 'dave'],
      ['<p>Erin Smith SAID</p>', 'Erin Smith'],
      ['<b>alice ha scritto:</b>', 'alice'],
      ['<span>bob scrisse:</span>', 'bob'],
      ['<span>carol a écrit :</span>', 'carol'],
      ['<span>dave schrieb:</span>', 'dave'],
      ['<cite><a href="/user/erin">erin</a> said:</cite>', 'erin'],
    ] as const) {
      const md = bodyOf(`<div class="quote">${header}<p>Feed it twice a day.</p></div>`);
      expect(md, header).toContain(`> ${NAME_OPEN}${name}${NAME_CLOSE} wrote:`);
      expect(md, header).toMatch(/^> Feed it twice a day\.$/m);
      expect([...findLeaks(render(md), [name])], header).toEqual([]);
    }
  });

  it('marks nested quote headers', () => {
    const md = bodyOf('<div class="quote"><cite>erin said:</cite><p>Rye.</p><div class="quote">dave said: Feed it.</div></div>');
    expect(md).toContain(`> ${NAME_OPEN}erin${NAME_CLOSE} wrote:`);
    expect(md).toContain(`> > ${NAME_OPEN}dave${NAME_CLOSE} wrote:`);
    expect([...findLeaks(render(md), NAMES)]).toEqual([]);
  });

  it('leaves a quote without a header, an overlong name and ordinary sentences as they are', () => {
    expect(bodyOf('<div class="quote">Feed it twice a day.</div>')).toMatch(/^> Feed it twice a day\.$/m);
    expect(bodyOf('<div class="quote">I said it before: feed it.</div>')).toMatch(/^> I said it before: feed it\.$/m);
    const long = `${'x'.repeat(65)} said:`;
    const md = bodyOf(`<div class="quote">${long} hi</div>`);
    expect(md).not.toContain(NAME_OPEN);
  });
});

describe('nextSelectorPage', () => {
  it('follows a link on the source host that was not read yet, without its fragment', () => {
    expect(nextSelectorPage(source, THREAD, THREAD, '?page=2#top', new Set([THREAD]))).toBe(`${THREAD}?page=2`);
  });

  it('refuses another host, a page already read, a denied path and a non-http link', () => {
    expect(nextSelectorPage(source, THREAD, THREAD, 'https://elsewhere.example.net/thread/42?page=2', new Set())).toBeNull();
    expect(nextSelectorPage(source, THREAD, `${THREAD}?page=2`, '/thread/42#x', new Set([THREAD]))).toBeNull();
    expect(nextSelectorPage(source, THREAD, THREAD, '/thread/42/reply', new Set())).toBeNull();
    expect(nextSelectorPage(source, THREAD, THREAD, 'javascript:next()', new Set())).toBeNull();
    expect(nextSelectorPage(source, THREAD, THREAD, null, new Set())).toBeNull();
    // The same page with its query parameters in another order counts as read.
    expect(nextSelectorPage(source, THREAD, THREAD, '/thread/42?x=1&page=2#top', new Set([`${THREAD}?page=2&x=1`]))).toBeNull();
  });

  it('stays on the first page path, its query or one trailing segment, without a thread pattern', () => {
    const at = `${THREAD}/2`;
    expect(nextSelectorPage(source, THREAD, THREAD, '/thread/42?page=2&x=1', new Set())).toBe(`${THREAD}?page=2&x=1`);
    expect(nextSelectorPage(source, THREAD, THREAD, '/thread/42/2', new Set())).toBe(at);
    expect(nextSelectorPage(source, THREAD, at, '/thread/42/page-3/', new Set([THREAD, at]))).toBe(`${THREAD}/page-3/`);
    expect(nextSelectorPage(source, `${THREAD}/`, `${THREAD}/`, '/thread/42/3', new Set())).toBe(`${THREAD}/3`);
    // Another thread, the forum index, two more segments, a parent path.
    expect(nextSelectorPage(source, THREAD, THREAD, '/thread/43', new Set())).toBeNull();
    expect(nextSelectorPage(source, THREAD, THREAD, '/forum/bread', new Set())).toBeNull();
    expect(nextSelectorPage(source, THREAD, THREAD, '/thread/42/page/2', new Set())).toBeNull();
    expect(nextSelectorPage(source, THREAD, THREAD, '/thread', new Set())).toBeNull();
    expect(nextSelectorPage(source, THREAD, THREAD, '/thread/420', new Set())).toBeNull();
  });

  it('accepts only query changes when the thread starts at the site root', () => {
    const root = `${BASE}/`;
    expect(nextSelectorPage(source, root, root, '/?page=2', new Set([root]))).toBe(`${BASE}/?page=2`);
    expect(nextSelectorPage(source, root, root, '/other-thread', new Set([root]))).toBeNull();
  });

  it('refuses a link out of the thread path when the engine has a thread pattern', () => {
    const xf = testSource({ id: 'test-xf', engine: 'xenforo', base_url: BASE });
    const first = `${BASE}/threads/x.55/`;
    expect(nextSelectorPage(xf, first, first, '/threads/x.55/page-2', new Set())).toBe(`${BASE}/threads/x.55/page-2`);
    expect(nextSelectorPage(xf, first, first, '/forums/news.3/', new Set())).toBeNull();
  });
});

describe('extractWithSelectors redirects (I7)', () => {
  const page = (posts: string[], next: string | null) =>
    `<html><body><h1 class="thread-title">T</h1>${posts.map((p) => `<article class="post"><div class="post-author"><span class="name">${p}</span></div><div class="post-body"><p>${p} text</p></div></article>`).join('')}${next === null ? '' : `<a rel="next" href="${next}">next</a>`}</body></html>`;
  type Route = { html?: string; redirectTo?: string };
  function stub(routes: Record<string, Route>): { ctx: ExtractContext; opened: string[] } {
    const opened: string[] = [];
    let at = 'about:blank';
    const reader = {
      page: { url: () => at },
      open: async (url: string) => {
        opened.push(url.slice(BASE.length));
        const r = routes[url.slice(BASE.length)];
        at = r?.redirectTo !== undefined ? new URL(r.redirectTo, url).href : url;
        return { status: routes[at.slice(BASE.length)] === undefined ? 404 : 200, finalUrl: at, detection: null };
      },
      evaluate: async () => routes[at.slice(BASE.length)]?.html ?? '<html></html>',
    } as unknown as PageReader;
    return { ctx: { reader, source, onProgress: () => {} }, opened };
  }

  it('ends the read, keeping earlier pages, when a later page redirects to another thread (7c) or the forum index (7d)', async () => {
    for (const elsewhere of ['/thread/43', '/forum/bread']) {
      const { ctx, opened } = stub({
        '/thread/42': { html: page(['alice', 'bob'], '/thread/42?page=2') },
        '/thread/42?page=2': { redirectTo: elsewhere },
        [elsewhere]: { html: page(['carol', 'dave'], null) },
      });
      const t = await extractWithSelectors(ctx, THREAD, SEL);
      expect(t.posts.map((p) => p.author), elsewhere).toEqual(['alice', 'bob']);
      expect(t.pages).toBe(1);
      expect(opened).toEqual(['/thread/42', '/thread/42?page=2']);
    }
  });

  it('follows a redirect that stays on the thread path', async () => {
    const { ctx } = stub({
      '/thread/42': { html: page(['alice'], '/thread/42?page=2') },
      '/thread/42?page=2': { redirectTo: '/thread/42/2' },
      '/thread/42/2': { html: page(['bob'], null) },
    });
    expect((await extractWithSelectors(ctx, THREAD, SEL)).posts.map((p) => p.author)).toEqual(['alice', 'bob']);
  });

  it('from the site root, follows no link to another path (13)', async () => {
    const { ctx, opened } = stub({ '/': { html: page(['alice'], '/other-thread') }, '/other-thread': { html: page(['bob'], null) } });
    const t = await extractWithSelectors(ctx, `${BASE}/`, SEL);
    expect(t.posts.map((p) => p.author)).toEqual(['alice']);
    expect(opened).toEqual(['/']);
  });
});

describe('parseThreadList', () => {
  it('reads absolute thread links on the source hosts, each once', () => {
    expect(parseThreadList(fixture('custom/list.html'), `${BASE}/find?q=starter`, SEL, source)).toEqual([
      { url: `${BASE}/thread/42`, title: 'Sourdough starter smells of acetone', posts: null },
      { url: `${BASE}/thread/43`, title: 'Rye starter for beginners', posts: null },
      { url: `${BASE}/thread/45`, title: 'Starter in the fridge', posts: null },
    ]);
  });

  it('reports an invalid thread_list selector naming its key', () => {
    expect(() => parseThreadList('<p></p>', BASE, { thread_list: 'a[[' }, source)).toThrow(
      expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('selectors.thread_list') }),
    );
  });
});

describe('customAdapter', () => {
  it('agrees with Registry.canSearch', () => {
    const endpoint = [{ method: 'POST' as const, path: '/search/run', note: 'search form' }];
    for (const s of [
      source,
      testSource({ id: 'test-custom', engine: 'custom', base_url: BASE, selectors: SEL, search_url: `${BASE}/find?q={query}` }),
      testSource({ id: 'test-custom', engine: 'custom', base_url: BASE, selectors: { ...SEL, search_form: 'form', search_input: 'input' }, read_endpoints: endpoint }),
      testSource({ id: 'test-custom', engine: 'custom', base_url: BASE, selectors: { ...SEL, search_form: 'form', search_input: 'input' } }),
    ]) {
      expect(customAdapter.canSearch(s)).toBe(canSearch(s));
    }
  });

  it('refuses search without search_url or a form before any request', async () => {
    await expect(customAdapter.search(noReaderCtx(), 'starter', 5)).rejects.toMatchObject({ code: 'search_unsupported' });
  });

  it('has no author lookup', async () => {
    await expect(customAdapter.authorSignals(noReaderCtx(), { username: 'erin', profileUrl: `${BASE}/user/erin` })).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Author lookup is not available for custom sources.',
    });
  });

  it('refuses a thread URL on another host without its query', () => {
    expect(() => customAdapter.canonicalUrl(source, 'https://elsewhere.example.net/thread/1?u=erin')).toThrow(
      expect.objectContaining({ code: 'off_domain', message: expect.not.stringContaining('erin') }),
    );
  });
});
