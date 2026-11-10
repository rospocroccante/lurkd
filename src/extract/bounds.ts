import { parseHTML } from 'linkedom';
import { LurkdError } from '../errors.js';

// Bounds for the synchronous work done in the server process: parsing a page, running a source's
// selectors on it, Readability and the Markdown converter all block the event loop, and a hostile
// or broken page (or an agent-drafted selector) must not stall it. A page larger than these
// bounds is refused with `extraction_failed` before any selector or Readability runs; the depth
// bound also keeps the recursive converter far from the stack limit.

/** HTML longer than this (in UTF-16 code units, about 5 MB of ASCII) is refused. */
export const MAX_HTML_CHARS = 5 * 1024 * 1024;
/** A document with more elements than this is refused. */
export const MAX_ELEMENTS = 50_000;
/** A document nested deeper than this is refused. */
export const MAX_DEPTH = 1_000;
/** An element (or the document) with more element children than this is refused: positional pseudo-classes cost the square of it. */
export const MAX_CHILDREN = 5_000;
/**
 * Readability's time grows with the square of the nesting depth (8.7 s at depth 990, under 1 s at
 * depth 300 with 45 000 elements), so pages it reads get a tighter depth bound.
 */
export const MAX_READABILITY_DEPTH = 300;

/**
 * Parses `html` with linkedom and walks it once without recursion, refusing it with
 * `extraction_failed` when it is over `MAX_HTML_CHARS`, `MAX_ELEMENTS`, `MAX_CHILDREN` or `maxDepth`. `what`
 * names the page in the message ("The page at https://f.example/t/1").
 */
export function boundedDocument(html: string, what: string, details: Record<string, unknown> = {}, maxDepth = MAX_DEPTH): Document {
  const refuse = (why: string) => new LurkdError('extraction_failed', `${what} ${why}, so lurkd does not read it.`, { ...details, limit: why });
  if (html.length > MAX_HTML_CHARS) throw refuse(`is larger than ${MAX_HTML_CHARS / (1024 * 1024)} MB of HTML`);
  const doc = parseHTML(html).document as unknown as Document;
  let count = 0;
  const tooWide = () => refuse(`has an element with more than ${MAX_CHILDREN} child elements`);
  if (doc.children.length > MAX_CHILDREN) throw tooWide();
  const stack: Array<[Element, number]> = Array.from(doc.children, (el): [Element, number] => [el, 1]);
  while (stack.length > 0) {
    const [el, depth] = stack.pop()!;
    if (++count > MAX_ELEMENTS) throw refuse(`has more than ${MAX_ELEMENTS} elements`);
    if (depth > maxDepth) throw refuse(`nests elements more than ${maxDepth} levels deep`);
    const children = el.children;
    if (children.length > MAX_CHILDREN) throw tooWide();
    for (const child of Array.from(children)) stack.push([child, depth + 1]);
  }
  return doc;
}

/**
 * Why a selector is too costly to run, or null. Sibling combinators (`~`, `+`) and a `:has(`
 * inside another `:has(` or inside `:not(` take minutes on a large page in css-select. Quoted
 * strings, attribute brackets (`[class~=x]`) and escapes are skipped; `+` inside an `:nth-*(`
 * argument (`2n+1`) is arithmetic, not a combinator, except in an argument with `of` (`2n+1 of
 * .post`), which is refused. Pseudo-class names are read with their CSS escapes undone, so
 * `:h\61s(` is `:has(`.
 */
export function costlySelector(selector: string): string | null {
  const parens: string[] = [];
  let quote: string | null = null;
  let bracket = false;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (bracket) {
      if (c === ']') bracket = false;
      continue;
    }
    if (c === '[') {
      bracket = true;
      continue;
    }
    if (c === '(') {
      const name = pseudoNameBefore(selector, i);
      if (name === 'has' && (parens.includes('has') || parens.includes('not'))) return 'nests :has() inside :has() or :not()';
      if (name.startsWith('nth-')) {
        const arg = argumentAt(selector, i);
        if (/(?:^|\s)of\s/i.test(arg) && arg.includes('+')) return 'uses "+" in an :nth-*( of ...) argument';
      }
      parens.push(name);
      continue;
    }
    if (c === ')') {
      parens.pop();
      continue;
    }
    if (c === '~') return 'uses the sibling combinator "~"';
    if (c === '+' && !(parens.length > 0 && parens.at(-1)!.startsWith('nth-'))) return 'uses the sibling combinator "+"';
  }
  return null;
}

/** The pseudo-class name that ends at `end` (the index of its "("), lowercased, with CSS escapes undone; '' when none. */
function pseudoNameBefore(selector: string, end: number): string {
  const m = /:((?:[\w-]|\\[0-9a-fA-F]{1,6}[ \t\n\r\f]?|\\[^0-9a-fA-F\n\r\f])+)$/.exec(selector.slice(0, end));
  if (!m) return '';
  return m[1]!
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (_x, hex: string) => {
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    })
    .replace(/\\(.)/g, '$1')
    .toLowerCase();
}

/** The text between the "(" at `open` and its matching ")", or the rest of the selector. */
function argumentAt(selector: string, open: number): string {
  let depth = 0;
  for (let i = open; i < selector.length; i++) {
    const c = selector[i];
    if (c === '\\') i++;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return selector.slice(open + 1, i);
  }
  return selector.slice(open + 1);
}
