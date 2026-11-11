import { LurkdError } from '../errors.js';
import { formatDate } from '../output/render.js';
import { isRedditHost } from '../policy/urls.js';
import { markName, NAME_CLOSE, NAME_OPEN, stripMarkers } from '../pseudonym.js';
import type { ExtractedPost, ExtractedThread } from '../types.js';
import { codeUnits, fromCodeUnits, UNIT_LOOP_MIN } from '../units.js';

// D50: a Reddit thread the user saved from their own browser (the thread address with .json
// added) becomes an ExtractedThread, by the rules of D38 to D40. Nothing here makes a request:
// the input is the file's text. The post is #1 and the comments follow depth-first in the file's
// order; each comment says which post it answers. Real usernames go in `author`; `u/name`,
// `/u/name`, `/user/name` and `r/u_name` in titles and bodies are wrapped with the name markers,
// so rendering turns them into pseudonyms as for every engine. Removed and deleted comments stay
// as placeholders; "more" stubs, whose comments the file does not hold, become notes.

export const REDDIT_IMPORT_SOURCE_ID = 'reddit-import';

/** The largest file `lurkd import reddit` and the upload routes take. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

const THREAD_ID = /^[a-z0-9]{1,13}$/;
// Subreddit names, and `u_<name>` for a post on a user profile.
const SUBREDDIT = /^[A-Za-z0-9_]{2,24}$/;
const FULLNAME = /^t[13]_[a-z0-9]{1,13}$/;
// Reddit usernames are 3 to 20 letters, digits, `_` or `-`; Markdown may escape the `_`.
const NAME = String.raw`((?:[A-Za-z0-9-]|\\?_){3,40})`;
// Not after a letter, digit or `_`, so `menu/x` is no mention; after `/` it is, so profile links are covered.
const MENTION = new RegExp(String.raw`(?<![\p{L}\p{N}_])(\/?)(u|U|user)\/${NAME}`, 'gu');
const PROFILE_SUB = new RegExp(String.raw`(?<![\p{L}\p{N}_])(\/?)r\/u_${NAME}`, 'gu');
// The same mentions with a name of 3 to 20 characters and no escaped `_`, which is nearly every
// one: marked by a replacement string, with no call per match. NAME above then finds only the rest.
const PLAIN_NAME = String.raw`([A-Za-z0-9_-]{3,20})(?![A-Za-z0-9_-]|\\_)`;
const MENTION_PLAIN = new RegExp(String.raw`(?<![\p{L}\p{N}_])(\/?)(u|U|user)\/${PLAIN_NAME}`, 'gu');
const PROFILE_SUB_PLAIN = new RegExp(String.raw`(?<![\p{L}\p{N}_])(\/?)r\/u_${PLAIN_NAME}`, 'gu');
const ZERO_WIDTH_ENTITY = /&#x200b;|&#8203;/gi;
const MAX_FLAIR_CHARS = 80;
/** The longest title lurkd keeps from a file, as Reddit allows; a longer one is cut with "...". */
export const MAX_TITLE_CHARS = 300;
/**
 * The longest post or comment body lurkd keeps from a file, with a note where it was cut. Reddit
 * allows 40,000 characters, so only a crafted file reaches this.
 */
export const MAX_BODY_CHARS = 100_000;
export const BODY_CUT_NOTE = 'Cut at 100,000 characters: the rest of this post is not kept';
// The longest link address of a link post lurkd keeps.
const MAX_LINK_CHARS = 2000;
// A title, flair or link is cleaned from a prefix of the raw text this many times what it keeps.
const PREFIX_FACTOR = 8;
// Where the prefix may end: at white space in its last PREFIX_TAIL characters, or else that many
// characters are dropped from its cleaned end. A mention is at most 46 raw characters (`/user/` and
// a name of 40), and its markers add 2.
const PREFIX_TAIL = 128;
// Dates before Reddit's launch year, or more than a day ahead of now, are not believed.
const FIRST_DATE_MS = Date.UTC(2005, 0, 1);
const DAY_MS = 86_400_000;

/**
 * The largest comment count lurkd takes from a file, for `num_comments`, a "more" stub and their
 * total. Reddit's largest threads hold well under this; a count above it is not believed.
 */
export const MAX_COMMENT_COUNT = 10_000_000;
/**
 * The most comments lurkd keeps from one file, in depth-first file order; the post is always kept.
 * Saved threads hold hundreds; a crafted file of 150,000 tiny comments held the server loop for
 * over a second on import and a third of one on every read. Comments past it are counted, checked
 * as the others are, and dropped, and post #1 gets a note saying how many.
 */
export const MAX_IMPORT_COMMENTS = 20_000;
const COUNT = new Intl.NumberFormat('en-US');
// Scores beyond this are not believed either; the most upvoted posts are far below it.
const MAX_SCORE = 1_000_000_000;

const HOW_TO_SAVE =
  'Open the thread in your browser, add .json to the end of its address (for example https://www.reddit.com/r/sub/comments/abc123/title.json) and save that page as a file.';

/** The canonical archive address of a Reddit thread: every address form of the thread maps here. */
export function redditThreadUrl(id: string): string {
  return `https://www.reddit.com/comments/${id}/`;
}

/**
 * The thread id of a Reddit thread address (`/r/<sub>/comments/<id>/...`, `/comments/<id>...`,
 * `redd.it/<id>`), or null for anything else, share links (`/r/<sub>/s/...`) included.
 */
export function redditThreadId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !isRedditHost(u.hostname)) return null;
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  const m = host === 'redd.it' ? /^\/([a-z0-9]{1,13})\/?$/i.exec(u.pathname) : /^(?:\/r\/[^/]+)?\/comments\/([a-z0-9]{1,13})(?:[/.]|$)/i.exec(u.pathname);
  return m ? m[1]!.toLowerCase() : null;
}

/** True for an absolute http(s) address on a Reddit host. */
export function isRedditUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && isRedditHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * `unsupported`: lurkd does not read Reddit (D50), with the steps to import a thread instead. With
 * a thread id the example address is that thread's own `.json` address.
 */
export function redditUnsupported(threadId: string | null = null, details?: Record<string, unknown>): LurkdError {
  const example = threadId !== null && THREAD_ID.test(threadId) ? `${redditThreadUrl(threadId).replace(/\/$/, '')}.json` : 'https://www.reddit.com/r/sub/comments/abc123/title.json';
  return new LurkdError(
    'unsupported',
    `lurkd does not read Reddit. To add a thread to the archive, the user opens it in their own browser, adds .json to the end of its address (for example ${example}), saves that page as a file and runs lurkd import reddit <file>. archive.search then finds the imported thread.`,
    details,
  );
}

function refused(message: string): LurkdError {
  return new LurkdError('invalid_request', message);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parses the saved file. A byte order mark is dropped. The text of the file is never put into an
 * error: the file could be anything the user pointed at.
 */
export function parseRedditFile(text: string): ExtractedThread {
  return readThread(parseJson(text)).thread;
}

function parseJson(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw refused('The file is larger than 20 MB, so lurkd does not import it.');
  const body = text.replace(/^\uFEFF/, '');
  if (body.trim() === '') throw refused(`The file is empty. ${HOW_TO_SAVE}`);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    // The parser's message quotes the text, so it is not repeated.
    if (/^\s*</.test(body)) throw refused(`The file is a web page, not JSON. ${HOW_TO_SAVE}`);
    throw refused(`The file is not JSON. ${HOW_TO_SAVE}`);
  }
  return value;
}

interface Pending {
  node: unknown;
  // The number of the post this entry sits under in the tree.
  treeParent: number;
}

/**
 * What an import read: the thread, the comments it kept, the comments in the file past
 * MAX_IMPORT_COMMENTS that it did not keep, and the comments "more" stubs left out of the file.
 */
export interface RedditImport {
  thread: ExtractedThread;
  comments: number;
  notKept: number;
  notInFile: number;
}

/** The thread from the parsed JSON: an array of two Listings, the post and its comment tree. */
export function parseRedditThread(value: unknown): ExtractedThread {
  return readThread(value).thread;
}

/** `parseRedditFile` with the counts the import reports. */
export function parseRedditImport(text: string): RedditImport {
  return readThread(parseJson(text));
}

function readThread(value: unknown): RedditImport {
  if (isObj(value) && value.kind === 'Listing')
    throw refused(`The file holds a list of posts, not one thread. Open the thread itself (its address has /comments/ in it). ${HOW_TO_SAVE}`);
  if (!Array.isArray(value) || value.length !== 2 || !isListing(value[0]) || !isListing(value[1]))
    throw refused(`The file is JSON but not a Reddit thread: lurkd expects the two Listings Reddit sends for a thread, the post and its comments. ${HOW_TO_SAVE}`);
  const postChildren = listingChildren(value[0]);
  const first = postChildren[0];
  if (postChildren.length !== 1 || !isObj(first) || first.kind !== 't3' || !isObj(first.data))
    throw refused(`The file is JSON but its first Listing has no post. ${HOW_TO_SAVE}`);
  const post = first.data;
  const id = post.id;
  if (typeof id !== 'string' || !THREAD_ID.test(id)) throw refused('The post in the file has no valid id, so lurkd cannot tell which thread it is.');
  for (const field of ['title', 'author'] as const)
    if (typeof post[field] !== 'string') throw refused(`The post in the file has no ${field}.`);
  if (post.selftext !== undefined && post.selftext !== null && typeof post.selftext !== 'string') throw refused('The post in the file has a selftext that is not text.');

  const escaped = isEscaped(post, listingChildren(value[1]));
  const text: Clean = (s, max) => cleanText(s, escaped, max);
  const numbers = new Map<string, number>([[`t3_${id}`, 1]]);
  const posts: ExtractedPost[] = [toPost(post, text)];

  // Depth-first in file order with an explicit stack: a file can nest replies deeper than the call stack.
  const stack: Pending[] = listingChildren(value[1])
    .map((node) => ({ node, treeParent: 1 }))
    .reverse();
  // `seen` counts the comments in the file, kept or not, for the messages; `comments` those kept.
  let seen = 0;
  let comments = 0;
  let notInFile = 0;
  // Per post number: where its count note is, the count so far, and whether it has the "further replies" note.
  const moreNotes = new Map<number, { countAt: number; total: number; further: boolean }>();
  while (stack.length > 0) {
    const { node, treeParent } = stack.pop()!;
    if (!isObj(node) || !isObj(node.data)) throw refused(`Comment ${seen + 1} in the file is not a Reddit comment.`);
    const data = node.data;
    // Depth-first order is file order, so once the cap is reached every later entry is past it.
    const full = comments >= MAX_IMPORT_COMMENTS;
    if (node.kind === 'more') {
      const missing = moreCount(data, seen);
      // Past the cap a stub is only counted: the note on post #1 already says comments are missing.
      // C5: one note of each kind per post, the counts of its stubs added up, so a file with
      // thousands of stubs gives at most two notes a post.
      if (!full) {
        const number = parentNumber(data.parent_id, numbers, treeParent);
        const at = posts[number - 1]!;
        const seenHere = moreNotes.get(number) ?? { countAt: -1, total: 0, further: false };
        moreNotes.set(number, seenHere);
        if (missing === 0) {
          if (!seenHere.further) at.notes.push('Further replies are not in the saved file');
          seenHere.further = true;
        } else {
          seenHere.total = Math.min(seenHere.total + missing, MAX_COMMENT_COUNT);
          const note = `${seenHere.total} more ${seenHere.total === 1 ? 'comment is' : 'comments are'} not in the saved file`;
          if (seenHere.countAt < 0) {
            seenHere.countAt = at.notes.length;
            at.notes.push(note);
          } else at.notes[seenHere.countAt] = note;
        }
      }
      notInFile = Math.min(notInFile + missing, MAX_COMMENT_COUNT);
      continue;
    }
    if (node.kind !== 't1') throw refused(`An entry after comment ${seen} in the file has an unknown kind, so it is not a Reddit thread.`);
    seen += 1;
    const c = checkComment(data, seen);
    const number = posts.length + 1;
    if (!full) {
      comments += 1;
      posts.push(toComment(data, number, numbers.get(c.parentId) ?? null, text));
      numbers.set(`t1_${c.id}`, number);
    }
    const replies = data.replies;
    if (isListing(replies)) {
      const kids = listingChildren(replies);
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], treeParent: number });
    }
  }
  const notKept = seen - comments;
  if (notKept > 0)
    posts[0]!.notes.push(`Kept the first ${COUNT.format(MAX_IMPORT_COMMENTS)} comments; ${COUNT.format(notKept)} more in the file ${notKept === 1 ? 'was' : 'were'} not kept`);

  const sub = subredditOf(post);
  const where = sub === null ? '' : sub.startsWith('u_') ? ', a user profile' : `, r/${sub}`;
  const total = isCount(post.num_comments) ? post.num_comments : null;
  const inFile = total === null ? `${seen} ${seen === 1 ? 'comment' : 'comments'} in the file` : `${seen} of ${total} ${total === 1 ? 'comment' : 'comments'} in the file`;
  const counted = notKept === 0 ? inFile : `${inFile}, the first ${COUNT.format(MAX_IMPORT_COMMENTS)} kept and ${COUNT.format(notKept)} not kept`;
  const thread: ExtractedThread = {
    url: redditThreadUrl(id),
    title: oneLineCut(prefixText(post.title as string, MAX_TITLE_CHARS, text), MAX_TITLE_CHARS),
    engine: 'import',
    postsExpected: total === null ? (notInFile + notKept > 0 ? posts.length + notKept + notInFile : null) : total + 1,
    pages: null,
    extraction: `saved Reddit JSON${where}, ${counted}`,
    quality: 'full',
    posts,
  };
  return { thread, comments, notKept, notInFile };
}

/** A comment count lurkd believes: a non-negative safe integer no larger than MAX_COMMENT_COUNT. */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_COMMENT_COUNT;
}

/**
 * How many comments a "more" stub stands for; 0 is the "continue this thread" link. A count that
 * is not a whole number refuses the file; a whole number beyond MAX_COMMENT_COUNT is ignored and
 * the stub's children count instead.
 */
function moreCount(data: Obj, comments: number): number {
  const count = data.count;
  const children = data.children;
  if ((count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 0)) || (children !== undefined && !Array.isArray(children)))
    throw refused(`A "more" entry after comment ${comments} in the file is malformed, so it is not a Reddit thread.`);
  const kids = Array.isArray(children) ? Math.min(children.length, MAX_COMMENT_COUNT) : 0;
  return Math.max(isCount(count) ? count : 0, kids);
}

function checkComment(data: Obj, n: number): { id: string; parentId: string } {
  const id = data.id;
  if (typeof id !== 'string' || !THREAD_ID.test(id)) throw refused(`Comment ${n} in the file has no valid id.`);
  if (typeof data.parent_id !== 'string' || !FULLNAME.test(data.parent_id)) throw refused(`Comment ${n} in the file has no valid parent_id.`);
  for (const field of ['author', 'body'] as const) if (typeof data[field] !== 'string') throw refused(`Comment ${n} in the file has no ${field}.`);
  const replies = data.replies;
  if (replies !== undefined && replies !== null && replies !== '' && !isListing(replies)) throw refused(`Comment ${n} in the file has replies that are not a Listing.`);
  return { id, parentId: data.parent_id };
}

function parentNumber(parentId: unknown, numbers: Map<string, number>, fallback: number): number {
  return (typeof parentId === 'string' ? numbers.get(parentId) : undefined) ?? fallback;
}

function isListing(v: unknown): v is { kind: 'Listing'; data: { children: unknown[] } } {
  return isObj(v) && v.kind === 'Listing' && isObj(v.data) && Array.isArray(v.data.children);
}

function listingChildren(v: unknown): unknown[] {
  return isListing(v) ? v.data.children : [];
}

/**
 * Whether the file was saved without `raw_json=1`: Reddit then writes &, < and > as entities in
 * every text field. The HTML fields tell (escaped, they start with `&lt;`); without them, text
 * with entities and no bare `<`, `>` or `&` reads as escaped.
 */
function isEscaped(post: Obj, comments: unknown[]): boolean {
  const html = [post.selftext_html, ...comments.map((c) => (isObj(c) && isObj(c.data) ? c.data.body_html : undefined))].find(
    (h): h is string => typeof h === 'string' && h.trim() !== '',
  );
  if (html !== undefined) return html.trimStart().startsWith('&lt;');
  const sample = [post.title, post.selftext, ...comments.map((c) => (isObj(c) && isObj(c.data) ? c.data.body : undefined))]
    .filter((s): s is string => typeof s === 'string')
    .join('\n');
  return /&(?:amp|lt|gt);/.test(sample) && !/[<>]|&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/i.test(sample);
}

/**
 * Decodes the entities Reddit writes in a file saved without `raw_json=1`, in one pass from the
 * left, so `&amp;lt;` becomes `&lt;`. A long text goes through its code units; a short one through
 * a split and a join per entity, `&amp;` last, which gives the same.
 */
function unescapeEntities(s: string): string {
  if (!s.includes('&')) return s;
  if (s.length < UNIT_LOOP_MIN) {
    for (const [entity, char] of [['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&amp;', '&']] as const)
      if (s.includes(entity)) s = s.split(entity).join(char);
    return s;
  }
  const u = codeUnits(s);
  const n = u.length;
  let w = 0;
  for (let r = 0; r < n; r++) {
    const c = u[r]!;
    if (c === 0x26) {
      const a = u[r + 1];
      if (a === 0x61 && u[r + 2] === 0x6d && u[r + 3] === 0x70 && u[r + 4] === 0x3b) {
        u[w++] = 0x26; // &amp;
        r += 4;
        continue;
      }
      if ((a === 0x6c || a === 0x67) && u[r + 2] === 0x74 && u[r + 3] === 0x3b) {
        u[w++] = a === 0x6c ? 0x3c : 0x3e; // &lt; &gt;
        r += 3;
        continue;
      }
      if (a === 0x71 && u[r + 2] === 0x75 && u[r + 3] === 0x6f && u[r + 4] === 0x74 && u[r + 5] === 0x3b) {
        u[w++] = 0x22; // &quot;
        r += 5;
        continue;
      }
      if (a === 0x23 && u[r + 2] === 0x33 && u[r + 3] === 0x39 && u[r + 4] === 0x3b) {
        u[w++] = 0x27; // &#39;
        r += 4;
        continue;
      }
    }
    u[w++] = c;
  }
  return fromCodeUnits(u, w);
}

/** Line ends as \n: \r\n and a lone \r alike. */
function normaliseLineEnds(s: string): string {
  if (!s.includes('\r')) return s;
  if (s.length < UNIT_LOOP_MIN) return s.replace(/\r\n?/g, '\n');
  const u = codeUnits(s);
  const n = u.length;
  let w = 0;
  for (let r = 0; r < n; r++) {
    const c = u[r]!;
    if (c === 0x0d) {
      u[w++] = 0x0a;
      if (u[r + 1] === 0x0a) r += 1;
    } else {
      u[w++] = c;
    }
  }
  return fromCodeUnits(u, w);
}

/** Reddit's zero-width filler, as a character or an entity, removed. */
function dropZeroWidth(s: string): string {
  if (s.includes('&#')) s = s.replace(ZERO_WIDTH_ENTITY, '');
  return s.includes('\u200b') ? s.split('\u200b').join('') : s;
}

/**
 * Wraps each Reddit username mention with the name markers; subreddit names stay. A plain name is
 * marked by a replacement string; only a text with an escaped `_` in it is passed over again with
 * a function, for the names with escapes and the names too long to be one (left as they are). The
 * result is that of one pass with the function: a name followed by a name character or an escape
 * is not a plain name, and no mention starts inside a name, as a mention needs a `/`.
 */
function markMentions(s: string): string {
  if (!s.includes('/')) return s;
  const escapes = s.includes('\\_');
  const mark = (whole: string, prefix: string, raw: string): string => {
    const name = raw.replace(/\\_/g, '_');
    return name.length >= 3 && name.length <= 20 ? `${prefix}${markName(name)}` : whole;
  };
  s = s.replace(PROFILE_SUB_PLAIN, `$1r/u_${NAME_OPEN}$2${NAME_CLOSE}`);
  if (escapes) s = s.replace(PROFILE_SUB, (whole, slash: string, raw: string) => mark(whole, `${slash}r/u_`, raw));
  s = s.replace(MENTION_PLAIN, `$1$2/${NAME_OPEN}$3${NAME_CLOSE}`);
  if (escapes) s = s.replace(MENTION, (whole, slash: string, u: string, raw: string) => mark(whole, `${slash}${u}/`, raw));
  return s;
}

/**
 * Each line without the spaces and tabs at its end; the end of the text is left to the caller's
 * trim. Not `/[ \t]+$/gm`: that pattern retries the whole run from every space of a run not at a
 * line end, so a body of a million spaces and one letter took minutes and held up the server.
 * Only the line ends that have a space or tab before them are visited, each run walked back once.
 */
function trimLineEnds(s: string): string {
  if (!s.includes(' \n') && !s.includes('\t\n')) return s;
  if (s.length >= UNIT_LOOP_MIN) {
    // In place: at each line end, the spaces and tabs just written are taken back.
    const u = codeUnits(s);
    let w = 0;
    let lineStart = 0;
    for (let r = 0; r < u.length; r++) {
      const c = u[r]!;
      if (c === 0x0a) {
        while (w > lineStart && (u[w - 1] === 0x20 || u[w - 1] === 0x09)) w -= 1;
        lineStart = w + 1;
      }
      u[w++] = c;
    }
    return fromCodeUnits(u, w);
  }
  const BEFORE_END = /[ \t]\n/g;
  let m = BEFORE_END.exec(s);
  if (m === null) return s;
  const parts: string[] = [];
  let copied = 0;
  for (; m !== null; m = BEFORE_END.exec(s)) {
    let start = m.index;
    while (start > copied && (s.charCodeAt(start - 1) === 0x20 || s.charCodeAt(start - 1) === 0x09)) start -= 1;
    parts.push(s.slice(copied, start));
    copied = m.index + 1;
  }
  parts.push(s.slice(copied));
  return parts.join('');
}

/** Cleans raw text from the file; with `max`, only the first `max` characters of the result count. */
type Clean = (raw: string, max?: number) => string;

// Mentions are marked last, on the cleaned text cut this far past the characters that count: marking
// only lengthens text, so every name in those characters is whole, and the cut is never in them.
const MARK_MARGIN = 64;

/**
 * Reddit Markdown as lurkd stores it: line ends as \n, entities decoded when the file was saved
 * escaped, the private-use name markers dropped from the input (as the HTML converter does) and
 * then placed around mentions only, Reddit's zero-width filler removed, at most one blank line in
 * a row. Headings and open fences are guarded by the renderer, as for every engine. Every step is
 * linear in the length of the text: a file may hold 20 MB of it. With `max`, mentions are marked
 * in the first `max` characters and a margin only; the caller cuts the rest.
 */
function cleanText(raw: string, escaped: boolean, max = Number.POSITIVE_INFINITY): string {
  let s = normaliseLineEnds(raw);
  if (escaped) s = unescapeEntities(s);
  s = trimLineEnds(dropZeroWidth(stripMarkers(s)));
  s = (s.includes('\n\n\n') ? s.replace(/\n{3,}/g, '\n\n') : s).trim();
  if (s.length > max + MARK_MARGIN) s = s.slice(0, max + MARK_MARGIN);
  return markMentions(s);
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The first `max` characters of s, or more when the cut falls inside a marked name: the whole
 * name is kept, so no part of a real name is left unmarked. A cut never splits a surrogate pair.
 */
function cutAt(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const open = s.lastIndexOf(NAME_OPEN, end - 1);
  if (open >= 0 && s.lastIndexOf(NAME_CLOSE, end - 1) < open) {
    const close = s.indexOf(NAME_CLOSE, open);
    end = close >= 0 ? close + 1 : open;
  }
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** s cut back to at most `end` characters; a marked name the cut falls in is dropped whole. */
function cutBefore(s: string, end: number): string {
  if (end <= 0) return '';
  if (s.length <= end) return s;
  const open = s.lastIndexOf(NAME_OPEN, end - 1);
  if (open >= 0 && s.lastIndexOf(NAME_CLOSE, end - 1) < open) end = open;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** Cleaned text and whether text that is not white space was left out of it. */
interface Prefix {
  text: string;
  more: boolean;
}

/**
 * The cleaned text of a value lurkd keeps at most `max` characters of (a title, a flair, a link):
 * only a prefix of the raw text, from its first character that is not white space, is cleaned,
 * about PREFIX_FACTOR times `max`. A mention holds no white space, so the prefix ends at white
 * space when there is some in its last PREFIX_TAIL characters; when there is none, the last
 * PREFIX_TAIL characters of the cleaned prefix are dropped (a mention the cut split in two would
 * sit there, partly unmarked). `more` says text that is not white space was left out.
 */
function prefixText(raw: string, max: number, text: Clean): Prefix {
  const from = raw.search(/\S/);
  if (from < 0) return { text: '', more: false };
  const end = from + max * PREFIX_FACTOR;
  if (raw.length <= end) return { text: text(from === 0 ? raw : raw.slice(from)), more: false };
  let space = end;
  while (space > end - PREFIX_TAIL && !/\s/.test(raw[space]!)) space -= 1;
  if (space > end - PREFIX_TAIL) {
    const more = raw.slice(space).search(/\S/) >= 0;
    return { text: text(raw.slice(from, space)), more };
  }
  const cleaned = text(raw.slice(from, end));
  return { text: cutBefore(cleaned, cleaned.length - PREFIX_TAIL).trimEnd(), more: true };
}

/** A prefix on one line and at most `max` characters, with "..." when anything was left out. */
function oneLineCut(p: Prefix, max: number): string {
  // White space runs collapse to one space, so a bounded part of the text is enough for `max`.
  const part = cutAt(p.text, max * PREFIX_FACTOR);
  const line = oneLine(part);
  const more = p.more || (part.length < p.text.length && /\S/.test(p.text.slice(part.length)));
  if (line.length <= max && !more) return line;
  return `${cutAt(line, max).trimEnd()}...`;
}

/**
 * A body cleaned whole (every step is linear) and cut at MAX_BODY_CHARS, never through a marked
 * name; `cut` says it was. The cut bounds what saving and every later read of the post cost.
 */
function bodyText(raw: string, text: Clean): { body: string; cut: boolean } {
  const body = text(raw, MAX_BODY_CHARS);
  if (body.length <= MAX_BODY_CHARS) return { body, cut: false };
  return { body: cutAt(body, MAX_BODY_CHARS).trimEnd(), cut: true };
}

/** A date the file gives in seconds, when it falls between 2005 and a day from now; else null. */
function isoOf(seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  const ms = seconds * 1000;
  if (ms < FIRST_DATE_MS || ms > Date.now() + DAY_MS) return null;
  return new Date(ms).toISOString();
}

/** Reddit writes `[deleted]` as the author of removed and deleted posts: no name, so no pseudonym. */
function authorOf(v: unknown): string {
  const name = typeof v === 'string' ? stripMarkers(v).trim() : '';
  return name === '[deleted]' ? '' : name;
}

/**
 * Flair is text the user picked, so it is quoted (inner quotes and backslashes escaped): a flair
 * such as `x, moderator, OP` stays one signal and cannot read as the signals lurkd writes. It is
 * cut at MAX_FLAIR_CHARS with "...", from a bounded prefix of the value, and never through a marked
 * name: a cut inside one keeps the whole name.
 */
function flair(v: unknown, label: string, text: Clean): string[] {
  if (typeof v !== 'string') return [];
  const f = oneLineCut(prefixText(v, MAX_FLAIR_CHARS, text), MAX_FLAIR_CHARS);
  if (f === '') return [];
  return [`${label}: "${f.replace(/["\\]/g, '\\$&')}"`];
}

function score(data: Obj): string[] {
  if (data.score_hidden === true) return ['score hidden'];
  const v = data.score;
  return typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= MAX_SCORE ? [`score ${v}`] : [];
}

function distinguished(v: unknown): string[] {
  if (v === 'moderator') return ['moderator'];
  if (v === 'admin') return ['Reddit admin'];
  return typeof v === 'string' && v !== '' ? ['distinguished'] : [];
}

function edited(v: unknown): string[] {
  if (v === true) return ['edited'];
  if (typeof v === 'number' && v > 0) {
    const at = isoOf(v);
    return [at === null ? 'edited' : `edited ${formatDate(at)}`];
  }
  return [];
}

/** The subreddit name when it has the form Reddit allows (it goes into front matter), else null. */
function subredditOf(post: Obj): string | null {
  return typeof post.subreddit === 'string' && SUBREDDIT.test(post.subreddit) ? post.subreddit : null;
}

function toPost(post: Obj, text: Clean): ExtractedPost {
  const sub = subredditOf(post);
  const where = sub === null ? [] : sub.startsWith('u_') ? [markMentions(`u/${sub.slice(2)}`)] : [`r/${sub}`];
  const self = typeof post.selftext === 'string' ? bodyText(post.selftext, text) : { body: '', cut: false };
  const url = post.is_self === false && typeof post.url === 'string' ? oneLineCut(prefixText(post.url, MAX_LINK_CHARS, text), MAX_LINK_CHARS) : '';
  const link = url === '' ? '' : `Link: ${url}`;
  return {
    number: 1,
    page: null,
    author: authorOf(post.author),
    authorUrl: null,
    signals: [
      ...where,
      ...score(post),
      ...flair(post.link_flair_text, 'post flair', text),
      ...flair(post.author_flair_text, 'flair', text),
      ...distinguished(post.distinguished),
      ...(post.stickied === true ? ['pinned'] : []),
      ...edited(post.edited),
    ],
    notes: self.cut ? [BODY_CUT_NOTE] : [],
    postedAt: isoOf(post.created_utc),
    bodyMd: [link, self.body].filter((s) => s !== '').join('\n\n'),
  };
}

function toComment(data: Obj, number: number, parent: number | null, text: Clean): ExtractedPost {
  const { body, cut } = bodyText(data.body as string, text);
  return {
    number,
    page: null,
    author: authorOf(data.author),
    authorUrl: null,
    signals: [
      parent === null ? 'in reply to a comment not in the saved file' : `in reply to #${parent}`,
      ...score(data),
      ...(data.is_submitter === true ? ['OP'] : []),
      ...flair(data.author_flair_text, 'flair', text),
      ...distinguished(data.distinguished),
      ...(data.stickied === true ? ['pinned'] : []),
      ...edited(data.edited),
    ],
    notes: cut ? [BODY_CUT_NOTE] : [],
    postedAt: isoOf(data.created_utc),
    bodyMd: body,
  };
}
