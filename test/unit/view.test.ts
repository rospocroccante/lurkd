import { describe, expect, it } from 'vitest';
import type { JobProgress } from '../../src/fetch/queue.js';
import type { DraftView } from '../../src/sources/drafts.js';
import type { SourceView } from '../../src/sources/registry.js';
import {
  describeJob,
  draftHighlights,
  filterSources,
  groupByTopic,
  policyBadge,
  safeHttpUrl,
  sessionBadge,
  statusBadge,
} from '../../ui/view.js';

const v: SourceView = {
  id: 'level1techs',
  name: 'Level1Techs',
  description: 'Hardware and homelab talk',
  topics: ['gpu', 'homelab'],
  engine: 'discourse',
  status: 'untested',
  policy: 'allowed',
  ruleUrl: 'https://forum.level1techs.com/faq',
  ruleQuote: null,
  domains: ['forum.level1techs.com'],
  loginUrl: 'https://forum.level1techs.com/login',
  enabled: true,
  needsAcknowledgment: false,
  session: 'logged_in',
  showRealNames: false,
  allowBeacons: false,
  searchSupported: true,
  seed: true,
};

const job: JobProgress = {
  jobId: 'j1',
  sourceId: 'level1techs',
  kind: 'fetch',
  state: 'running',
  phase: 'queued',
  threadIndex: 0,
  threadCount: 0,
  postsFetched: 0,
  requestsUsed: 0,
  requestCap: 0,
  message: null,
  queuedAt: '2026-11-09T10:00:00.000Z',
  startedAt: null,
  endedAt: null,
};

const draft: DraftView = {
  id: 1,
  sourceId: 'new-forum',
  host: 'forum.example',
  yaml: 'id: new-forum\n',
  warnings: [],
  state: 'pending',
  createdAt: '2026-11-09T10:00:00.000Z',
};

describe('badges', () => {
  it('maps session, status and policy badges', () => {
    expect(sessionBadge({ ...v, session: 'never', loginUrl: null })).toEqual({ text: 'No login needed', tone: 'neutral' });
    expect(sessionBadge({ ...v, session: 'never' })).toEqual({ text: 'Not logged in', tone: 'neutral' });
    expect(sessionBadge({ ...v, session: 'logged_in' })).toEqual({ text: 'Logged in', tone: 'ok' });
    expect(sessionBadge({ ...v, session: 'expired' })).toEqual({ text: 'Session expired', tone: 'warn' });
    expect(sessionBadge({ ...v, session: 'disabled' })).toEqual({ text: 'Switched off', tone: 'off' });
    expect(statusBadge({ ...v, status: 'public_read' }).text).toBe('Checked on public pages');
    expect(statusBadge({ ...v, status: 'verified' }).text).toBe('Verified with an account');
    expect(statusBadge({ ...v, status: 'untested' }).text).toBe('Untested');
    expect(policyBadge({ ...v, policy: 'forbidden' })).toEqual({ text: 'Automation forbidden', tone: 'off' });
    expect(policyBadge({ ...v, policy: 'allowed' })).toEqual({ text: 'Automation allowed', tone: 'ok' });
    expect(policyBadge({ ...v, policy: 'unknown' })).toEqual({ text: 'Rules silent on automation', tone: 'warn' });
  });

  it('does not trust a value the server did not promise', () => {
    // @ts-expect-error a value outside the union
    expect(statusBadge({ ...v, status: 'weird' }).text).toBe('Untested');
    // @ts-expect-error a value outside the union
    expect(policyBadge({ ...v, policy: 'weird' }).tone).toBe('warn');
  });
});

describe('filterSources', () => {
  const views: SourceView[] = [
    v,
    { ...v, id: 'servethehome', name: 'ServeTheHome', description: null, topics: ['gpu', 'servers'], domains: ['forums.servethehome.com'] },
    { ...v, id: 'bakers', name: 'Bakers Corner', description: 'Bread talk', topics: ['cooking'], domains: ['bakers.example'] },
  ];

  it('filters sources by topic and name', () => {
    expect(filterSources(views, 'gpu').map((s) => s.id)).toEqual(['level1techs', 'servethehome']);
    expect(filterSources(views, 'bread').map((s) => s.id)).toEqual(['bakers']);
    expect(filterSources(views, 'BAKERS corner').map((s) => s.id)).toEqual(['bakers']);
    expect(filterSources(views, 'gpu servers').map((s) => s.id)).toEqual(['servethehome']);
    expect(filterSources(views, 'zzz')).toEqual([]);
  });

  it('keeps everything for an empty or blank query', () => {
    expect(filterSources(views, '')).toHaveLength(3);
    expect(filterSources(views, '   ')).toHaveLength(3);
  });
});

describe('groupByTopic', () => {
  it('groups by first topic in input order and puts topic-less sources last', () => {
    const groups = groupByTopic([
      { ...v, id: 'a', topics: ['cooking'] },
      { ...v, id: 'b', topics: ['gpu', 'cooking'] },
      { ...v, id: 'c', topics: ['cooking'] },
      { ...v, id: 'd', topics: [] },
    ]);
    expect(groups.map((g) => [g.topic, g.sources.map((s) => s.id)])).toEqual([
      ['cooking', ['a', 'c']],
      ['gpu', ['b']],
      ['Other', ['d']],
    ]);
  });
});

describe('describeJob', () => {
  it('describes a running job', () =>
    expect(describeJob({ ...job, phase: 'thread', threadIndex: 2, threadCount: 3, postsFetched: 140, requestsUsed: 9, requestCap: 60 })).toBe(
      'Reading thread 2 of 3, 140 posts, 9 of 60 requests',
    ));

  it('describes the other phases', () => {
    expect(describeJob({ ...job, phase: 'search' })).toBe('Searching level1techs');
    expect(describeJob({ ...job, phase: 'search' }, (id) => (id === 'level1techs' ? 'Level1Techs' : id))).toBe('Searching Level1Techs');
    expect(describeJob({ ...job, phase: 'search', sourceId: 'gone' }, (id) => (id === 'level1techs' ? 'Level1Techs' : id))).toBe('Searching gone');
    expect(describeJob({ ...job, kind: 'session', phase: 'session' })).toBe('Checking the session');
    expect(describeJob({ ...job, kind: 'signals', phase: 'signals' })).toBe('Looking up an author');
    expect(describeJob({ ...job, kind: 'sample', phase: 'sample' })).toBe('Sampling a page');
    expect(describeJob({ ...job, state: 'queued', phase: 'queued' })).toBe('Waiting in the queue');
    expect(describeJob({ ...job, state: 'running', phase: 'queued' })).toBe('Starting');
  });

  it('says state and message for a finished job', () => {
    expect(describeJob({ ...job, state: 'done', phase: 'done', message: '3 threads, 140 posts' })).toBe('Done: 3 threads, 140 posts');
    expect(describeJob({ ...job, state: 'failed', phase: 'done', message: 'The page did not answer' })).toBe('Failed: The page did not answer');
    expect(describeJob({ ...job, state: 'stopped', phase: 'done', message: null })).toBe('Stopped');
  });

  it('says in plain words what the user has to do, not the text written for the agent', () => {
    const name = (id: string) => (id === 'level1techs' ? 'Level1Techs' : id);
    const login = 'Error needs_login: Ask the user to open the lurkd page and press "Log in" next to level1techs. Do not retry until they say it is done.';
    expect(describeJob({ ...job, state: 'failed', phase: 'done', message: login }, name)).toBe('Failed: login needed for Level1Techs');
    expect(describeJob({ ...job, state: 'stopped', phase: 'done', message: login }, name)).toBe('Stopped: login needed for Level1Techs');
    expect(describeJob({ ...job, state: 'failed', phase: 'done', message: 'Error challenge: The site showed a human check. Do not retry.' }, name)).toBe(
      'Failed: human check needed for Level1Techs',
    );
    expect(describeJob({ ...job, state: 'failed', phase: 'done', message: 'Error needs_acknowledgment: Ask the user to read the warning.' }, name)).toBe(
      'Failed: Level1Techs needs its warning accepted first',
    );
    expect(describeJob({ ...job, state: 'failed', phase: 'done', message: 'Error disabled: Ask the user to switch it on.' })).toBe('Failed: level1techs is switched off');
    // Any other code keeps the formatted line.
    expect(describeJob({ ...job, state: 'failed', phase: 'done', message: 'Error timeout: http://f.example did not load within 45 s.' }, name)).toBe(
      'Failed: Error timeout: http://f.example did not load within 45 s.',
    );
  });
});

describe('draftHighlights', () => {
  it('puts POST endpoints first in draft highlights', () => {
    const out = draftHighlights({
      ...draft,
      warnings: ['domains: forum.example', 'login_url: https://forum.example/login', 'POST /search/run*: search form, read-only'],
    });
    expect(out[0]!.startsWith('POST ')).toBe(true);
    expect(out).toHaveLength(3);
  });

  it('reads read_endpoints from the YAML when the warnings lack them', () => {
    const yaml = ['id: x', 'read_endpoints:', '  - method: POST', '    path: /search/run*', '    note: search form', 'rate_limit: { min_delay_s: 2 }'].join('\n');
    const out = draftHighlights({ ...draft, yaml, warnings: ['domains: forum.example'] });
    expect(out[0]).toBe('POST /search/run*: search form');
    expect(out[1]).toBe('domains: forum.example');
  });

  it('does not repeat an endpoint the warnings already list', () => {
    const yaml = 'read_endpoints:\n  - method: POST\n    path: /a\n    note: n\n';
    expect(draftHighlights({ ...draft, yaml, warnings: ['POST /a: n'] })).toEqual(['POST /a: n']);
  });

  it('returns an empty list for a draft with nothing to show', () => expect(draftHighlights(draft)).toEqual([]));
});

describe('safeHttpUrl', () => {
  it('returns http and https addresses only', () => {
    expect(safeHttpUrl('https://forum.example/rules#bots')).toBe('https://forum.example/rules#bots');
    expect(safeHttpUrl('http://forum.example/')).toBe('http://forum.example/');
    for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '//evil.example', '/relative', '', 'not a url']) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
  });

  it('drops credentials', () => expect(safeHttpUrl('https://user:pw@forum.example/x')).toBeNull());
});
