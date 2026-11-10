import { describe, expect, it } from 'vitest';
import type { SessionStatusOut } from '../../src/fetch/service.js';
import { statusJson, statusText, type ApiStatus } from '../../src/launcher/status.js';

const URL_ = 'http://127.0.0.1:4321/?t=' + 'a'.repeat(64);

const entry = (over: Partial<SessionStatusOut>): SessionStatusOut => ({
  id: 'alpha',
  name: 'Alpha forum',
  state: 'expired',
  loginUrl: 'https://forum.example.org/login',
  lastLoginAt: null,
  lastCheckAt: null,
  needsAcknowledgment: false,
  lastBlock: null,
  ...over,
});

const api: ApiStatus = {
  version: '0.1.0',
  pid: 4242,
  browser: { state: 'ready', lastError: null },
  queueLength: 2,
  attention: [
    entry({}),
    entry({ id: 'beta', name: 'Beta board', state: 'logged_in' as SessionStatusOut['state'], lastBlock: { kind: 'challenge', url: 'https://beta.example.net/t/123' } }),
    entry({ id: 'gamma', name: 'Gamma', needsAcknowledgment: true, lastBlock: { kind: 'login', url: 'https://gamma.example.com/private' } }),
  ],
};

const withoutOurUrl = (text: string): string => text.split(URL_).join('');

describe('lurkd status output', () => {
  it('projects the sources needing attention without forum URLs (JSON)', () => {
    const text = statusJson(URL_, api);
    expect(withoutOurUrl(text)).not.toContain('http');
    const s = JSON.parse(text) as Record<string, unknown>;
    expect(s).toMatchObject({ running: true, url: URL_, pid: 4242, version: '0.1.0', browser: 'ready', browserError: null, queueLength: 2 });
    expect(s.attention).toEqual([
      { id: 'alpha', name: 'Alpha forum', state: 'expired', block: null, needsAcknowledgment: false },
      { id: 'beta', name: 'Beta board', state: 'logged_in', block: 'challenge', needsAcknowledgment: false },
      { id: 'gamma', name: 'Gamma', state: 'expired', block: 'login', needsAcknowledgment: true },
    ]);
  });

  it('prints the same fields as text, without forum URLs', () => {
    const text = statusText(URL_, api);
    expect(withoutOurUrl(text)).not.toContain('http');
    expect(text.split('\n')).toEqual([
      'lurkd is running.',
      `URL: ${URL_}`,
      'PID: 4242',
      'Version: 0.1.0',
      'Browser: ready',
      'Queue: 2',
      'Sources needing attention:',
      '  alpha (Alpha forum): expired',
      '  beta (Beta board): logged_in, human check pending',
      '  gamma (Gamma): expired, login needed, needs acknowledgment',
    ]);
  });

  it('says none when nothing needs attention', () => {
    expect(statusText(URL_, { ...api, attention: [] }).split('\n').at(-1)).toBe('Sources needing attention: none');
  });
});
