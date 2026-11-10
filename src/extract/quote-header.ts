import { stripMarkers } from '../pseudonym.js';
import { namesAuthor } from './scrub.js';

// Quote headers of forums lurkd reads with declarative selectors (D34): "bob said:", phpBB's
// `<cite><a>bob</a> wrote: <a>↑</a><span>date</span></cite>`, XenForo's "bob said:" title. The
// header is taken off the quote and its name is returned, so the caller can hand it to the
// converter's quote rule, which writes the marked "<name> wrote:" header.
//
// Two forms. A header element: the deepest element at the start of the quote whose whole text
// (at most 200 characters) is a header, or a `<cite>` whose text starts with one; the element is
// removed and only it, its images and media move out first unless they are the quoted author's
// avatar. A header at the start of the quote's text, alone on its line or followed by the quoted
// text: those characters are cut, and elements left empty by the cut are removed. A multi-word
// name counts only when the header stands alone (its own element or line) or when the name is the
// text of a link in the header; inline, "My mother said: no" is ordinary quoted text.

const VERBS = String.raw`(?:said|wrote|ha\s+scritto|scrisse|a\s+écrit|schrieb)`;
const MAX_QUOTED_NAME = 64;
const MAX_HEADER_TEXT = 200;
/** Elements and text characters looked at per quote: a quote of 50 000 elements is not walked whole. */
const SCAN_ELEMENTS = 200;
const SCAN_CHARS = 400;
const NAME = String.raw`(\S[^\n]{0,${MAX_QUOTED_NAME - 1}}?)`;
const HEADER_ALONE = new RegExp(String.raw`^${NAME}\s+${VERBS}\s*:?$`, 'iu');
const HEADER_FIRST = new RegExp(String.raw`^${NAME}\s+${VERBS}\s*:[ \t]*`, 'iu');
const MEDIA = 'img, video, audio, picture';

interface HeaderMatch {
  name: string;
  /** Characters of the raw text the header takes, leading whitespace and a line break included. */
  length: number;
  alone: boolean;
}

const collapse = (s: string | null | undefined): string => stripMarkers(s ?? '').replace(/\s+/g, ' ').trim();

function matchHeader(raw: string): HeaderMatch | null {
  const lead = /^\s*/.exec(raw)![0].length;
  const body = raw.slice(lead);
  const nl = body.indexOf('\n');
  const line = nl < 0 ? body : body.slice(0, nl);
  const alone = HEADER_ALONE.exec(line.trimEnd());
  if (alone) return { name: alone[1]!, length: lead + line.length + (nl < 0 ? 0 : 1), alone: true };
  const first = HEADER_FIRST.exec(line);
  if (first) return { name: first[1]!, length: lead + first[0].length, alone: false };
  return null;
}

/** Text nodes under `root` in document order, outside nested quotes, until `SCAN_CHARS` characters. */
function textNodes(root: Element, nested: (el: Element) => boolean): Text[] {
  const out: Text[] = [];
  let chars = 0;
  const stack: Node[] = Array.from(root.childNodes).reverse();
  while (stack.length > 0 && chars < SCAN_CHARS) {
    const n = stack.pop()!;
    if (n.nodeType === 3) {
      out.push(n as Text);
      chars += (n as Text).data.length;
    } else if (n.nodeType === 1 && !nested(n as Element)) {
      for (const c of Array.from(n.childNodes).reverse()) stack.push(c);
    }
  }
  return out;
}

const rawText = (nodes: readonly Text[]): string => nodes.map((t) => t.data).join('');

/** Elements under `root` in document order, at most `SCAN_ELEMENTS`, outside nested quotes. */
function elementsOf(root: Element, nested: (el: Element) => boolean): Element[] {
  const out: Element[] = [];
  const stack: Element[] = Array.from(root.children).reverse();
  while (stack.length > 0 && out.length < SCAN_ELEMENTS) {
    const el = stack.pop()!;
    if (nested(el)) continue;
    out.push(el);
    for (const c of Array.from(el.children).reverse()) stack.push(c);
  }
  return out;
}

/** The name of a header: a link's text when a link in the header holds (part of) the matched name, else the match. */
function nameOf(m: HeaderMatch, links: readonly Element[]): { name: string; fromLink: boolean } | null {
  const matched = collapse(m.name).replace(/^@/, '').trim();
  for (const a of links) {
    const text = collapse(a.textContent).replace(/^@/, '').trim();
    if (text !== '' && text.length <= MAX_QUOTED_NAME && matched.toLowerCase().includes(text.toLowerCase())) return { name: text, fromLink: true };
  }
  if (matched === '' || matched.length > MAX_QUOTED_NAME) return null;
  // Inline, only one word is a name: "My mother said: no" and "Note: bob said: hi" stay text.
  if (!m.alone && /\s/.test(matched)) return null;
  return { name: matched, fromLink: false };
}

/** True when `el` holds a nested quote, or more elements than a header plausibly has. */
function holdsQuoteOrTooMuch(el: Element, nested: (el: Element) => boolean): boolean {
  let seen = 0;
  const stack: Element[] = Array.from(el.children);
  while (stack.length > 0) {
    const c = stack.pop()!;
    if (nested(c) || ++seen > SCAN_ELEMENTS) return true;
    for (const d of Array.from(c.children)) stack.push(d);
  }
  return false;
}

function isAvatar(img: Element, name: string): boolean {
  if (/\bavatar\b/i.test(img.getAttribute('class') ?? '')) return true;
  return ['alt', 'title', 'src'].some((a) => namesAuthor(img.getAttribute(a) ?? '', [name]));
}

function isEmpty(el: Element): boolean {
  return collapse(el.textContent) === '' && el.querySelector(MEDIA) === null;
}

/**
 * Takes the header off quote `q` and returns the quoted name, or null when it has none.
 * `isQuote` tells a nested quote (another `quote` match), whose header is its own.
 */
export function takeQuoteHeader(q: Element, isQuote: (el: Element) => boolean): string | null {
  const nested = (el: Element) => el !== q && isQuote(el);
  const quoteText = collapse(rawText(textNodes(q, nested)));
  if (quoteText === '') return null;

  // A header element: the deepest one at the start of the quote.
  let header: { el: Element; name: string } | null = null;
  for (const el of elementsOf(q, nested)) {
    if (header !== null && !header.el.contains(el)) break;
    const nodes = textNodes(el, nested);
    const text = collapse(rawText(nodes));
    if (text === '' || text.length > MAX_HEADER_TEXT || !quoteText.startsWith(text)) continue;
    const m = matchHeader(rawText(nodes));
    if (m === null || !(m.alone || el.localName === 'cite')) continue;
    if (holdsQuoteOrTooMuch(el, nested)) continue;
    const links = el.localName === 'a' ? [el] : Array.from(el.querySelectorAll('a'));
    const name = nameOf(m, links);
    if (name !== null) header = { el, name: name.name };
  }
  if (header !== null) {
    for (const media of Array.from(header.el.querySelectorAll(MEDIA))) {
      if (media.localName !== 'img' || !isAvatar(media, header.name)) header.el.before(media);
    }
    header.el.remove();
    return header.name;
  }

  // A header at the start of the quote's text.
  const nodes = textNodes(q, nested);
  const m = matchHeader(rawText(nodes));
  if (m === null) return null;
  const taken: Text[] = [];
  let left = m.length;
  for (const t of nodes) {
    if (left <= 0) break;
    taken.push(t);
    left -= t.data.length;
  }
  const links = [...new Set(taken.map((t): Element | null => t.parentElement?.closest('a') ?? null).filter((a): a is Element => a !== null && q.contains(a)))];
  const name = nameOf(m, links);
  if (name === null) return null;
  left = m.length;
  for (const t of taken) {
    const n = Math.min(left, t.data.length);
    t.data = t.data.slice(n);
    left -= n;
  }
  // Elements the cut left empty (the name's link, a wrapper) go; never the quote itself.
  for (const t of taken) {
    let node: Element | null = t.parentElement;
    if (t.data === '') t.remove();
    while (node !== null && node !== q && q.contains(node) && isEmpty(node)) {
      const parent: Element | null = node.parentElement;
      node.remove();
      node = parent;
    }
  }
  return name.name;
}
