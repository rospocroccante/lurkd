import { describe, expect, it } from 'vitest';
import { findLeaks } from '../../src/pseudonym.js';
import { shutdownSmoke, structural, type ShutdownDeps } from '../../scripts/smoke.js';
import type { LurkdPaths } from '../../src/paths.js';

const paths = {} as LurkdPaths;
const total = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

describe('structural', () => {
  const names = ['Erin Smith', 'bob'];
  const md = [
    '## #1, Erin Smith (trust level 2), 2026-01-01 10:00 UTC',
    '',
    '> bob wrote (post #1):',
    '> quoted words',
    '',
    'Thanks @Erin Smith, and @bob too.',
    'See the reply, Topic - #12 by Erin Smith for details.',
    'Thanks bob, and cheers to Erin Smith.',
  ].join('\n');

  it('counts multi-word names after @ and "#N by" as structural, and keeps the rest as free text', () => {
    const parts = structural(md, names);
    const struct = findLeaks(parts.structural, names);
    expect(struct.get('Erin Smith')).toBe(3); // header, @mention, "#12 by"
    expect(struct.get('bob')).toBe(2); // quote header, @bob
    const free = findLeaks(parts.free, names);
    expect(free.get('Erin Smith')).toBe(1);
    expect(free.get('bob')).toBe(1);
    expect(total(struct) + total(free)).toBe(total(findLeaks(md, names)));
  });

  it('the old pattern would have missed the surname of a mention', () => {
    // Without the name list, "@Erin" is structural and " Smith" stays in the free text.
    const blind = structural('hello @Erin Smith', []);
    expect(blind.free).toContain('Smith');
    const aware = structural('hello @Erin Smith', ['Erin Smith']);
    expect(aware.free).not.toContain('Smith');
    expect(findLeaks(aware.structural, ['Erin Smith']).get('Erin Smith')).toBe(1);
  });

  it('still treats a mention of an unlisted name as structural up to the next space', () => {
    const parts = structural('ping @carol-x now', names);
    expect(parts.structural).toBe('@carol-x');
    expect(parts.free).not.toContain('carol');
  });
});

describe('shutdownSmoke', () => {
  function deps(over: Partial<ShutdownDeps> & { alive?: { v: boolean } } = {}): { d: ShutdownDeps; log: string[] } {
    const log: string[] = [];
    const alive = over.alive ?? { v: true };
    const d: ShutdownDeps = {
      stop: async () => {
        log.push('stop');
        alive.v = false;
        return 'stopped';
      },
      readRun: () => ({ pid: 4242 }),
      isOurServer: () => true,
      isAlive: () => alive.v,
      kill: () => {
        log.push('kill');
        alive.v = false;
      },
      wait: async () => {},
      rmHome: () => {
        log.push('rm');
      },
      ...over,
    };
    return { d, log };
  }

  it('stops the server, then removes the home', async () => {
    const { d, log } = deps();
    const r = await shutdownSmoke(paths, '/tmp/h', {}, d);
    expect(r).toEqual({ server: 'stopped', homeRemoved: true, error: null });
    expect(log).toEqual(['stop', 'rm']);
  });

  it('kills our server when stop throws, then removes the home', async () => {
    const alive = { v: true };
    const { d, log } = deps({
      alive,
      stop: async () => {
        log.push('stop');
        throw new Error('still answers');
      },
    });
    const r = await shutdownSmoke(paths, '/tmp/h', {}, d);
    expect(r.server).toBe('killed');
    expect(r.homeRemoved).toBe(true);
    expect(r.error).toBe('still answers');
    expect(log).toEqual(['stop', 'kill', 'rm']);
  });

  it('never kills a pid that is not our server and never removes the home while it lives', async () => {
    const log: string[] = [];
    const { d } = deps({
      stop: async () => {
        throw new Error('x');
      },
      isOurServer: () => false,
      kill: () => log.push('kill'),
      rmHome: () => log.push('rm'),
    });
    const r = await shutdownSmoke(paths, '/tmp/h', {}, d);
    expect(r).toMatchObject({ server: 'alive', homeRemoved: false });
    expect(log).toEqual([]);
  });

  it('leaves the home when the kill did not work', async () => {
    const log: string[] = [];
    const { d } = deps({
      stop: async () => {
        throw new Error('x');
      },
      kill: () => log.push('kill'),
      rmHome: () => log.push('rm'),
    });
    const r = await shutdownSmoke(paths, '/tmp/h', {}, d);
    expect(r).toMatchObject({ server: 'alive', homeRemoved: false });
    expect(log).toEqual(['kill']);
  });

  it('keeps the home on request, and removes nothing when no server ever ran', async () => {
    const a = deps();
    expect(await shutdownSmoke(paths, '/tmp/h', { keep: true }, a.d)).toMatchObject({ homeRemoved: false });
    expect(a.log).toEqual(['stop']);
    const b = deps({ readRun: () => null, stop: async () => 'not_running', isAlive: () => false });
    expect(await shutdownSmoke(paths, '/tmp/h', {}, b.d)).toEqual({ server: 'not_running', homeRemoved: true, error: null });
  });
});
