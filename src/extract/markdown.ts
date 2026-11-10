import crypto from 'node:crypto';
import TurndownService from 'turndown';
import { markName, NAME_CLOSE, NAME_OPEN, stripMarkers } from '../pseudonym.js';

// HTML (Discourse "cooked", XenForo bbWrapper, generic post bodies) to Markdown.
// Quotes become nested ">" blocks with a marked author header; mentions, profile
// links and Discourse post-link titles carry marked names (D34), which the renderer
// turns into pseudonyms or real names. Names in free post text are not marked.

export interface ConvertContext {
  baseUrl: string;
  topicId?: string;
}

type El = HTMLElement;

const hasClass = (node: Node | null, c: string): boolean =>
  node !== null && node.nodeType === 1 && ((node as El).getAttribute('class') ?? '').split(/\s+/).includes(c);

const directChild = (node: El, tag: string): El | null => {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeName === tag) return child as El;
  }
  return null;
};

export function quoteBlock(header: string, body: string): string {
  const lines = [header, '', ...body.trim().split('\n')];
  return lines.map((l) => (l.length ? `> ${l}` : '>')).join('\n');
}

// Escapes what would change the meaning of plain text: backslashes and backticks
// everywhere, `_` and `*` unless they sit between two word characters
// (CC1352P2_CC2652P stays readable), and block syntax at line starts, code fences
// included.
export function escapeText(text: string): string {
  return text
    .replace(/[\\`]/g, '\\$&')
    .replace(/(?<![\p{L}\p{N}])[_*]|[_*](?![\p{L}\p{N}])/gu, '\\$&')
    .replace(/^( {0,3})(#{1,6})(?=\s|$)/gm, '$1\\$2')
    .replace(/^( {0,3})>/gm, '$1\\>')
    .replace(/^( {0,3})([-+])(?=\s|$|-)/gm, '$1\\$2')
    .replace(/^( {0,3})(\d+)([.)])(?=\s|$)/gm, '$1$2\\$3')
    // A fence opened in one post's text would swallow the headings of the next posts.
    // Backticks are escaped above; tildes only open a fence at a line start.
    .replace(/^( {0,3})~~~/gm, '$1\\~~~');
}

const TAIL = String.raw`(?:\/[^?#]*)?(?:[?#].*)?$`;
// XenForo member routes, matched on the path of a friendly URL or on the route in
// the query of a non-friendly one (index.php?members/erin.42/): /members/<slug>.<id>/
// and the id-only /members/<id>/, with any subpage.
const XENFORO_SLUG = /\/members\/([^/?#]+?)\.(\d+)(?:\/[^?#]*)?$/i;
const XENFORO_ID = /^\/members\/(\d+)(?:\/[^?#]*)?$/i;
// Discourse avatar URLs carry the username: /user_avatar/<host>/<name>/<size>/... and
// the legacy /letter_avatar/<name>/<size>/<v>.png.
const USER_AVATAR = /\/(?:user_avatar|letter_avatar)\//i;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

// XenForo slugs lowercase the name and turn other characters into dashes.
const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

// A fence longer than any run of backticks or tildes at a line start in the code,
// so no line inside can close it.
export function fenceFor(code: string): string {
  let longest = 0;
  for (const m of code.matchAll(/^ {0,3}(`+|~+)/gm)) longest = Math.max(longest, m[1].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

// Elements whose content is never post text.
const NON_TEXT: ReadonlySet<string> = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'NOSCRIPT', 'TEMPLATE']);

export function makeConverter(ctx: ConvertContext): (html: string) => string {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
    hr: '---',
  });
  td.escape = escapeText;

  // Rules write a per-converter token pair instead of the real markers. The final
  // pass drops every marker character, including ones decoded from entities such as
  // &#xE000; in text, code or attributes, then turns the tokens into markers, so
  // only names placed by these rules come out marked.
  const nonce = crypto.randomBytes(12).toString('hex');
  const open = `lurkd${nonce}o`;
  const close = `lurkd${nonce}c`;
  const gap = `lurkd${nonce}g`;
  const noscriptTag = `lurkd-noscript-${nonce}`;
  const gapRun = new RegExp(`[ \\t]*${gap}(?:[ \\t]*${gap})*[ \\t]*`, 'g');
  const closeGaps = (md: string): string =>
    md.replace(gapRun, (run: string, at: number) => {
      const before = md[at - 1];
      const after = md[at + run.length];
      const edge = before === undefined || before === '\n' || after === undefined || after === '\n';
      return !edge && /[ \t]/.test(run) ? ' ' : '';
    });
  const mark = (name: string): string => markName(name).replace(NAME_OPEN, open).replace(NAME_CLOSE, close);

  const base = (() => {
    try {
      return new URL(ctx.baseUrl);
    } catch {
      return new URL('https://base.invalid/');
    }
  })();
  const basePath = base.pathname.replace(/\/+$/, '');
  const resolve = (href: string): URL | null => {
    try {
      return new URL(href, base);
    } catch {
      return null;
    }
  };

  // Discourse profiles: /u/<name> and its /users/<name> alias, with any subpage,
  // query or fragment, on any host or protocol-relative, under the source's base
  // path when it has one.
  const DISCOURSE_PROFILE = new RegExp(
    String.raw`^(?:(?:https?:)?\/\/[^/]+)?(?:${escapeRe(basePath)})?\/(?:u|users)\/([^/?#]+)` + TAIL,
    'i',
  );

  // XenForo member links on the source's host (relative hrefs resolve to it). The
  // slug form is distinctive enough to match under any path there; the id-only form
  // must sit at the base path, so /wiki/members/1999/ stays a link. Returns the slug,
  // null for an id-only link, or undefined when the href is not a member link.
  const xenforoMember = (href: string): string | null | undefined => {
    const u = resolve(href);
    if (!u || u.hostname !== base.hostname) return undefined;
    const lowerBase = basePath.toLowerCase();
    const path = u.pathname.toLowerCase();
    // Non-friendly routes live in the query, after index.php or the bare base path.
    const nonFriendly = (path.endsWith('/index.php') || path === `${lowerBase}/`) && /^\?members\//i.test(u.search);
    const route = nonFriendly ? `/${u.search.slice(1).split('&')[0]}` : u.pathname;
    const slug = route.match(XENFORO_SLUG);
    if (slug) return decode(slug[1]);
    const atBase = nonFriendly
      ? path === `${lowerBase}/index.php` || path === `${lowerBase}/`
      : path.startsWith(`${lowerBase}/`);
    const rel = nonFriendly ? route : u.pathname.slice(basePath.length);
    return atBase && XENFORO_ID.test(rel) ? null : undefined;
  };

  // Discourse share links carry the sharer's name in ?u=<name>; drop it from same-host
  // topic links.
  const linkHref = (raw: string): string => {
    const u = resolve(raw);
    if (u && u.hostname === base.hostname && u.pathname.startsWith(`${basePath}/t/`) && u.searchParams.has('u')) {
      u.searchParams.delete('u');
      return u.toString();
    }
    return abs(raw);
  };

  const abs = (u: string | null): string => {
    if (!u) return '';
    try {
      return new URL(u, ctx.baseUrl).toString();
    } catch {
      return u;
    }
  };

  // Only http(s) targets become links or images; javascript:, data:, vbscript:, mailto: and
  // anything that does not parse stay plain text.
  const isWeb = (url: string): boolean => {
    try {
      const p = new URL(url).protocol;
      return p === 'http:' || p === 'https:';
    } catch {
      return false;
    }
  };

  // Turndown gives priority to rules added later, so generic rules come first.

  // Never post text: scripts, styles, embedded frames, noscript fallbacks and templates. Each
  // becomes a gap token, and the final pass turns a run of gaps into one space when whitespace
  // stood next to it between two words, so `a <noscript>x</noscript> b` gives "a b". Turndown
  // treats noscript as a block and trims the spaces around it, so the input names it `noscriptTag`
  // instead, which Turndown handles as an inline element.
  const isNonText = (node: Node): boolean => NON_TEXT.has(node.nodeName) || node.nodeName === noscriptTag.toUpperCase();
  td.addRule('nonText', { filter: (node) => isNonText(node), replacement: () => gap });
  const blank = td.options.blankReplacement!;
  td.options.blankReplacement = (content, node, options) => (isNonText(node as Node) ? gap : blank(content, node, options));

  td.addRule('br', {
    filter: 'br',
    replacement: () => '\n',
  });

  td.addRule('link', {
    filter: (node) => node.nodeName === 'A' && !!(node as El).getAttribute('href'),
    replacement: (content, node) => {
      const rawHref = (node as El).getAttribute('href') ?? '';
      const href = linkHref(rawHref);
      // Markers decoded from entities would otherwise split a name from the pattern below.
      let text = stripMarkers(content).trim();
      const plain = text.replace(/\\(.)/g, '$1');
      // Link text that is an avatar URL names the user; text that repeats the href
      // takes the cleaned href (share links lose ?u=).
      if (USER_AVATAR.test(plain)) text = '';
      else if (plain === rawHref || plain === abs(rawHref)) text = href;
      if (USER_AVATAR.test(rawHref) || !text) return text;
      if (!isWeb(href)) return text;
      // Discourse titles internal post links "Topic - #12 by username".
      text = text.replace(/ - #(\d+) by ((?:\\.|[\w.\-])+)$/, (_m, n: string, user: string) => ` - #${n} by ${mark(user.replace(/\\(.)/g, '$1'))}`);
      if (text === href) return `<${href}>`;
      return `[${text}](${href})`;
    },
  });

  td.addRule('image', {
    filter: 'img',
    replacement: (_c, node) => {
      const el = node as El;
      const src = el.getAttribute('data-src') || el.getAttribute('data-url') || el.getAttribute('src');
      if (!src || src.startsWith('data:') || USER_AVATAR.test(src) || !isWeb(abs(src))) return '';
      const alt = (el.getAttribute('alt') ?? '').replace(/[[\]\n]/g, ' ').trim();
      return `![${alt}](${abs(src)})`;
    },
  });

  td.addRule('codeBlock', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_c, node) => {
      const el = node as El;
      const code = directChild(el, 'CODE') ?? el;
      const m = (code.getAttribute('class') ?? '').match(/lang(?:uage)?-(\S+)/);
      const lang = m && !['auto', 'nohighlight', 'plaintext'].includes(m[1]) ? m[1].replace(/[`~]/g, '') : '';
      const text = (code.textContent ?? '').replace(/\n+$/, '');
      const fence = fenceFor(text);
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });

  // Headings inside a post never reach the levels the renderer uses for the thread
  // title (#) and the post headers (##).
  td.addRule('heading', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (content, node) => {
      const text = content.replace(/\s+/g, ' ').trim();
      if (!text) return '';
      const level = Math.max(3, Number(node.nodeName.charAt(1)));
      return `\n\n${'#'.repeat(level)} ${text}\n\n`;
    },
  });

  td.addRule('details', {
    filter: 'summary',
    replacement: (content) => `\n\n**Collapsed section: ${content.trim()}**\n\n`,
  });

  // Discourse UI chrome inside cooked HTML.
  td.remove((node) => hasClass(node, 'quote-controls') || (hasClass(node, 'meta') && hasClass(node.parentNode, 'lightbox')));
  // XenForo UI chrome.
  td.remove((node) => hasClass(node, 'bbCodeBlock-expandLink') || hasClass(node, 'bbCodeBlock-shrinkLink'));

  td.addRule('emoji', {
    filter: (node) => node.nodeName === 'IMG' && (hasClass(node, 'emoji') || hasClass(node, 'smilie')),
    replacement: (_c, node) => (node as El).getAttribute('alt') ?? '',
  });

  td.addRule('avatar', {
    filter: (node) => node.nodeName === 'IMG' && (hasClass(node, 'avatar') || hasClass(node, 'site-icon')),
    replacement: () => '',
  });

  td.addRule('lightbox', {
    filter: (node) => node.nodeName === 'DIV' && hasClass(node, 'lightbox-wrapper'),
    replacement: (_c, node) => {
      const el = node as El;
      const a = el.querySelector('a.lightbox');
      const img = el.querySelector('img');
      const href = a?.getAttribute('href') ?? img?.getAttribute('src') ?? null;
      if (href && USER_AVATAR.test(href)) return '';
      const alt = (img?.getAttribute('alt') ?? 'image').replace(/[[\]\n]/g, ' ').trim();
      return `![${alt}](${abs(href)})`;
    },
  });

  td.addRule('onebox', {
    filter: (node) => (node.nodeName === 'ASIDE' || node.nodeName === 'DIV') && hasClass(node, 'onebox'),
    replacement: (_c, node) => {
      const el = node as El;
      const src = el.getAttribute('data-onebox-src') ?? el.querySelector('header a, h3 a, a')?.getAttribute('href') ?? '';
      const title = (el.querySelector('h3, h4')?.textContent ?? src).trim().replace(/\s+/g, ' ');
      return `\n\n[Link preview: ${title}](${linkHref(src)})\n\n`;
    },
  });

  td.addRule('video', {
    filter: (node) => node.nodeName === 'DIV' && hasClass(node, 'lazy-video-container'),
    replacement: (_c, node) => {
      const el = node as El;
      const title = el.getAttribute('data-video-title') ?? 'video';
      const href = el.querySelector('a')?.getAttribute('href') ?? '';
      return `\n\n[Video: ${title}](${linkHref(href)})\n\n`;
    },
  });

  td.addRule('poll', {
    filter: (node) => node.nodeName === 'DIV' && hasClass(node, 'poll'),
    replacement: (_c, node) => {
      const el = node as El;
      const opts = Array.from(el.querySelectorAll('li[data-poll-option-id]')).map(
        (li) => `- ${(li.textContent ?? '').trim()}`,
      );
      return `\n\n**Poll** (options only, results not captured):\n${opts.join('\n')}\n\n`;
    },
  });

  td.addRule('profileLink', {
    filter: (node) => {
      if (node.nodeName !== 'A') return false;
      const href = (node as El).getAttribute('href') ?? '';
      return DISCOURSE_PROFILE.test(href) || xenforoMember(href) !== undefined;
    },
    replacement: (_c, node) => {
      const el = node as El;
      const href = el.getAttribute('href') ?? '';
      const text = stripMarkers(el.textContent ?? '').replace(/^\s*@/, '').trim();
      const d = href.match(DISCOURSE_PROFILE);
      if (d) return `@${mark(decode(d[1]))}`;
      const slug = xenforoMember(href);
      if (slug) {
        // The slug names the member whatever the link text says ("click here"); the
        // text is kept when it is the name the slug came from, so "Erin Smith" maps to
        // the same pseudonym as a quote header data-quote="Erin Smith".
        return `@${mark(slugify(text) === slug.toLowerCase() ? text : slug)}`;
      }
      // Id-only member link: the text is the only name there is.
      return `@${mark(text)}`;
    },
  });

  td.addRule('mention', {
    filter: (node) =>
      ((node.nodeName === 'A' || node.nodeName === 'SPAN') && hasClass(node, 'mention')) ||
      (node.nodeName === 'A' && hasClass(node, 'username') && (node as El).hasAttribute('data-user-id')),
    replacement: (_c, node) => {
      const el = node as El;
      const raw = el.getAttribute('data-username') ?? el.textContent ?? '';
      return `@${mark(raw.replace(/^@/, ''))}`;
    },
  });

  // Discourse: <aside class="quote" data-username data-post data-topic><div class="title"/><blockquote/></aside>
  td.addRule('discourseQuote', {
    filter: (node) => node.nodeName === 'ASIDE' && hasClass(node, 'quote'),
    replacement: (_c, node) => {
      const el = node as El;
      const user = el.getAttribute('data-username');
      const post = el.getAttribute('data-post');
      const topic = el.getAttribute('data-topic');
      const bq = directChild(el, 'BLOCKQUOTE');
      const body = bq ? td.turndown(bq) : '';
      let header: string;
      if (user) {
        const where = post ? ` (post #${post}${topic && topic !== ctx.topicId ? ` in topic ${topic}` : ''})` : '';
        header = `${mark(user)} wrote${where}:`;
      } else {
        const a = el.querySelector('.title a');
        header = a ? `Linked topic: [${(a.textContent ?? '').trim()}](${linkHref(a.getAttribute('href') ?? '')})` : 'Quote:';
      }
      return `\n\n${quoteBlock(header, body)}\n\n`;
    },
  });

  // XenForo: <blockquote class="bbCodeBlock--quote" data-quote="Name" data-source="post: 123">
  td.addRule('xenforoQuote', {
    filter: (node) => node.nodeName === 'BLOCKQUOTE' && hasClass(node, 'bbCodeBlock--quote'),
    replacement: (_c, node) => {
      const el = node as El;
      const user = el.getAttribute('data-quote');
      const source = (el.getAttribute('data-source') ?? '').match(/post:\s*(\d+)/);
      const content = el.querySelector('.bbCodeBlock-expandContent') ?? el.querySelector('.bbCodeBlock-content');
      const body = content ? td.turndown(content as El) : '';
      const header = user ? `${mark(user)} wrote${source ? ` (post id ${source[1]})` : ''}:` : 'Quote:';
      return `\n\n${quoteBlock(header, body)}\n\n`;
    },
  });

  // XenForo code block title ("Code:") is chrome, the <pre> below carries the code.
  td.remove((node) => hasClass(node, 'bbCodeBlock-title') && hasClass(node.parentNode, 'bbCodeBlock--code'));

  return (html: string) =>
    stripMarkers(closeGaps(td.turndown(stripMarkers(html).replace(/<(\/?)noscript(?=[\s/>])/gi, `<$1${noscriptTag}`))).replace(/\n{3,}/g, '\n\n').trim())
      .split(open)
      .join(NAME_OPEN)
      .split(close)
      .join(NAME_CLOSE);
}
