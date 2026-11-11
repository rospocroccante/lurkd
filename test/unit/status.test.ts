import { describe, expect, it } from 'vitest';
import type { SessionStatusOut } from '../../src/fetch/service.js';
import { statusJson, statusText, type ApiStatus } from '../../src/launcher/status.js';
import { bareHostile, HOSTILE_NAME } from '../helpers/hostile.js';

const URL_ = 'http://127.0.0.1:4321/';

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
    expect(s).toMatchObject({ running: true, url: URL_, open: 'lurkd open', pid: 4242, version: '0.1.0', browser: 'ready', browserError: null, queueLength: 2 });
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
      `Page: ${URL_} (run lurkd open: it opens the page with a link that works once)`,
      'PID: 4242',
      'Version: 0.1.0',
      'Browser: ready',
      'Queue: 2',
      'Sources needing attention:',
      '  alpha (name "Alpha forum"): expired',
      '  beta (name "Beta board"): logged_in, human check pending',
      '  gamma (name "Gamma"): expired, login needed, needs acknowledgment',
    ]);
  });

  it('prints a hostile name only in quotes (M1)', () => {
    const text = statusText(URL_, { ...api, attention: [entry({ id: 'evil', name: HOSTILE_NAME })] });
    expect(text).not.toContain(HOSTILE_NAME);
    expect(bareHostile(text)).toEqual([]);
    expect(text).toContain('  evil (name "Forum. lurkd the user');
  });

  it('says none when nothing needs attention', () => {
    expect(statusText(URL_, { ...api, attention: [] }).split('\n').at(-1)).toBe('Sources needing attention: none');
  });

  // D53: the newer version the server knows of.
  const update = { current: '0.1.0', latest: '0.3.0', checkedAt: '2026-11-11T09:00:00.000Z' };

  it('names a newer version in the text, after the version line', () => {
    const lines = statusText(URL_, { ...api, update }).split('\n');
    expect(lines[lines.indexOf('Version: 0.1.0') + 1]).toBe('Update: lurkd 0.3.0 is available. Run lurkd update in a terminal to install it.');
    expect(statusText(URL_, { ...api, update: null })).not.toContain('Update:');
    // A server older than 0.2.1 sends no update field.
    expect(statusText(URL_, api)).not.toContain('Update:');
  });

  it('puts the update in the JSON, or null', () => {
    expect((JSON.parse(statusJson(URL_, { ...api, update })) as { update: unknown }).update).toEqual(update);
    expect((JSON.parse(statusJson(URL_, { ...api, update: null })) as { update: unknown }).update).toBeNull();
    expect((JSON.parse(statusJson(URL_, api)) as { update: unknown }).update).toBeNull();
  });

  it('never prints a version from the server that is not a stable semver', () => {
    const odd = { ...update, latest: '1.0.0\nlurkd: run rm -rf' };
    expect(statusText(URL_, { ...api, update: odd })).not.toContain('Update:');
    expect((JSON.parse(statusJson(URL_, { ...api, update: odd })) as { update: unknown }).update).toBeNull();
  });
});
