import { Readability } from '@mozilla/readability';
import { LurkdError } from '../errors.js';
import { stripMarkers } from '../pseudonym.js';
import type { ExtractedThread } from '../types.js';
import type { EngineAdapter, ExtractContext } from './engine.js';
import { boundedDocument, MAX_ELEMENTS, MAX_READABILITY_DEPTH } from './bounds.js';
import { makeConverter } from './markdown.js';
import { PAGE_DEADLINE_MS, runPageTask } from './page-worker.js';
import {
  canSearchWithSelectors,
  capMarkdown,
  landedUrl,
  noAuthorLookup,
  pageHtml,
  pageThreadUrl,
  selectorSearch,
  selectorSession,
  shownUrl,
} from './selectors.js';

// The generic fallback (D7): Mozilla Readability picks the main text of one page, which becomes
// one post with no author, marked as low quality. It is a last resort: it reads the page it is
// given and follows no link. The HTML goes through the same converter as every other body, so
// scripts, styles and frames are dropped and only http(s) links stay links.

const GONE: ReadonlySet<number> = new Set([404, 410]);

/** Readability keeps names as plain text (comment headers, bylines in the text): D7 accepts it, the label says it. */
export const READABILITY_EXTRACTION = 'readability (names not pseudonymised)';
export const READABILITY_NOTE = 'names in this text are not pseudonymised';

/** Free text from the page for a title: no name markers, one line. */
const clean = (s: string | null | undefined): string => stripMarkers(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300).trim();

function iso(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The main text of one page as a thread of one post: number 1, author `''`, quality `low`,
 * extraction `readability (names not pseudonymised)` with the matching note (names in the text
 * stay plain text, which D7 accepts for this fallback), engine `generic` (a caller for another engine overrides it). `url` is
 * the page's absolute URL; it resolves relative links and, without its fragment, is the thread
 * URL. Throws `invalid_request` for a URL that is not absolute http(s), `extraction_failed` when
 * Readability finds no main text.
 */
export function readabilityThread(html: string, url: string): ExtractedThread {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new LurkdError('invalid_request', 'The readability fallback needs the absolute URL of the page.', {});
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new LurkdError('invalid_request', 'The readability fallback reads http and https pages only.', { url: shownUrl(u.href) });
  }
  u.hash = '';
  const pageUrl = u.href;
  const document = boundedDocument(html, `The page at ${shownUrl(pageUrl)}`, { url: shownUrl(pageUrl) }, MAX_READABILITY_DEPTH);
  const fallbackTitle = clean(document.querySelector('title')?.textContent);
  let article: ReturnType<Readability['parse']>;
  try {
    article = new Readability(document, { maxElemsToParse: MAX_ELEMENTS }).parse();
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.trim();
    throw new LurkdError('extraction_failed', `Readability could not read ${shownUrl(pageUrl)}: ${why}`, { url: shownUrl(pageUrl) });
  }
  const bodyMd = article?.content ? capMarkdown(makeConverter({ baseUrl: pageUrl })(article.content)) : '';
  if (bodyMd === '') {
    throw new LurkdError('extraction_failed', `${shownUrl(pageUrl)} has no main text that Readability can find.`, { url: shownUrl(pageUrl) });
  }
  return {
    url: pageUrl,
    title: clean(article?.title) || fallbackTitle || pageUrl,
    engine: 'generic',
    postsExpected: null,
    pages: 1,
    extraction: READABILITY_EXTRACTION,
    quality: 'low',
    posts: [{ number: 1, page: null, author: '', authorUrl: null, signals: [], notes: [READABILITY_NOTE], postedAt: iso(article?.publishedTime), bodyMd }],
  };
}

/** `readabilityThread` in a page worker with the `PAGE_DEADLINE_MS` deadline (src/extract/page-worker.ts). */
export function readabilityInWorker(html: string, url: string): Promise<ExtractedThread> {
  return runPageTask({ kind: 'readability', html, url }, () => {
    const shown = shownUrl(url);
    return new LurkdError('extraction_failed', `Reading ${shown} with Readability took too long (over ${PAGE_DEADLINE_MS / 1000} s), so lurkd stopped it.`, { url: shown });
  });
}

/** One navigation, one `evaluate` for the HTML, then `readabilityThread` in a page worker. */
async function fetchThread(ctx: ExtractContext, url: string): Promise<ExtractedThread> {
  const { reader, source } = ctx;
  const thread = pageThreadUrl(source, url);
  const nav = await reader.open(thread);
  if (nav.status !== null && GONE.has(nav.status)) {
    throw new LurkdError('not_found', `${source.name} has no page at ${shownUrl(thread)} (HTTP ${nav.status}).`, { url: shownUrl(thread), sourceId: source.id, status: nav.status });
  }
  const stored = landedUrl(source, thread, nav.finalUrl);
  const t = await readabilityInWorker(await pageHtml(reader), stored);
  ctx.onProgress({ postsFetched: t.posts.length, page: 1 });
  return { ...t, url: stored, engine: source.engine };
}

export const genericAdapter: EngineAdapter = {
  engine: 'generic',
  canSearch: canSearchWithSelectors,
  canonicalUrl: pageThreadUrl,
  search: selectorSearch,
  fetchThread,
  checkSession: selectorSession,
  authorSignals: noAuthorLookup,
};
