import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { parseSource } from '../../src/sources/schema.js';
import { fixture, range, testSource } from '../helpers/common.js';

const base = {
  id: 'forum-example', name: 'Example', status: 'untested', topics: ['hardware'], engine: 'discourse',
  base_url: 'https://forum.example.org', domains: ['forum.example.org'], login_url: 'https://forum.example.org/login',
  automation: { policy: 'unknown', rule_url: 'https://forum.example.org/tos', rule_quote: null, checked_at: '2026-11-08' },
};
const parse = (o: object, file = 'forum-example.yaml') => parseSource(YAML.stringify(o), { file });
const errorsOf = (o: object, file = 'forum-example.yaml'): string[] => {
  const r = parse(o, file);
  if (r.ok) throw new Error('expected the source to be refused');
  return r.errors;
};

describe('parseSource defaults', () => {
  it('fills the defaults', () => {
    const r = parse(base); if (!r.ok) throw new Error(r.errors.join());
    expect(r.source.rate_limit).toEqual({ min_delay_s: 2, max_requests_per_run: 60, max_requests_per_day: 300 });
    expect(r.source.pagination.max_pages_per_thread).toBe(20);
    expect(r.source.author_signals.profile_lookup).toBe(true);
    expect([r.source.enabled, r.source.show_real_names, r.source.allow_beacons]).toEqual([true, false, false]);
  });

  it('fills null and empty defaults for the optional fields', () => {
    const { login_url: _, status: __, ...bare } = base;
    const r = parse(bare); if (!r.ok) throw new Error(r.errors.join());
    expect(r.source).toMatchObject({ description: null, status: 'untested', login_url: null, signup_url: null, search_url: null, read_endpoints: [], session_check: null, selectors: null, deny_paths: [] });
  });

  it('defaults profile_lookup to false for generic and custom', () => {
    const g = parse({ ...base, engine: 'generic' });
    const c = parse({ ...base, engine: 'custom', selectors: { post: 'article.post', author: '.author' } });
    const x = parse({ ...base, engine: 'xenforo' });
    const p = parse({ ...base, engine: 'phpbb' });
    expect([g, c, x, p].map((r) => (r.ok ? r.source.author_signals.profile_lookup : r.errors))).toEqual([false, false, true, false]);
    const off = parse({ ...base, author_signals: { profile_lookup: false } });
    expect(off.ok && off.source.author_signals.profile_lookup).toBe(false);
  });
});

describe('parseSource policy rules', () => {
  it('rejects a forbidden source that ships enabled', () =>
    expect(parse({ ...base, automation: { ...base.automation, policy: 'forbidden', rule_quote: 'No bots.' } })).toMatchObject({ ok: false, errors: [expect.stringContaining('forbidden requires enabled: false')] }));

  it('accepts a forbidden source that ships disabled', () =>
    expect(parse({ ...base, enabled: false, automation: { ...base.automation, policy: 'forbidden', rule_quote: 'No bots.' } }).ok).toBe(true));

  it('requires rule_quote for allowed and forbidden', () => {
    expect(errorsOf({ ...base, automation: { ...base.automation, policy: 'allowed' } })).toEqual([
      'forum-example.yaml: automation.rule_quote is required when automation.policy is allowed',
    ]);
    expect(errorsOf({ ...base, enabled: false, automation: { ...base.automation, policy: 'forbidden', rule_quote: '  ' } })).toEqual([
      'forum-example.yaml: automation.rule_quote is required when automation.policy is forbidden',
    ]);
    expect(parse({ ...base, automation: { ...base.automation, policy: 'allowed', rule_quote: 'Bots may read.' } }).ok).toBe(true);
  });

  it('never marks a forbidden source public_read', () =>
    expect(errorsOf({ ...base, status: 'public_read', enabled: false, automation: { ...base.automation, policy: 'forbidden', rule_quote: 'No bots.' } })).toEqual([
      'forum-example.yaml: status public_read is not allowed when automation.policy is forbidden',
    ]));

  it('checks checked_at as a real YYYY-MM-DD date', () => {
    for (const d of ['08/11/2026', '2026-02-30', '2026-11-8'])
      expect(errorsOf({ ...base, automation: { ...base.automation, checked_at: d } }), d).toEqual([
        'forum-example.yaml: automation.checked_at must be a date written YYYY-MM-DD',
      ]);
  });
});

describe('parseSource ids and files', () => {
  it('rejects an id that differs from the file name', () => {
    expect(parse(base, 'other.yaml').ok).toBe(false);
    expect(errorsOf(base, 'other.yaml')).toEqual(['other.yaml: id "forum-example" must equal the file name "other"']);
  });

  it('compares only the basename of a root-relative path and prefixes it once (P5)', () => {
    expect(parse(base, 'hardware/forum-example.yaml').ok).toBe(true);
    expect(errorsOf(base, 'hardware/other.yaml')).toEqual(['hardware/other.yaml: id "forum-example" must equal the file name "other"']);
  });

  it('checks the id format', () =>
    expect(errorsOf({ ...base, id: 'Forum_Example' }, 'Forum_Example.yaml')).toEqual([
      'Forum_Example.yaml: id must be 2 to 63 lowercase letters, digits or hyphens, starting with a letter or digit',
    ]));
});

describe('parseSource hosts and URLs', () => {
  it('rejects a login_url outside domains', () =>
    expect(errorsOf({ ...base, login_url: 'https://evil.example/login' })).toEqual([
      'forum-example.yaml: login_url host evil.example is not listed in domains',
    ]));

  it('checks every URL host against domains, exactly', () =>
    expect(errorsOf({
      ...base,
      base_url: 'https://www.forum.example.org',
      search_url: 'https://evil-forum.example.org/search?q={query}',
      session_check: { url: 'https://forum.example.org.evil.example/me', logged_in_selector: 'a.logout' },
    })).toEqual([
      'forum-example.yaml: base_url host www.forum.example.org is not listed in domains',
      'forum-example.yaml: search_url host evil-forum.example.org is not listed in domains',
      'forum-example.yaml: session_check.url host forum.example.org.evil.example is not listed in domains',
    ]));

  it('requires https, except on 127.0.0.1 and localhost', () => {
    expect(errorsOf({ ...base, base_url: 'http://forum.example.org' })).toEqual([
      'forum-example.yaml: base_url must use https (http only for 127.0.0.1 and localhost)',
    ]);
    expect(parse({ ...base, base_url: 'http://127.0.0.1:4100', domains: ['127.0.0.1'], login_url: null }).ok).toBe(true);
    expect(parse({ ...base, base_url: 'http://localhost:4100/forum', domains: ['localhost'], login_url: 'http://localhost:4100/login' }).ok).toBe(true);
    expect(errorsOf({ ...base, base_url: 'forum.example.org' })).toEqual(['forum-example.yaml: base_url must be an absolute URL']);
  });

  it('accepts a signup_url on one of the domains (D47)', () => {
    const r = parse({ ...base, signup_url: 'https://forum.example.org/signup' });
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.source.signup_url).toBe('https://forum.example.org/signup');
    const nulled = parse({ ...base, signup_url: null });
    expect(nulled.ok && nulled.source.signup_url).toBeNull();
  });

  it('checks signup_url like the other URLs: absolute, https, host in domains', () => {
    expect(errorsOf({ ...base, signup_url: 'https://evil.example/signup' })).toEqual([
      'forum-example.yaml: signup_url host evil.example is not listed in domains',
    ]);
    expect(errorsOf({ ...base, signup_url: 'https://www.forum.example.org/signup' })).toEqual([
      'forum-example.yaml: signup_url host www.forum.example.org is not listed in domains',
    ]);
    expect(errorsOf({ ...base, signup_url: 'http://forum.example.org/signup' })).toEqual([
      'forum-example.yaml: signup_url must use https (http only for 127.0.0.1 and localhost)',
    ]);
    expect(errorsOf({ ...base, signup_url: '/signup' })).toEqual(['forum-example.yaml: signup_url must be an absolute URL']);
    expect(errorsOf({ ...base, signup_url: 'javascript:alert(1)' })).toContain(
      'forum-example.yaml: signup_url must use https (http only for 127.0.0.1 and localhost)',
    );
    expect(errorsOf({ ...base, signup_url: 42 })).toEqual(['forum-example.yaml: signup_url must be a string']);
  });

  it('requires {query} in search_url', () =>
    expect(errorsOf({ ...base, search_url: 'https://forum.example.org/search' })).toEqual([
      'forum-example.yaml: search_url must contain {query}',
    ]));

  it('accepts only bare lowercase hostnames in domains', () =>
    expect(errorsOf({ ...base, domains: ['forum.example.org', 'https://forum.example.org', 'forum.example.org/x', '*.example.org', 'Forum.Example.org', 'forum.example.org:443'] })).toEqual([
      'forum-example.yaml: domains[1] must be a bare lowercase hostname, without scheme, port, path or wildcard',
      'forum-example.yaml: domains[2] must be a bare lowercase hostname, without scheme, port, path or wildcard',
      'forum-example.yaml: domains[3] must be a bare lowercase hostname, without scheme, port, path or wildcard',
      'forum-example.yaml: domains[4] must be a bare lowercase hostname, without scheme, port, path or wildcard',
      'forum-example.yaml: domains[5] must be a bare lowercase hostname, without scheme, port, path or wildcard',
    ]));
});

describe('parseSource read endpoints, selectors and deny rules', () => {
  it('rejects read_endpoints that look like writes', () => {
    const errs = errorsOf({ ...base, read_endpoints: [{ method: 'POST', path: '/posts/1/reply', note: 'not a search' }] });
    expect(errs).toEqual(['forum-example.yaml: read_endpoints[0].path has the segment "reply", which looks like a write action']);
  });

  it('also refuses an endpoint segment whose wildcard can match a write word', () => {
    expect(errorsOf({ ...base, read_endpoints: [{ method: 'POST', path: '/ajax/vo*', note: 'votes' }] })).toEqual([
      'forum-example.yaml: read_endpoints[0].path has the segment "vote", which looks like a write action',
    ]);
    expect(parse({ ...base, read_endpoints: [{ method: 'POST', path: '/search/run*', note: 'search form' }] }).ok).toBe(true);
  });

  it('refuses an endpoint path made only of wildcards (D14)', () => {
    const paths = ['/**', '/*', '/*/**', '/*?*'];
    expect(errorsOf({ ...base, read_endpoints: paths.map((path) => ({ method: 'POST', path, note: 'everything' })) })).toEqual(
      paths.map((_, i) => `forum-example.yaml: read_endpoints[${i}].path matches every path on the host, which would make every POST read-only; give the path of the search endpoint`),
    );
    expect(parse({ ...base, read_endpoints: [{ method: 'POST', path: '/search/**', note: 'search form' }] }).ok).toBe(true);
  });

  it('checks the shape of each read endpoint', () =>
    expect(errorsOf({ ...base, read_endpoints: [{ method: 'GET', path: 'search', note: '' }, { method: 'POST', path: '/search/run*', note: 'search form' }] })).toEqual([
      'forum-example.yaml: read_endpoints[0].method must be POST',
      'forum-example.yaml: read_endpoints[0].path must start with /',
      'forum-example.yaml: read_endpoints[0].note must not be empty',
    ]));

  it('requires post and author selectors for engine custom', () => {
    expect(errorsOf({ ...base, engine: 'custom', selectors: {} })).toEqual([
      'forum-example.yaml: selectors.post is required for engine custom',
      'forum-example.yaml: selectors.author is required for engine custom',
    ]);
    expect(errorsOf({ ...base, engine: 'custom' })).toHaveLength(2);
  });

  it('refuses unknown selector names and empty selectors', () =>
    expect(errorsOf({ ...base, selectors: { posts: 'article', author: '' } })).toEqual([
      'forum-example.yaml: selectors.author must not be empty',
      'forum-example.yaml: selectors.posts is not a known field',
    ]));

  it('checks the form of deny rules', () =>
    expect(errorsOf({ ...base, deny_paths: ['logout', '/admin/**', 'admin/users', 'mode=delete', ''] })).toEqual([
      'forum-example.yaml: deny_paths[2] must be a word without "/" or a path pattern starting with "/"',
      'forum-example.yaml: deny_paths[3] can never match: a word rule is compared with one segment, and segments are split on / \\ ? & = ;',
      'forum-example.yaml: deny_paths[4] must not be empty',
    ]));
});

describe('parseSource limits, types and status', () => {
  it('refuses max_requests_per_run above 60 and min_delay_s below 1', () =>
    expect(errorsOf({ ...base, rate_limit: { min_delay_s: 0.5, max_requests_per_run: 61 } })).toEqual([
      'forum-example.yaml: rate_limit.min_delay_s must be at least 1',
      'forum-example.yaml: rate_limit.max_requests_per_run must be at most 60',
    ]));

  it('keeps the other rate defaults when one limit is set', () => {
    const r = parse({ ...base, rate_limit: { min_delay_s: 6 } });
    expect(r.ok && r.source.rate_limit).toEqual({ min_delay_s: 6, max_requests_per_run: 60, max_requests_per_day: 300 });
  });

  it('accepts public_read and rejects other status values', () => {
    const r = parse({ ...base, status: 'public_read' });
    expect(r.ok && r.source.status).toBe('public_read');
    expect(errorsOf({ ...base, status: 'trusted' })).toEqual(['forum-example.yaml: status must be verified, public_read or untested, not "trusted"']);
  });

  it('refuses unknown fields, so a typo never drops a rule silently', () =>
    expect(errorsOf({ ...base, deny_path: ['logout'] })).toEqual(['forum-example.yaml: deny_path is not a known field']));

  it('reports every error, not the first one', () => {
    const { name: _, ...noName } = base;
    const errs = errorsOf({ ...noName, engine: 'smf', topics: [], enabled: 'no', pagination: { max_pages_per_thread: 0 }, automation: { ...base.automation, policy: 'allowed' } }, 'nope.yaml');
    expect(errs).toEqual([
      'nope.yaml: name is required',
      'nope.yaml: topics must list at least one topic',
      'nope.yaml: engine must be discourse, xenforo, phpbb, vbulletin, generic or custom, not "smf"',
      'nope.yaml: pagination.max_pages_per_thread must be at least 1',
      'nope.yaml: enabled must be true or false',
      'nope.yaml: automation.rule_quote is required when automation.policy is allowed',
      'nope.yaml: id "forum-example" must equal the file name "nope"',
    ]);
  });

  it('checks topic names', () =>
    expect(errorsOf({ ...base, topics: ['hardware', 'Vegetarian Food'] })).toEqual([
      'forum-example.yaml: topics[1] must be kebab-case (lowercase letters, digits, hyphens)',
    ]));
});

describe('parseSource YAML input', () => {
  it('prefixes YAML syntax errors with the file name', () =>
    expect(parseSource('id: [', { file: 'x.yaml' })).toMatchObject({ ok: false, errors: [expect.stringMatching(/^x\.yaml: /)] }));

  it('refuses duplicate keys', () =>
    expect(parseSource('id: a\nid: b\n', { file: 'x.yaml' })).toMatchObject({ ok: false, errors: [expect.stringMatching(/^x\.yaml: .*unique/)] }));

  it('keeps every syntax error on one line', () => {
    const r = parseSource('id: [\nname: "x\n', { file: 'x.yaml' });
    expect(r.ok).toBe(false);
    if (!r.ok) for (const e of r.errors) expect(e).toMatch(/^x\.yaml: [^\n]+$/);
  });

  it('refuses an empty file and a file that is not a mapping', () => {
    expect(parseSource('', { file: 'x.yaml' })).toEqual({ ok: false, errors: ['x.yaml: the file must be a YAML mapping of source fields'] });
    expect(parseSource('- a\n- b\n', { file: 'x.yaml' })).toEqual({ ok: false, errors: ['x.yaml: the file must be a YAML mapping of source fields'] });
  });

  it('parses a complete custom source', () => {
    const r = parseSource(fixture('sources/custom-example.yaml'), { file: 'sources/custom-example.yaml' });
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(r.source).toEqual({
      id: 'custom-example',
      name: 'Custom example forum',
      description: 'A synthetic forum without a known engine, searched with a POST form.',
      status: 'untested',
      topics: ['vegetarian-nutrition', 'cooking'],
      engine: 'custom',
      base_url: 'https://forum.example.org',
      domains: ['forum.example.org', 'static.forum.example.org'],
      login_url: 'https://forum.example.org/login',
      signup_url: null,
      search_url: null,
      read_endpoints: [{ method: 'POST', path: '/search/run*', note: 'search form of the page, read-only' }],
      session_check: { url: 'https://forum.example.org/account', logged_in_selector: 'a.logout' },
      selectors: {
        search_form: 'form#search', search_input: 'input[name=keywords]', thread_list: 'ol.results li a.thread-title',
        title: 'h1.thread-title', post: 'article.post', author: '.post-author .name', author_signals: '.post-author .stats',
        date: 'time[datetime]', body: '.post-body', quote: 'blockquote.quote', next_page: 'a[rel=next]',
      },
      author_signals: { profile_lookup: false },
      automation: { policy: 'forbidden', rule_url: 'https://forum.example.org/rules#bots', rule_quote: 'No bots or automated tools.', checked_at: '2026-11-07' },
      rate_limit: { min_delay_s: 6, max_requests_per_run: 30, max_requests_per_day: 200 },
      pagination: { max_pages_per_thread: 10 },
      deny_paths: ['/account/**', 'messages'],
      show_real_names: false,
      allow_beacons: false,
      enabled: false,
    });
  });
});

describe('test helpers', () => {
  it('testSource builds a valid source from base_url', () => {
    const t = testSource({ base_url: 'http://127.0.0.1:4100' });
    expect(t).toMatchObject({ domains: ['127.0.0.1'], status: 'untested', automation: { policy: 'allowed' }, engine: 'generic' });
    expect(parseSource(YAML.stringify(t), { file: `${t.id}.yaml` })).toEqual({ ok: true, source: t });
  });

  it('testSource applies overrides and derives profile_lookup from the engine', () => {
    const t = testSource({ base_url: 'https://forum.example.org', engine: 'discourse', deny_paths: ['secret'] });
    expect([t.engine, t.author_signals.profile_lookup, t.deny_paths]).toEqual(['discourse', true, ['secret']]);
    expect(() => testSource({ base_url: 'https://forum.example.org', login_url: 'https://evil.example/login' })).toThrow(/login_url host evil\.example/);
  });

  it('range is inclusive at both ends', () => {
    expect(range(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(range(3, 3)).toEqual([3]);
    expect(range(2, 1)).toEqual([]);
  });
});
