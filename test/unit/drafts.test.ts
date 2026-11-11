import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openArchive } from '../../src/archive/db.js';
import { StateStore } from '../../src/archive/state.js';
import { Registry } from '../../src/sources/registry.js';
import { AddRequestStore, DraftStore, draftRefused, ForbiddenLog, MAX_ADD_REQUESTS, MAX_DRAFT_BYTES, SampleStore } from '../../src/sources/drafts.js';

const SEED = fileURLToPath(new URL('../fixtures/sources/seed/', import.meta.url));
const HOST = 'kappa.example.org';

const draft = (overrides: Record<string, unknown> = {}) =>
  YAML.stringify({
    id: 'kappa',
    name: 'Kappa Bench',
    topics: ['electronics'],
    engine: 'custom',
    base_url: `https://${HOST}`,
    domains: [HOST],
    read_endpoints: [{ method: 'POST', path: '/search/run*', note: 'search form' }],
    selectors: {
      search_form: 'form.search',
      search_input: 'input[name=keywords]',
      thread_list: 'ol.results a.title',
      post: 'article.message',
      author: '.message-name a',
      date: 'time[datetime]',
      body: '.bbWrapper',
    },
    automation: { policy: 'unknown', rule_url: `https://${HOST}/help/terms`, rule_quote: null, checked_at: '2026-11-09' },
    ...overrides,
  });

const failed = (r: ReturnType<DraftStore['submit']>): string[] => {
  if (r.ok) throw new Error('expected the draft to be refused');
  return r.errors;
};

describe('DraftStore', () => {
  let tmp: string;
  let db: Database.Database;
  let state: StateStore;
  let registry: Registry;
  let drafts: DraftStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-drafts-'));
    db = openArchive(':memory:');
    state = new StateStore(db);
    registry = Registry.load({ seedDir: SEED, userDir: path.join(tmp, 'sources'), state });
    drafts = new DraftStore(db, registry);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('forces status untested', () => {
    const r = drafts.submit(draft({ status: 'verified' }), HOST);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(r.draft.yaml).toContain('status: untested');
    expect(r.draft.yaml).not.toContain('verified');
    expect(r.draft).toMatchObject({ sourceId: 'kappa', host: HOST, state: 'pending' });
    const realNames = drafts.submit(draft({ show_real_names: true }), HOST);
    expect(realNames.ok && realNames.draft.yaml).toContain('show_real_names: false');
    const withoutStatus = drafts.submit(draft(), HOST);
    expect(withoutStatus.ok && withoutStatus.draft.yaml).toContain('status: untested');
  });

  it('refuses a seed id and a draft whose domains lack the sampled host', () => {
    const seed = failed(drafts.submit(draft({ id: 'alpha' }), HOST));
    expect(seed.join('\n')).toMatch(/"alpha" is the id of a seed source/);
    const elsewhere = failed(drafts.submit(draft(), 'other.example.org'));
    expect(elsewhere.join('\n')).toMatch(/domains does not list other\.example\.org/);
    expect(drafts.list()).toEqual([]);
  });

  it('lists read endpoints first among the warnings', () => {
    const r = drafts.submit(
      draft({
        login_url: `https://${HOST}/login`,
        signup_url: `https://${HOST}/register`,
        search_url: `https://${HOST}/find?q={query}`,
        allow_beacons: true,
        read_endpoints: [
          { method: 'POST', path: '/search/run*', note: 'search form' },
          { method: 'POST', path: '/find/more', note: 'next page\nof hits' },
        ],
      }),
      HOST,
    );
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(r.draft.warnings[0]).toBe('POST /search/run*: search form');
    // allow_beacons is forced off, so its warning names the change instead of the switch.
    expect(r.draft.warnings).toEqual([
      'POST /search/run*: search form',
      'POST /find/more: next page of hits',
      `domains: ${HOST}`,
      `login_url: https://${HOST}/login`,
      `signup_url: https://${HOST}/register`,
      `search_url: https://${HOST}/find?q={query}`,
      `policy unknown (https://${HOST}/help/terms)`,
      'allow_beacons set to false: beacons are allowed from the lurkd page',
      'enabled set to false: switch the source on from the lurkd page after approval',
    ]);
  });

  it('approval registers the source, switched off when forbidden', () => {
    const r = drafts.submit(
      draft({ automation: { policy: 'forbidden', rule_url: `https://${HOST}/help/terms`, rule_quote: 'No bots.', checked_at: '2026-11-09' }, enabled: false }),
      HOST,
    );
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(r.draft.warnings.at(-1)).toBe(`policy forbidden: "No bots." (https://${HOST}/help/terms)`);
    expect(registry.ids()).not.toContain('kappa');
    const source = drafts.approve(r.draft.id);
    expect(source.id).toBe('kappa');
    expect(source.status).toBe('untested');
    expect(registry.view('kappa').session).toBe('disabled');
    expect(registry.view('kappa').needsAcknowledgment).toBe(true);
    expect(() => registry.assertUsable('kappa')).toThrow(expect.objectContaining({ code: 'disabled' }));
    expect(drafts.list('approved').map((d) => d.id)).toEqual([r.draft.id]);
    expect(drafts.list('pending')).toEqual([]);
    expect(fs.statSync(path.join(tmp, 'sources', 'kappa.yaml')).mode & 0o777).toBe(0o600);
  });

  it('never enables a source by itself: it lands switched off and an unknown policy still needs the acknowledgment', () => {
    const r = drafts.submit(draft({ enabled: true }), HOST);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(r.draft.yaml).toContain('enabled: false');
    expect(registry.ids()).not.toContain('kappa');
    drafts.approve(r.draft.id);
    expect(registry.view('kappa')).toMatchObject({ enabled: false, session: 'disabled', needsAcknowledgment: true });
    expect(() => registry.assertUsable('kappa')).toThrow(expect.objectContaining({ code: 'disabled' }));
    expect(() => registry.enable('kappa', false)).toThrow(expect.objectContaining({ code: 'needs_acknowledgment' }));
    registry.enable('kappa', true);
    expect(() => registry.assertUsable('kappa')).not.toThrow();
  });

  it('clamps the rate limit and the page cap to the defaults and names each change', () => {
    const r = drafts.submit(
      draft({
        rate_limit: { min_delay_s: 1, max_requests_per_run: 60, max_requests_per_day: 100000 },
        pagination: { max_pages_per_thread: 500 },
        enabled: false,
      }),
      HOST,
    );
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const source = YAML.parse(r.draft.yaml) as Record<string, Record<string, number>>;
    expect(source.rate_limit).toEqual({ min_delay_s: 2, max_requests_per_run: 60, max_requests_per_day: 300 });
    expect(source.pagination).toEqual({ max_pages_per_thread: 20 });
    expect(r.draft.warnings.slice(-3)).toEqual([
      'rate_limit.min_delay_s set to 2 (the draft had 1): a draft can only keep the default or a stricter value',
      'rate_limit.max_requests_per_day set to 300 (the draft had 100000): a draft can only keep the default or a stricter value',
      'pagination.max_pages_per_thread set to 20 (the draft had 500): a draft can only keep the default or a stricter value',
    ]);
    // Stricter values stay as written, with no warning.
    const strict = drafts.submit(draft({ rate_limit: { min_delay_s: 5, max_requests_per_run: 10, max_requests_per_day: 50 }, pagination: { max_pages_per_thread: 3 }, enabled: false }), HOST);
    if (!strict.ok) throw new Error(strict.errors.join('\n'));
    expect(YAML.parse(strict.draft.yaml)).toMatchObject({ rate_limit: { min_delay_s: 5, max_requests_per_run: 10, max_requests_per_day: 50 }, pagination: { max_pages_per_thread: 3 } });
    expect(strict.draft.warnings.at(-1)).toBe(`policy unknown (https://${HOST}/help/terms)`);
    expect(drafts.approve(strict.draft.id).rate_limit).toEqual({ min_delay_s: 5, max_requests_per_run: 10, max_requests_per_day: 50 });
  });

  it('forces show_real_names and allow_beacons off with a warning each', () => {
    const r = drafts.submit(draft({ show_real_names: true, allow_beacons: true, enabled: false }), HOST);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(YAML.parse(r.draft.yaml)).toMatchObject({ show_real_names: false, allow_beacons: false, enabled: false });
    expect(r.draft.warnings.slice(-2)).toEqual([
      'show_real_names set to false: real names are switched on from the lurkd page',
      'allow_beacons set to false: beacons are allowed from the lurkd page',
    ]);
    expect(r.draft.warnings).not.toContain('allow_beacons: true');
  });

  it('drops an earlier acknowledgment when a draft replaces a user source', () => {
    const first = drafts.submit(draft(), HOST);
    if (!first.ok) throw new Error(first.errors.join('\n'));
    drafts.approve(first.draft.id);
    registry.enable('kappa', true);
    expect(() => registry.assertUsable('kappa')).not.toThrow();
    expect(registry.view('kappa').enabled).toBe(true);
    const second = drafts.submit(draft({ name: 'Kappa Bench 2' }), HOST);
    if (!second.ok) throw new Error(second.errors.join('\n'));
    expect(second.draft.warnings.at(-1)).toBe('replaces the user source kappa');
    drafts.approve(second.draft.id);
    expect(registry.view('kappa')).toMatchObject({ name: 'Kappa Bench 2', enabled: false, needsAcknowledgment: true });
    expect(() => registry.assertUsable('kappa')).toThrow(expect.objectContaining({ code: 'disabled' }));
  });

  it('clears every override when a draft replaces a user source', () => {
    const first = drafts.submit(draft(), HOST);
    if (!first.ok) throw new Error(first.errors.join('\n'));
    drafts.approve(first.draft.id);
    registry.enable('kappa', true);
    registry.setShowRealNames('kappa', true);
    registry.setAllowBeacons('kappa', true);
    const second = drafts.submit(draft({ name: 'Kappa 2' }), HOST);
    if (!second.ok) throw new Error(second.errors.join('\n'));
    drafts.approve(second.draft.id);
    expect(registry.view('kappa')).toMatchObject({ enabled: false, needsAcknowledgment: true, showRealNames: false, allowBeacons: false });
    expect(state.getOverride('kappa')).toEqual({ enabled: null, acknowledgedAt: null, acknowledgedPolicy: null, showRealNames: null, allowBeacons: null });
  });

  it('leaves the draft pending and the overrides untouched when the file cannot be written', () => {
    fs.writeFileSync(path.join(tmp, 'blocker'), 'x');
    const blocked = Registry.load({ seedDir: SEED, userDir: path.join(tmp, 'blocker', 'sources'), state });
    const store = new DraftStore(db, blocked, { state });
    state.setOverride('kappa', { showRealNames: true });
    const r = store.submit(draft(), HOST);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(() => store.approve(r.draft.id)).toThrow();
    expect(store.list().map((d) => d.state)).toEqual(['pending']);
    expect(blocked.ids()).not.toContain('kappa');
    expect(state.getOverride('kappa').showRealNames).toBe(true);
  });

  it('writes no file when the overrides cannot be cleared', () => {
    const failing = new Proxy(state, {
      get: (t, p, rcv) =>
        p === 'setOverride'
          ? () => {
              throw new Error('disk full');
            }
          : Reflect.get(t, p, rcv),
    });
    const store = new DraftStore(db, registry, { state: failing });
    const r = store.submit(draft(), HOST);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(() => store.approve(r.draft.id)).toThrow('disk full');
    expect(fs.existsSync(path.join(tmp, 'sources', 'kappa.yaml'))).toBe(false);
    expect(store.list().map((d) => d.state)).toEqual(['pending']);
  });

  it('refuses a selector that cannot run or costs too much', () => {
    const errors = failed(
      drafts.submit(draft({ selectors: { post: 'article.message ~ article', author: 'a[[', body: 'x'.repeat(1001) } }), HOST),
    );
    expect(errors.some((e) => e.includes('selectors.post') && e.includes('sibling combinator'))).toBe(true);
    expect(errors.some((e) => e.includes('selectors.author') && e.includes('not a CSS selector'))).toBe(true);
    expect(errors.some((e) => e.includes('selectors.body') && e.includes('longer than'))).toBe(true);
    const session = failed(drafts.submit(draft({ session_check: { url: `https://${HOST}/account`, logged_in_selector: 'a:has(b:has(c))' } }), HOST));
    expect(session.join('\n')).toMatch(/session_check\.logged_in_selector/);
  });

  it('refuses anchors, aliases, tags, directives and oversized text', () => {
    const anchored = 'base: &b https://kappa.example.org\n' + draft().replace(`base_url: https://${HOST}`, 'base_url: *b');
    expect(failed(drafts.submit(anchored, HOST)).join('\n')).toMatch(/anchor|alias/);
    const tagged = draft().replace('name: Kappa Bench', 'name: !!str Kappa Bench');
    expect(failed(drafts.submit(tagged, HOST)).join('\n')).toMatch(/tag/);
    const custom = draft().replace('name: Kappa Bench', 'name: !secret Kappa Bench');
    expect(failed(drafts.submit(custom, HOST)).join('\n')).toMatch(/tag/);
    const directive = `%YAML 1.1\n---\n${draft()}`;
    expect(failed(drafts.submit(directive, HOST)).join('\n')).toMatch(/directive/);
    const big = draft({ description: 'x'.repeat(MAX_DRAFT_BYTES) });
    expect(failed(drafts.submit(big, HOST)).join('\n')).toMatch(/larger than 64 KB/);
    expect(failed(drafts.submit(`${draft()}---\nid: other\n`, HOST)).length).toBeGreaterThan(0);
    expect(drafts.list()).toEqual([]);
  });

  it('refuses a draft whose domain another source claims', () => {
    const errors = failed(drafts.submit(draft({ domains: [HOST, 'alpha.example.org'] }), HOST));
    expect(errors.join('\n')).toMatch(/alpha\.example\.org is already claimed by alpha/);
  });

  it('reports schema errors under the id file name', () => {
    const errors = failed(drafts.submit(draft({ engine: 'smf', topics: [] }), HOST));
    expect(errors.every((e) => e.startsWith('kappa.yaml: '))).toBe(true);
    expect(failed(drafts.submit('id: [x]\n', HOST)).every((e) => e.startsWith('draft.yaml: '))).toBe(true);
  });

  it('approves only pending drafts and re-checks the stored text', () => {
    const r = drafts.submit(draft(), HOST);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    // A row altered after submit (or written by an older version) is checked again on approval.
    db.prepare('UPDATE drafts SET yaml = ? WHERE id = ?').run(draft({ selectors: { post: 'a + b', author: 'b' }, enabled: false }), r.draft.id);
    expect(() => drafts.approve(r.draft.id)).toThrow(expect.objectContaining({ code: 'invalid_request', details: { errors: [expect.stringMatching(/sibling combinator/)] } }));
    db.prepare('UPDATE drafts SET yaml = ? WHERE id = ?').run(draft({ status: 'verified', show_real_names: true }), r.draft.id);
    expect(() => drafts.approve(r.draft.id)).toThrow(
      expect.objectContaining({
        details: {
          errors: [expect.stringMatching(/status must be untested/), expect.stringMatching(/show_real_names must be false/), expect.stringMatching(/enabled must be false/)],
        },
      }),
    );
    const loose = draft({ allow_beacons: true, rate_limit: { min_delay_s: 1, max_requests_per_day: 1000 }, pagination: { max_pages_per_thread: 99 }, enabled: false });
    db.prepare('UPDATE drafts SET yaml = ? WHERE id = ?').run(loose, r.draft.id);
    expect(() => drafts.approve(r.draft.id)).toThrow(
      expect.objectContaining({
        details: {
          errors: [
            expect.stringMatching(/allow_beacons must be false/),
            expect.stringMatching(/rate_limit\.min_delay_s must be at least 2/),
            expect.stringMatching(/rate_limit\.max_requests_per_day must be at most 300/),
            expect.stringMatching(/pagination\.max_pages_per_thread must be at most 20/),
          ],
        },
      }),
    );
    expect(registry.ids()).not.toContain('kappa');
    drafts.reject(r.draft.id);
    expect(drafts.list('rejected').map((d) => d.state)).toEqual(['rejected']);
    expect(() => drafts.approve(r.draft.id)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => drafts.approve(9999)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => drafts.reject(9999)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('builds the invalid_request error of a refused draft', () => {
    const e = draftRefused(['kappa.yaml: engine must be ...']);
    expect(e).toMatchObject({ code: 'invalid_request', details: { errors: ['kappa.yaml: engine must be ...'] } });
  });
});

describe('SampleStore', () => {
  let db: Database.Database;
  let now: Date;
  let samples: SampleStore;

  beforeEach(() => {
    db = openArchive(':memory:');
    now = new Date('2026-11-09T10:00:00.000Z');
    samples = new SampleStore(db, () => now);
  });
  afterEach(() => db.close());

  it('records requests, lists them as pending and stores the sample', () => {
    expect(samples.get(HOST)).toBeNull();
    samples.request('Kappa.Example.org', `https://${HOST}/threads/1`);
    expect(samples.pending()).toEqual([{ host: HOST, url: `https://${HOST}/threads/1`, requestedAt: '2026-11-09T10:00:00.000Z' }]);
    now = new Date('2026-11-09T10:05:00.000Z');
    samples.save(HOST, `https://${HOST}/threads/1`, 'body text=0');
    expect(samples.pending()).toEqual([]);
    expect(samples.get(HOST)).toEqual({
      host: HOST,
      url: `https://${HOST}/threads/1`,
      structure: 'body text=0',
      requestedAt: '2026-11-09T10:00:00.000Z',
      sampledAt: '2026-11-09T10:05:00.000Z',
    });
  });

  it('saves a sample nobody requested and a new request asks again', () => {
    samples.save(HOST, `https://${HOST}/`, 'body text=0');
    expect(samples.get(HOST)).toMatchObject({ structure: 'body text=0', requestedAt: '2026-11-09T10:00:00.000Z' });
    samples.request(HOST, `https://${HOST}/threads/2`);
    expect(samples.get(HOST)).toMatchObject({ url: `https://${HOST}/threads/2`, structure: null, sampledAt: null });
    expect(samples.pending().map((p) => p.host)).toEqual([HOST]);
  });
});

describe('AddRequestStore', () => {
  let db: Database.Database;
  let now: Date;
  let adds: AddRequestStore;

  beforeEach(() => {
    db = openArchive(':memory:');
    now = new Date('2026-11-10T10:00:00.000Z');
    adds = new AddRequestStore(db, () => now);
  });
  afterEach(() => db.close());

  it('records one request per host, oldest first, and keeps the first address of a host asked again', () => {
    expect(adds.request('Kappa.Example.org', `https://${HOST}/t/1`)).toEqual({ url: `https://${HOST}/t/1`, kept: false });
    now = new Date('2026-11-10T10:01:00.000Z');
    adds.request('bench.example', 'https://bench.example/');
    now = new Date('2026-11-10T10:02:00.000Z');
    // The address the page shows cannot change under the user: the agent cannot rewrite it.
    expect(adds.request(HOST, `https://${HOST}/community`)).toEqual({ url: `https://${HOST}/t/1`, kept: true });
    expect(adds.request(HOST, `https://${HOST}/t/1`)).toEqual({ url: `https://${HOST}/t/1`, kept: false });
    expect(adds.pending()).toEqual([
      { host: HOST, url: `https://${HOST}/t/1`, requestedAt: '2026-11-10T10:00:00.000Z' },
      { host: 'bench.example', url: 'https://bench.example/', requestedAt: '2026-11-10T10:01:00.000Z' },
    ]);
    expect(adds.remove('BENCH.example')).toBe(true);
    expect(adds.pending().map((r) => r.host)).toEqual([HOST]);
    expect(adds.remove('nobody.example')).toBe(false);
    expect(adds.pending()).toHaveLength(1);
    // Once removed, the host may be queued again with another address.
    adds.remove(HOST);
    expect(adds.request(HOST, `https://${HOST}/community`)).toEqual({ url: `https://${HOST}/community`, kept: false });
  });

  it(`keeps at most ${MAX_ADD_REQUESTS} hosts waiting`, () => {
    for (let i = 0; i < MAX_ADD_REQUESTS; i++) adds.request(`f${i}.example`, `https://f${i}.example/`);
    expect(() => adds.request('one-more.example', 'https://one-more.example/')).toThrow(
      expect.objectContaining({
        code: 'invalid_request',
        message: `${MAX_ADD_REQUESTS} forums are already waiting on the lurkd page. Ask the user to analyse or dismiss some of them under "Add a forum" first.`,
      }),
    );
    // A host already waiting is not refused: it keeps its first address.
    expect(adds.request('f0.example', 'https://f0.example/community')).toEqual({ url: 'https://f0.example/', kept: true });
    expect(adds.pending()).toHaveLength(MAX_ADD_REQUESTS);
  });
});

describe('ForbiddenLog (D49)', () => {
  let db: Database.Database;
  let now: Date;
  let log: ForbiddenLog;
  const entry = (host: string, sentence: string) => {
    const h = host.toLowerCase();
    return {
      host,
      name: `Forum ${h}`,
      engine: 'discourse' as const,
      baseUrl: `https://${h}`,
      loginUrl: `https://${h}/login`,
      signupUrl: `https://${h}/signup`,
      searchUrl: null,
      ruleUrl: `https://${h}/tos`,
      sentence,
    };
  };

  beforeEach(() => {
    db = openArchive(':memory:');
    now = new Date('2026-11-10T10:00:00.000Z');
    log = new ForbiddenLog(db, () => now);
  });
  afterEach(() => db.close());

  it('keeps one entry per host, newest first, and the latest clause wins', () => {
    expect(log.record(entry('Kappa.Example.org', 'You may not use bots.'))).toEqual({ ...entry(HOST, 'You may not use bots.'), host: HOST, foundAt: '2026-11-10T10:00:00.000Z' });
    now = new Date('2026-11-10T10:01:00.000Z');
    log.record(entry('bench.example', 'Scraping is prohibited.'));
    expect(log.list().map((e) => e.host)).toEqual(['bench.example', HOST]);
    now = new Date('2026-11-10T10:02:00.000Z');
    log.record({ ...entry(HOST, 'You may not automate access to the forum.'), engine: null, loginUrl: null, signupUrl: null });
    expect(log.list()).toEqual([
      { ...entry(HOST, 'You may not automate access to the forum.'), engine: null, loginUrl: null, signupUrl: null, foundAt: '2026-11-10T10:02:00.000Z' },
      { ...entry('bench.example', 'Scraping is prohibited.'), foundAt: '2026-11-10T10:01:00.000Z' },
    ]);
    expect(log.get('KAPPA.example.org')?.sentence).toBe('You may not automate access to the forum.');
    expect(log.get('nobody.example')).toBeNull();
  });

  it('removes an entry by host', () => {
    log.record(entry(HOST, 'You may not use bots.'));
    expect(log.remove('nobody.example')).toBe(false);
    expect(log.remove(HOST.toUpperCase())).toBe(true);
    expect(log.list()).toEqual([]);
  });
});
