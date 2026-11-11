import { REDDIT_IMPORT_SOURCE_ID } from '../extract/reddit-import.js';
import type { SourceConfig } from './schema.js';

// Sources that ship in code, not as files: the schema refuses their engine and hosts in any file.
// `Registry.load({ builtins: true })` loads them first, as seed sources, so they cannot be removed
// and no file can take their id or their hosts.

/**
 * D50: the source of the Reddit threads the user saved and imported. Engine `import`, so it is
 * never read live: the Registry keeps it switched off and refuses to switch it on, and every
 * Reddit request is refused by the browser guard. It claims the usual Reddit hosts so "Add a
 * forum", `lurkd add` and drafts point at it; the schema refuses every other Reddit host.
 */
export const REDDIT_IMPORT_SOURCE: Readonly<SourceConfig> = Object.freeze({
  id: REDDIT_IMPORT_SOURCE_ID,
  name: 'Reddit, saved threads',
  description:
    'Reddit threads the user saved and imported with lurkd import reddit <file>. lurkd does not read Reddit live; find these threads with archive.search.',
  status: 'untested',
  topics: ['general', 'reddit'],
  engine: 'import',
  base_url: 'https://www.reddit.com/',
  domains: ['www.reddit.com', 'reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com', 'm.reddit.com', 'redd.it'],
  login_url: null,
  signup_url: null,
  search_url: null,
  read_endpoints: [],
  session_check: null,
  selectors: null,
  author_signals: { profile_lookup: false },
  automation: {
    policy: 'forbidden',
    rule_url: 'https://redditinc.com/policies/user-agreement',
    rule_quote:
      'Access, search, or collect data from the Services by any means (automated or otherwise) except as permitted in these Terms or in a separate agreement with Reddit (we conditionally grant permission to crawl the Services in accordance with the parameters set forth in our robots.txt file, but scraping the Services without Reddit’s prior written consent is prohibited); or',
    checked_at: '2026-11-10',
  },
  rate_limit: { min_delay_s: 3, max_requests_per_run: 20, max_requests_per_day: 200 },
  pagination: { max_pages_per_thread: 1 },
  deny_paths: [],
  show_real_names: false,
  allow_beacons: false,
  enabled: false,
} satisfies SourceConfig);

export const BUILTIN_SOURCES: readonly Readonly<SourceConfig>[] = [REDDIT_IMPORT_SOURCE];

/** True for a source that holds imported threads and is never read live. */
export function isImportOnly(source: Pick<SourceConfig, 'engine'>): boolean {
  return source.engine === 'import';
}
