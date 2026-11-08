import { describe, expect, it } from 'vitest';
import { makeConverter } from '../../src/extract/markdown.js';
import { excerpt, nameResolver, renderThread, toRenderInput, type RenderInput } from '../../src/output/render.js';
import { markName, pseudonym } from '../../src/pseudonym.js';
import type { ExtractedPost, ExtractedThread } from '../../src/types.js';

const SOURCE = 'forum-example';
const SALT = 'd'.repeat(64);
const FETCHED = '2026-11-08T00:00:00.000Z';
const mode = nameResolver({ sourceId: SOURCE, salt: SALT, realNames: false });
const real = nameResolver({ sourceId: SOURCE, salt: SALT, realNames: true });
const P = (u: string) => pseudonym(SOURCE, u, SALT);

const post = (number: number, over: Partial<ExtractedPost> = {}): ExtractedPost => ({
  number,
  page: null,
  author: 'alice',
  authorUrl: null,
  signals: [],
  notes: [],
  postedAt: '2026-11-01T10:05:42.000Z',
  bodyMd: `Body of post ${number}.`,
  ...over,
});

const input = (over: Partial<RenderInput> = {}): RenderInput => ({
  sourceId: SOURCE,
  url: 'https://forum.example.org/t/x/100',
  title: 'Zigbee "stick" setup',
  engine: 'discourse',
  fetchedAt: FETCHED,
  postsExpected: 2,
  pages: null,
  extraction: 'json',
  quality: 'full',
  posts: [post(1), post(2)],
  ...over,
});

// n posts with bodies of `size` characters each.
const thread = (n: number, size: number): RenderInput =>
  input({ postsExpected: n, posts: Array.from({ length: n }, (_, i) => post(i + 1, { bodyMd: 'x'.repeat(size) })) });

describe('renderThread', () => {
  it('writes the exact front matter, headings, notes and empty post', () => {
    const r = renderThread(
      input({
        posts: [
          post(1, { signals: ['trust level 2', 'admin'], notes: ['3 likes', 'reply to #4'], bodyMd: `${markName('bob')} wrote:` }),
          post(2, { author: '', postedAt: null, bodyMd: '' }),
        ],
      }),
      mode,
    );
    expect(r).toEqual({
      truncated: false,
      nextFromPost: null,
      markdown: [
        '---',
        `source: ${SOURCE}`,
        'url: https://forum.example.org/t/x/100',
        'title: "Zigbee \\"stick\\" setup"',
        `fetched_at: ${FETCHED}`,
        'engine: discourse',
        'post_count: 2',
        'posts_expected: 2',
        'extraction: json',
        'quality: full',
        'authors: pseudonyms',
        '---',
        '',
        '# Zigbee "stick" setup',
        '',
        `## #1, ${P('alice')} (trust level 2, admin), 2026-11-01 10:05 UTC`,
        '',
        '_3 likes. reply to #4._',
        '',
        `${P('bob')} wrote:`,
        '',
        '## #2, unknown author, unknown date',
        '',
        '_(empty post)_',
        '',
      ].join('\n'),
    });
  });

  it('renders a Discourse thread without page notes', () => {
    const { markdown } = renderThread(input({ posts: [post(1, { notes: ['3 likes'] })] }), mode);
    expect(markdown.split('\n')).toContain('_3 likes._');
    expect(markdown).not.toContain('page ');
    expect(markdown).not.toContain('pages:');
  });

  it('renders DOM page notes and the pages field', () => {
    const { markdown } = renderThread(
      input({ engine: 'xenforo', pages: 6, postsExpected: null, extraction: 'dom (6 of 6 pages)', posts: [post(1, { page: 2, notes: ['4 reactions', 'page 2'] })] }),
      mode,
    );
    const lines = markdown.split('\n');
    expect(lines).toContain('_4 reactions. page 2._');
    expect(lines).toContain('pages: 6');
    expect(lines).toContain('posts_expected: unknown');
    expect(lines.indexOf('pages: 6')).toBe(lines.indexOf('posts_expected: unknown') + 1);
  });

  it('uses pseudonyms by default and real names on request', () => {
    const p = renderThread(input(), mode).markdown;
    expect(p).toContain('authors: pseudonyms');
    expect(p).toMatch(/^## #1, author-[0-9a-f]{10}, /m);
    expect(p).not.toMatch(/alice/i);
    const r = renderThread(input({ posts: [post(1, { author: 'Alice', bodyMd: `@${markName('bob')} hi` })] }), real).markdown;
    expect(r).toContain('authors: real names');
    expect(r).toContain('## #1, Alice, 2026-11-01 10:05 UTC');
    expect(r).toContain('@bob hi');
  });

  it('cuts at maxChars and reports next_from_post (Review Focus 1)', () => {
    const r = renderThread(thread(300, 1000), mode, { maxChars: 40_000 });
    expect(r.markdown.length).toBeLessThanOrEqual(40_200);
    expect(r.truncated).toBe(true);
    expect(r.markdown).toMatch(
      new RegExp(`_Truncated after post #${r.nextFromPost! - 1} of 300\\. Ask for from_post ${r.nextFromPost} to read on\\._`),
    );
    expect(r.markdown.endsWith(`_Truncated after post #${r.nextFromPost! - 1} of 300. Ask for from_post ${r.nextFromPost} to read on._\n`)).toBe(true);
    expect(r.markdown).toContain(`## #${r.nextFromPost! - 1},`);
    expect(r.markdown).not.toContain(`## #${r.nextFromPost},`);
  });

  it('starts at fromPost and always keeps one post', () => {
    const t = thread(300, 1000);
    const tail = renderThread(t, mode, { fromPost: 299 });
    expect([...tail.markdown.matchAll(/^## #(\d+),/gm)].map((m) => Number(m[1]))).toEqual([299, 300]);
    expect(tail.truncated).toBe(false);
    expect(tail.nextFromPost).toBeNull();
    expect(tail.markdown).toContain('post_count: 300');
    const one = renderThread(t, mode, { maxChars: 10 });
    expect([...one.markdown.matchAll(/^## #(\d+),/gm)].map((m) => Number(m[1]))).toEqual([1]);
    expect(one.truncated).toBe(true);
    expect(one.nextFromPost).toBe(2);
    expect(one.markdown).toContain('_Truncated after post #1 of 300. Ask for from_post 2 to read on._');
  });

  it('escapes a plain-text fence line so it cannot swallow the next post heading', () => {
    const convert = makeConverter({ baseUrl: 'https://forum.example.org' });
    for (const fence of ['~~~', '```']) {
      const body = convert(`<p>before<br>${fence}<br>after</p>`);
      const { markdown } = renderThread(input({ posts: [post(1, { bodyMd: body }), post(2)] }), mode);
      const lines = markdown.split('\n');
      expect(lines).toContain(fence === '~~~' ? '\\~~~' : '\\`\\`\\`');
      const heading = lines.findIndex((l) => l.startsWith('## #2, '));
      expect(heading).toBeGreaterThan(0);
      // CommonMark: a fence opens on a line starting with up to 3 spaces and ``` or ~~~.
      const openFences = lines.slice(0, heading).filter((l) => /^ {0,3}(```|~~~)/.test(l)).length;
      expect(openFences % 2).toBe(0);
    }
  });

  it('renders marked names in signals and notes and keeps them on one line (finding 3)', () => {
    const { markdown } = renderThread(
      input({ posts: [post(1, { signals: [`title "${markName('carol')}"`, 'trust\nlevel 2'], notes: [`reply to ${markName('dave')}`] })] }),
      mode,
    );
    expect(markdown).toContain(`## #1, ${P('alice')} (title "${P('carol')}", trust level 2), 2026-11-01 10:05 UTC`);
    expect(markdown).toContain(`_reply to ${P('dave')}._`);
    expect(markdown).not.toMatch(/[\uE000\uE001]/u);
  });

  it('escapes level 1 and 2 headings in a body outside code (finding 2c)', () => {
    const body = ['# fake title', '## #9, author-0000000000, 2026-01-01 00:00 UTC', '### kept', '```sh', '# a shell comment', '```'].join('\n');
    const lines = renderThread(input({ posts: [post(1, { bodyMd: body }), post(2)] }), mode).markdown.split('\n');
    expect(lines).toContain('\\# fake title');
    expect(lines).toContain('\\## #9, author-0000000000, 2026-01-01 00:00 UTC');
    expect(lines).toContain('### kept');
    expect(lines).toContain('# a shell comment');
    expect(lines.filter((l) => l.startsWith('## #'))).toHaveLength(2);
  });

  it('escapes a heading whose hash run is followed by a tab (round 2, item 4)', () => {
    const lines = renderThread(input({ posts: [post(1, { bodyMd: '##\t#9, bob\n#\tfake' }), post(2)] }), mode).markdown.split('\n');
    expect(lines).toContain('\\##\t#9, bob');
    expect(lines).toContain('\\#\tfake');
  });

  it('closes a fence a body left open before the next post (finding 2c)', () => {
    const { markdown } = renderThread(input({ posts: [post(1, { bodyMd: 'see\n~~~~\ncode' }), post(2)] }), mode);
    expect(markdown).toContain('see\n~~~~\ncode\n~~~~\n\n## #2, ');
  });

  it('keeps title and url on one line (finding 2c)', () => {
    const lines = renderThread(input({ title: 'T\n## #1, author-0000000000', url: 'https://forum.example.org/t/x\nengine: x' }), mode).markdown.split('\n');
    expect(lines).toContain('title: "T ## #1, author-0000000000"');
    expect(lines).toContain('# T ## #1, author-0000000000');
    expect(lines).toContain('url: https://forum.example.org/t/x engine: x');
    expect(lines.filter((l) => l.startsWith('## #'))).toHaveLength(2);
  });
});

describe('toRenderInput', () => {
  it('copies the extracted thread and adds the source and fetch time', () => {
    const t: ExtractedThread = {
      url: 'https://forum.example.org/threads/x.5/',
      title: 'T',
      engine: 'xenforo',
      postsExpected: null,
      pages: 2,
      extraction: 'dom (2 of 2 pages)',
      quality: 'full',
      posts: [post(1)],
    };
    expect(toRenderInput(SOURCE, t, FETCHED)).toEqual({ sourceId: SOURCE, fetchedAt: FETCHED, ...t });
  });
});

describe('nameResolver', () => {
  it('maps names to pseudonyms or keeps them', () => {
    expect(mode.nameFor('Alice')).toBe(P('alice'));
    expect(mode.label).toBe('pseudonyms');
    expect(real.nameFor('Alice')).toBe('Alice');
    expect(real.label).toBe('real names');
    expect(mode.nameFor('  ')).toBe('unknown author');
  });
});

describe('excerpt', () => {
  it('builds an excerpt around the first match', () =>
    expect(excerpt('a '.repeat(400) + 'B12 levels ' + 'z '.repeat(400), 'b12', 60)).toMatch(/^\.\.\..*B12 levels.*\.\.\.$/));
  it('returns short text whole and starts at the top when nothing matches', () => {
    expect(excerpt('short  text', 'x')).toBe('short text');
    expect(excerpt('q '.repeat(200), 'nothing', 20)).toMatch(/^q q .*\.\.\.$/);
  });
  it('matches any word of the query', () => expect(excerpt('a '.repeat(300) + 'zigbee' + ' b'.repeat(300), 'stick zigbee', 40)).toContain('zigbee'));
});
