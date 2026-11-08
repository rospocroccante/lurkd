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
