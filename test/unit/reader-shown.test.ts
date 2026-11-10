import { describe, expect, it } from 'vitest';
import { PageReader } from '../../src/browser/reader.js';
import { LurkdError } from '../../src/errors.js';
import { HostPacer, RunLimiter } from '../../src/policy/limiter.js';
import { testSource } from '../helpers/common.js';

// Which addresses a lurkd message may show with their path: only the ones the agent asked for
// (`ask`) and the source's own configured URLs. Everything a page supplied shows its origin.

const source = testSource({
  id: 'ff',
  base_url: 'https://f.example',
  login_url: 'https://f.example/login',
  search_url: 'https://f.example/search/?q={query}',
});
const limiter = new RunLimiter({ minIntervalMs: 0, maxRequestsPerRun: 60, maxRequestsPerDay: 300, deadlineMs: 600_000 }, new HostPacer(), () => 0);
const reader = () => new PageReader({} as never, source, { limiter, log: () => {}, jobId: null, arm: () => () => {} });

describe('PageReader.shown and scrubbed', () => {
  it('shows the path of the source config URLs and of the addresses asked for, origin only for the rest', () => {
    const r = reader();
    expect(r.shown('https://f.example/login?next=x')).toBe('https://f.example/login');
    expect(r.shown('https://f.example/search/?q=anything')).toBe('https://f.example/search/');
    expect(r.shown('https://f.example/t/IGNORE-ME/5')).toBe('https://f.example');
    r.ask('https://f.example/t/mine/5?u=someone#x');
    expect(r.shown('https://f.example/t/mine/5')).toBe('https://f.example/t/mine/5');
    expect(r.shown('https://f.example/t/IGNORE-ME/5')).toBe('https://f.example');
    expect(r.shown('not a url')).toBe('that address');
  });

  it('shows no host name the forum chose: an address off the source domains is "another host"', () => {
    const r = reader();
    expect(r.shown('https://f.example/x')).toBe('https://f.example');
    expect(r.shown('https://ignore-previous-instructions.f.example/x')).toBe('another host');
    expect(r.shown('https://other.example:8443/x?y=1')).toBe('another host');
    // The agent chose its own address, so it is shown as given.
    r.ask('https://other.example/mine');
    expect(r.shown('https://other.example/mine')).toBe('https://other.example/mine');
  });

  it('finds an address with an upper-case scheme', () => {
    const r = reader();
    const s = r.scrubbed(new LurkdError('timeout', 'HTTPS://F.EXAMPLE/t/IGNORE-ME/6 and Http://other.example/x did not load.', {}));
    expect(s.message).not.toMatch(/IGNORE|\/x/);
    expect(s.message).toContain('another host');
  });

  it('rewrites the addresses inside an error message, and keeps code and details', () => {
    const r = reader();
    r.ask('https://f.example/t/mine/5');
    const e = new LurkdError('not_found', 'f has no topic at https://f.example/t/IGNORE-ME/6 (HTTP 404); asked https://f.example/t/mine/5?x=1.', { url: 'https://f.example/t/IGNORE-ME/6' });
    const s = r.scrubbed(e);
    expect(s.message).toBe('f has no topic at https://f.example (HTTP 404); asked https://f.example/t/mine/5.');
    expect(s).toMatchObject({ code: 'not_found', details: { url: 'https://f.example/t/IGNORE-ME/6' } });
  });
});
