import { LurkdError } from '../errors.js';
import { quotedName } from '../output/quoted.js';
import { isAllowedHost } from '../policy/urls.js';
import { stripMarkers } from '../pseudonym.js';
import type { JsonResult } from '../browser/reader.js';
import type { SourceConfig } from '../sources/schema.js';
import type { AuthorSignals, ExtractedPost, ExtractedThread, SearchHit } from '../types.js';
import type { EngineAdapter, ExtractContext } from './engine.js';
import { readabilityInWorker } from './generic.js';
import { escapeText, makeConverter } from './markdown.js';
import { withoutAuthor } from './scrub.js';

// Discourse: the topic JSON, then the posts of `post_stream.stream` that the first payload lacks,
// in chunks of 20 through `/t/<id>/posts.json`. Every request goes through `ctx.reader.getJson`
// (or `open` for pages), so the URL policy, run limits, fetch log and block detection apply.
// Paths sit under the path of `base_url`, for forums served from a subfolder. A forum that does
// not serve the topic JSON (other than a 404, which means the topic is gone) is read from the
// open topic page through `readabilityThread` (Task 12), as one low-quality post.
//
// Reputation signals (D33) come from the topic payload only: trust level, role, title, primary
// group and the posts of the top participants in this topic. Total post count and join date need
// one `/u/<name>.json` request per author, which only `authorSignals` makes.

/** A post of the topic JSON or of a posts.json chunk; the fields lurkd reads (the spike's DPost). */
export interface DiscoursePost {
  id: number;
  post_number: number;
  username: string | null;
  created_at: string;
  cooked: string;
  /** 1 regular, 2 moderator action, 3 small action (topic event), 4 whisper. */
  post_type: number;
  action_code?: string;
  trust_level?: number;
  moderator?: boolean;
  admin?: boolean;
  staff?: boolean;
  user_title?: string | null;
  primary_group_name?: string | null;
  reply_to_post_number?: number | null;
  actions_summary?: Array<{ id: number; count?: number }>;
  like_count?: number;
  reactions?: Array<{ id: string; count: number }>;
  version?: number;
  hidden?: boolean;
  cooked_hidden?: boolean;
  deleted_at?: string | null;
  accepted_answer?: boolean;
  topic_id?: number;
}

/** The topic JSON (`/t/<slug>/<id>.json`), as far as lurkd reads it. */
export interface DiscourseTopic {
  id?: number;
  slug?: string;
  title?: string;
  fancy_title?: string;
  /** Counts the posts, not the topic events that the stream also holds (C8). */
  posts_count?: number;
  post_stream: { stream: number[]; posts: DiscoursePost[] };
  details?: { participants?: Array<{ username: string; post_count: number }> };
}

export interface ParsedTopic {
  canonical: string;
  id: string;
  slug: string | null;
}

const CHUNK = 20;
const PAGE_HTML = 'document.documentElement.outerHTML';
const DIGITS = /^\d+$/;
const SMALL_ACTION = 3;
const WHISPER = 4;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Free text from the JSON for a signal or note: no name markers, one line. */
const clean = (s: string): string => stripMarkers(s).replace(/\s+/g, ' ').trim();

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function iso(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * A URL for an error message without its query and fragment: a share link carries the sharer's
 * username in `?u=<name>`, and errors reach the agent.
 */
function shownUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** A slug from the JSON, cleaned; '' when nothing usable is left (a slug of only dots would make a dot segment). */
function slugOf(raw: unknown): string {
  const slug = typeof raw === 'string' ? clean(decode(raw)) : '';
  return /^\.*$/.test(slug) ? '' : slug;
}

/** `base_url` without a trailing slash: origin plus the subfolder, if any. */
function baseOf(source: SourceConfig): string {
  const u = new URL(source.base_url);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * Reads the topic id and slug from a topic URL under `baseUrl`: `/t/<slug>/<id>`, `/t/<id>`, each
 * with an optional post number and `.json`; query and fragment are dropped. A numeric first
 * segment is the id, since Discourse never makes an all-digit slug. Whether the browser may open
 * the URL is the URL policy's call (src/policy/urls.ts, which owns the thread patterns); this
 * only parses. Throws `invalid_request` for anything else.
 */
export function parseTopicUrl(baseUrl: string, url: string): ParsedTopic {
  const fail = () => new LurkdError('invalid_request', `Not a Discourse topic URL: ${shownUrl(url)}`, { url: shownUrl(url) });
  let base: URL;
  let u: URL;
  try {
    base = new URL(baseUrl);
    u = new URL(url);
  } catch {
    throw fail();
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw fail();
  const basePath = base.pathname.replace(/\/+$/, '');
  if (basePath !== '' && !u.pathname.startsWith(`${basePath}/`)) throw fail();
  const rel = u.pathname.slice(basePath.length).replace(/\/+$/, '').replace(/\.json$/i, '');
  const [lead, t, ...rest] = rel.split('/');
  if (lead !== '' || t !== 't') throw fail();
  let slug: string | null;
  let id: string;
  const [a = '', b, c] = rest;
  if (DIGITS.test(a) && rest.length <= 2 && (b === undefined || DIGITS.test(b))) {
    slug = null;
    id = a;
  } else if (a !== '' && !DIGITS.test(a) && b !== undefined && DIGITS.test(b) && rest.length <= 3 && (c === undefined || DIGITS.test(c))) {
    slug = a;
    id = b;
  } else {
    throw fail();
  }
  id = id.replace(/^0+(?=\d)/, '');
  return { canonical: `${base.origin}${basePath}/t/${slug === null ? '' : `${slug}/`}${id}`, id, slug };
}

/** D33 signals from the topic payload: trust level, one role, title, primary group, posts in this topic. */
export function discourseSignals(p: DiscoursePost, inTopic: Map<string, number>): string[] {
  const signals: string[] = [];
  if (isNum(p.trust_level)) signals.push(`trust level ${p.trust_level}`);
  if (p.admin === true) signals.push('admin');
  else if (p.moderator === true) signals.push('moderator');
  else if (p.staff === true) signals.push('staff');
  if (typeof p.user_title === 'string' && clean(p.user_title)) signals.push(`title "${clean(p.user_title)}"`);
  if (typeof p.primary_group_name === 'string' && clean(p.primary_group_name)) signals.push(`group ${clean(p.primary_group_name)}`);
  const count = typeof p.username === 'string' ? inTopic.get(p.username.toLowerCase()) : undefined;
  if (isNum(count) && count > 0) signals.push(plural(count, 'post in this topic', 'posts in this topic'));
  return signals;
}

/**
 * Notes under the post header: a topic event (C8) or `whisper` first, then likes, reactions,
 * `reply to #N`, `edited (version N)`, `accepted answer`, `hidden by community flags`, `deleted`.
 * Never a page (D32).
 */
export function discourseNotes(p: DiscoursePost): string[] {
  const notes: string[] = [];
  if (p.post_type === SMALL_ACTION) notes.push(`topic event ${clean(typeof p.action_code === 'string' ? p.action_code : 'unknown') || 'unknown'}`);
  if (p.post_type === WHISPER) notes.push('whisper');
  const liked = Array.isArray(p.actions_summary) ? p.actions_summary.find((a) => isObj(a) && a.id === 2)?.count : undefined;
  const likes = isNum(liked) ? liked : p.like_count;
  if (isNum(likes) && likes > 0) notes.push(plural(likes, 'like', 'likes'));
  if (Array.isArray(p.reactions)) {
    const list = p.reactions.filter((r) => isObj(r) && typeof r.id === 'string' && isNum(r.count) && r.count > 0).map((r) => `${clean(r.id)} ${r.count}`);
    if (list.length) notes.push(`reactions: ${list.join(', ')}`);
  }
  if (isNum(p.reply_to_post_number) && p.reply_to_post_number > 0) notes.push(`reply to #${p.reply_to_post_number}`);
  if (isNum(p.version) && p.version > 1) notes.push(`edited (version ${p.version})`);
  if (p.accepted_answer === true) notes.push('accepted answer');
  if (p.hidden === true || p.cooked_hidden === true) notes.push('hidden by community flags');
  if (typeof p.deleted_at === 'string' && p.deleted_at !== '') notes.push('deleted');
  return notes;
}

function isPost(v: unknown): v is DiscoursePost {
  return isObj(v) && isNum(v.id) && isNum(v.post_number);
}

function postsOf(list: unknown): DiscoursePost[] {
  return Array.isArray(list) ? list.filter(isPost) : [];
}

function isTopic(v: unknown): v is DiscourseTopic {
  return isObj(v) && isObj(v.post_stream) && Array.isArray(v.post_stream.stream) && Array.isArray(v.post_stream.posts);
}

/** The stream ids, each once, in stream order. */
function streamOf(data: DiscourseTopic): number[] {
  return [...new Set(data.post_stream.stream.filter(isNum))];
}

/** The stream ids that the first payload does not carry, in stream order. */
export function missingPostIds(data: DiscourseTopic): number[] {
  const have = new Set(postsOf(data.post_stream.posts).map((p) => p.id));
  return streamOf(data).filter((id) => !have.has(id));
}

/**
 * The thread from the topic JSON and the posts the chunks returned. Posts follow the stream; a
 * post counts once whichever payload carried it; topic events stay as posts of their own and are
 * marked (C8), so `posts` may hold more items than `postsExpected`.
 */
export function assembleThread(source: SourceConfig, topic: ParsedTopic, data: DiscourseTopic, chunkPosts: DiscoursePost[]): ExtractedThread {
  const byId = new Map<number, DiscoursePost>();
  for (const p of [...postsOf(data.post_stream.posts), ...postsOf(chunkPosts)]) if (!byId.has(p.id)) byId.set(p.id, p);
  const stream = streamOf(data);
  const topicId = isNum(data.id) ? data.id : Number(topic.id);
  // One post per post number, the first in stream order; a post of another topic is dropped.
  const numbers = new Set<number>();
  const posts: DiscoursePost[] = [];
  for (const id of stream) {
    const p = byId.get(id);
    if (p === undefined || numbers.has(p.post_number)) continue;
    if (isNum(p.topic_id) && p.topic_id !== topicId) continue;
    numbers.add(p.post_number);
    posts.push(p);
  }

  // Only the top participants (about 24) carry their post count in this topic.
  const inTopic = new Map<string, number>();
  for (const part of Array.isArray(data.details?.participants) ? data.details.participants : []) {
    if (isObj(part) && typeof part.username === 'string' && isNum(part.post_count)) inTopic.set(part.username.toLowerCase(), part.post_count);
  }

  const base = baseOf(source);
  const convert = makeConverter({ baseUrl: source.base_url, topicId: topic.id });
  const extracted: ExtractedPost[] = posts.map((p) => {
    const username = typeof p.username === 'string' ? p.username.trim() : '';
    let bodyMd = convert(typeof p.cooked === 'string' ? p.cooked : '');
    if (p.post_type === SMALL_ACTION) {
      const code = clean(typeof p.action_code === 'string' ? p.action_code : '') || 'unknown';
      bodyMd = `_Topic event: ${escapeText(code)}_${bodyMd ? `\n\n${bodyMd}` : ''}`;
    }
    return {
      number: p.post_number,
      page: null,
      author: username,
      authorUrl: username ? `${base}/u/${encodeURIComponent(username)}` : null,
      signals: discourseSignals(p, inTopic),
      notes: discourseNotes(p),
      postedAt: iso(p.created_at),
      bodyMd,
    };
  });

  const title = [data.title, data.fancy_title].map((s) => (typeof s === 'string' ? clean(s) : '')).find((s) => s !== '') ?? topic.canonical;
  return {
    url: storedUrl(base, topic, data),
    title,
    engine: 'discourse',
    postsExpected: isNum(data.posts_count) ? data.posts_count : stream.length,
    pages: null,
    extraction: extracted.length < stream.length ? `json (${extracted.length} of ${stream.length} posts in the stream)` : 'json',
    quality: 'full',
    posts: extracted,
  };
}

/**
 * The URL a thread is stored under: slug and id from the topic JSON, so `/t/<id>`, share links,
 * a case-changed slug, `/t/topic/<id>` and `/t/-/<id>` of one topic give one archive row. The
 * parsed canonical URL is the fallback when the JSON has no slug.
 */
function storedUrl(base: string, topic: ParsedTopic, data: DiscourseTopic): string {
  const slug = slugOf(data.slug);
  if (slug === '') return topic.canonical;
  const id = isNum(data.id) && Number.isInteger(data.id) && data.id >= 0 ? String(data.id) : topic.id;
  return `${base}/t/${encodeURIComponent(slug)}/${id}`;
}

function topicOf(source: SourceConfig, url: string): ParsedTopic {
  if (!isAllowedHost(source, url)) {
    throw new LurkdError('off_domain', `${shownUrl(url)} is not on a domain of ${source.id} (${source.domains.join(', ')}).`, {
      url: shownUrl(url),
      sourceId: source.id,
      domains: source.domains,
    });
  }
  return parseTopicUrl(source.base_url, url);
}

/** The topic a page URL of the source shows, or null. */
function topicAt(source: SourceConfig, url: string): ParsedTopic | null {
  try {
    return isAllowedHost(source, url) ? parseTopicUrl(source.base_url, url) : null;
  } catch {
    return null;
  }
}

/**
 * The topic page through Readability when the forum does not serve the topic JSON (other than a
 * 404, which means the topic is gone): one post with no author, quality `low` (D7). The page the
 * adapter opened is read as it is; when the browser no longer shows that topic it is opened
 * again. The stored URL is the topic the page shows, so a slug redirect still gives one row.
 */
/** The two media types a topic answer is expected to have; any other header is the forum's own text and is not printed. */
const PRINTED_MEDIA_TYPES: ReadonlySet<string> = new Set(['application/json', 'text/html']);

function mediaType(header: string): string {
  if (header.trim() === '') return 'no content type';
  const type = header.split(';')[0]!.trim().toLowerCase();
  return PRINTED_MEDIA_TYPES.has(type) ? type : 'an unexpected content type';
}

// Carried to the Task 21 smoke run: usernames the Discourse page shows as plain text, outside profile links, come through unmarked here.
async function readabilityFallback(ctx: ExtractContext, topic: ParsedTopic, first: JsonResult): Promise<ExtractedThread> {
  const { reader, source } = ctx;
  let here = topicAt(source, reader.page.url());
  if (here === null || here.id !== topic.id) {
    await reader.open(topic.canonical);
    here = topicAt(source, reader.page.url());
  }
  const stored = here !== null && here.id === topic.id ? here.canonical : topic.canonical;
  const html = await reader.evaluate<unknown>(PAGE_HTML);
  let t: ExtractedThread;
  try {
    t = await readabilityInWorker(typeof html === 'string' ? html : '', stored);
  } catch (e) {
    if (!(e instanceof LurkdError) || e.code !== 'extraction_failed') throw e;
    throw new LurkdError(
      'extraction_failed',
      `${quotedName(source.name)} did not serve the topic JSON for ${topic.canonical} (HTTP ${first.status}, ${mediaType(first.contentType)}), and Readability could not read the topic page either.`,
      { url: topic.canonical, sourceId: source.id, status: first.status, contentType: first.contentType, readability: e.message },
    );
  }
  ctx.onProgress({ postsFetched: t.posts.length });
  return { ...t, url: stored, engine: 'discourse', extraction: `readability (names not pseudonymised; topic JSON not served, HTTP ${first.status})` };
}

async function fetchThread(ctx: ExtractContext, url: string): Promise<ExtractedThread> {
  const { reader, source } = ctx;
  const topic = topicOf(source, url);
  await reader.open(topic.canonical);
  const first = await reader.getJson(`${topic.canonical}.json`);
  if (first.status === 404) {
    throw new LurkdError('not_found', `${quotedName(source.name)} has no topic at ${topic.canonical} (HTTP 404).`, { url: topic.canonical, sourceId: source.id });
  }
  if (first.status !== 200 || !isTopic(first.json)) return readabilityFallback(ctx, topic, first);
  const data = first.json;
  const inStream = new Set(streamOf(data));
  const received = new Set<number>();
  const countFetched = (list: DiscoursePost[]): number => {
    for (const p of list) if (inStream.has(p.id)) received.add(p.id);
    return received.size;
  };
  ctx.onProgress({ postsFetched: countFetched(postsOf(data.post_stream.posts)) });

  const missing = missingPostIds(data);
  const chunkPosts: DiscoursePost[] = [];
  const base = baseOf(source);
  for (let i = 0; i < missing.length; i += CHUNK) {
    const qs = missing
      .slice(i, i + CHUNK)
      .map((id) => `post_ids[]=${id}`)
      .join('&');
    const chunkUrl = `${base}/t/${topic.id}/posts.json?${qs}`;
    const r = await reader.getJson(chunkUrl);
    const posts = isObj(r.json) && isObj(r.json.post_stream) ? r.json.post_stream.posts : undefined;
    if (r.status !== 200 || !Array.isArray(posts)) {
      throw new LurkdError('extraction_failed', `${quotedName(source.name)} did not serve the posts of ${topic.canonical} at ${chunkUrl} (HTTP ${r.status}).`, {
        url: chunkUrl,
        sourceId: source.id,
        status: r.status,
      });
    }
    const list = postsOf(posts);
    chunkPosts.push(...list);
    ctx.onProgress({ postsFetched: countFetched(list) });
  }
  return assembleThread(source, topic, data, chunkPosts);
}

async function search(ctx: ExtractContext, query: string, limit: number): Promise<SearchHit[]> {
  const { reader, source } = ctx;
  const base = baseOf(source);
  const q = encodeURIComponent(query);
  await reader.open(`${base}/search?q=${q}`);
  const r = await reader.getJson(`${base}/search.json?q=${q}`);
  if (r.status !== 200 || !isObj(r.json)) {
    throw new LurkdError('extraction_failed', `${quotedName(source.name)} did not serve the search JSON (HTTP ${r.status}).`, { sourceId: source.id, status: r.status });
  }
  const data = r.json;
  const topics = new Map<number, Obj>();
  for (const tp of Array.isArray(data.topics) ? data.topics : []) if (isObj(tp) && isNum(tp.id) && !topics.has(tp.id)) topics.set(tp.id, tp);
  // The relevance order of the matching posts, then the topics no post pointed at.
  const order: number[] = [];
  for (const p of Array.isArray(data.posts) ? data.posts : []) {
    if (isObj(p) && isNum(p.topic_id) && topics.has(p.topic_id) && !order.includes(p.topic_id)) order.push(p.topic_id);
  }
  for (const id of topics.keys()) if (!order.includes(id)) order.push(id);
  const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return order.slice(0, n).map((id) => {
    const tp = topics.get(id)!;
    const cleanSlug = slugOf(tp.slug);
    const slug = cleanSlug === '' ? null : encodeURIComponent(cleanSlug);
    const url = `${base}/t/${slug === null ? '' : `${slug}/`}${id}`;
    const title = [tp.title, tp.fancy_title].map((s) => (typeof s === 'string' ? clean(s) : '')).find((s) => s !== '') ?? url;
    return { url, title, posts: isNum(tp.posts_count) ? tp.posts_count : null };
  });
}

/** True when `/session/current.json` answers 200 with a `current_user`; a login wall is false. */
async function checkSession(ctx: ExtractContext): Promise<boolean> {
  try {
    const r = await ctx.reader.getJson(`${baseOf(ctx.source)}/session/current.json`);
    return r.status === 200 && isObj(r.json) && isObj(r.json.current_user);
  } catch (e) {
    if (e instanceof LurkdError && e.code === 'needs_login') return false;
    throw e;
  }
}

/**
 * One `/u/<username>.json` request (D33). In the test fixture (test/fixtures/discourse/user-alice.json)
 * both `postCount` (`user.post_count`) and `joinedAt` (`user.created_at`) come back non-null; what a
 * real forum serves is reported by the Task 21 smoke run, which prints whether each came back
 * non-null (P34). A field the forum leaves out is null here, never a guess.
 */
async function authorSignals(ctx: ExtractContext, author: { username: string; profileUrl: string | null }): Promise<AuthorSignals> {
  const username = author.username.trim();
  if (username === '') throw new LurkdError('invalid_request', 'An author lookup needs a username.', { sourceId: ctx.source.id });
  try {
    return await lookupAuthor(ctx, username);
  } catch (e) {
    throw withoutAuthor(e, username);
  }
}

async function lookupAuthor(ctx: ExtractContext, username: string): Promise<AuthorSignals> {
  const { reader, source } = ctx;
  // Fail-closed for now: a username equal to a built-in write word (report, like, edit...) makes
  // this path `denied_path`, since the write-word exemption (C9) covers thread paths only.
  const url = `${baseOf(source)}/u/${encodeURIComponent(username)}.json`;
  const r = await reader.getJson(url);
  if (r.status === 404) {
    throw new LurkdError('not_found', `${quotedName(source.name)} has no public profile for this author (HTTP 404).`, { sourceId: source.id, status: 404 });
  }
  const user = isObj(r.json) ? r.json.user : undefined;
  if (r.status !== 200 || !isObj(user)) {
    throw new LurkdError('extraction_failed', `${quotedName(source.name)} did not serve the profile JSON of this author (HTTP ${r.status}).`, {
      sourceId: source.id,
      status: r.status,
    });
  }
  const extra: string[] = [];
  if (isNum(user.trust_level)) extra.push(`trust level ${user.trust_level}`);
  if (isNum(user.badge_count)) extra.push(plural(user.badge_count, 'badge', 'badges'));
  return {
    postCount: isNum(user.post_count) ? user.post_count : null,
    joinedAt: iso(user.created_at),
    extra,
  };
}

export const discourseAdapter: EngineAdapter = {
  engine: 'discourse',
  // Discourse always searches with GET (`/search.json`), as Registry.canSearch says.
  canSearch: () => true,
  canonicalUrl: (source, url) => topicOf(source, url).canonical,
  search,
  fetchThread,
  checkSession,
  authorSignals,
};
