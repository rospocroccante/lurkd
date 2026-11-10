import { describe, expect, it } from 'vitest';
import type { PageReader } from '../../src/browser/reader.js';
import { LurkdError } from '../../src/errors.js';
import { adapterFor, type ExtractContext } from '../../src/extract/engine.js';
import {
  canonicalThreadUrl,
  nextPageUrl,
  pageNumberOf,
  pageUrlOf,
  parseMemberPage,
  parseSearchResults,
  parseThreadPage,
  threadPosts,
  xenforoAdapter,
} from '../../src/extract/xenforo.js';
import { nameResolver, renderThread, toRenderInput } from '../../src/output/render.js';
import { findLeaks, NAME_CLOSE, NAME_OPEN } from '../../src/pseudonym.js';
import { namesAuthor } from '../../src/extract/scrub.js';
import { canSearch } from '../../src/sources/registry.js';
import type { ExtractedThread } from '../../src/types.js';
import { fixture, range, testSource } from '../helpers/common.js';

const SALT = 'f'.repeat(64);
const BASE = 'https://forum.example.org';
const THREAD = `${BASE}/threads/test.55/`;
const source = testSource({ id: 'test-xenforo', engine: 'xenforo', base_url: BASE });
const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin'];
const marked = (name: string) => `${NAME_OPEN}${name}${NAME_CLOSE}`;

/** A context whose reader fails the test when anything uses it. */
function noReaderCtx(src = source): ExtractContext {
  const reader = new Proxy({}, { get: (_t, key) => { throw new Error(`the reader was used: ${String(key)}`); } }) as unknown as PageReader;
  return { reader, source: src, onProgress: () => {} };
}

describe('canonicalThreadUrl', () => {
  it('canonicalises page URLs', () => {
    expect(canonicalThreadUrl('https://f.example/threads/x.55/page-3')).toBe('https://f.example/threads/x.55/');
    expect(canonicalThreadUrl('https://f.example/index.php?threads/x.55/page-2')).toBe('https://f.example/index.php?threads/x.55/');
  });

  it('gives one URL for every form of one thread', () => {
    for (const url of [
      'https://f.example/threads/x.55',
      'https://f.example/threads/x.55/',
      'https://f.example/threads/x.55/page-12/',
      'https://f.example/threads/x.55/post-1234',
      'https://f.example/threads/x.55/?u=erin#post-9',
    ]) {
      expect(canonicalThreadUrl(url)).toBe('https://f.example/threads/x.55/');
    }
    expect(canonicalThreadUrl('https://f.example/community/index.php?threads/x.55/page-4&u=erin#post-1')).toBe('https://f.example/community/index.php?threads/x.55/');
  });

  it('refuses what is no URL, without echoing a query', () => {
    expect(() => canonicalThreadUrl('not a url')).toThrow(LurkdError);
  });
});

describe('xenforoAdapter.canonicalUrl', () => {
  it('accepts thread paths of the source only', () => {
    expect(xenforoAdapter.canonicalUrl(source, `${THREAD}page-2`)).toBe(THREAD);
    expect(xenforoAdapter.canonicalUrl(source, `${BASE}/threads/test.55/post-1003`)).toBe(THREAD);
    expect(() => xenforoAdapter.canonicalUrl(source, `${BASE}/forums/boards.2/`)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => xenforoAdapter.canonicalUrl(source, `${BASE}/threads/test.55/unread`)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('answers off_domain for another host and drops query and fragment from the message', () => {
    let err: unknown;
    try {
      xenforoAdapter.canonicalUrl(source, 'https://elsewhere.example/threads/x.9/?u=erin#post-3');
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'off_domain' });
    expect(JSON.stringify({ m: (err as LurkdError).message, d: (err as LurkdError).details })).not.toMatch(/erin|post-3/);
  });
});

describe('page numbers', () => {
  it('builds and reads page URLs in both URL forms', () => {
    expect(pageUrlOf(THREAD, 1)).toBe(THREAD);
    expect(pageUrlOf(THREAD, 3)).toBe(`${THREAD}page-3`);
    expect(pageUrlOf(`${BASE}/index.php?threads/test.55/`, 2)).toBe(`${BASE}/index.php?threads/test.55/page-2`);
    expect(pageNumberOf(`${THREAD}page-3`)).toBe(3);
    expect(pageNumberOf(THREAD)).toBe(1);
    expect(pageNumberOf(`${BASE}/index.php?threads/test.55/page-2`)).toBe(2);
    expect(pageNumberOf(`${THREAD}post-1003`)).toBeNull();
  });

  it('follows a next link only inside the thread, on the source, to a page not read yet', () => {
    const visited = new Set([1]);
    expect(nextPageUrl(source, THREAD, `${THREAD}`, 'page-2', visited)).toEqual({ url: `${THREAD}page-2`, page: 2 });
    expect(nextPageUrl(source, THREAD, THREAD, '/threads/test.55/page-2?x=1#top', visited)).toEqual({ url: `${THREAD}page-2`, page: 2 });
    // Off the source's hosts.
    expect(nextPageUrl(source, THREAD, THREAD, 'https://elsewhere.example/threads/test.55/page-2', visited)).toBeNull();
    // Another thread.
    expect(nextPageUrl(source, THREAD, THREAD, '/threads/other.56/page-2', visited)).toBeNull();
    // A page already read (loop guard).
    expect(nextPageUrl(source, THREAD, `${THREAD}page-2`, '/threads/test.55/', new Set([1, 2]))).toBeNull();
    expect(nextPageUrl(source, THREAD, `${THREAD}page-2`, 'page-2', new Set([1, 2]))).toBeNull();
    // Not a page link, or none at all.
    expect(nextPageUrl(source, THREAD, THREAD, '/threads/test.55/post-1003', visited)).toBeNull();
    expect(nextPageUrl(source, THREAD, THREAD, '/threads/test.55/reply', visited)).toBeNull();
    expect(nextPageUrl(source, THREAD, THREAD, null, visited)).toBeNull();
    expect(nextPageUrl(source, THREAD, THREAD, 'javascript:void(0)', visited)).toBeNull();
  });
});

describe('parseThreadPage', () => {
  const p1 = parseThreadPage(fixture('xenforo/thread-p1.html'), THREAD);

  it('reads posts, title, next link and the last page', () => {
    expect(p1.posts.map((p) => p.position)).toEqual(range(1, 20));
    expect(p1.title).toBe('Solved Board resets after the firmware update');
    expect(p1.next).toBe(`${THREAD}page-2`);
    expect(p1.lastPage).toBe(3);
    expect(p1.isError).toBe(false);
    const p3 = parseThreadPage(fixture('xenforo/thread-p3.html'), `${THREAD}page-3`);
    expect(p3.posts.map((p) => p.position)).toEqual(range(41, 50));
    expect(p3.next).toBeNull();
  });

  it('turns a page into posts with signals, notes and a marked body', () => {
    const posts = threadPosts(p1, 1, source);
    const first = posts[0]!;
    expect(first).toMatchObject({
      number: 1,
      page: 1,
      author: 'alice',
      authorUrl: `${BASE}/members/alice.1/`,
      postedAt: '2024-01-02T10:00:00.000Z',
      signals: ['title "Well-known member"', 'banner "Staff member"', 'joined Mar 1, 2019', 'messages 1,234', 'reaction score 567', 'points 89'],
      notes: ['3 reactions', 'page 1'],
    });
    // Location is not a reputation signal.
    expect(first.signals.join(' ')).not.toContain('Lab bench');
    expect(posts[1]!.notes).toEqual(['0 reactions', 'page 1']);
    // Post 3 quotes post 1 by alice: a marked header, no "said:" chrome, no expand link.
    const third = posts[2]!.bodyMd;
    expect(third).toContain(`> ${marked('alice')} wrote (post id 1001):`);
    expect(third).not.toMatch(/said:|Click to expand/);
    // The signature and the reactions bar stay out of the body.
    expect(posts[8]!.bodyMd).not.toContain('Signature');
    expect(posts.map((p) => p.bodyMd).join('\n')).not.toMatch(/<bdi>|bdi/);
  });

  it('marks an error page and finds no posts there', () => {
    const page = parseThreadPage('<!doctype html><html data-template="error"><body><div class="blockMessage">The requested thread could not be found.</div></body></html>', THREAD);
    expect(page).toMatchObject({ posts: [], isError: true, next: null, lastPage: null });
  });
});

describe('rendered thread', () => {
  it('leaks no real name over three pages', () => {
    const posts = [1, 2, 3].flatMap((n) => threadPosts(parseThreadPage(fixture(`xenforo/thread-p${n}.html`), n === 1 ? THREAD : `${THREAD}page-${n}`), n, source));
    expect(posts.map((p) => p.number)).toEqual(range(1, 50));
    const t: ExtractedThread = { url: THREAD, title: 'x', engine: 'xenforo', postsExpected: null, pages: 3, extraction: 'dom (3 of 3 pages)', quality: 'full', posts };
    const md = renderThread(toRenderInput('test-xenforo', t, '2026-11-09T00:00:00.000Z'), nameResolver({ sourceId: 'test-xenforo', salt: SALT, realNames: false })).markdown;
    expect([...findLeaks(md, NAMES)]).toEqual([]);
    // The mention and the member link of the fixture are there, as pseudonyms.
    expect(posts[29]!.bodyMd).toContain(`@${marked('carol')}`);
    expect(posts[40]!.bodyMd).toContain(`@${marked('dave')}`);
  });
});

describe('parseSearchResults', () => {
  it('keeps thread links on the source, once each, canonical', () => {
    const hits = parseSearchResults(fixture('xenforo/search-results.html'), `${BASE}/search/77/?q=board&o=relevance`, source);
    expect(hits).toEqual([
      { url: THREAD, title: 'Board resets after the firmware update', posts: null },
      { url: `${BASE}/threads/riser-cable-errors.57/`, title: 'Riser cable errors on a second board', posts: null },
      { url: `${BASE}/threads/fan-curve-resets.58/`, title: 'Fan curve resets on reboot', posts: null },
    ]);
  });
});

describe('parseMemberPage', () => {
  it('reads messages, the join date and the reputation extras', () => {
    expect(parseMemberPage(fixture('xenforo/member.html'))).toEqual({
      header: true,
      isError: false,
      signals: { postCount: 1234, joinedAt: '2019-03-01T10:00:00.000Z', extra: ['solutions 3', 'reaction score 567', 'points 89'] },
    });
  });

  it('gives null for a count it would have to guess', () => {
    const html = '<html><body><div class="memberHeader"><div class="memberHeader-stats"><dl><dt>Messages</dt><dd>1.2K</dd></dl></div></div></body></html>';
    expect(parseMemberPage(html).signals).toEqual({ postCount: null, joinedAt: null, extra: [] });
  });
});

describe('xenforoAdapter', () => {
  it('is the adapter for xenforo sources', () => {
    expect(adapterFor(source)).toBe(xenforoAdapter);
    expect(xenforoAdapter.engine).toBe('xenforo');
  });

  it('agrees with Registry.canSearch', () => {
    const endpoint = [{ method: 'POST' as const, path: '/search/search', note: 'XenForo search form' }];
    for (const s of [
      source,
      testSource({ id: 'test-xenforo', engine: 'xenforo', base_url: BASE, read_endpoints: endpoint }),
      testSource({ id: 'test-xenforo', engine: 'xenforo', base_url: BASE, search_url: `${BASE}/search/?q={query}` }),
    ]) {
      expect(xenforoAdapter.canSearch(s)).toBe(canSearch(s));
    }
    expect(xenforoAdapter.canSearch(source)).toBe(false);
  });

  it('refuses a POST search without read_endpoints before any request', async () => {
    await expect(xenforoAdapter.search(noReaderCtx(), 'board', 5)).rejects.toMatchObject({
      code: 'search_unsupported',
      message: 'This XenForo source searches with POST and lists no read_endpoints entry.',
    });
  });

  it('keeps the username, its slug and the profile query out of author lookup errors', async () => {
    const err = await xenforoAdapter
      .authorSignals(noReaderCtx(), { username: 'Erin Smith', profileUrl: 'https://elsewhere.example/members/erin-smith.5/?tab=about#x' })
      .then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'off_domain' });
    const text = JSON.stringify({ m: (err as LurkdError).message, d: (err as LurkdError).details });
    expect(text).not.toMatch(/erin|smith|tab=about/i);
    expect(text).toContain('/members/<author>.5/');
  });

  it('needs a profile URL for an author lookup', async () => {
    await expect(xenforoAdapter.authorSignals(noReaderCtx(), { username: 'erin', profileUrl: null })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(xenforoAdapter.authorSignals(noReaderCtx(), { username: ' ', profileUrl: `${BASE}/members/erin.5/` })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

// ---- review round 1: hostile pages against fetchThread, with a reader that serves strings ----

interface Served {
  status?: number;
  html: string;
  finalUrl?: string;
}

/** Serves fixed pages by URL; any other URL answers 404. Records every URL opened. */
class FakeReader {
  requests: string[] = [];
  private current = 'about:blank';
  private html = '';
  readonly page = { url: () => this.current };
  constructor(private readonly pages: Record<string, Served>) {}
  async open(url: string) {
    this.requests.push(url);
    const p = this.pages[url] ?? { status: 404, html: '<!doctype html><body><p>not found</p></body>' };
    this.current = p.finalUrl ?? url;
    this.html = p.html;
    return { status: p.status ?? 200, finalUrl: this.current, detection: null };
  }
  async evaluate() {
    return this.html;
  }
}

interface FakePost {
  n: number;
  author: string;
  body?: string;
  title?: string;
  extras?: Array<[string, string]>;
}

function fakePost(p: FakePost, thread: string): string {
  const extras = (p.extras ?? []).map(([k, v]) => `<dl class="pairs"><dt>${k}</dt><dd>${v}</dd></dl>`).join('');
  return `<article class="message message--post js-post" data-author="${p.author}">
  <section class="message-user"><h4 class="message-name"><a href="/members/${p.author}.9/" class="username" data-user-id="9">${p.author}</a></h4>
  ${p.title ? `<h5 class="userTitle message-userTitle">${p.title}</h5>` : ''}<div class="message-userExtras">${extras}</div></section>
  <header class="message-attribution"><ul class="message-attribution-main"><li><time datetime="2024-01-02T10:00:00+0000">x</time></li></ul>
  <ul class="message-attribution-opposite"><li><a href="${thread}post-${1000 + p.n}">#${p.n}</a></li></ul></header>
  <article class="message-body"><div class="bbWrapper">${p.body ?? `body ${p.n}`}</div></article></article>`;
}

function fakePage(o: { thread: string; pages?: Array<number | string>; next?: string | null; posts: FakePost[] }): string {
  const nav = (o.pages ?? []).length
    ? `<div class="pageNav"><ul class="pageNav-main">${o.pages!.map((n) => `<li class="pageNav-page"><a href="${o.thread}page-${n}">${n}</a></li>`).join('')}</ul>${o.next ? `<a href="${o.next}" class="pageNav-jump pageNav-jump--next">Next</a>` : ''}</div>`
    : '';
  return `<!doctype html><html data-template="thread_view"><body><h1 class="p-title-value">T</h1>${nav}${o.posts.map((p) => fakePost(p, o.thread)).join('\n')}</body></html>`;
}

const fakePosts = (from: number, to: number, author = 'alice'): FakePost[] => range(from, to).map((n) => ({ n, author }));
const T1 = `${BASE}/threads/t.1/`;

async function fetchWith(pages: Record<string, Served>, url = T1, src = source) {
  const reader = new FakeReader(pages);
  const ctx = { reader: reader as unknown as PageReader, source: src, onProgress: () => {} };
  const t = await xenforoAdapter.fetchThread(ctx, url);
  return { t, requests: reader.requests };
}

describe('fetchThread against hostile pages', () => {
  it('B: a next link to page-0 does not request page 1 again', async () => {
    const { t, requests } = await fetchWith({ [T1]: { html: fakePage({ thread: '/threads/t.1/', pages: [1, 2], next: '/threads/t.1/page-0', posts: fakePosts(1, 3) }) } });
    expect(requests).toEqual([T1]);
    expect(t.pages).toBe(1);
    expect(pageNumberOf(`${T1}page-0`)).toBeNull();
  });

  it('G: a later page that redirects to another thread ends the read without its posts', async () => {
    const { t, requests } = await fetchWith({
      [T1]: { html: fakePage({ thread: '/threads/t.1/', pages: [1, 2], next: '/threads/t.1/page-2', posts: fakePosts(1, 3) }) },
      [`${T1}page-2`]: { finalUrl: `${BASE}/threads/other.2/`, html: fakePage({ thread: '/threads/other.2/', posts: fakePosts(40, 41, 'mallory') }) },
    });
    expect(requests).toEqual([T1, `${T1}page-2`]);
    expect(t.posts.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(t.posts.every((p) => p.author === 'alice')).toBe(true);
    expect(t.pages).toBe(1);
  });

  it('I: a later page without posts is not counted', async () => {
    const { t } = await fetchWith({
      [T1]: { html: fakePage({ thread: '/threads/t.1/', pages: [1, 2], next: '/threads/t.1/page-2', posts: fakePosts(1, 3) }) },
      [`${T1}page-2`]: { html: fakePage({ thread: '/threads/t.1/', pages: [1, 2], posts: [] }) },
    });
    expect(t.pages).toBe(1);
    expect(t.extraction).toBe('dom (1 of 2 pages)');
  });

  it('J: an absurd page count in the navigation is ignored', async () => {
    const { t } = await fetchWith({ [T1]: { html: fakePage({ thread: '/threads/t.1/', pages: [1, '999999999999999', '1e309', 'NaN'], posts: fakePosts(1, 2) }) } });
    expect(t.extraction).toBe('dom (1 of 1 pages)');
    expect(parseThreadPage(fakePage({ thread: '/threads/t.1/', pages: ['100001'], posts: fakePosts(1, 1) }), T1).lastPage).toBeNull();
    expect(parseThreadPage(fakePage({ thread: '/threads/t.1/', pages: ['2,000'], posts: fakePosts(1, 1) }), T1).lastPage).toBe(2000);
  });

  it('K: an article nested in a post body is not a post of its own', async () => {
    const nested = fakePost({ n: 7, author: 'mallory', body: 'injected post' }, '/threads/t.1/');
    const { t } = await fetchWith({
      [T1]: { html: fakePage({ thread: '/threads/t.1/', posts: [{ n: 1, author: 'alice' }, { n: 2, author: 'bob', body: `two ${nested} after` }, { n: 3, author: 'carol' }] }) },
    });
    expect(t.posts.map((p) => [p.number, p.author])).toEqual([
      [1, 'alice'],
      [2, 'bob'],
      [3, 'carol'],
    ]);
  });

  it('a later page redirected to the forum index (or to no URL at all) ends the read, keeping page 1', async () => {
    for (const finalUrl of [`${BASE}/forums/boards.2/`, `${BASE}/`, 'not a url']) {
      const { t, requests } = await fetchWith({
        [T1]: { html: fakePage({ thread: '/threads/t.1/', pages: [1, 2], next: '/threads/t.1/page-2', posts: fakePosts(1, 3) }) },
        [`${T1}page-2`]: { finalUrl, html: '<!doctype html><html data-template="forum_list"><body><p>Forum list.</p></body></html>' },
      });
      expect(requests).toEqual([T1, `${T1}page-2`]);
      expect(t.posts.map((p) => p.number)).toEqual([1, 2, 3]);
      expect(t.pages).toBe(1);
    }
  });

  it('Q: stacked position segments collapse to one thread URL', () => {
    expect(xenforoAdapter.canonicalUrl(source, `${BASE}/threads/t.1/page-2/page-3`)).toBe(T1);
    expect(xenforoAdapter.canonicalUrl(source, `${BASE}/threads/t.1/page-2/post-77`)).toBe(T1);
    expect(xenforoAdapter.canonicalUrl(source, `${BASE}/threads/t.1/post-77`)).toBe(T1);
    expect(canonicalThreadUrl(`${BASE}/index.php?threads/t.1/page-2/post-9&u=erin`)).toBe(`${BASE}/index.php?threads/t.1/`);
    expect(() => xenforoAdapter.canonicalUrl(source, `${BASE}/threads/t.1//page-2`)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => xenforoAdapter.canonicalUrl(source, `${BASE}/threads/t.1/unread`)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });
});

describe('signals that could carry a name', () => {
  const html = fakePage({
    thread: '/threads/t.1/',
    posts: [
      { n: 1, author: 'alice', title: "alice's lab", extras: [['Joined', 'Mar 1, 2019'], ['Messages', '1,234'], ['Points', 'ask alice'], ['Reaction score', '1.2K']] },
      { n: 2, author: 'bob', title: 'Visits the lab of carol', extras: [['Joined', 'whenever bob felt like it 2019'], ['Solutions', '3']] },
    ],
  });
  const posts = threadPosts(parseThreadPage(html, T1), 1, source);

  it("drops a user title that names the post's author", () => {
    expect(posts[0]!.signals).toEqual(['joined Mar 1, 2019', 'messages 1,234']);
  });

  it('keeps only extras with a count, or a date for joined', () => {
    // A title naming another member stays (free text, like a post body); a non-date joined goes.
    expect(posts[1]!.signals).toEqual(['title "Visits the lab of carol"', 'solutions 3']);
  });

  it('drops a banner that carries the member slug', () => {
    const page = parseThreadPage(
      `<html><body><article class="message--post" data-author="Erin Smith"><h4 class="message-name"><a class="username" href="/members/erin-smith.5/">Erin Smith</a></h4>
      <div class="message-userBanner">ERIN-SMITH fan club</div><div class="message-userBanner">Erin Smith approved</div><div class="message-userBanner">Supporter</div>
      <div class="message-body"><div class="bbWrapper">hi</div></div></article></body></html>`,
      T1,
    );
    expect(threadPosts(page, 1, source)[0]!.signals).toEqual(['banner "Supporter"']);
  });

  it('sees the author through dots, spaces, accents and joined words', () => {
    for (const text of ['a.l.i.c.e fan', 'the a l i c e show', 'Álice approved', 'ＡＬＩＣＥ', "alice's lab"]) expect(namesAuthor(text, ['alice'])).toBe(true);
    expect(namesAuthor('alicesmith fan club', ['alice smith'])).toBe(true);
    expect(namesAuthor('Alice-Smith', ['alice smith'])).toBe(true);
    // Whole words only: a short name never matches inside a longer word.
    expect(namesAuthor('local hero', ['al'])).toBe(false);
    expect(namesAuthor('Well-known member', ['al', 'alice'])).toBe(false);
    expect(namesAuthor('malice aforethought', ['alice'])).toBe(false);
  });

  it('drops a member extra that is not a count', () => {
    const member = '<html><body><div class="memberHeader"><div class="memberHeader-stats"><dl><dt>Points</dt><dd>see profile</dd></dl><dl><dt>Solutions</dt><dd>12</dd></dl></div></div></body></html>';
    expect(parseMemberPage(member).signals.extra).toEqual(['solutions 12']);
  });
});
