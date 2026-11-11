import { describe, expect, it } from 'vitest';
import { boundedDocument, costlySelector, MAX_ELEMENTS } from '../../src/extract/bounds.js';
import { readabilityThread } from '../../src/extract/generic.js';
import { makeConverter } from '../../src/extract/markdown.js';
import { authorForms, checkSelector, parseSelectorPage, selectorPosts } from '../../src/extract/selectors.js';
import { nameResolver, renderThread, toRenderInput } from '../../src/output/render.js';
import { findLeaks, NAME_CLOSE, NAME_OPEN } from '../../src/pseudonym.js';
import type { Selectors } from '../../src/sources/schema.js';
import type { ExtractedPost } from '../../src/types.js';
import { testSource } from '../helpers/common.js';

// Cases from the Task 12 review probes: hostile pages and selectors, author forms in signals and
// bodies, quote headers of real forum engines.

const SALT = '9'.repeat(64);
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
};
const sourceWith = (sel: Selectors) => testSource({ id: 'test-custom', engine: 'custom', base_url: BASE, selectors: sel });
const source = sourceWith(SEL);
const convert = makeConverter({ baseUrl: BASE });
const marked = (name: string) => `${NAME_OPEN}${name}${NAME_CLOSE}`;

function postsOf(html: string, sel: Selectors = SEL): ExtractedPost[] {
  const src = sourceWith(sel);
  return selectorPosts(parseSelectorPage(html, THREAD, sel, src), 1, src, 0, convert);
}

function rendered(posts: ExtractedPost[]): string {
  const t = { url: THREAD, title: 't', engine: 'custom' as const, postsExpected: null, pages: 1, extraction: 'selectors', quality: 'full' as const, posts };
  return renderThread(toRenderInput('test-custom', t, '2026-11-09T00:00:00.000Z'), nameResolver({ sourceId: 'test-custom', salt: SALT, realNames: false })).markdown;
}

/**
 * The CPU time `fn` takes, user plus system, in ms. Vitest runs each test file in a process of its
 * own (the forks pool), so other test files and programs running at the same time do not count,
 * as they do in wall-clock time: the bounds below measure the work, not the machine's load.
 */
const cpuTime = (fn: () => unknown): { ms: number; error: unknown } => {
  const t0 = process.cpuUsage();
  let error: unknown = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  const d = process.cpuUsage(t0);
  return { ms: (d.user + d.system) / 1000, error };
};

describe('page bounds (Critical 1)', () => {
  it('refuses HTML over 5 MB, documents over 50 000 elements and deeper than 1000 levels', () => {
    expect(() => boundedDocument(`<p>${'x'.repeat(5 * 1024 * 1024)}</p>`, 'The page')).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('5 MB') }));
    expect(() => boundedDocument(`<div>${'<p><i></i><i></i><i></i><i></i></p>'.repeat(600)}</div>`.repeat(20), 'The page')).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('50000 elements') }));
    expect(() => boundedDocument(`${'<div>'.repeat(1001)}x${'</div>'.repeat(1001)}`, 'The page')).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('1000 levels') }));
    expect(boundedDocument(`${'<div>'.repeat(999)}x${'</div>'.repeat(999)}`, 'The page').querySelectorAll('div')).toHaveLength(999);
    // More than 5000 element children under one parent, or at the top of a fragment.
    expect(() => boundedDocument(`<div>${'<i></i>'.repeat(5_001)}</div>`, 'The page')).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('5000 child elements') }));
    expect(() => boundedDocument('<i></i>'.repeat(5_001), 'The page')).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('5000 child elements') }));
    expect(boundedDocument(`<div>${'<i></i>'.repeat(5_000)}</div>`, 'The page').querySelectorAll('i')).toHaveLength(5_000);
    // Fragments with several top-level elements are counted whole.
    expect(() => boundedDocument(`<p></p>${'<b><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></b>'.repeat(MAX_ELEMENTS / 10)}`, 'The page')).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('elements') }));
  });

  it('turns deep nesting into extraction_failed, never a stack overflow (Minor 11)', () => {
    const deep = `<html><body><article class="post"><div class="post-author"><span class="name">alice</span></div><div class="post-body">${'<div class="quote">'.repeat(3000)}bob said: deep${'</div>'.repeat(3000)}</div></article></body></html>`;
    for (const sel of [SEL, { ...SEL, quote: 'div' }, { ...SEL, post: '*', quote: '*' }]) {
      expect(() => postsOf(deep, sel)).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('levels deep') }));
    }
    expect(() => readabilityThread(`<html><body>${'<div>'.repeat(3000)}<p>text</p>${'</div>'.repeat(3000)}</body></html>`, THREAD)).toThrow(
      expect.objectContaining({ code: 'extraction_failed' }),
    );
  });

  it('gives Readability a tighter depth bound, where its time grows with the square of the depth', () => {
    const page = (d: number) => `<html><body>${'<div>'.repeat(d)}${'<p>Fermented foods keep for months in a cool cellar. </p>'.repeat(5)}${'</div>'.repeat(d)}</body></html>`;
    expect(() => readabilityThread(page(400), THREAD)).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('300 levels') }));
    expect(readabilityThread(page(250), THREAD).posts).toHaveLength(1);
  });
});

describe('costly selectors (Critical 1)', () => {
  it('refuses sibling combinators and nested :has(), naming the key', () => {
    for (const s of ['.post ~ .post', 'article ~ article ~ article', '.post + .post', 'a+b', ':has(:has(span))', 'div:has(p :has(b))', ':not(:has(*))', 'div:not(.x :has(b))', ':has(:is(:has(b)))']) {
      expect(costlySelector(s), s).not.toBeNull();
      expect(() => checkSelector(source, 'selectors.post', s), s).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('selectors.post') }));
    }
  });

  it('refuses "+" in an :nth-*( of ...) argument and reads escaped pseudo-class names', () => {
    for (const s of ['i:nth-child(2n+1 of .post)', 'i:nth-child(n of .post + .post)', ':nth-last-of-type(n of a + b)', String.raw`:h\61s(:h\61s(*))`, String.raw`:has(:h\61s(*))`, String.raw`:\68 as(:\68 as(*))`, String.raw`:n\6ft(:has(*))`, String.raw`:not(:h\61s(*))`]) {
      expect(costlySelector(s), s).not.toBeNull();
    }
    expect(costlySelector('li:nth-child(1 of .x)')).toBeNull();
  });

  it('accepts the same characters where they are no combinator', () => {
    for (const s of ['[class~="x"]', 'a[title="a+b ~ c"]', 'li:nth-child(2n+1)', 'li:nth-last-of-type(-n+3)', 'a:has(> b)', ':has(b), :has(c)', 'p:not(.x)', 'div.a\\~b', 'article.post']) {
      expect(costlySelector(s), s).toBeNull();
      expect(() => checkSelector(source, 'selectors.post', s), s).not.toThrow();
    }
  });

  it('finishes the review probes worst page shapes in under 2 s of CPU time each', () => {
    const post = (i: number) =>
      `<article class="post"><div class="post-author"><a href="/user/u${i}"><span class="name">u${i}</span></a><span class="stats">s</span></div><time datetime="2026-10-01T09:00:00Z">d</time><div class="post-body"><div class="quote">u${i} said: q</div><p>body ${i}</p></div></article>`;
    const page = (n: number) => `<!doctype html><html><head><title>t</title></head><body><h1 class="thread-title">t</h1>${Array.from({ length: n }, (_, i) => post(i)).join('')}</body></html>`;
    // 100 000 elements, 4.8 MB: refused after one parse and walk.
    const big = page(20_000);
    // Just under the element bound: these shapes run to a result in process. Positional
    // pseudo-classes and :has() lists are bounded by the page worker (test/unit/page-worker.test.ts).
    const wide = page(4_500);
    const deep = `<html><body><article class="post"><span class="name">alice</span><div class="post-body">${'<div class="quote">'.repeat(3000)}bob said: deep${'</div>'.repeat(3000)}</div></article></body></html>`;
    const nearDeep = `<html><body><article class="post"><span class="name">alice</span><div class="post-body">${'<div class="quote">'.repeat(990)}bob said: deep${'</div>'.repeat(990)}</div></article></body></html>`;
    const { body: _b, ...noBody } = SEL;
    // 2 s of CPU time each (see cpuTime): on an idle machine the wide page takes about 450 ms.
    const cases: Array<[string, string, Selectors]> = [
      ['big page', big, SEL],
      ['big page, sibling chain', big, { ...SEL, post: 'article ~ article ~ article ~ article ~ article' }],
      ['big page, nested :has', big, { ...SEL, post: ':has(:has(*))' }],
      ['wide page', wide, SEL],
      ['wide page, post :has(*)', wide, { ...SEL, post: ':has(*)' }],
      ['wide page, post body, default body', wide, { ...noBody, post: 'body' }],
      ['wide page, quote *', wide, { ...SEL, quote: '*' }],
      ['wide page, post *, quote *', wide, { ...noBody, post: '*', quote: '*' }],
      ['wide page, :is chain', wide, { ...SEL, post: 'article.post :is(*, *, *, *) *' }],
      ['deep page', deep, SEL],
      ['near-deep page', nearDeep, { ...SEL, post: '*', quote: '*' }],
    ];
    for (const [label, html, sel] of cases) {
      const { ms, error } = cpuTime(() => postsOf(html, sel));
      expect(ms, label).toBeLessThan(2_000);
      if (error !== null) expect(error, label).toMatchObject({ code: 'extraction_failed' });
    }
    for (const [label, html] of [['readability, big', big], ['readability, wide', wide]] as const) {
      const { ms, error } = cpuTime(() => readabilityThread(html, THREAD));
      expect(ms, label).toBeLessThan(2_000);
      if (error !== null) expect(error, label).toMatchObject({ code: 'extraction_failed' });
    }
    // The thirteen cases take about 4 to 5 s of wall-clock time on an idle machine, near the
    // default 5 s test timeout; each case has its own bound above, so the test as a whole gets room.
  }, 60_000);
});

describe('author forms in signals and bodies (Critical 2, Important 5)', () => {
  it('reads signals without the author element, its link and the date, joining texts with spaces', () => {
    const html = '<article class="post"><div class="who"><a href="/user/alice"><span class="name">alice</span></a><span class="stats">Regular member,</span><b>312 posts</b><time>1 Oct 2026</time></div><div class="body"><p>hi</p></div></article>';
    const [p] = postsOf(html, { post: 'article.post', author: '.name', author_signals: '.who', date: 'time', body: '.body' });
    expect(p!.signals).toEqual(['Regular member, 312 posts']);
    expect([...findLeaks(rendered([p!]), ['alice'])]).toEqual([]);
  });

  it('drops a signal that is the author element or lies inside it', () => {
    const html = '<article class="post"><div class="who"><a href="/user/alice"><span class="name">alice <i class="stats">Moderator</i></span></a></div><div class="body"><p>hi</p></div></article>';
    expect(postsOf(html, { post: 'article.post', author: '.name', author_signals: '.stats', body: '.body' })[0]!.signals).toEqual([]);
    expect(postsOf(html, { post: 'article.post', author: '.name', author_signals: '.name', body: '.body' })[0]!.signals).toEqual([]);
  });

  it('knows the profile slug as a form of the author', () => {
    expect(authorForms('Alice S.', `${BASE}/user/alice-smith.77`)).toEqual(['Alice S.', 'alice-smith.77', 'alice smith.77', 'alice-smith', 'alice smith']);
    expect(authorForms('bob', `${BASE}/members/3-bob`)).toEqual(['bob', '3-bob', '3 bob']);
    expect(authorForms('bob', `${BASE}/memberlist.php?mode=viewprofile&u=3`)).toEqual(['bob']);
    expect(authorForms('bob', `${BASE}/u/77/`)).toEqual(['bob']);
  });

  it('drops a signal naming the slug and removes links to the profile and its subpages', () => {
    const html =
      '<article class="post"><div class="who"><a href="/user/alice-smith.77"><span class="name">Alice S.</span></a><span class="stats">alice-smith\'s lab</span></div>' +
      '<div class="body"><p>See <a href="/user/alice-smith.77/posts">my posts</a>, <a href="/user/alice-smith.77?tab=about">about me</a>, <a href="/user/dave.4">another member</a> and <img src="/a/alice-smith.png" alt="me">.</p></div></article>';
    const [p] = postsOf(html, { post: 'article.post', author: '.name', author_signals: '.stats', body: '.body' });
    expect(p!.signals).toEqual([]);
    expect(p!.bodyMd).not.toMatch(/my posts|about me|alice-smith\.png/);
    expect(p!.bodyMd).toContain('another member');
    expect([...findLeaks(rendered([p!]), ['alice-smith', 'alice smith', 'Alice S.'])]).toEqual([]);
  });

  it('removes only the author profile among query-identified profile links', () => {
    const html =
      '<div class="post"><dl class="postprofile"><dt><a href="./memberlist.php?mode=viewprofile&amp;u=3" class="username">bob</a></dt></dl>' +
      '<div class="content"><p>Me: <a href="./memberlist.php?u=3&amp;mode=viewprofile&amp;tab=posts">my posts</a>, ' +
      '<a href="./memberlist.php?mode=viewprofile&amp;u=3#about">about me</a>, and <a href="./memberlist.php?mode=viewprofile&amp;u=5">a friend</a>, ' +
      '<a href="./memberlist.php?mode=viewprofile&amp;u=30">another</a>, <a href="./memberlist.php?mode=team">the team</a>.</p></div></div>';
    const [p] = postsOf(html, { post: 'div.post', author: 'dt a.username', body: 'div.content' });
    // Same path and the profile's own parameters, in any order, with more parameters or a fragment.
    expect(p!.bodyMd).not.toMatch(/my posts|about me/);
    for (const kept of ['a friend', 'another', 'the team']) expect(p!.bodyMd).toContain(kept);
  });
});

describe('quote headers of real engines (Critical 3, Important 4, Minor 8)', () => {
  const phpbb = (cite: string) =>
    `<div class="post"><dl class="postprofile"><dt><a href="./memberlist.php?mode=viewprofile&amp;u=3" class="username">bob</a></dt><dd class="profile-posts">Posts: 300</dd></dl>` +
    `<div class="postbody"><div class="content"><blockquote><div>${cite}My starter smells of nail polish remover.</div></blockquote><p>It is hungry, not ruined.</p></div></div></div>`;
  const phpbbSel: Selectors = { post: 'div.post', author: 'dl.postprofile dt a.username', author_signals: 'dd.profile-posts', body: 'div.content', quote: 'blockquote' };

  it('reads the phpBB 3 cite, with and without the arrow link and date', () => {
    for (const cite of [
      '<cite><a href="./memberlist.php?mode=viewprofile&amp;u=2" class="username">alice</a> wrote: <a href="./viewtopic.php?p=5#p5" data-post-id="5">↑</a><span class="responsive-hide">Mon Oct 01, 2026 9:00 am</span></cite>',
      '<cite><a href="./memberlist.php?mode=viewprofile&amp;u=2" class="username">alice</a> wrote:</cite>',
      '<cite>alice wrote:</cite>',
    ]) {
      const [p] = postsOf(phpbb(cite), phpbbSel);
      expect(p!.bodyMd, cite).toContain(`> ${marked('alice')} wrote:`);
      expect(p!.bodyMd, cite).toMatch(/^> My starter smells of nail polish remover\.$/m);
      expect(p!.bodyMd, cite).not.toMatch(/↑|Mon Oct/);
      expect(p!.signals).toEqual(['Posts: 300']);
      expect([...findLeaks(rendered([p!]), NAMES)], cite).toEqual([]);
    }
  });

  it('reads a header element deeper in the quote and removes that element only', () => {
    const quote = (inner: string) => `<article class="post"><div class="post-author"><span class="name">carol</span></div><div class="post-body"><div class="quote">${inner}</div><p>Agreed.</p></div></article>`;
    let md = postsOf(quote('<div><div><span>bob said:</span></div><p>Content kept.</p></div>'))[0]!.bodyMd;
    expect(md).toContain(`> ${marked('bob')} wrote:`);
    expect(md).toContain('> Content kept.');
    // A non-avatar image in or next to the header stays; the quoted author's avatar goes.
    md = postsOf(quote('<div><span>bob said:</span><span><img src="/i.png" alt="keep me"></span></div>'))[0]!.bodyMd;
    expect(md).toContain('![keep me](https://forum.example.org/i.png)');
    md = postsOf(quote('<div class="hdr"><img class="avatar" src="/av/bob.png" alt=""><img src="/img/evidence.png" alt="evidence"> bob said:</div><p>Rest.</p>'))[0]!.bodyMd;
    expect(md).toContain(`> ${marked('bob')} wrote:`);
    expect(md).toContain('![evidence](https://forum.example.org/img/evidence.png)');
    expect(md).not.toContain('av/bob.png');
    expect(md).toContain('> Rest.');
    // The header of an outer quote that comes after a nested quote.
    md = postsOf(quote('<div class="quote">dave said: inner</div>erin said: outer'))[0]!.bodyMd;
    expect([...findLeaks(rendered([{ ...postsOf(quote('<div class="quote">dave said: inner</div>'))[0]!, bodyMd: md }]), ['dave'])]).toEqual([]);
    // A quote holding only its header is not emptied: it names the author, marked, and leaks nothing.
    for (const only of ['bob said:', '<cite>bob said:</cite>']) {
      const p = postsOf(quote(only))[0]!;
      expect(p.bodyMd, only).toContain(`> @${marked('bob')} wrote:`);
      expect([...findLeaks(rendered([p]), ['bob'])], only).toEqual([]);
    }
  });

  it('takes the name from a link in an inline header', () => {
    const md = postsOf(`<article class="post"><div class="post-author"><span class="name">carol</span></div><div class="post-body"><div class="quote"><p><a href="/user/erin-smith">Erin Smith</a> said: hi</p></div></div></article>`)[0]!.bodyMd;
    expect(md).toContain(`> ${marked('Erin Smith')} wrote:`);
    expect(md).toMatch(/^> hi$/m);
  });

  it('leaves ordinary quoted sentences alone', () => {
    for (const text of ['My mother said: no', 'The manual said: use 2% salt.', 'Then she said: "leave it a week". And it worked.', 'Note: bob said: hi', 'Mia madre ha scritto: no', 'Everyone who wrote: nonsense']) {
      const md = postsOf(`<article class="post"><div class="post-author"><span class="name">carol</span></div><div class="post-body"><div class="quote">${text}</div></div></article>`)[0]!.bodyMd;
      expect(md, text).not.toContain(NAME_OPEN);
      expect(md.replace(/\\(.)/g, '$1'), text).toContain(`> ${text}`);
    }
  });
});

describe('dates, body and title selectors (Minors 9 and 10)', () => {
  const html = '<article class="post"><div class="post-author"><span class="name">alice</span></div><time>2 Oct</time><div class="post-body"><p>hi</p></div></article>';

  it('takes a text date only with a four-digit year', () => {
    expect(postsOf(html)[0]!.postedAt).toBeNull();
    expect(postsOf(html.replace('2 Oct', '2 Oct 2026'))[0]!.postedAt).not.toBeNull();
    expect(postsOf(html, { ...SEL, date: '.post-author' })[0]!.postedAt).toBeNull();
  });

  it('refuses a body or title selector equal to or inside the author element', () => {
    for (const sel of [{ ...SEL, body: '.post-author .name' }, { ...SEL, body: '.post-author span' }]) {
      expect(() => postsOf(html, sel)).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('selectors.body') }));
    }
    expect(() => postsOf(html, { ...SEL, title: '.post-author .name' })).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('selectors.title') }));
    // The author's wrapping link, and titles around the author.
    const linked = '<h1 class="thread-title">T</h1><article class="post"><div class="who"><a class="lnk" href="/user/alice"><span class="name">alice</span></a> <span class="rank">Admin</span></div><div class="body"><p>hi</p></div></article>';
    const A: Selectors = { post: 'article.post', author: '.name', body: '.body' };
    expect(() => postsOf(linked, { ...A, body: 'a.lnk' })).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('selectors.body') }));
    expect(() => postsOf(linked, { ...A, author: 'a.lnk', body: 'a.lnk' })).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('selectors.body') }));
    for (const title of ['.who', 'article.post', 'a.lnk']) {
      expect(() => postsOf(linked, { ...A, title }), title).toThrow(expect.objectContaining({ code: 'extraction_failed', message: expect.stringContaining('selectors.title') }));
    }
    expect(postsOf(linked, { ...A, body: '.who' })[0]!.bodyMd).not.toContain('alice');
    // An ancestor of the author is a body: the author is taken out of it.
    expect(postsOf(html, { ...SEL, body: 'article.post' })[0]!.bodyMd).not.toContain('alice');
  });
});
