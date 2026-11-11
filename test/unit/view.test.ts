import { describe, expect, it } from 'vitest';
import type { JobProgress } from '../../src/fetch/queue.js';
import type { DraftView } from '../../src/sources/drafts.js';
import type { SourceView } from '../../src/sources/registry.js';
import type { AnalyseOut, ForumDetection } from '../../src/sources/analyse.js';
import {
  addDraftBody,
  addFormErrors,
  analyseView,
  checkAddForm,
  describeJob,
  attentionBadges,
  DEFAULT_FILTERS,
  draftHighlights,
  engineLabel,
  engineName,
  enginesOf,
  filterRows,
  filterSources,
  forbiddenView,
  formatHash,
  isFilterHash,
  present,
  lastReadTimes,
  needsAttention,
  parseHash,
  queueSummary,
  sortRows,
  todoItems,
  topicsOf,
  groupByTopic,
  parseTopics,
  policyBadge,
  rulesPageChoices,
  safeHttpUrl,
  sessionBadge,
  signUpOffered,
  statusBadge,
  termsLinkText,
  UNKNOWN_ENGINE_TEXT,
  bulkDialogView,
  checkImportFile,
  groupRows,
  groupSwitchState,
  importResultView,
  IMPORT_MAX_BYTES,
  isSwitchable,
  selectionState,
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
  signupUrl: 'https://forum.level1techs.com/signup',
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
    // C1: imported threads have no session and no switch.
    expect(sessionBadge({ ...v, engine: 'import', session: 'disabled', loginUrl: null })).toEqual({ text: 'Imported', tone: 'neutral' });
    expect(statusBadge({ ...v, engine: 'import', status: 'untested' })).toEqual({ text: 'From saved files', tone: 'neutral' });
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

describe('signUpOffered (D47)', () => {
  it('offers Sign up when the source has a sign-up page and no session', () => {
    expect(signUpOffered({ ...v, session: 'never' })).toBe(true);
    // A switched-off source hides its session; logging in works while it is off, so signing up does too.
    expect(signUpOffered({ ...v, session: 'disabled' })).toBe(true);
  });

  it('hides it with a session, without a sign-up page, or for an address that is not http or https', () => {
    expect(signUpOffered({ ...v, session: 'logged_in' })).toBe(false);
    expect(signUpOffered({ ...v, session: 'expired' })).toBe(false);
    expect(signUpOffered({ ...v, session: 'never', signupUrl: null })).toBe(false);
    expect(signUpOffered({ ...v, session: 'never', signupUrl: 'javascript:alert(1)' })).toBe(false);
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
    expect(describeJob({ ...job, kind: 'analyse', phase: 'analyse' })).toBe('Analysing a forum address');
    expect(describeJob({ ...job, state: 'queued', phase: 'queued' })).toBe('Waiting in the queue');
    expect(describeJob({ ...job, state: 'running', phase: 'queued' })).toBe('Starting');
  });

  it('says state and message for a finished job', () => {
    expect(describeJob({ ...job, state: 'done', phase: 'done', message: '3 threads, 140 posts' })).toBe('Done: 3 threads, 140 posts');
    // D48: a read on an expired session says so on the page too.
    expect(describeJob({ ...job, state: 'done', phase: 'done', message: '1 thread read with 5 requests. Read without login: the session expired.' })).toBe(
      'Done: 1 thread read with 5 requests. Read without login: the session expired.',
    );
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

const forum: ForumDetection = {
  engine: 'discourse',
  name: 'Plant Growers',
  base_url: 'https://plants.example',
  domains: ['plants.example'],
  login_url: 'https://plants.example/login',
  search_url: null,
  signup_url: 'https://plants.example/signup',
  termsLinks: [
    { href: 'https://plants.example/guidelines', text: 'Guidelines' },
    { href: 'https://plants.example/tos', text: '' },
  ],
};

describe('Add a forum (D45)', () => {
  it('names the engines lurkd can read and says so for the others', () => {
    expect(engineLabel('discourse')).toBe('Discourse');
    expect(engineLabel('xenforo')).toBe('XenForo');
    expect(engineLabel(null)).toBe('Not recognised');
    expect(engineLabel('phpbb')).toBe('Not recognised');
    expect(UNKNOWN_ENGINE_TEXT).toBe('lurkd cannot read this engine by itself. Ask your agent to add this site: it will draft the selectors.');
  });

  it('splits topics on commas, trims them and drops empty and repeated ones', () => {
    expect(parseTopics(' gardening, indoor-plants ,, gardening ')).toEqual(['gardening', 'indoor-plants']);
    expect(parseTopics('')).toEqual([]);
    expect(parseTopics(' , ')).toEqual([]);
    // Not rewritten: the server says which one is not kebab-case.
    expect(parseTopics('Indoor Plants')).toEqual(['Indoor Plants']);
  });

  it('asks for the quote under Allowed and Forbidden and for at least one topic', () => {
    expect(checkAddForm({ policy: 'unknown', quote: '', topicsText: 'gardening' })).toEqual({});
    expect(checkAddForm({ policy: 'allowed', quote: 'Bots are welcome.', topicsText: 'gardening' })).toEqual({});
    const quote = 'Paste the sentence from the rules that says this. lurkd needs it for Allowed and Forbidden.';
    expect(checkAddForm({ policy: 'allowed', quote: '   ', topicsText: 'gardening' })).toEqual({ quote });
    expect(checkAddForm({ policy: 'forbidden', quote: '', topicsText: ' , ' })).toEqual({ quote, topics: 'Give at least one topic, for example gardening.' });
    expect(checkAddForm({ policy: 'weird', quote: '', topicsText: 'x' })).toEqual({ policy: 'Choose what the rules say about automated access.' });
  });

  it('asks for a name when the form shows the name field (M1)', () => {
    expect(checkAddForm({ policy: 'unknown', quote: '', topicsText: 'gardening', name: 'Plant Growers' })).toEqual({});
    expect(checkAddForm({ policy: 'unknown', quote: '', topicsText: 'gardening', name: '  ' })).toEqual({ name: 'Give the forum a name.' });
    expect(checkAddForm({ policy: 'unknown', quote: '', topicsText: 'gardening', name: 'x'.repeat(101) })).toEqual({ name: 'Keep the name to 100 characters or fewer.' });
  });

  it('sends the name the person checked, trimmed, instead of the detected one (M1)', () => {
    const body = addDraftBody(forum, { policy: 'unknown', quote: '', topicsText: 'gardening', ruleUrl: 'https://plants.example/tos', name: '  Plant Growers Club ' });
    expect(body.name).toBe('Plant Growers Club');
    expect(addDraftBody(forum, { policy: 'unknown', quote: '', topicsText: 'gardening', ruleUrl: 'https://plants.example/tos' }).name).toBe('Plant Growers');
    expect(addFormErrors({ message: 'm', details: { errors: ['plants-example.yaml: name must not be empty'] } })).toEqual({ fields: { name: ['name must not be empty'] }, other: [] });
    expect(addFormErrors({ message: 'name has at most 100 characters.', details: { field: 'name' } })).toEqual({ fields: { name: ['name has at most 100 characters.'] }, other: [] });
  });

  it('offers the rules links and the home page as the page the quote comes from', () => {
    expect(rulesPageChoices(forum)).toEqual([
      { value: 'https://plants.example/guidelines', text: 'Guidelines' },
      { value: 'https://plants.example/tos', text: 'https://plants.example/tos' },
      { value: 'https://plants.example', text: 'The forum home page' },
    ]);
    // D49: the page a found clause is on comes first, once.
    expect(rulesPageChoices(forum, 'https://plants.example/tos').map((c) => c.value)).toEqual([
      'https://plants.example/tos',
      'https://plants.example/guidelines',
      'https://plants.example',
    ]);
    expect(rulesPageChoices(forum, 'https://plants.example/rules')[0]).toEqual({ value: 'https://plants.example/rules', text: 'https://plants.example/rules' });
    // A link that is not http(s) is never offered.
    expect(rulesPageChoices({ ...forum, termsLinks: [{ href: 'javascript:alert(1)', text: 'Rules' }] }).map((c) => c.value)).toEqual(['https://plants.example']);
    expect(termsLinkText({ href: 'https://plants.example/tos', text: '  ' })).toBe('https://plants.example/tos');
    expect(termsLinkText({ href: 'https://plants.example/tos', text: 'Terms' })).toBe('Terms');
  });

  it('sends the detected fields and the form, nothing else', () => {
    const body = addDraftBody(forum, { policy: 'allowed', quote: ' Bots are welcome. ', topicsText: 'gardening, indoor-plants', ruleUrl: 'https://plants.example/tos' });
    expect(body).toEqual({
      engine: 'discourse',
      name: 'Plant Growers',
      base_url: 'https://plants.example',
      domains: ['plants.example'],
      login_url: 'https://plants.example/login',
      signup_url: 'https://plants.example/signup',
      search_url: null,
      topics: ['gardening', 'indoor-plants'],
      automation: { policy: 'allowed', rule_url: 'https://plants.example/tos', rule_quote: 'Bots are welcome.' },
    });
    // No quote under Unknown, and a rules page that is not http(s) falls back to the home page.
    expect(addDraftBody(forum, { policy: 'unknown', quote: '  ', topicsText: 'gardening', ruleUrl: 'javascript:x' }).automation).toEqual({
      policy: 'unknown',
      rule_url: 'https://plants.example',
      rule_quote: null,
    });
  });

  it('puts the server errors next to their field and keeps the rest together', () => {
    const out = addFormErrors({
      message: 'The draft is not valid',
      details: {
        errors: [
          'plants-example.yaml: topics[0] must be kebab-case (lowercase letters, digits, hyphens)',
          'plants-example.yaml: automation.rule_quote is required when automation.policy is forbidden',
          'plants-example.yaml: automation.rule_url host evil.example is not listed in domains',
          'plants-example.yaml: domain plants.example is already claimed by plants',
          'draft.yaml: topics must list at least one topic',
        ],
      },
    });
    expect(out).toEqual({
      fields: {
        topics: ['Use lowercase letters, digits and hyphens, for example indoor-plants.', 'Give at least one topic, for example gardening.'],
        quote: ['Paste the sentence from the rules that says this. lurkd needs it for Allowed and Forbidden.'],
        ruleUrl: ['automation.rule_url host evil.example is not listed in domains'],
      },
      other: ['domain plants.example is already claimed by plants'],
    });
  });

  it('maps a single field error and keeps any other message as it is', () => {
    expect(addFormErrors({ message: 'automation.rule_url must not carry a user name or password.', details: { field: 'automation.rule_url' } })).toEqual({
      fields: { ruleUrl: ['automation.rule_url must not carry a user name or password.'] },
      other: [],
    });
    expect(addFormErrors({ message: 'lurkd is not running. Run lurkd start in a terminal.' })).toEqual({ fields: {}, other: ['lurkd is not running. Run lurkd start in a terminal.'] });
    // details from the server are data: anything but a list of strings is ignored.
    expect(addFormErrors({ message: 'm', details: { errors: [42, { a: 1 }] } })).toEqual({ fields: {}, other: ['m'] });
  });

  it('turns each answer of the analysis into what the page shows', () => {
    const nameOf = (id: string) => (id === 'plants' ? 'Plant Growers' : undefined);
    expect(analyseView({ status: 'known', host: 'plants.example', sourceId: 'plants' }, nameOf)).toEqual({
      kind: 'known',
      sourceId: 'plants',
      name: 'Plant Growers',
      text: 'Already in lurkd as Plant Growers',
    });
    expect(analyseView({ status: 'known', host: 'x.example', sourceId: 'gone' }, nameOf)).toMatchObject({ text: 'Already in lurkd as gone' });
    const blocked: AnalyseOut = { status: 'blocked', host: 'plants.example', block: { kind: 'challenge', message: 'plants.example shows a human check.' } };
    expect(analyseView(blocked, nameOf)).toEqual({ kind: 'blocked', text: 'plants.example shows a human check.' });
    const rules = { pages: [], clause: null };
    const unknown = { policy: 'unknown' as const, rule_url: null, rule_quote: null };
    expect(analyseView({ status: 'analysed', host: 'plants.example', forum: { ...forum, engine: null }, block: null, rules, automation: unknown }, nameOf)).toEqual({
      kind: 'unknown',
      forum: { ...forum, engine: null },
      text: UNKNOWN_ENGINE_TEXT,
    });
    const login = { kind: 'login' as const, message: 'plants.example asks for a login on this page.' };
    expect(analyseView({ status: 'analysed', host: 'plants.example', forum, block: login, rules, automation: unknown }, nameOf)).toEqual({
      kind: 'form',
      forum,
      note: login.message,
      prefill: null,
    });
    expect(analyseView({ status: 'analysed', host: 'plants.example', forum, block: null, rules, automation: unknown }, nameOf)).toEqual({
      kind: 'form',
      forum,
      note: null,
      prefill: null,
    });
    // D49: a clause on a rules page starts the form at Forbidden, with the sentence and its page.
    const sentence = 'You may not automate access to the forum.';
    const found = { policy: 'forbidden' as const, rule_url: 'https://plants.example/tos', rule_quote: sentence };
    expect(
      analyseView({ status: 'analysed', host: 'plants.example', forum, block: null, rules: { pages: [], clause: { url: found.rule_url, sentence } }, automation: found }, nameOf),
    ).toEqual({
      kind: 'form',
      forum,
      note: null,
      prefill: {
        policy: 'forbidden',
        quote: sentence,
        ruleUrl: 'https://plants.example/tos',
        text: 'lurkd found this sentence on https://plants.example/tos, so Forbidden is chosen. Change the choice if the sentence does not apply.',
      },
    });
    // A prefill the page cannot trust as a link is dropped.
    expect(
      analyseView({ status: 'analysed', host: 'plants.example', forum, block: null, rules, automation: { ...found, rule_url: 'javascript:alert(1)' } as unknown as typeof found }, nameOf),
    ).toMatchObject({ prefill: null });
    // An answer the page does not know.
    expect(analyseView({ status: 'later' } as unknown as AnalyseOut, nameOf).kind).toBe('error');
    expect(analyseView(null as unknown as AnalyseOut, nameOf).kind).toBe('error');
  });
});

// ---- A7: the table, its filters, the hash and the "To do" bar ----

type Row = SourceView & { block: 'login' | 'challenge' | null; lastReadAt?: string | null };
const row = (o: Partial<Row>): Row => ({ ...v, block: null, ...o });

const rows: Row[] = [
  row({ id: 'b', name: 'Bakers Corner', topics: ['cooking'], engine: 'xenforo', policy: 'unknown', needsAcknowledgment: true, session: 'never' }),
  row({ id: 'a', name: 'alpha Forum', topics: ['gpu', 'homelab'], policy: 'allowed', session: 'logged_in' }),
  row({ id: 'c', name: 'Cellar', topics: ['cooking', 'wine'], policy: 'forbidden', enabled: false, needsAcknowledgment: true, session: 'disabled' }),
  row({ id: 'd', name: 'Dens', topics: [], engine: 'vbulletin', policy: 'unknown', session: 'expired' }),
  row({ id: 'e', name: 'Echo', topics: ['gpu'], policy: 'allowed', session: 'never', block: 'challenge' }),
];
const ids = (list: { id: string }[]) => list.map((x) => x.id);

describe('needsAttention and attentionBadges', () => {
  it('flags a warning to read on a source that is on, an expired session and a pending human check', () => {
    expect(rows.filter(needsAttention).map((x) => x.id)).toEqual(['b', 'd', 'e']);
    // A forbidden source that is off waits for "I accept" only when the person switches it on.
    expect(needsAttention(rows[2]!)).toBe(false);
    expect(needsAttention(row({ block: 'login' }))).toBe(false);
  });

  it('names each reason as a warning chip', () => {
    expect(attentionBadges(rows[0]!)).toEqual([{ text: 'Warning to read', tone: 'warn' }]);
    expect(attentionBadges(rows[4]!)).toEqual([{ text: 'Human check waiting', tone: 'warn' }]);
    expect(attentionBadges(rows[1]!)).toEqual([]);
    // The session chip already says "Session expired".
    expect(attentionBadges(rows[3]!)).toEqual([]);
  });
});

describe('filterRows', () => {
  const f = (o: Partial<typeof DEFAULT_FILTERS>) => ({ ...DEFAULT_FILTERS, ...o });

  it('keeps every row with the default filters', () => expect(ids(filterRows(rows, DEFAULT_FILTERS))).toEqual(['b', 'a', 'c', 'd', 'e']));

  it('filters by text with the rule of filterSources', () => {
    expect(ids(filterRows(rows, f({ q: 'cooking' })))).toEqual(['b', 'c']);
    expect(ids(filterRows(rows, f({ q: 'zzz' })))).toEqual([]);
  });

  it('filters by any topic of the source', () => {
    expect(ids(filterRows(rows, f({ topic: 'homelab' })))).toEqual(['a']);
    expect(ids(filterRows(rows, f({ topic: 'wine' })))).toEqual(['c']);
  });

  it('filters by state', () => {
    expect(ids(filterRows(rows, f({ state: 'on' })))).toEqual(['b', 'a', 'd', 'e']);
    expect(ids(filterRows(rows, f({ state: 'off' })))).toEqual(['c']);
    expect(ids(filterRows(rows, f({ state: 'attention' })))).toEqual(['b', 'd', 'e']);
    expect(ids(filterRows(rows, f({ state: 'logged_in' })))).toEqual(['a']);
    expect(ids(filterRows(rows, f({ state: 'warning' })))).toEqual(['b']);
    expect(ids(filterRows(rows, f({ state: 'expired' })))).toEqual(['d']);
  });

  it('filters by policy and engine, and combines every filter', () => {
    expect(ids(filterRows(rows, f({ policy: 'forbidden' })))).toEqual(['c']);
    expect(ids(filterRows(rows, f({ policy: 'unknown' })))).toEqual(['b', 'd']);
    expect(ids(filterRows(rows, f({ engine: 'xenforo' })))).toEqual(['b']);
    expect(ids(filterRows(rows, f({ topic: 'cooking', state: 'on', policy: 'unknown' })))).toEqual(['b']);
  });
});

describe('lastReadTimes and sortRows', () => {
    it('takes lastReadAt of each source, from the archive (D51), and leaves out the sources never read', () => {
    const times = lastReadTimes([
      row({ id: 'a', lastReadAt: '2026-11-10T09:00:00.000Z' }),
      row({ id: 'b', lastReadAt: null }),
      row({ id: 'c' }),
      row({ id: 'd', lastReadAt: '2026-11-01T07:00:00.000Z' }),
    ]);
    expect([...times]).toEqual([
      ['a', '2026-11-10T09:00:00.000Z'],
      ['d', '2026-11-01T07:00:00.000Z'],
    ]);
  });

  it('sorts by name, by first topic or by last read, without changing the input', () => {
    expect(ids(sortRows(rows, 'name', new Map()))).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Sources without a topic go last; ties fall back to the name.
    expect(ids(sortRows(rows, 'topic', new Map()))).toEqual(['b', 'c', 'a', 'e', 'd']);
    const times = new Map([
      ['c', '2026-11-10T07:00:00.000Z'],
      ['e', '2026-11-10T09:00:00.000Z'],
    ]);
    // The latest read first; never read last, by name.
    expect(ids(sortRows(rows, 'last_read', times))).toEqual(['e', 'c', 'a', 'b', 'd']);
    expect(ids(rows)).toEqual(['b', 'a', 'c', 'd', 'e']);
  });
});

describe('parseHash and formatHash', () => {
  it('writes nothing for the default filters and only the changed ones otherwise', () => {
    expect(formatHash(DEFAULT_FILTERS)).toBe('');
    expect(formatHash({ ...DEFAULT_FILTERS, state: 'on', topic: 'gpu' })).toBe('topic=gpu&state=on');
    expect(formatHash({ ...DEFAULT_FILTERS, q: 'b12 levels', sort: 'last_read' })).toBe('q=b12+levels&sort=last_read');
    // D51: the grouping of the table is kept in the hash too.
    expect(formatHash({ ...DEFAULT_FILTERS, group: 'topic' })).toBe('group=topic');
    expect(formatHash({ ...DEFAULT_FILTERS, state: 'on', group: 'custom' })).toBe('state=on&group=custom');
  });

  it('reads back what it wrote', () => {
    const all = { q: 'a&b=c #x', topic: 'indoor-plants', state: 'attention', policy: 'forbidden', engine: 'xenforo', sort: 'topic', group: 'custom' } as const;
    expect(parseHash(`#${formatHash(all)}`)).toEqual(all);
    expect(parseHash(formatHash(all))).toEqual(all);
  });

  it('falls back to the default for a missing, unknown or oversized value', () => {
    expect(parseHash('')).toEqual(DEFAULT_FILTERS);
    expect(parseHash('#h-drafts')).toEqual(DEFAULT_FILTERS);
    expect(parseHash('#state=weird&policy=maybe&sort=random&extra=1')).toEqual(DEFAULT_FILTERS);
    expect(parseHash(`#topic=${'x'.repeat(300)}`).topic).toBe('');
    expect(parseHash('#state=expired').state).toBe('expired');
    expect(parseHash('#group=topic').group).toBe('topic');
    expect(parseHash('#group=none').group).toBe('none');
    expect(parseHash('#group=weird').group).toBe(DEFAULT_FILTERS.group);
  });
});

describe('topicsOf, enginesOf and engineName', () => {
  it('lists each topic and engine once, sorted', () => {
    expect(topicsOf(rows)).toEqual(['cooking', 'gpu', 'homelab', 'wine']);
    expect(enginesOf(rows)).toEqual(['discourse', 'vbulletin', 'xenforo']);
  });

  it('names every engine of the schema', () => {
    expect(['discourse', 'xenforo', 'phpbb', 'vbulletin', 'generic', 'custom'].map(engineName)).toEqual(['Discourse', 'XenForo', 'phpBB', 'vBulletin', 'Generic', 'Custom']);
    expect(engineName('later')).toBe('later');
    // C1: the built-in source of imported threads.
    expect(engineName('import')).toBe('Saved files');
  });
});

describe('todoItems', () => {
  const empty = { sources: [] as Row[], drafts: [] as DraftView[], samplesPending: [], addRequests: [], forbidden: [], registryErrors: [] as string[] };
  const at = { host: 'x.example', url: 'https://x.example/', requestedAt: 'x' };

  it('is empty when nothing needs the person', () => expect(todoItems({ ...empty, sources: [rows[1]!] })).toEqual([]));

  it('counts source files, not error lines', () => {
    const errors = ['user/bad.yaml: name is required', 'user/bad.yaml: topics must list at least one topic', 'seed/x.yaml: cannot read the file: EACCES', 'a line without a file'];
    expect(todoItems({ ...empty, registryErrors: errors })).toEqual([{ key: 'errors', label: 'Source files with problems', count: 3, panel: 'errors' }]);
  });

  it('counts each kind of work, in a fixed order, and says where it leads', () => {
    const out = todoItems({
      sources: rows,
      drafts: [draft, { ...draft, id: 2 }],
      samplesPending: [at],
      addRequests: [at, at, at],
      forbidden: [{ host: 'f.example' }],
      registryErrors: ['bad.yaml: name is required'],
    });
    expect(out).toEqual([
      { key: 'drafts', label: 'Drafts to approve', count: 2, panel: 'drafts' },
      { key: 'warnings', label: 'Warnings to read', count: 1, filter: 'warning' },
      { key: 'expired', label: 'Sessions expired', count: 1, filter: 'expired' },
      { key: 'samples', label: 'Sites waiting for a sample', count: 1, panel: 'samples' },
      { key: 'add', label: 'Add requests from your agent', count: 3, panel: 'add' },
      { key: 'forbidden', label: 'Forums that forbid automated access', count: 1, panel: 'forbidden' },
      { key: 'errors', label: 'Source files with problems', count: 1, panel: 'errors' },
    ]);
  });
});

describe('queueSummary', () => {
  it('says what runs and how many wait', () => {
    expect(queueSummary([])).toEqual({ running: null, waiting: 0, text: 'Queue empty' });
    const running = { ...job, phase: 'thread' as const };
    expect(queueSummary([{ ...job, state: 'done', phase: 'done' }, running, { ...job, jobId: 'q', state: 'queued' }])).toEqual({
      running,
      waiting: 1,
      text: '1 job running, 1 waiting',
    });
    expect(queueSummary([{ ...job, state: 'queued' }, { ...job, state: 'queued' }]).text).toBe('2 jobs waiting');
  });
});

describe('forbiddenView (D49)', () => {
  const entry = { host: 'plants.example', name: 'Plant Growers', engine: 'discourse', baseUrl: 'https://plants.example', ruleUrl: 'https://plants.example/tos', sentence: 'You may not automate access.', foundAt: '2026-11-10T08:00:00.000Z', sourceId: null };
  const nameOf = (id: string) => (id === 'plants' ? 'Plant Growers' : undefined);

  it('offers Add anyway for an engine lurkd reads', () => {
    expect(forbiddenView(entry, nameOf)).toEqual({ kind: 'form', ruleUrl: 'https://plants.example/tos' });
    expect(forbiddenView({ ...entry, engine: 'xenforo', ruleUrl: 'javascript:alert(1)' }, nameOf)).toEqual({ kind: 'form', ruleUrl: null });
  });

  it('points to the source that claims the host by now', () =>
    expect(forbiddenView({ ...entry, sourceId: 'plants' }, nameOf)).toEqual({ kind: 'known', sourceId: 'plants', name: 'Plant Growers', ruleUrl: 'https://plants.example/tos' }));

  it('says lurkd cannot read an unknown engine', () =>
    expect(forbiddenView({ ...entry, engine: null }, nameOf)).toEqual({ kind: 'unknown', text: UNKNOWN_ENGINE_TEXT, ruleUrl: 'https://plants.example/tos' }));
});

describe('present', () => {
  it('drops null, undefined and false, flattens one level and keeps every other child in order', () => {
    expect(present(['a', null, 0, undefined, false, '', ['b', null, 'c'], 'd'])).toEqual(['a', 0, '', 'b', 'c', 'd']);
    expect(present([null, null])).toEqual([]);
    expect(present([])).toEqual([]);
  });
});

describe('isFilterHash', () => {
  it('takes an empty hash or one with key=value pairs as filters, and leaves an anchor alone', () => {
    expect(isFilterHash('')).toBe(true);
    expect(isFilterHash('#')).toBe(true);
    expect(isFilterHash('#state=off&engine=xenforo')).toBe(true);
    expect(isFilterHash('q=b12')).toBe(true);
    expect(isFilterHash('#source-lg')).toBe(false);
    expect(isFilterHash('#h-drafts')).toBe(false);
  });
});

// ---- D51: groups, the tri-state switch, the selection and the bulk dialog ----

describe('groupRows (D51)', () => {
  const g = (id: number, name: string, sourceIds: string[]) => ({ id, name, sourceIds });

  it('keeps every row in one unnamed block without grouping', () => {
    expect(groupRows(rows, 'none', []).map((x) => [x.key, x.label, ids(x.rows)])).toEqual([['all', '', ['b', 'a', 'c', 'd', 'e']]]);
  });

  it('groups by the first topic only, sorted by topic, rows in their order, and no topic last', () => {
    const out = groupRows(rows, 'topic', []);
    expect(out.map((x) => [x.key, x.label, x.kind, ids(x.rows)])).toEqual([
      ['topic:cooking', 'cooking', 'topic', ['b', 'c']],
      ['topic:gpu', 'gpu', 'topic', ['a', 'e']],
      ['topic:', 'No topic', 'ungrouped', ['d']],
    ]);
    // Each source shows once, under its first topic; "wine" and "homelab" get no group of their own.
    expect(out.flatMap((x) => ids(x.rows)).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('groups by custom group, a source in several groups under each, the others under "Not in a group"', () => {
    const out = groupRows(rows, 'custom', [g(2, 'Food', ['c', 'b']), g(1, 'Graphics', ['e', 'b', 'gone']), g(3, 'Empty', [])]);
    expect(out.map((x) => [x.key, x.label, x.kind, x.groupId, ids(x.rows)])).toEqual([
      ['group:2', 'Food', 'custom', 2, ['b', 'c']],
      ['group:1', 'Graphics', 'custom', 1, ['b', 'e']],
      ['group:none', 'Not in a group', 'ungrouped', null, ['a', 'd']],
    ]);
    // Empty groups show when asked, in their place.
    expect(groupRows(rows, 'custom', [g(2, 'Food', ['c']), g(3, 'Empty', [])], { includeEmpty: true }).map((x) => x.label)).toEqual(['Food', 'Empty', 'Not in a group']);
    // A group whose members the filters hide shows only when asked.
    expect(groupRows([rows[1]!], 'custom', [g(2, 'Food', ['c'])]).map((x) => x.label)).toEqual(['Not in a group']);
  });
});

describe('groupSwitchState and isSwitchable (D51)', () => {
  it('counts the sources that are on among those that can be switched, and says on, off or mixed', () => {
    expect(groupSwitchState([row({ enabled: true }), row({ enabled: true })])).toEqual({ on: 2, total: 2, state: 'on' });
    expect(groupSwitchState([row({ enabled: false }), row({ enabled: false })])).toEqual({ on: 0, total: 2, state: 'off' });
    expect(groupSwitchState([row({ enabled: true }), row({ enabled: false })])).toEqual({ on: 1, total: 2, state: 'mixed' });
    // The source of imported threads has no switch, so it does not count.
    expect(groupSwitchState([row({ enabled: true }), row({ engine: 'import', enabled: false })])).toEqual({ on: 1, total: 1, state: 'on' });
    expect(groupSwitchState([row({ engine: 'import', enabled: false })])).toEqual({ on: 0, total: 0, state: 'none' });
    expect(groupSwitchState([])).toEqual({ on: 0, total: 0, state: 'none' });
    expect([isSwitchable(row({})), isSwitchable(row({ engine: 'import' }))]).toEqual([true, false]);
  });

  it('says whether all, some or none of a list is selected', () => {
    const sel = new Set(['a', 'b']);
    expect(selectionState(['a', 'b'], sel)).toBe('all');
    expect(selectionState(['a', 'c'], sel)).toBe('some');
    expect(selectionState(['c'], sel)).toBe('none');
    expect(selectionState([], sel)).toBe('none');
  });
});

describe('bulkDialogView (D51)', () => {
  const answer = (o: Record<string, unknown> = {}) => ({
    enabled: [],
    alreadyOn: [],
    needsAcknowledgment: [],
    forbidden: [],
    notSwitchable: [],
    acknowledgment: null,
    ...o,
  });
  const uk = { id: 'uk', name: 'Unknown Forum', policy: 'unknown', ruleUrl: 'https://uk.example/tos', ruleQuote: 'Be kind.' };
  const uk2 = { id: 'uk2', name: 'Quiet Forum', policy: 'unknown', ruleUrl: 'javascript:alert(1)', ruleQuote: null };
  const fb = { id: 'fb', name: 'Strict Forum', ruleUrl: 'https://fb.example/rules', ruleQuote: 'No bots.' };

  it('needs no dialog when everything went on', () => {
    const d = bulkDialogView(answer({ enabled: ['a', 'b'] }));
    expect([d.dialog, d.notice, d.accept]).toEqual([false, 'Switched on 2 sources.', null]);
    expect(bulkDialogView(answer({ alreadyOn: ['a'] })).notice).toBe('Every source you chose was on already.');
    expect(bulkDialogView(answer({ notSwitchable: ['reddit-import'] })).notice).toBe(null);
  });

  it('lists each unknown source with its rule line and link, and accepts for exactly that many', () => {
    const d = bulkDialogView(answer({ enabled: ['a'], needsAcknowledgment: [uk, uk2], acknowledgment: { token: 't', ids: ['uk', 'uk2'] } }));
    expect(d.dialog).toBe(true);
    expect(d.title).toBe('Switch on 2 sources whose rules say nothing about automation?');
    expect(d.accept).toBe('I accept for these 2');
    expect(d.needs).toEqual([
      { id: 'uk', name: 'Unknown Forum', quote: 'Be kind.', ruleUrl: 'https://uk.example/tos' },
      { id: 'uk2', name: 'Quiet Forum', quote: 'The rules page has no line that lurkd could quote.', ruleUrl: null },
    ]);
    expect(d.before).toEqual(['Switched on 1 source now: its rules allow automated access, or you accepted it before.']);
    expect(d.forbidden).toEqual([]);
    expect(bulkDialogView(answer({ needsAcknowledgment: [uk], acknowledgment: { token: 't', ids: ['uk'] } })).accept).toBe('I accept for this one');
  });

  it('names the forbidden sources and offers no way to accept them', () => {
    const d = bulkDialogView(answer({ forbidden: [fb] }));
    expect([d.dialog, d.accept, d.title]).toEqual([true, null, 'Strict Forum stays off']);
    expect(d.forbidden).toEqual([{ id: 'fb', name: 'Strict Forum', ruleUrl: 'https://fb.example/rules' }]);
    expect(d.forbiddenText).toBe('This source stays off: its rules forbid automated access, so lurkd never switches it on together with others. Switch it on from its own row, after reading its warning.');
    const two = bulkDialogView(answer({ forbidden: [fb, { ...fb, id: 'fb2', name: 'Other' }], needsAcknowledgment: [uk], acknowledgment: { token: 't', ids: ['uk'] } }));
    expect(two.accept).toBe('I accept for this one');
    expect(two.forbiddenText).toBe('These sources stay off: their rules forbid automated access, so lurkd never switches them on together with others. Switch each one on from its own row, after reading its warning.');
  });

  it('accepts only when the server sent the list to accept', () => {
    expect(bulkDialogView(answer({ needsAcknowledgment: [uk], acknowledgment: null })).accept).toBe(null);
  });
});

describe('importResultView and checkImportFile (C1, D50)', () => {
  const out = {
    source: 'reddit-import',
    threadId: 3,
    url: 'https://www.reddit.com/comments/1k2m3n4/',
    title: 'Zigbee coordinator drops',
    posts: 8,
    comments: 7,
    notKept: 0,
    notInFile: 11,
    replaced: false,
    replacedImportAt: null,
    importedBy: 'page upload',
    importedAt: '2026-11-10T09:00:00.000Z',
  };

  it('says what was imported, what the file did not hold and what was not kept', () => {
    expect(importResultView(out)).toEqual({
      heading: 'Thread imported',
      title: 'Zigbee coordinator drops',
      lines: ['8 posts: the post and 7 comments.', '11 more comments were not in the saved file.', 'Your agent finds it with archive.search, or reads it with source.fetch and the thread address.'],
    });
    const big = importResultView({ ...out, posts: 20001, comments: 20000, notKept: 130000, notInFile: 1 });
    expect(big.lines.slice(0, 3)).toEqual([
      '20,001 posts: the post and 20,000 comments.',
      '1 more comment was not in the saved file.',
      '130,000 more comments in the file were not kept: lurkd keeps the first 20,000 comments of a thread.',
    ]);
  });

  it('names the date of the import it replaced', () => {
    const r = importResultView({ ...out, replaced: true, replacedImportAt: '2026-11-09T08:15:00.000Z', notInFile: 0 });
    expect(r.heading).toBe('Thread imported again');
    expect(r.lines).toContain('It replaced the import of 9 Nov 2026, 08:15 UTC.');
    expect(importResultView({ ...out, replaced: true, replacedImportAt: null }).lines).toContain('It replaced an earlier import of this thread.');
  });

  it('checks the file before it is read: present, not empty, at most 20 MB', () => {
    expect(checkImportFile(null)).toBe('Choose the saved thread file first.');
    expect(checkImportFile({ size: 0 })).toBe('This file is empty.');
    expect(checkImportFile({ size: IMPORT_MAX_BYTES + 1 })).toBe('This file is larger than 20 MB. A saved Reddit thread is much smaller: check that you chose the right file.');
    expect(checkImportFile({ size: IMPORT_MAX_BYTES })).toBe(null);
  });
});
