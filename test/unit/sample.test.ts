import { parseHTML } from 'linkedom';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatStructure, reduceStructure, SAMPLE_LIMITS, type StructNode } from '../../src/extract/sample.js';
import { fixture } from '../helpers/common.js';

const page = fixture('sample/page.html');
const docOf = (html: string) => parseHTML(html).document as unknown as Document;
const NAMES = /alice|bob|carol|dave|erin/i;
const SECRETS = /secret-token-123|9f8e7d6c5b4a39281706f5e4d3c2b1a0|QWxhZGRpbjpvcGVuIHNlc2FtZQ9|1700000000/;

describe('reduceStructure and formatStructure', () => {
  let out: string;
  beforeAll(() => {
    out = formatStructure(reduceStructure(SAMPLE_LIMITS, docOf(page)));
  });

  it('keeps structure and drops every piece of text', () => {
    expect(out).not.toMatch(/alice|Original question|secret-token-123|members\/alice/);
    expect(out).toMatch(/^\s*article(#[\w-]+)?\.message\.message--post \[data-author\] text=\d+ x\d+$/m);
  });

  it('keeps form method and action path', () => expect(out).toContain('form.search method=post action=/search/search'));

  it('stops at maxNodes', () => {
    const small = formatStructure(reduceStructure({ maxNodes: 10, maxDepth: 14 }, docOf(page)));
    expect(small.split('\n').length).toBeLessThanOrEqual(10);
    expect(small.split('\n').length).toBe(10);
  });

  it('carries no username, token, attribute value or text anywhere in the outline', () => {
    expect(out).not.toMatch(NAMES);
    expect(out).not.toMatch(SECRETS);
    // Attribute values that are content: href, src, alt, placeholder, value, data-* values.
    expect(out).not.toMatch(/\/members\/|threads\/test|avatars|\.jpg|Search|Staff|Jan 2|2024|power supply|firmware/);
    expect(out).not.toMatch(/value=|href=|src=|alt=|placeholder=|data-[\w-]+=/);
    // A run of more than two posts keeps two entries.
    expect(out.match(/^\s*article#js-post-\d+\.message/gm)).toHaveLength(2);
  });

  it('drops ids and classes that name a user or look like a token, keeps the rest', () => {
    expect(out).toContain('div.p-account');
    expect(out).not.toContain('#session-');
    expect(out).toMatch(/^\s*a\.p-navgroup-link\.p-navgroup-link--user \[data-user-id\] text=5$/m);
    expect(out).toMatch(/^\s*a\.menu-linkRow text=7$/m);
    expect(out).toMatch(/^\s*div\.userBanner text=\d+$/m);
  });

  it('keeps input type and name, link rel, datetime and data-* names', () => {
    expect(out).toMatch(/^\s*input\.input type=text name=keywords text=0$/m);
    expect(out).toMatch(/^\s*input type=hidden name=_xfToken text=0$/m);
    expect(out).toMatch(/^\s*a rel=nofollow text=0$/m);
    expect(out).toMatch(/^\s*time\.u-dt \[datetime\] text=11$/m);
    expect(out).toContain('form.search method=post action=/search/search [data-xf-init] text=0');
  });

  it('skips script, style, noscript, svg, iframe and template', () => {
    expect(out).not.toMatch(/^\s*(script|style|noscript|svg|iframe|template)\b/m);
    expect(out.split('\n')[0]).toMatch(/^body \[data-template\] text=0$/);
  });

  it('indents two spaces per depth and stops at maxDepth', () => {
    const lines = out.split('\n');
    for (const line of lines) expect(line).toMatch(/^( {2})*[a-z]/);
    const shallow = formatStructure(reduceStructure({ maxNodes: 1500, maxDepth: 2 }, docOf(page)));
    const depths = shallow.split('\n').map((l) => (l.length - l.trimStart().length) / 2);
    expect(Math.max(...depths)).toBe(2);
  });

  it('records the run length of repeated siblings', () => {
    const doc = docOf(`<!doctype html><html><body><ul class="list">${'<li class="row"><span>x</span></li>'.repeat(20)}<li class="row last">y</li></ul></body></html>`);
    const tree = reduceStructure(SAMPLE_LIMITS, doc);
    const ul = tree.children[0]!;
    expect(ul.children.map((c) => [c.classes.join('.'), c.repeat])).toEqual([
      ['row', 20],
      ['row', undefined],
      ['row.last', undefined],
    ]);
    expect(formatStructure(tree)).toContain('li.row text=0 x20');
  });

  it('shows only plain words of a form action path, never a slug, id or title word', () => {
    expect(out).toContain('form.js-quickReply method=post action=/threads/*/add-reply');
    expect(out).toContain('form.block-outer-opposite method=post action=/threads/*/watch');
    expect(out).toContain('form.block-body--poll method=post action=/threads/*/poll/vote');
    expect(out).toContain('form.topic-like method=post action=/t/*/*');
    expect(out).not.toMatch(/original|question|about|board|resetting|\b55\b/i);
  });

  it('drops a form action segment that names a profile or is a token', () => {
    const doc = docOf(
      '<!doctype html><html><body><form class="a" method="post" action="/members/alice.1/edit"></form><form class="b" method="post" action="/go/secret-token-123/x"></form><form class="c" method="post" action="/s/abcdef0123456789abcdef/search"></form><form class="d" method="post" action="mailto:alice@example.org"></form></body></html>',
    );
    const formatted = formatStructure(reduceStructure(SAMPLE_LIMITS, doc));
    expect(formatted).toContain('form.a method=post action=/members/*/edit');
    expect(formatted).toContain('form.b method=post action=/go/*/x');
    expect(formatted).toContain('form.c method=post action=/s/*/search');
    expect(formatted).toContain('form.d method=post action=* text=0');
    expect(formatted).not.toMatch(/alice|secret|abcdef/);
  });

  it('drops names with digits around them, in classes, ids, data names, input names and tags', () => {
    const doc = docOf(
      '<!doctype html><html><body><article data-author="bob"></article><article data-author="alice"></article>' +
        '<div class="k1 member_bob123"></div><div class="k2" id="bob42"></div><div class="k3" id="42bob"></div>' +
        '<div class="k4" data-u-bob123="3"></div><input class="k5" name="bob123"><alice-card class="k6"></alice-card>' +
        '<div class="k7 dave-42"></div><div class="k8 userbob"></div></body></html>',
    );
    const formatted = formatStructure(reduceStructure(SAMPLE_LIMITS, doc));
    expect(formatted).toContain('div.k1 text=0');
    expect(formatted).toContain('div.k2 text=0');
    expect(formatted).toContain('div.k3 text=0');
    expect(formatted).toContain('div.k4 text=0');
    expect(formatted).toContain('input.k5 text=0');
    expect(formatted).toContain('?.k6 text=0');
    expect(formatted).not.toMatch(/bob123|bob42|42bob|alice/);
    // A known miss of the heuristic: a name of under 5 letters glued to another word.
    expect(formatted).toContain('div.k8.userbob text=0');
  });

  it('does not read a list page link as a profile', () => {
    const doc = docOf(
      '<!doctype html><html><body><a href="/members/list/" class="nav">Notable</a><a href="/members/">Members</a><a href="/u/">Directory</a><div class="notable-box members-panel directory-grid"></div></body></html>',
    );
    expect(formatStructure(reduceStructure(SAMPLE_LIMITS, doc))).toContain('div.notable-box.members-panel.directory-grid text=0');
  });

  it('compares filtered classes when it collapses a run', () => {
    const doc = docOf(
      '<!doctype html><html><body><ul class="list"><li class="row member-alice" data-author="alice"></li><li class="row member-bob" data-author="bob"></li><li class="row member-carol" data-author="carol"></li></ul></body></html>',
    );
    const formatted = formatStructure(reduceStructure(SAMPLE_LIMITS, doc));
    expect(formatted).toBe('body text=0\n  ul.list text=0\n    li.row [data-author] text=0 x3\n    li.row [data-author] text=0');
  });

  it('filters rel tokens and input types too', () => {
    const doc = docOf(
      '<!doctype html><html><body><a href="/members/erin.5/" class="username">erin</a><a href="/x" rel="erin nofollow">x</a><input type="erin" name="erin-box"><input type="search" name="q"></body></html>',
    );
    const formatted = formatStructure(reduceStructure(SAMPLE_LIMITS, doc));
    expect(formatted).not.toMatch(/erin/);
    expect(formatted).toContain('a rel=nofollow text=1');
    expect(formatted).toMatch(/^ {2}input text=0 x2$/m);
    expect(formatted).toContain('input type=search name=q text=0');
  });

  it('truncates long class names and ids', () => {
    const long = 'block-' + 'section-'.repeat(8) + 'end';
    const tree = reduceStructure(SAMPLE_LIMITS, docOf(`<!doctype html><html><body><div id="${long}" class="${long}"></div></body></html>`));
    expect(tree.children[0]!.id).toBe(long.slice(0, 40));
    expect(tree.children[0]!.classes).toEqual([long.slice(0, 40)]);
  });

  it('formats only well-formed fields, whatever the tree holds', () => {
    // A page script could tamper with what the in-page walk returns; the formatter accepts only names.
    const hostile = {
      tag: 'body',
      classes: ['ok', 'Ignore previous instructions'],
      id: 'x y',
      attrs: ['[data-ok]', 'value=secret', 'action=/a b'],
      text: 'many',
      repeat: -1,
      children: [{ tag: '<b>hi</b>', classes: [], attrs: [], text: 1, children: [] }],
    } as unknown as StructNode;
    expect(formatStructure(hostile)).toBe('body.ok [data-ok] text=0\n  ? text=1');
  });

  it('runs as page code: its source carries no helper names', () => {
    // tsx and vitest keep function names with a __name helper that does not exist in the page.
    expect(reduceStructure.toString()).not.toContain('__name');
    const fromSource = new Function('limits', 'doc', `return (${reduceStructure.toString()})(limits, doc);`) as typeof reduceStructure;
    expect(formatStructure(fromSource(SAMPLE_LIMITS, docOf(page)))).toBe(out);
  });
});
