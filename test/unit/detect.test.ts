import { describe, expect, it } from 'vitest';
import { detectBlock, hasPasswordInput } from '../../src/detect.js';
import { fixture, testSource } from '../helpers/common.js';

describe('detectBlock on saved pages', () => {
  it('ignores the hidden login form Discourse ships on every page', () => {
    const html = fixture('detect/discourse-search-anon.reduced.html');
    expect(html).toContain('hidden-login-form');
    expect(hasPasswordInput(html)).toBe(false);
    expect(detectBlock({ url: 'https://forum.level1techs.com/search?q=gpu', status: 200, html })).toBeNull();
  });

  it('fires on the Discourse login redirect for /my/preferences', () => {
    const html = fixture('detect/discourse-login-redirect.reduced.html');
    const d = detectBlock({
      url: 'https://forum.obsidian.md/login-preferences',
      requestedUrl: 'https://forum.obsidian.md/my/preferences',
      status: 200,
      html,
    });
    expect(d?.kind).toBe('login');
    expect(d?.reasons).toEqual(['login-like path']);
  });

  it('fires on HTTP 403 for private messages of another user', () => {
    const html = fixture('detect/discourse-messages-anon.reduced.html');
    const d = detectBlock({ url: 'https://forum.level1techs.com/u/system/messages', status: 403, html });
    expect(d).toEqual({ kind: 'login', reasons: ['HTTP 403'] });
  });

  it('classifies a Cloudflare managed challenge as a challenge', () => {
    const html = fixture('detect/cloudflare-challenge.synthetic.html');
    const d = detectBlock({ url: 'https://forum.example.org/t/x/1', status: 403, html });
    expect(d?.kind).toBe('challenge');
    expect(d?.reasons).toContain('Cloudflare "Just a moment" title');
  });
});

describe('detectBlock on a real challenge', () => {
  it('classifies the Cloudflare page served to the headless browser as a challenge', () => {
    const html = fixture('detect/cloudflare-challenge-xenforo.html');
    const d = detectBlock({ url: 'https://xenforo.com/community/', status: 403, html });
    expect(d?.kind).toBe('challenge');
    expect(d?.reasons).toEqual(expect.arrayContaining(['Cloudflare "Just a moment" title', 'Cloudflare _cf_chl_opt', 'HTTP 403']));
  });
});

describe('detectBlock heuristics', () => {
  it('fires on a visible password field outside hidden forms', () => {
    const html = '<form action="/login"><input type="text" name="u"><input type="password" name="p"></form>';
    expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status: 200, html })?.reasons).toEqual(['visible password input']);
  });
  it('trusts the live visible-field count over the HTML', () => {
    const html = '<input type="password">';
    expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status: 200, html, visiblePasswordInputs: 0 })).toBeNull();
    expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status: 200, html: '', visiblePasswordInputs: 1 })?.kind).toBe('login');
  });
  it('fires on login and session paths', () => {
    expect(detectBlock({ url: 'https://forum.example.org/session/sso', status: 200, html: '' })?.kind).toBe('login');
    expect(detectBlock({ url: 'https://forum.example.org/login/', status: 200, html: '' })?.kind).toBe('login');
    expect(detectBlock({ url: 'https://forum.example.org/t/loginless-setup/5', status: 200, html: '' })).toBeNull();
  });
  it('treats the Cloudflare script on a normal page as harmless, with an error status as a challenge', () => {
    const html = '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>';
    expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status: 200, html })).toBeNull();
    expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status: 503, html })?.kind).toBe('challenge');
  });
  it('classifies 429 as a challenge and 401 as a login', () => {
    expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status: 429, html: '' })?.kind).toBe('challenge');
    expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status: 401, html: '' })?.kind).toBe('login');
  });
});

describe('detectBlock D30 rules', () => {
  it('ignores Cloudflare markers on a 200 page (D30)', () =>
    expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status: 200, html: fixture('detect/cloudflare-challenge.synthetic.html') })).toBeNull());

  it('ignores Cloudflare markers without a status', () =>
    expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status: null, html: fixture('detect/cloudflare-challenge-xenforo.html') })).toBeNull());

  it('counts Cloudflare markers with 403, 429 and 503', () => {
    const html = fixture('detect/cloudflare-challenge.synthetic.html');
    for (const status of [403, 429, 503]) {
      const d = detectBlock({ url: 'https://forum.example.org/t/x/1', status, html });
      expect(d?.kind).toBe('challenge');
      expect(d?.reasons).toEqual(
        expect.arrayContaining(['Cloudflare "Just a moment" title', 'Cloudflare Turnstile widget', 'Cloudflare _cf_chl_opt', `HTTP ${status}`]),
      );
    }
  });

  it('classifies 403 and 401 alone as a login, 503 alone as a challenge', () => {
    expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status: 403, html: '' })).toEqual({ kind: 'login', reasons: ['HTTP 403'] });
    expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status: 401, html: '' })).toEqual({ kind: 'login', reasons: ['HTTP 401'] });
    expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status: 503, html: '' })).toEqual({ kind: 'challenge', reasons: ['HTTP 503'] });
  });

  it('does not treat 404 as a block', () => expect(detectBlock({ url: 'https://forum.example.org/c/private/9', status: 404, html: '' })).toBeNull());

  it('does not treat other statuses as a block', () => {
    for (const status of [200, 301, 304, 410, 500]) expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status, html: '' })).toBeNull();
  });
});

describe('hasPasswordInput on hostile markup', () => {
  // [^>]* runs used to backtrack quadratically on tags that never close (1 MB took 82 s).
  const timed = (html: string) => {
    const t0 = performance.now();
    const r = hasPasswordInput(html);
    return { r, ms: performance.now() - t0 };
  };

  it('scans 2000 unterminated <input and 2000 <form tags in under 200 ms', () => {
    const { r, ms } = timed('<input '.repeat(2000) + '<form '.repeat(2000));
    expect(r).toBe(false);
    expect(ms).toBeLessThan(200);
  });

  it('scans 10000 hidden forms that never close in under 200 ms', () => {
    const { r, ms } = timed('<form style="display:none">'.repeat(10_000) + 'x'.repeat(500_000) + '<input type="password">');
    expect(r).toBe(true);
    expect(ms).toBeLessThan(200);
  });

  it('scans one 200 KB form tag full of display:none in under 200 ms', () => {
    const { r, ms } = timed('<form ' + 'style="display:none" '.repeat(10_000) + '>' + 'x'.repeat(500_000));
    expect(r).toBe(false);
    expect(ms).toBeLessThan(200);
  });

  it('still removes hidden forms and keeps the visible ones', () => {
    const hidden = '<form id="hidden-login-form" style="display: none;"><input type="password"></form>';
    const shown = '<FORM action="/login"><input type="password"></FORM>';
    expect(hasPasswordInput(hidden)).toBe(false);
    expect(hasPasswordInput(hidden.toUpperCase())).toBe(false);
    expect(hasPasswordInput(hidden + hidden)).toBe(false);
    expect(hasPasswordInput(hidden + shown)).toBe(true);
    expect(hasPasswordInput(shown + hidden)).toBe(true);
    expect(hasPasswordInput('<form style="display:none"><input type="password">')).toBe(true); // never closed: not removed
    expect(hasPasswordInput('<form style="display:none"><form style="display:none"><input type="password"></form><input type="password">')).toBe(true);
  });

  it('cuts hidden forms at the right place after non-ASCII text', () => {
    // U+0130 lowercases to two code units; indices from a lowercased copy used to drift.
    expect(hasPasswordInput('<p>İİİ</p><form style="display:none"><input type="text"></form><input type="password">')).toBe(true);
    const turkish =
      '<title>' + 'İ'.repeat(60) + '</title><form id="hidden-login-form" style="display: none;"><input type="password"></form>' +
      '<div class="login-modal"><input type="password"></div>';
    expect(hasPasswordInput(turkish)).toBe(true);
    expect(detectBlock({ url: 'https://forum.example.org/t/x/1', status: 200, html: turkish })).toEqual({ kind: 'login', reasons: ['visible password input'] });
    expect(hasPasswordInput('<p>İ</p><form style="display:none"><input type="password"></FORM>')).toBe(false);
    expect(hasPasswordInput('<p>İ</p><form style="display:none"><input type="password"></form >')).toBe(true); // as the original pattern: no space allowed
  });

  it('keeps the tag boundaries of the original patterns', () => {
    // A "<" inside an attribute value does not end the tag; only ">" does.
    expect(hasPasswordInput('<input placeholder="a<b" type="password">')).toBe(true);
    expect(hasPasswordInput('<form data-x="a<b" style="display:none"><input type="password"></form>')).toBe(false);
    // An input that never closes still counts; type outside the tag does not.
    expect(hasPasswordInput('<input name="p" type=password')).toBe(true);
    expect(hasPasswordInput('<input name="p"> type="password"')).toBe(false);
    // A form open tag without ">" is not a hidden form; with one, the tag runs up to it.
    expect(hasPasswordInput('<form style="display:none" <input type="password"')).toBe(true);
    expect(hasPasswordInput('<form style="display:none" <input type="password"></form>')).toBe(false);
  });

  it('scans 20000 of each in under 200 ms', () => {
    const { r, ms } = timed('<input '.repeat(20_000) + '<form '.repeat(20_000) + '<input type="password">');
    expect(r).toBe(true);
    expect(ms).toBeLessThan(200);
  });
});

describe('detectBlock login path (P23)', () => {
  it('fires on a redirect from a thread to a login path', () => {
    const d = detectBlock({ url: 'https://forum.example.org/login?return=%2Ft%2Fx%2F1', requestedUrl: 'https://forum.example.org/t/x/1', status: 200, html: '' });
    expect(d).toEqual({ kind: 'login', reasons: ['login-like path'] });
  });

  it('does not flag a login path that was requested on purpose', () => {
    expect(detectBlock({ url: 'https://forum.example.org/login', requestedUrl: 'https://forum.example.org/login', status: 200, html: '' })).toBeNull();
    expect(
      detectBlock({ url: 'https://forum.example.org/session/current.json', requestedUrl: 'https://forum.example.org/session/current.json', status: 200, html: '' }),
    ).toBeNull();
  });

  it('fires on a redirect between login paths (P23, literal reading)', () => {
    expect(detectBlock({ url: 'https://forum.example.org/session/sso', requestedUrl: 'https://forum.example.org/login', status: 200, html: '' })).toEqual({
      kind: 'login',
      reasons: ['login-like path'],
    });
    expect(detectBlock({ url: 'https://forum.example.org/login?return=%2F', requestedUrl: 'https://forum.example.org/login', status: 200, html: '' })?.kind).toBe(
      'login',
    );
  });

  it('compares the two URLs after parsing', () =>
    expect(detectBlock({ url: 'https://forum.example.org/login', requestedUrl: 'https://FORUM.example.org:443/login', status: 200, html: '' })).toBeNull());

  it('still fires on other signals on a requested login page', () => {
    const d = detectBlock({ url: 'https://forum.example.org/login', requestedUrl: 'https://forum.example.org/login', status: 200, html: '', visiblePasswordInputs: 1 });
    expect(d).toEqual({ kind: 'login', reasons: ['visible password input'] });
  });

  it('treats a missing requested URL as a possible redirect', () =>
    expect(detectBlock({ url: 'https://forum.example.org/login', status: 200, html: '' })?.kind).toBe('login'));

  it('does not flag a final URL that is not a login path', () =>
    expect(detectBlock({ url: 'https://forum.example.org/t/x/2', requestedUrl: 'https://forum.example.org/t/x/1', status: 200, html: '' })).toBeNull());
});

describe('detectBlock login path on thread paths', () => {
  const discourse = testSource({ id: 'alpha', engine: 'discourse', base_url: 'https://forum.example.org' });
  const xenforo = testSource({ id: 'bravo', engine: 'xenforo', base_url: 'https://forum.example.org' });
  const at = (url: string, requestedUrl: string, source?: typeof discourse) => detectBlock({ url, requestedUrl, status: 200, html: '', source });

  it('ignores a Discourse slug redirect onto a slug that starts with "login"', () =>
    expect(at('https://forum.example.org/t/login-problems/123', 'https://forum.example.org/t/123', discourse)).toBeNull());

  it('still fires on a Discourse redirect to /login', () =>
    expect(at('https://forum.example.org/login', 'https://forum.example.org/t/123', discourse)).toEqual({ kind: 'login', reasons: ['login-like path'] }));

  it('ignores a XenForo thread whose slug starts with "login"', () => {
    expect(at('https://forum.example.org/threads/login-help.42/', 'https://forum.example.org/threads/42/', xenforo)).toBeNull();
    expect(at('https://forum.example.org/login/', 'https://forum.example.org/threads/42/', xenforo)?.kind).toBe('login');
  });

  it('uses the thread paths of the source engine only', () =>
    expect(at('https://forum.example.org/threads/login-help.42/', 'https://forum.example.org/threads/42/', discourse)?.kind).toBe('login'));

  it('keeps other signals on a thread path', () =>
    expect(
      detectBlock({ url: 'https://forum.example.org/t/login-problems/123', requestedUrl: 'https://forum.example.org/t/123', status: 403, html: '', source: discourse }),
    ).toEqual({ kind: 'login', reasons: ['HTTP 403'] }));

  it('keeps the old behaviour without a source', () =>
    expect(at('https://forum.example.org/t/login-problems/123', 'https://forum.example.org/t/123')?.kind).toBe('login'));
});
