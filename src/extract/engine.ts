import type { PageReader } from '../browser/reader.js';
import { LurkdError } from '../errors.js';
import type { SourceConfig } from '../sources/schema.js';
import type { AuthorSignals, Engine, ExtractedThread, SearchHit } from '../types.js';
import { discourseAdapter } from './discourse.js';
import { genericAdapter } from './generic.js';
import { customAdapter } from './selectors.js';
import { xenforoAdapter } from './xenforo.js';

// One adapter per engine. Adapters make every request through `ctx.reader` (URL policy, run
// limits, fetch log, block detection), never through Playwright directly.

export interface ExtractContext {
  reader: PageReader;
  source: SourceConfig;
  onProgress: (p: { postsFetched: number; page?: number }) => void;
}

export interface EngineAdapter {
  engine: Engine;
  /**
   * Whether `search` can run for this source (P15, D6). It must agree with `canSearch` in
   * src/sources/registry.ts; `search` answers `search_unsupported` exactly when this is false.
   */
  canSearch(source: SourceConfig): boolean;
  canonicalUrl(source: SourceConfig, url: string): string;
  search(ctx: ExtractContext, query: string, limit: number): Promise<SearchHit[]>;
  fetchThread(ctx: ExtractContext, url: string): Promise<ExtractedThread>;
  checkSession(ctx: ExtractContext): Promise<boolean>;
  authorSignals(ctx: ExtractContext, author: { username: string; profileUrl: string | null }): Promise<AuthorSignals>;
}

export function adapterFor(source: SourceConfig): EngineAdapter {
  switch (source.engine) {
    case 'discourse':
      return discourseAdapter;
    case 'xenforo':
      return xenforoAdapter;
    case 'generic':
      return genericAdapter;
    case 'custom':
      return customAdapter;
    default:
      throw new LurkdError('extraction_failed', `Engine ${source.engine} is not supported in this version.`, {
        sourceId: source.id,
        engine: source.engine,
      });
  }
}
