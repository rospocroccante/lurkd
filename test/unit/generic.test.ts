import { describe, expect, it } from 'vitest';
import type { PageReader } from '../../src/browser/reader.js';
import { adapterFor, type ExtractContext } from '../../src/extract/engine.js';
import { genericAdapter, readabilityThread } from '../../src/extract/generic.js';
import { customAdapter } from '../../src/extract/selectors.js';
import { findLeaks } from '../../src/pseudonym.js';
import { canSearch } from '../../src/sources/registry.js';
import { fixture, testSource } from '../helpers/common.js';

const BASE = 'https://forum.example.org';
const source = testSource({ id: 'test-generic', engine: 'generic', base_url: BASE });

/** A context whose reader fails the test when anything uses it. */
function noReaderCtx(src = source): ExtractContext {
  const reader = new Proxy({}, { get: (_t, key) => { throw new Error(`the reader was used: ${String(key)}`); } }) as unknown as PageReader;
  return { reader, source: src, onProgress: () => {} };
}

describe('readabilityThread', () => {
  it('turns an article into one low-quality post without navigation text', () => {
    const t = readabilityThread(fixture('generic/article.html'), 'https://f.example/a/1');
    expect([t.quality, t.posts.length, t.posts[0]!.author]).toEqual(['low', 1, '']);
    expect(t.posts[0]!.bodyMd).toContain('Fermented foods');
    expect(t.posts[0]!.bodyMd).not.toContain('Home | About | Contact');
  });

  it('describes the thread as one readability post', () => {
    const t = readabilityThread(fixture('generic/article.html'), 'https://f.example/a/1#comments');
    expect(t).toMatchObject({ url: 'https://f.example/a/1', engine: 'generic', extraction: 'readability (names not pseudonymised)', quality: 'low', pages: 1, postsExpected: null });
    expect(t.title).toContain('Fermented foods for beginners');
    expect(t.posts[0]).toMatchObject({ number: 1, page: null, author: '', authorUrl: null, signals: [], notes: ['names in this text are not pseudonymised'] });
  });

  it('runs the body through the converter rules: no script text, no javascript: links, absolute links', () => {
    const md = readabilityThread(fixture('generic/article.html'), 'https://f.example/a/1').posts[0]!.bodyMd;
    expect(md).not.toContain('injected text');
    expect(md).not.toContain('javascript:');
    expect(md).toContain('this broken link');
    expect(md).toContain('[guide to fermentation weights](https://f.example/a/4)');
    expect(md).toMatch(/^> Taste the batch/m);
    expect(md).not.toContain('Copyright');
  });

  it('refuses a page with nothing to read', () => {
    expect(() => readabilityThread('<!doctype html><html><body></body></html>', 'https://f.example/a/1')).toThrow(
      expect.objectContaining({ code: 'extraction_failed' }),
    );
  });

  it('refuses a URL that is not absolute', () => {
    expect(() => readabilityThread(fixture('generic/article.html'), '/a/1')).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('marks no names and leaks none of the test names', () => {
    const md = readabilityThread(fixture('generic/article.html'), 'https://f.example/a/1').posts[0]!.bodyMd;
    expect([...findLeaks(md, ['alice', 'bob', 'carol', 'dave', 'erin'])]).toEqual([]);
  });
});

describe('genericAdapter', () => {
  it('is the adapter for generic sources, and custom gets the custom adapter', () => {
    expect(adapterFor(source)).toBe(genericAdapter);
    expect(genericAdapter.engine).toBe('generic');
    const custom = testSource({ id: 'test-custom', engine: 'custom', base_url: BASE, selectors: { post: 'article.post', author: '.name' } });
    expect(adapterFor(custom)).toBe(customAdapter);
  });

  it('canonicalises to the URL without its fragment and refuses other hosts', () => {
    expect(genericAdapter.canonicalUrl(source, `${BASE}/a/1?x=1#top`)).toBe(`${BASE}/a/1?x=1`);
    expect(() => genericAdapter.canonicalUrl(source, 'https://other.example.org/a/1?u=erin')).toThrow(
      expect.objectContaining({ code: 'off_domain', message: expect.not.stringContaining('erin') }),
    );
    expect(() => genericAdapter.canonicalUrl(source, 'ftp://forum.example.org/a/1')).toThrow(expect.objectContaining({ code: 'off_domain' }));
  });

  it('agrees with Registry.canSearch', () => {
    const endpoint = [{ method: 'POST' as const, path: '/search/run', note: 'search form' }];
    const form = { search_form: 'form#s', search_input: 'input[name=q]' };
    for (const s of [
      source,
      testSource({ id: 'test-generic', engine: 'generic', base_url: BASE, search_url: `${BASE}/find?q={query}` }),
      testSource({ id: 'test-generic', engine: 'generic', base_url: BASE, search_url: `${BASE}/find?q={query}`, selectors: { thread_list: 'a' } }),
      testSource({ id: 'test-generic', engine: 'generic', base_url: BASE, selectors: { ...form, thread_list: 'a' }, read_endpoints: endpoint }),
      testSource({ id: 'test-generic', engine: 'generic', base_url: BASE, selectors: form }),
      testSource({ id: 'test-generic', engine: 'generic', base_url: BASE, selectors: form, read_endpoints: endpoint }),
      testSource({ id: 'test-generic', engine: 'generic', base_url: BASE, selectors: { search_form: 'form#s' }, read_endpoints: endpoint }),
    ]) {
      expect(genericAdapter.canSearch(s)).toBe(canSearch(s));
    }
  });

  it('refuses search without search_url or a form before any request', async () => {
    await expect(genericAdapter.search(noReaderCtx(), 'starter', 5)).rejects.toMatchObject({ code: 'search_unsupported' });
  });

  it('refuses search with search_url but no thread_list before any request, as Registry.canSearch says', async () => {
    const s = testSource({ id: 'test-generic', engine: 'generic', base_url: BASE, search_url: `${BASE}/find?q={query}` });
    expect(genericAdapter.canSearch(s)).toBe(false);
    expect(canSearch(s)).toBe(false);
    await expect(genericAdapter.search(noReaderCtx(s), 'starter', 5)).rejects.toMatchObject({ code: 'search_unsupported', message: expect.stringContaining('thread_list') });
  });

  it('answers false for the session without session_check, without a request', async () => {
    await expect(genericAdapter.checkSession(noReaderCtx())).resolves.toBe(false);
  });

  it('has no author lookup', async () => {
    await expect(genericAdapter.authorSignals(noReaderCtx(), { username: 'erin', profileUrl: null })).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Author lookup is not available for generic sources.',
    });
  });
});
