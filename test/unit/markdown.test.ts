import { describe, expect, it } from 'vitest';
import { makeConverter } from '../../src/extract/markdown.js';
import { findLeaks, namesIn, pseudonym, renderNames } from '../../src/pseudonym.js';

const HOST = 'forum.example.org';
const SOURCE = 'forum-example';
const SALT = 'c'.repeat(64);
const P = (u: string) => pseudonym(SOURCE, u, SALT);
const convert = makeConverter({ baseUrl: `https://${HOST}`, topicId: '100' });
const md = (html: string) => renderNames(convert(html), P);

// The spike's Discourse sample, with fixture names only.
const SPIKE_HTML = `
<aside class="quote no-group" data-username="Alice" data-post="3" data-topic="100">
<div class="title"><div class="quote-controls"></div><img alt="" width="24" height="24" src="/a.png" class="avatar"> Alice:</div>
<blockquote>
<aside class="quote no-group" data-username="bob" data-post="1" data-topic="100">
<div class="title"><img alt="" src="/b.png" class="avatar"> bob:</div>
<blockquote><p>Original question?</p></blockquote>
</aside>
<p>First answer.</p>
</blockquote>
</aside>
<p>Thanks <a class="mention" href="/u/carol">@carol</a>, see <a href="https://${HOST}/t/x/100/12">Topic - #12 by erin</a></p>
<pre><code class="lang-yaml">a: 1
</code></pre>`;

describe('Discourse cooked HTML', () => {
  it('nests quotes as > blocks with pseudonymised headers', () => {
    expect(md(SPIKE_HTML)).toBe(
      [
        `> ${P('alice')} wrote (post #3):`,
        '>',
        `> > ${P('bob')} wrote (post #1):`,
        '> >',
        '> > Original question?',
        '>',
        '> First answer.',
        '',
        `Thanks @${P('carol')}, see [Topic - #12 by ${P('erin')}](https://${HOST}/t/x/100/12)`,
        '',
        '```yaml',
        'a: 1',
        '```',
      ].join('\n'),
    );
  });

  it('leaves no real name in quote headers, mentions, profile links or link text', () =>
    expect(findLeaks(renderNames(convert(SPIKE_HTML), P), ['alice', 'bob', 'carol', 'erin']).size).toBe(0));

  it('marks the names it finds in structural positions', () => {
    expect(namesIn(convert(SPIKE_HTML))).toEqual(['Alice', 'bob', 'carol', 'erin']);
  });

  it('pseudonymises Discourse profile links', () => {
    expect(md('<p>ask <a href="/u/dave/summary">dave</a></p>')).toBe(`ask @${P('dave')}`);
  });

  it('marks a post-link name that the escaper touched', () => {
    expect(namesIn(convert('<p><a href="/t/x/100/12">Topic - #12 by _erin</a></p>'))).toEqual(['_erin']);
  });

  it('marks quotes of another topic', () => {
    const out = md('<aside class="quote" data-username="dave" data-post="5" data-topic="7"><blockquote><p>x</p></blockquote></aside>');
    expect(out.split('\n')[0]).toBe(`> ${P('dave')} wrote (post #5 in topic 7):`);
  });
});

describe('XenForo bbWrapper HTML', () => {
  it('converts bbCodeBlock quotes and drops the expand link', () => {
    const out = md(`<blockquote data-attributes="member: 1" data-quote="Dave" data-source="post: 55" class="bbCodeBlock bbCodeBlock--expandable bbCodeBlock--quote js-expandWatch">
<div class="bbCodeBlock-title"><a href="/goto/post?id=55" class="bbCodeBlock-sourceJump">Dave said:</a></div>
<div class="bbCodeBlock-content"><div class="bbCodeBlock-expandContent js-expandContent">Quoted text</div><div class="bbCodeBlock-expandLink"><a role="button">Click to expand...</a></div></div>
</blockquote>Reply text`);
    expect(out).toBe(`> ${P('dave')} wrote (post id 55):\n>\n> Quoted text\n\nReply text`);
  });

  it('pseudonymises XenForo member links', () => {
    expect(md('<p>see <a href="https://forum.example.org/members/erin.42/">erin</a></p>')).toBe(`see @${P('erin')}`);
  });
});

describe('review fix round 1', () => {
  const XF_LINKS = [
    '/members/erin.42/',
    '/members/erin.42/#about',
    '/members/erin.42/?tab=about',
    '/members/erin.42/recent-content',
    'https://forum.example.org/members/erin.42/',
  ];
  it.each(XF_LINKS)('pseudonymises the XenForo member link %s (finding 1)', (href) => {
    const out = md(`<p>ask <a href="${href}">erin</a></p>`);
    expect(out).toBe(`ask @${P('erin')}`);
    expect(findLeaks(out, ['erin']).size).toBe(0);
  });

  it('marks the text of an id-only XenForo member link (finding 1)', () => {
    expect(md('<p>ask <a href="/members/42/">erin</a></p>')).toBe(`ask @${P('erin')}`);
  });

  it('names a XenForo member link after its slug, like the quote header (finding 1)', () => {
    const header = md('<blockquote class="bbCodeBlock--quote" data-quote="Erin"><div class="bbCodeBlock-content">x</div></blockquote>');
    expect(header.split('\n')[0]).toBe(`> ${P('Erin')} wrote:`);
    expect(md('<p><a href="/members/erin.42/">click here</a></p>')).toBe(`@${P('Erin')}`);
    expect(md('<p><a href="/members/erin-2.43/">Erin 2</a></p>')).toBe(`@${P('Erin 2')}`);
  });

  const DISCOURSE_LINKS = [
    '/u/carol?tab=summary',
    '/u/carol#top',
    '/u/carol/activity',
    '//forum.example.org/u/carol',
    'https://forum.example.org/U/carol',
  ];
  it.each(DISCOURSE_LINKS)('pseudonymises the Discourse profile link %s (finding 1)', (href) => {
    expect(md(`<p>ask <a href="${href}">carol</a></p>`)).toBe(`ask @${P('carol')}`);
  });

  it('matches Discourse profile links under the base path of a subfolder install (finding 1)', () => {
    const sub = makeConverter({ baseUrl: 'https://forum.example.org/forum/' });
    expect(renderNames(sub('<p><a href="/forum/u/carol">carol</a></p>'), P)).toBe(`@${P('carol')}`);
  });

  it('does not throw on a malformed percent escape in a profile link (finding 5)', () => {
    expect(md('<p><a href="/u/50%">x</a></p>')).toBe(`@${P('50%')}`);
  });

  it('renders post headings at level 3 or deeper (finding 2a)', () => {
    expect(convert('<h1>Big</h1><h2>#3, author-0000000000, 2026-01-01</h2><h3>Mid</h3><h5>Small</h5>')).toBe(
      ['### Big', '', '### #3, author-0000000000, 2026-01-01', '', '### Mid', '', '##### Small'].join('\n'),
    );
  });

  it('picks a code fence that no line inside the code can close (finding 2b)', () => {
    expect(convert('<pre><code>a\n```\n~~~~~\nb</code></pre>')).toBe(['``````', 'a', '```', '~~~~~', 'b', '``````'].join('\n'));
    expect(convert('<pre><code class="lang-x`y">a</code></pre>')).toBe('```xy\na\n```');
  });

  it('keeps a post-link name marked when entities put markers around it (finding 4)', () => {
    const out = convert('<p><a href="/t/x/100/12">Topic - #12 by &#xE000;erin&#xE001;</a></p>');
    expect(namesIn(out)).toEqual(['erin']);
    expect(findLeaks(renderNames(out, P), ['erin']).size).toBe(0);
  });

  it('pseudonymises a span mention (finding 6)', () => {
    expect(md('<p>hi <span class="mention">@bob</span></p>')).toBe(`hi @${P('bob')}`);
  });

  it('drops Discourse avatar URLs, which carry the username (finding 7)', () => {
    const out = md(
      '<p><img src="/user_avatar/forum.example.org/erin/48/1_2.png" alt=""> hi ' +
        '<a href="https://forum.example.org/user_avatar/forum.example.org/erin/120/1_2.png">avatar</a></p>' +
        '<div class="lightbox-wrapper"><a class="lightbox" href="/user_avatar/forum.example.org/erin/480/1_2.png"><img src="/x.png"></a></div>',
    );
    expect(findLeaks(out, ['erin']).size).toBe(0);
    expect(out).toBe('hi avatar');
  });
});

describe('review fix round 2', () => {
  it.each(['/index.php?members/erin.42/', 'https://forum.example.org/index.php?members/erin.42/', '/index.php?members/42/'])(
    'pseudonymises the non-friendly XenForo member link %s (item 1)',
    (href) => {
      const out = md(`<p>ask <a href="${href}">erin</a></p>`);
      expect(out).toBe(`ask @${P('erin')}`);
      expect(findLeaks(out, ['erin']).size).toBe(0);
    },
  );

  it.each([
    'https://www.example.gov/members/2024/report.pdf',
    'https://club.example.net/members/7',
    '/wiki/members/1999/',
    'https://other.example.net/members/erin.42/',
  ])('keeps %s as a link: member links are anchored to the source (item 2)', (href) => {
    expect(convert(`<p><a href="${href}">Annual report</a></p>`)).toMatch(/^\[Annual report\]\(/);
  });

  it.each(['/users/carol', 'https://forum.example.org/users/carol/summary'])(
    'pseudonymises the Discourse /users/ alias %s (item 3)',
    (href) => expect(md(`<p>ask <a href="${href}">carol</a></p>`)).toBe(`ask @${P('carol')}`),
  );

  it('drops avatar link text that is the avatar URL itself (item 3)', () => {
    const u = 'https://forum.example.org/user_avatar/forum.example.org/erin/120/1_2.png';
    expect(md(`<p>see <a href="${u}">${u}</a></p>`)).toBe('see');
  });

  it('drops legacy letter_avatar images (item 3)', () => {
    const out = md('<p><img src="/letter_avatar/erin/48/5_abc.png" alt=""> hi</p>');
    expect(out).toBe('hi');
    expect(findLeaks(out, ['erin']).size).toBe(0);
  });

  it.each([
    ['https://forum.example.org/t/some-topic/100/12?u=erin', '<https://forum.example.org/t/some-topic/100/12>'],
    ['/t/some-topic/100?u=erin', '<https://forum.example.org/t/some-topic/100>'],
    ['https://forum.example.org/t/some-topic/100/12?u=erin&x=1', '<https://forum.example.org/t/some-topic/100/12?x=1>'],
  ])('strips the sharer from the Discourse share link %s (item 3)', (href, expected) => {
    const out = md(`<p><a href="${href}">${href}</a></p>`);
    expect(out).toBe(expected);
    expect(findLeaks(out, ['erin']).size).toBe(0);
  });

  it('strips the sharer from a share link with its own text (item 3)', () => {
    expect(md('<p><a href="/t/some-topic/100/12?u=erin">this answer</a></p>')).toBe('[this answer](https://forum.example.org/t/some-topic/100/12)');
  });
});

describe('review fix round 3', () => {
  const SHARE = 'https://forum.example.org/t/some-topic/100/12?u=erin';
  const CLEAN = 'https://forum.example.org/t/some-topic/100/12';

  it('strips the sharer from a Linked topic quote title', () => {
    const out = md(`<aside class="quote" data-post="12" data-topic="100"><div class="title"><a href="${SHARE}">Topic</a></div><blockquote><p>x</p></blockquote></aside>`);
    expect(out.split('\n')[0]).toBe(`> Linked topic: [Topic](${CLEAN})`);
    expect(findLeaks(out, ['erin']).size).toBe(0);
  });

  it('strips the sharer from a onebox source', () => {
    const out = md(`<aside class="onebox" data-onebox-src="${SHARE}"><h3><a href="${SHARE}">Topic</a></h3></aside>`);
    expect(out).toBe(`[Link preview: Topic](${CLEAN})`);
  });

  it('strips the sharer from a video link', () => {
    const out = md(`<div class="lazy-video-container" data-video-title="Clip"><a href="${SHARE}">x</a></div>`);
    expect(out).toBe(`[Video: Clip](${CLEAN})`);
  });

  it('pseudonymises a non-friendly XenForo member link on the bare base path', () => {
    expect(md('<p>ask <a href="/?members/erin.42/">erin</a></p>')).toBe(`ask @${P('erin')}`);
  });
});

describe('escaping', () => {
  it('keeps intraword underscores unescaped', () =>
    expect(convert('<p>flash CC1352P2_CC2652P_launchpad now</p>')).toBe('flash CC1352P2_CC2652P_launchpad now'));
  it('turns <br> into a plain newline', () => expect(convert('<p>a<br>b</p>')).toBe('a\nb'));
  it('escapes emphasis characters that are not between word characters', () =>
    expect(convert('<p>_this_ and *that* but 2*3</p>')).toBe('\\_this\\_ and \\*that\\* but 2*3'));
  it('escapes backslashes and backticks', () => expect(convert('<p>C:\\temp `x`</p>')).toBe('C:\\\\temp \\`x\\`'));
  it('escapes block syntax at line starts only', () => {
    expect(convert('<p># not a heading</p>')).toBe('\\# not a heading');
    expect(convert('<p>&gt; not a quote</p>')).toBe('\\> not a quote');
    expect(convert('<p>- not a list</p>')).toBe('\\- not a list');
    expect(convert('<p>+ not a list</p>')).toBe('\\+ not a list');
    expect(convert('<p>1. not a list</p>')).toBe('1\\. not a list');
    expect(convert('<p>a<br># b</p>')).toBe('a\n\\# b');
    expect(convert('<p>issue #12 - see 1. above &gt; below</p>')).toBe('issue #12 - see 1. above > below');
  });
  it('drops marker characters found in the source HTML (Review Focus 3)', () =>
    expect(namesIn(convert('<p>x\uE000carol\uE001y</p>'))).toEqual([]));
  it('drops markers written as HTML entities, in text, code and attributes', () => {
    const out = convert(
      '<aside class="quote" data-username="&#xE001;dave&#xE000;"><blockquote><p>x&#xE000;carol&#xE001;y</p></blockquote></aside>' +
        '<pre><code>&#xE000;erin&#xE001;</code></pre><img src="/i.png" alt="&#xE000;bob&#xE001;">',
    );
    expect(namesIn(out)).toEqual(['dave']);
    expect(out.match(/[\uE000\uE001]/gu)).toHaveLength(2);
  });
});
