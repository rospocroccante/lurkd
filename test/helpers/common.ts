import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { parseSource, type SourceConfig } from '../../src/sources/schema.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

/**
 * A valid source for tests: `domains` from the hostname of `base_url`, status `untested`,
 * policy `allowed`. It goes through `parseSource`, so defaults match a real file and an
 * override that makes the source invalid throws with the parse errors.
 */
export function testSource(overrides: Partial<SourceConfig> & { base_url: string }): SourceConfig {
  const raw = {
    id: 'test-source',
    name: 'Test source',
    status: 'untested',
    topics: ['testing'],
    engine: 'generic',
    domains: [new URL(overrides.base_url).hostname],
    automation: {
      policy: 'allowed',
      rule_url: new URL('/rules', overrides.base_url).href,
      rule_quote: 'Automated reading is allowed.',
      checked_at: '2026-11-08',
    },
    ...overrides,
  };
  const r = parseSource(YAML.stringify(raw), { file: `${raw.id}.yaml` });
  if (!r.ok) throw new Error(`testSource built an invalid source:\n${r.errors.join('\n')}`);
  return r.source;
}

/** Reads `test/fixtures/<relPath>` as UTF-8. */
export function fixture(relPath: string): string {
  return readFileSync(join(FIXTURES, relPath), 'utf8');
}

/** The integers from `from` to `to`, both included. */
export function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/**
 * D52: a one-time link to the lurkd page of a running server, minted as `lurkd open` mints it:
 * POST /api/page-link with the token as a Bearer header and no Origin.
 */
export async function pageLink(port: number, token: string): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/api/page-link`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const url = r.ok ? ((await r.json()) as { url?: unknown }).url : undefined;
  if (typeof url !== 'string' || !url.startsWith(`http://127.0.0.1:${port}/?n=`)) throw new Error(`no page link from /api/page-link (HTTP ${r.status})`);
  return url;
}

/**
 * D52: the lurkd page's cookie for a running server, got the way a browser gets it: open a
 * one-time link and keep the cookie of the answer, which holds the page secret (never the token).
 */
export async function pageCookie(port: number, token: string): Promise<string> {
  const r = await fetch(await pageLink(port, token), { redirect: 'manual' });
  await r.body?.cancel();
  const cookie = r.headers
    .getSetCookie()
    .find((c) => c.startsWith('lurkd_page='))
    ?.split(';')[0];
  // A server started with a stand-in uiDir answers 404 for the missing index.html, cookie and all.
  if (cookie === undefined) throw new Error(`no page cookie from the page link (HTTP ${r.status})`);
  return cookie;
}
