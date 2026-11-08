import { describe, expect, it } from 'vitest';
import { BUILTIN_DENY, checkNavigable, deniedBy, isAllowedHost, isThreadPath, matchesReadEndpoint } from '../../src/policy/urls.js';
import { WRITE_WORDS } from '../../src/sources/schema.js';
import { range, testSource } from '../helpers/common.js';

const s = testSource({ base_url: 'https://forum.example.org', deny_paths: ['/admin/**', 'secret'] });

describe('deniedBy', () => {
  it.each([
    ['https://forum.example.org/t/bug-report-for-rtx-5090/55', null],
    ['https://forum.example.org/t/i-like-pizza/9', null],
    ['https://forum.example.org/t/123.json', null],
    ['https://forum.example.org/session/logout', 'logout'],
    ['https://forum.example.org/index.php?threads/x.55/reply', 'reply'],
    ['https://forum.example.org/ucp.php?mode=logout', 'logout'],
    ['https://forum.example.org/posts/9/react', 'react'],
    ['https://forum.example.org/admin/users/1', '/admin/**'],
    ['https://forum.example.org/t/secret/4', 'secret'],
  ])('deniedBy(%s) is %s', (url, rule) => expect(deniedBy(s, url)).toBe(rule));

  it('uses the built-in write words, in order, after the source rules', () => {
    expect(BUILTIN_DENY).toEqual(WRITE_WORDS);
    expect(WRITE_WORDS).toEqual(['logout', 'log-out', 'signout', 'sign-out', 'delete', 'destroy', 'subscribe', 'unsubscribe', 'vote', 'report', 'flag', 'like', 'react', 'reply', 'edit', 'bookmark', 'watch', 'follow', 'mute', 'ignore', 'upload', 'compose']);
    const both = testSource({ base_url: 'https://forum.example.org', deny_paths: ['session'] });
    expect(deniedBy(both, 'https://forum.example.org/session/logout')).toBe('session');
  });

  it('matches a word rule against whole segments only (P8)', () => {
    const p = testSource({ base_url: 'https://forum.example.org', deny_paths: ['posting', 'ucp.php'] });
    expect(deniedBy(p, 'https://forum.example.org/posting.php?mode=quote&p=5')).toBe('posting');
    expect(deniedBy(p, 'https://forum.example.org/posting/')).toBe('posting');
    expect(deniedBy(p, 'https://forum.example.org/t/posting-guidelines/5')).toBeNull();
    expect(deniedBy(p, 'https://forum.example.org/viewtopic.php?t=5&posting=1')).toBe('posting');
    // A rule written with its extension still matches the full segment.
    expect(deniedBy(p, 'https://forum.example.org/ucp.php?mode=register')).toBe('ucp.php');
    // One letters-only extension is dropped, nothing else.
    expect(deniedBy(s, 'https://forum.example.org/session/logout.json')).toBe('logout');
    expect(deniedBy(s, 'https://forum.example.org/threads/logout.55/')).toBeNull();
  });

  it('lets a * inside a word rule match within one segment', () => {
    const w = testSource({ base_url: 'https://forum.example.org', deny_paths: ['*report*', 'caf\u00e9-*-\u{1F355}'] });
    expect(deniedBy(w, 'https://forum.example.org/t/bug-report-for-rtx-5090/55')).toBe('*report*');
    expect(deniedBy(w, 'https://forum.example.org/t/i-like-pizza/9')).toBeNull();
    expect(deniedBy(w, `https://forum.example.org/c/${encodeURIComponent('caf\u00e9-x-\u{1F355}')}`)).toBe('caf\u00e9-*-\u{1F355}');
  });

  it('compares case-insensitively and after percent-decoding', () => {
    expect(deniedBy(s, 'https://forum.example.org/session/LogOut')).toBe('logout');
    expect(deniedBy(s, 'https://forum.example.org/session/%6Cogout')).toBe('logout');
    expect(deniedBy(s, 'https://forum.example.org/session%2Flogout')).toBe('logout');
    expect(deniedBy(s, 'https://forum.example.org/%61dmin/users')).toBe('/admin/**');
  });

  it('treats a rule starting with / as a glob: * within a segment, ** across segments', () => {
    const g = testSource({ base_url: 'https://forum.example.org', deny_paths: ['/admin/**', '/u/*/activity', '/mod/**/queue'] });
    expect(deniedBy(g, 'https://forum.example.org/admin')).toBe('/admin/**');
    expect(deniedBy(g, 'https://forum.example.org/admin?tab=users')).toBe('/admin/**');
    expect(deniedBy(g, 'https://forum.example.org/Admin/users/1')).toBe('/admin/**');
    expect(deniedBy(g, 'https://forum.example.org/administrator')).toBeNull();
    expect(deniedBy(g, 'https://forum.example.org/u/alice/activity')).toBe('/u/*/activity');
    expect(deniedBy(g, 'https://forum.example.org/u/alice/x/activity')).toBeNull();
    expect(deniedBy(g, 'https://forum.example.org/mod/queue')).toBe('/mod/**/queue');
    expect(deniedBy(g, 'https://forum.example.org/mod/a/b/queue')).toBe('/mod/**/queue');
  });

  it('skips the value of q for the write words (C9)', () => {
    expect(deniedBy(s, 'https://forum.example.org/search?q=report')).toBeNull();
    expect(deniedBy(s, 'https://forum.example.org/search.json?q=edit')).toBeNull();
    expect(deniedBy(s, 'https://forum.example.org/search?q=report&mode=delete')).toBe('delete');
    expect(deniedBy(s, 'https://forum.example.org/session/logout?q=x')).toBe('logout');
    expect(deniedBy(s, 'https://forum.example.org/search?query=report')).toBe('report');
    // Source rules still see the search value.
    expect(deniedBy(s, 'https://forum.example.org/search?q=secret')).toBe('secret');
  });

  it('skips the {query} slot of search_url for the write words (C9)', () => {
    const inQuery = testSource({ base_url: 'https://forum.example.org', search_url: 'https://forum.example.org/search.php?keywords={query}&sf=all' });
    expect(deniedBy(inQuery, 'https://forum.example.org/search.php?keywords=delete&sf=all')).toBeNull();
    expect(deniedBy(inQuery, 'https://forum.example.org/search.php?sf=all&keywords=report%20vote')).toBeNull();
    expect(deniedBy(inQuery, 'https://forum.example.org/ucp.php?keywords=delete')).toBe('delete');
    expect(deniedBy(inQuery, 'https://forum.example.org/search.php?keywords=x&mode=logout')).toBe('logout');
    const inPath = testSource({ base_url: 'https://forum.example.org', search_url: 'https://forum.example.org/find/{query}' });
    expect(deniedBy(inPath, 'https://forum.example.org/find/report')).toBeNull();
    expect(deniedBy(inPath, 'https://forum.example.org/other/report')).toBe('report');
    expect(deniedBy(inPath, 'https://forum.example.org/find/x/edit')).toBe('edit');
  });

  it('never applies the write words to a Discourse thread path (C9)', () => {
    const d = testSource({ base_url: 'https://forum.example.org', engine: 'discourse' });
    expect(deniedBy(d, 'https://forum.example.org/t/report/77')).toBeNull();
    expect(deniedBy(d, 'https://forum.example.org/t/report/77/3')).toBeNull();
    expect(deniedBy(d, 'https://forum.example.org/t/vote/12.json')).toBeNull();
    expect(deniedBy(d, 'https://forum.example.org/t/report/77?page=2')).toBeNull();
    expect(deniedBy(d, 'https://forum.example.org/report/77')).toBe('report');
    expect(deniedBy(d, 'https://forum.example.org/t/x/77/edit')).toBe('edit');
    expect(deniedBy(d, 'https://forum.example.org/t/report/77?action=delete')).toBe('delete');
    // The same path on a source of another engine is refused.
    expect(deniedBy(s, 'https://forum.example.org/t/report/77')).toBe('report');
  });

  it('does not exempt a thread-shaped path whose slug hides encoded slashes', () => {
    const d = testSource({ base_url: 'https://forum.example.org', engine: 'discourse' });
    expect(deniedBy(d, 'https://forum.example.org/t/x%2F..%2Fsession%2Flogout/77')).toBe('logout');
    expect(deniedBy(d, 'https://forum.example.org/t/x%5C..%5Csession%5Clogout/77')).toBe('logout');
    expect(isThreadPath(d, 'https://forum.example.org/t/x%2Flogout/77')).toBe(false);
  });

  it('keeps decoding single-byte escapes when a segment also holds an invalid escape', () => {
    const d = testSource({ base_url: 'https://forum.example.org', engine: 'discourse' });
    expect(deniedBy(s, 'https://forum.example.org/session%2Flogout%E0')).toBe('logout');
    expect(deniedBy(s, 'https://forum.example.org/%E0%2Fsession%2Flogout')).toBe('logout');
    expect(isThreadPath(d, 'https://forum.example.org/t/x%2Flogout%E0/77')).toBe(false);
    expect(deniedBy(d, 'https://forum.example.org/t/x%2Flogout%E0/77')).toBe('logout');
  });

  it('reads Discourse thread paths under the base path of a subfolder install', () => {
    const d = testSource({ base_url: 'https://forum.example.org/community', engine: 'discourse' });
    expect(deniedBy(d, 'https://forum.example.org/community/t/vote/12')).toBeNull();
    expect(deniedBy(d, 'https://forum.example.org/t/vote/12')).toBe('vote');
  });

  it('never applies the write words to a XenForo thread path (C9)', () => {
    const x = testSource({ base_url: 'https://forum.example.org', engine: 'xenforo' });
    expect(deniedBy(x, 'https://forum.example.org/threads/report.77/')).toBeNull();
    expect(deniedBy(x, 'https://forum.example.org/threads/report.77/page-2')).toBeNull();
    expect(deniedBy(x, 'https://forum.example.org/index.php?threads/report.77/')).toBeNull();
    expect(deniedBy(x, 'https://forum.example.org/threads/report.77/reply')).toBe('reply');
    expect(deniedBy(x, 'https://forum.example.org/index.php?threads/x.55/reply')).toBe('reply');
    expect(deniedBy(x, 'https://forum.example.org/report/77')).toBe('report');
  });

  it('keeps source rules on thread paths', () => {
    const d = testSource({ base_url: 'https://forum.example.org', engine: 'discourse', deny_paths: ['report'] });
    expect(deniedBy(d, 'https://forum.example.org/t/report/77')).toBe('report');
  });

  it('matches wildcard-heavy rules without catastrophic backtracking', () => {
    const w = testSource({ base_url: 'https://forum.example.org', deny_paths: ['*a*a*a*a*a*a*a*x', '/**/**/**/**/**/**/x', '/*a*a*a*a*a*a*x'] });
    const long = `https://forum.example.org/${range(0, 39).map((i) => `seg${i}`).join('/')}/${'a'.repeat(2000)}`;
    const t0 = performance.now();
    expect(deniedBy(w, long)).toBeNull();
    expect(deniedBy(w, `${long}x`)).toBe('*a*a*a*a*a*a*a*x');
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('throws invalid_request for a string that is not an absolute URL', () =>
    expect(() => deniedBy(s, '/session/logout')).toThrow(expect.objectContaining({ code: 'invalid_request' })));
});

describe('isThreadPath', () => {
  it('knows the thread paths of each engine', () => {
    const d = testSource({ base_url: 'https://forum.example.org', engine: 'discourse' });
    const x = testSource({ base_url: 'https://forum.example.org', engine: 'xenforo' });
    expect(isThreadPath(d, 'https://forum.example.org/t/report/77')).toBe(true);
    expect(isThreadPath(d, 'https://forum.example.org/t/report/77/reply')).toBe(false);
    expect(isThreadPath(d, 'https://forum.example.org/threads/report.77/')).toBe(false);
    expect(isThreadPath(x, 'https://forum.example.org/threads/report.77/')).toBe(true);
    expect(isThreadPath(x, 'https://forum.example.org/index.php?threads/report.77/page-3')).toBe(true);
    expect(isThreadPath(x, 'https://forum.example.org/threads/report.77/reply')).toBe(false);
    expect(isThreadPath(x, 'https://forum.example.org/t/report/77')).toBe(false);
    expect(isThreadPath(s, 'https://forum.example.org/t/report/77')).toBe(false);
  });
});

describe('isAllowedHost', () => {
  it('allows only listed hostnames over http(s)', () => {
    expect(isAllowedHost(s, 'https://forum.example.org/x')).toBe(true);
    for (const u of ['https://www.forum.example.org/x', 'https://evil.example/x', 'file:///etc/passwd', 'javascript:alert(1)'])
      expect(isAllowedHost(s, u)).toBe(false);
  });

  it('compares the hostname exactly, with no suffix or prefix tricks', () => {
    for (const u of [
      'https://evil-forum.example.org/x',
      'https://forum.example.org.evil.example/x',
      'https://forum.example.org@evil.example/x',
      'https://evil.example/?next=https://forum.example.org/',
      'https://evil.example/forum.example.org',
      'https://forum.example.org./x',
      'ftp://forum.example.org/x',
      'ws://forum.example.org/x',
      '//forum.example.org/x',
      '/x',
      'not a url',
    ])
      expect(isAllowedHost(s, u), u).toBe(false);
    for (const u of ['HTTPS://FORUM.EXAMPLE.ORG/x', 'http://forum.example.org/x', 'https://forum.example.org:8443/x', 'https://alice@forum.example.org/x'])
      expect(isAllowedHost(s, u), u).toBe(true);
  });
});

describe('matchesReadEndpoint', () => {
  const x = testSource({ base_url: 'https://forums.example.net', read_endpoints: [{ method: 'POST', path: '/index.php?search/search*', note: 'XenForo search form' }] });

  it('matches read endpoints on path plus query, POST only, own hosts only', () => {
    expect(matchesReadEndpoint(x, 'POST', 'https://forums.example.net/index.php?search/search')).toBe(true);
    expect(matchesReadEndpoint(x, 'POST', 'https://forums.example.net/index.php?threads/x.5/add-reply')).toBe(false);
    expect(matchesReadEndpoint(x, 'PUT', 'https://forums.example.net/index.php?search/search')).toBe(false);
    expect(matchesReadEndpoint(x, 'POST', 'https://evil.example/index.php?search/search')).toBe(false);
  });

  it('keeps * inside one segment and the match anchored at both ends', () => {
    expect(matchesReadEndpoint(x, 'POST', 'https://forums.example.net/index.php?search/search&t=post')).toBe(true);
    expect(matchesReadEndpoint(x, 'POST', 'https://forums.example.net/index.php?search/search/x')).toBe(false);
    expect(matchesReadEndpoint(x, 'POST', 'https://forums.example.net/x/index.php?search/search')).toBe(false);
    expect(matchesReadEndpoint(x, 'POST', 'https://forums.example.net/index.php')).toBe(false);
  });

  it('refuses a POST that matches an endpoint but also a deny rule', () =>
    expect(matchesReadEndpoint(x, 'POST', 'https://forums.example.net/index.php?search/search&mode=logout')).toBe(false));

  it('refuses everything for a source without read endpoints', () =>
    expect(matchesReadEndpoint(s, 'POST', 'https://forum.example.org/search')).toBe(false));

  it('returns false for a string that is not a URL', () => expect(matchesReadEndpoint(x, 'POST', 'nope')).toBe(false));
});

describe('checkNavigable', () => {
  it('checkNavigable throws off_domain and denied_path', () => {
    expect(() => checkNavigable(s, 'https://evil.example/t/1')).toThrow(expect.objectContaining({ code: 'off_domain' }));
    expect(() => checkNavigable(s, 'https://forum.example.org/session/logout')).toThrow(expect.objectContaining({ code: 'denied_path' }));
  });

  it('names the URL and the rule in the error', () => {
    expect(() => checkNavigable(s, 'https://evil.example/t/1')).toThrow(
      expect.objectContaining({ details: { url: 'https://evil.example/t/1', sourceId: 'test-source', domains: ['forum.example.org'] } }),
    );
    expect(() => checkNavigable(s, 'https://forum.example.org/session/logout')).toThrow(
      expect.objectContaining({ message: expect.stringContaining('built-in deny rule "logout"'), details: { url: 'https://forum.example.org/session/logout', sourceId: 'test-source', rule: 'logout' } }),
    );
    expect(() => checkNavigable(s, 'https://forum.example.org/admin/x')).toThrow(expect.objectContaining({ message: expect.stringContaining('deny rule "/admin/**" of test-source') }));
  });

  it('refuses a string that is not a URL as off_domain', () =>
    expect(() => checkNavigable(s, 'javascript:alert(1)')).toThrow(expect.objectContaining({ code: 'off_domain' })));

  it('lets a readable URL through', () => expect(() => checkNavigable(s, 'https://forum.example.org/t/i-like-pizza/9')).not.toThrow());
});
