import { parseHTML } from 'linkedom';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { LurkdError } from '../../src/errors.js';
import {
  analysableUrl,
  analyseSource,
  checkResolvesPublic,
  collectSignals,
  detectForum,
  idForHost,
  isPublicAddress,
  MAX_TERMS_LINKS,
  parseAddDraft,
  readSignals,
  SIGNAL_LIMITS,
  type ForumSignals,
  type ResolveHost,
  draftAddressErrors,
  draftResolveErrors,
} from '../../src/sources/analyse.js';
import { fixture } from '../helpers/common.js';

// D45: what lurkd reads from a page the user asked it to analyse, and the draft it builds from
// the "Add a forum" form. Everything here is pure: no browser, no network.

/** The signals of a fixture page as the browser would hand them over, read at `url`. */
function signalsOf(file: string, url: string): ForumSignals {
  const doc = parseHTML(fixture(`analyse/${file}`)).document as unknown as Document;
  return readSignals(collectSignals(SIGNAL_LIMITS, doc), url);
}

const signals = (over: Partial<ForumSignals> & { url: string }): ForumSignals => ({ title: '', siteName: '', generator: '', htmlId: '', links: [], ...over });
const link = (href: string, text = '') => ({ href, text });

function refusal(raw: string, opts?: { allowLoopback?: boolean }): LurkdError {
  try {
    analysableUrl(raw, opts);
  } catch (e) {
    if (e instanceof LurkdError) return e;
    throw e;
  }
  throw new Error(`expected ${raw} to be refused`);
}

describe('detectForum on the fixture pages', () => {
  it('recognises Discourse from its generator and fills the engine defaults', () => {
    expect(detectForum(signalsOf('discourse.html', 'https://plants.example/'))).toEqual({
      engine: 'discourse',
      name: 'Plant Growers',
      base_url: 'https://plants.example',
      domains: ['plants.example'],
      login_url: 'https://plants.example/login',
      search_url: null,
      signup_url: 'https://plants.example/signup',
      termsLinks: [
        { href: 'https://plants.example/guidelines', text: 'Guidelines' },
        { href: 'https://plants.example/tos', text: 'Terms of Service' },
      ],
    });
  });

  it('recognises XenForo from html#XF and fills the engine defaults', () => {
    expect(detectForum(signalsOf('xenforo.html', 'https://bench.example/'))).toEqual({
      engine: 'xenforo',
      name: 'Bench Electronics',
      base_url: 'https://bench.example',
      domains: ['bench.example'],
      login_url: 'https://bench.example/login/',
      search_url: 'https://bench.example/search/?q={query}&o=date',
      signup_url: 'https://bench.example/register/',
      termsLinks: [{ href: 'https://bench.example/help/terms/', text: 'Terms and rules' }],
    });
  });

  it('leaves an unknown engine without defaults and still lists the rules links, at most 8, same host only', () => {
    const d = detectForum(signalsOf('unknown.html', 'https://modellisti.example/'));
    expect(d).toMatchObject({
      engine: null,
      name: 'Il Forum dei Modellisti',
      base_url: 'https://modellisti.example',
      domains: ['modellisti.example'],
      login_url: null,
      search_url: null,
      signup_url: null,
    });
    expect(d.termsLinks).toHaveLength(MAX_TERMS_LINKS);
    expect(d.termsLinks).toEqual([
      { href: 'https://modellisti.example/regolamento/', text: 'Regolamento' },
      { href: 'https://modellisti.example/norme-di-utilizzo/', text: 'Norme di utilizzo' },
      { href: 'https://modellisti.example/faq/', text: 'Domande frequenti' },
      { href: 'https://modellisti.example/pagina/123', text: 'Le regole: Rules of the forum' },
      { href: 'https://modellisti.example/termsofservice', text: 'Condizioni' },
      { href: 'https://modellisti.example/linee-guida/', text: 'Community guidelines' },
      { href: 'https://modellisti.example/aiuto/', text: 'Terms' },
      { href: 'https://modellisti.example/extra/', text: 'FAQ extra' },
    ]);
    const hrefs = d.termsLinks.map((l) => l.href).join(' ');
    // "photos" holds "tos" but is not the word; other hosts, javascript: and mailto: are never listed.
    expect(hrefs).not.toMatch(/photos|other\.example|javascript|mailto/);
  });
});

describe('detectForum termsLinks', () => {
  it('reads faq as a prefix too: /help/faqs and the link text FAQs', () => {
    const d = detectForum(
      signals({
        url: 'https://plants.example/',
        links: [link('https://plants.example/help/faqs', 'Help'), link('https://plants.example/pages/7', 'FAQs'), link('https://plants.example/faqpage', '')],
      }),
    );
    expect(d.termsLinks).toEqual([
      { href: 'https://plants.example/help/faqs', text: 'Help' },
      { href: 'https://plants.example/pages/7', text: 'FAQs' },
      { href: 'https://plants.example/faqpage', text: '' },
    ]);
  });

  it('still reads tos as a whole word only', () => {
    const d = detectForum(signals({ url: 'https://plants.example/', links: [link('https://plants.example/tossed-salad', 'Toscana photos')] }));
    expect(d.termsLinks).toEqual([]);
  });
});

describe('detectForum base_url', () => {
  const discourse = (url: string, links: { href: string; text: string }[] = []) => detectForum(signals({ url, generator: 'Discourse 3.4.0', links }));
  const xenforo = (url: string, links: { href: string; text: string }[] = []) => detectForum(signals({ url, htmlId: 'XF', links }));

  it('keeps the path prefix of a Discourse forum under /community', () => {
    for (const url of [
      'https://example.org/community',
      'https://example.org/community/',
      'https://example.org/community/latest',
      'https://example.org/community/t/repotting-a-fern/43',
      'https://example.org/community/c/indoor/4',
    ]) {
      const d = discourse(url);
      expect(d.base_url, url).toBe('https://example.org/community');
      expect(d.login_url, url).toBe('https://example.org/community/login');
      expect(d.signup_url, url).toBe('https://example.org/community/signup');
    }
  });

  it('gives the origin for a Discourse forum at the root, whatever page was given', () => {
    for (const url of ['https://plants.example', 'https://plants.example/latest', 'https://plants.example/t/welcome/1', 'https://plants.example/u/alice/summary']) {
      expect(discourse(url).base_url, url).toBe('https://plants.example');
    }
  });

  it('keeps the path prefix of a XenForo forum under /forums', () => {
    const d = xenforo('https://example.org/forums/threads/lead-free-tips.43/');
    expect(d.base_url).toBe('https://example.org/forums');
    expect(d.login_url).toBe('https://example.org/forums/login/');
    expect(d.signup_url).toBe('https://example.org/forums/register/');
    expect(d.search_url).toBe('https://example.org/forums/search/?q={query}&o=date');
    expect(xenforo('https://example.org/forums/members/dave.7/').base_url).toBe('https://example.org/forums');
    expect(xenforo('https://example.org/board/index.php?threads/x.1/').base_url).toBe('https://example.org/board');
  });

  it('tells the XenForo forum list at /forums/ from a forum installed there by its login link', () => {
    expect(xenforo('https://bench.example/forums/', [link('https://bench.example/login/', 'Log in')]).base_url).toBe('https://bench.example');
    expect(xenforo('https://example.org/forums/', [link('https://example.org/forums/login/', 'Log in')]).base_url).toBe('https://example.org/forums');
    expect(xenforo('https://bench.example/forums/oscilloscopes.2/').base_url).toBe('https://bench.example');
  });

  it('takes the longest prefix the links confirm, and ignores links outside the page path', () => {
    const links = [link('https://example.org/login/', 'Site login'), link('https://example.org/board/login/', 'Log in'), link('https://example.org/other/login/', 'x')];
    expect(xenforo('https://example.org/board/threads/x.1/', links).base_url).toBe('https://example.org/board');
    expect(discourse('https://example.org/community/t/x/1', [link('https://example.org/community/signup', 'Sign up')]).base_url).toBe('https://example.org/community');
    // A login link on another host proves nothing.
    expect(xenforo('https://example.org/forums/', [link('https://other.example/login/', 'x')]).base_url).toBe('https://example.org/forums');
  });

  it('keeps the port of the origin', () => {
    expect(discourse('http://127.0.0.1:4123/').base_url).toBe('http://127.0.0.1:4123');
    expect(discourse('http://127.0.0.1:4123/').domains).toEqual(['127.0.0.1']);
  });
});

describe('detectForum engine and name', () => {
  it('reads XenForo from a generator too, and Discourse wins over a stray html id', () => {
    expect(detectForum(signals({ url: 'https://bench.example/', generator: 'XenForo 2.2.15' })).engine).toBe('xenforo');
    expect(detectForum(signals({ url: 'https://bench.example/', generator: 'Discourse 3.4.0', htmlId: 'XF' })).engine).toBe('discourse');
    expect(detectForum(signals({ url: 'https://bench.example/', generator: 'WordPress 6.6', htmlId: 'xf' })).engine).toBeNull();
    expect(detectForum(signals({ url: 'https://bench.example/', generator: 'Powered by Discourse' })).engine).toBeNull();
  });

  it('prefers og:site_name, then the title, then the host, on one line and at most 100 characters', () => {
    expect(detectForum(signals({ url: 'https://a.example/', siteName: 'Plant Growers', title: 'Latest topics - Plant Growers' })).name).toBe('Plant Growers');
    expect(detectForum(signals({ url: 'https://a.example/', title: '  Bench\n\tElectronics​\u0007 ' })).name).toBe('Bench Electronics');
    expect(detectForum(signals({ url: 'https://a.example/', title: '   ' })).name).toBe('a.example');
    expect(detectForum(signals({ url: 'https://a.example/', title: 'x'.repeat(300) })).name).toHaveLength(100);
  });
});

describe('readSignals', () => {
  it('keeps strings only, cuts long values and resolves links against the page address', () => {
    const s = readSignals(
      {
        title: 42,
        siteName: 'y'.repeat(1000),
        generator: ['Discourse'],
        htmlId: 'XF',
        links: [
          { href: '/t/welcome/1', text: '  Welcome\n to the forum ' },
          { href: 'https://alice:secret@plants.example/tos#top', text: 'Terms' },
          { href: 'javascript:alert(1)', text: 'Rules' },
          { href: 'mailto:bob@plants.example', text: 'Rules' },
          { href: 17, text: 'Rules' },
          { href: '/faq', text: { toString: () => 'FAQ' } },
          null,
        ],
      },
      'https://plants.example/latest',
    );
    expect(s.title).toBe('');
    expect(s.generator).toBe('');
    expect(s.htmlId).toBe('XF');
    expect(s.siteName).toHaveLength(SIGNAL_LIMITS.maxText);
    expect(s.links).toEqual([
      { href: 'https://plants.example/t/welcome/1', text: 'Welcome to the forum' },
      { href: 'https://plants.example/tos', text: 'Terms' },
      { href: 'https://plants.example/faq', text: '' },
    ]);
    expect(JSON.stringify(s)).not.toContain('secret');
  });

  it('reads nothing from a page answer that is not an object, and caps the link count', () => {
    expect(readSignals(null, 'https://plants.example/')).toEqual(signals({ url: 'https://plants.example/' }));
    expect(readSignals('Discourse', 'https://plants.example/').links).toEqual([]);
    const many = Array.from({ length: SIGNAL_LIMITS.maxLinks + 50 }, (_, i) => ({ href: `/t/x/${i}`, text: 'x' }));
    expect(readSignals({ links: many }, 'https://plants.example/').links).toHaveLength(SIGNAL_LIMITS.maxLinks);
  });

  it('collects the same signals in a document as the page script does', () => {
    const doc = parseHTML(fixture('analyse/xenforo.html')).document as unknown as Document;
    const raw = collectSignals(SIGNAL_LIMITS, doc);
    expect(raw).toMatchObject({ title: 'Bench Electronics', siteName: 'Bench Electronics', generator: '', htmlId: 'XF' });
    expect(raw.links[0]).toEqual({ href: '/', text: '' });
    expect(raw.links.find((l) => l.href === '/help/terms/')).toEqual({ href: '/help/terms/', text: 'Terms and rules' });
    // It runs in the page as a string: no helper of Node may appear in it.
    expect(`(${collectSignals.toString()})(${JSON.stringify(SIGNAL_LIMITS)})`).not.toMatch(/__name|require\(|import\(/);
  });
});

describe('analysableUrl', () => {
  it('accepts an https address and drops the fragment', () => {
    expect(analysableUrl('https://forum.example/t/x/1#post_3').href).toBe('https://forum.example/t/x/1');
    expect(analysableUrl(' https://Forum.Example:8443/community ').href).toBe('https://forum.example:8443/community');
    expect(analysableUrl('https://8.8.8.8/').hostname).toBe('8.8.8.8');
    expect(analysableUrl('https://172.32.0.1/').hostname).toBe('172.32.0.1');
  });

  it('reads an address without a scheme as https', () => {
    expect(analysableUrl('forum.example/community').href).toBe('https://forum.example/community');
  });

  it('refuses every loopback form, on any port, unless the caller allows loopback for tests', () => {
    for (const bad of [
      'http://127.0.0.1:4123/',
      'https://127.0.0.1/',
      'https://127.0.0.1:8443/x',
      'http://127.0.0.1./',
      'http://localhost:3000/x',
      'https://localhost/',
      'https://LOCALHOST:8443/',
      'https://localhost./',
      'https://127.1/',
      'https://0x7f.0.0.1/',
      'https://0177.0.0.1/',
      'https://2130706433/',
      'https://[::1]/',
      'https://[::1]:8443/',
      'https://[0:0:0:0:0:0:0:1]/',
      'https://[::ffff:127.0.0.1]/',
      'localhost:3000',
    ]) {
      const e = refusal(bad);
      expect(e.code, bad).toBe('invalid_request');
      if (bad !== 'localhost:3000') expect(e.message, bad).toBe('lurkd opens public forums only, not addresses on your own network.');
      expect(refusal(bad, { allowLoopback: false }).code, bad).toBe('invalid_request');
    }
  });

  it('with the test-only loopback allowance, opens http and https on 127.0.0.1 and localhost, as the source schema does', () => {
    const tests = { allowLoopback: true };
    expect(analysableUrl('http://127.0.0.1:4123/', tests).href).toBe('http://127.0.0.1:4123/');
    expect(analysableUrl('http://localhost:3000/x', tests).href).toBe('http://localhost:3000/x');
    expect(analysableUrl('https://localhost/', tests).href).toBe('https://localhost/');
    // The allowance covers those two names only, not the rest of the private ranges.
    for (const bad of ['https://127.0.0.2/', 'https://[::1]/', 'https://10.0.0.5/', 'https://printer.local/'])
      expect(refusal(bad, tests).message, bad).toBe('lurkd opens public forums only, not addresses on your own network.');
    expect(refusal('http://forum.example/', tests).message).toBe('lurkd opens forums over https only. Give the https address of the forum.');
    expect(refusal('http://forum.example/').message).toBe('lurkd opens forums over https only. Give the https address of the forum.');
  });

  it('refuses other schemes and addresses with a user name or password, without echoing them', () => {
    for (const bad of ['ftp://forum.example/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'localhost:3000']) {
      expect(refusal(bad).message, bad).toBe('Give the address of a forum page, starting with https://.');
    }
    for (const bad of ['https://alice:secret@forum.example/', 'https://alice@forum.example/', 'http://bob:pw@127.0.0.1:4123/']) {
      const e = refusal(bad, { allowLoopback: true });
      expect(e.message, bad).toBe('lurkd does not open addresses that carry a user name or password.');
      expect(JSON.stringify({ m: e.message, d: e.details ?? null })).not.toMatch(/alice|bob|secret|pw/);
    }
    for (const bad of ['', '   ', 'not a url at all', 'https://']) expect(refusal(bad).code, bad).toBe('invalid_request');
    expect(refusal('x'.repeat(3000)).code).toBe('invalid_request');
  });

  it('refuses private, link-local and local-network hosts', () => {
    for (const bad of [
      'https://10.0.0.5/',
      'https://192.168.1.10/',
      'https://172.16.0.1/',
      'https://172.31.255.255/',
      'https://169.254.169.254/latest/meta-data/',
      'https://100.64.0.1/',
      'https://0.0.0.0/',
      'https://127.0.0.2/',
      'https://2130706434/',
      'https://255.255.255.255/',
      'https://224.0.0.1/',
      'https://[::1]/',
      'https://[fd00::1]/',
      'https://[::ffff:10.0.0.1]/',
      'https://intranet/',
      'https://printer.local/',
      'https://app.localhost/',
      'https://nas.internal/',
      'https://router.lan/',
      'https://box.home.arpa/',
      'https://nas.home/',
      'https://wiki.corp/',
      'https://Wiki.Corp./',
    ]) {
      const e = refusal(bad);
      expect(e.code, bad).toBe('invalid_request');
      expect(e.message, bad).toBe('lurkd opens public forums only, not addresses on your own network.');
    }
  });
});

describe('isPublicAddress', () => {
  it('accepts public IPv4 and global IPv6 addresses', () => {
    for (const ok of ['198.51.101.1', '203.0.112.255', '203.0.114.1', '8.8.8.8', '93.184.215.14', '172.32.0.1', '2606:4700::1111', '2a00:1450:4001:81c::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])
      expect(isPublicAddress(ok), ok).toBe(true);
  });

  it('refuses loopback, private, link-local, unique-local, mapped private and other non-public addresses', () => {
    for (const bad of [
      '127.0.0.1',
      '127.8.9.10',
      '10.0.0.5',
      '172.16.0.1',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      // The documentation blocks TEST-NET-2 and TEST-NET-3 (RFC 5737), next to 192.0.2.0/24.
      '198.51.100.7',
      '203.0.113.20',
      '::ffff:198.51.100.7',
      '::ffff:203.0.113.20',
      '::',
      '::1',
      '0:0:0:0:0:0:0:1',
      'fe80::1',
      'fe80::1%en0',
      'febf::1',
      'fec0::1',
      'fc00::1',
      'fd12:3456:789a::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '::ffff:c0a8:101',
      '::127.0.0.1',
      '64:ff9b::a00:1',
      '64:ff9b:1::1',
      '2002:c0a8:101::1',
      '2002:7f00:1::1',
      '2001:db8::1',
      '2001::1',
      '3fff::1',
      '100::1',
      'not an address',
      '',
    ])
      expect(isPublicAddress(bad), bad).toBe(false);
  });
});

describe('checkResolvesPublic', () => {
  const local = 'lurkd opens public forums only, not addresses on your own network.';
  const answer = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  const refusedBy = async (url: string, resolve: ResolveHost, rules?: { allowLoopback?: boolean }): Promise<LurkdError> => {
    try {
      await checkResolvesPublic(new URL(url), resolve, rules);
    } catch (e) {
      if (e instanceof LurkdError) return e;
      throw e;
    }
    throw new Error(`expected ${url} to be refused`);
  };

  it('looks the host up and lets a public answer through', async () => {
    const resolve = vi.fn(answer('93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'));
    await expect(checkResolvesPublic(new URL('https://forum.example:8443/t/1'), resolve)).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledWith('forum.example');
  });

  it('refuses a public name that resolves to loopback or a private address, as analysableUrl refuses the address itself', async () => {
    for (const [url, addresses] of [
      ['https://127.0.0.1.nip.io/', ['127.0.0.1']],
      ['https://localtest.me/', ['127.0.0.1', '::1']],
      ['https://intranet.example/', ['10.1.2.3']],
      ['https://meta.example/', ['169.254.169.254']],
      ['https://v6.example/', ['fd00::5']],
      ['https://mapped.example/', ['::ffff:192.168.0.1']],
      // One private answer among public ones is enough.
      ['https://mixed.example/', ['93.184.215.14', '192.168.1.1']],
    ] as const) {
      const e = await refusedBy(url, answer(...addresses));
      expect(e.code, url).toBe('invalid_request');
      expect(e.message, url).toBe(local);
      expect(e.details, url).toBeUndefined();
    }
  });

  it('says so when the name does not resolve', async () => {
    const notFound = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.example'), { code: 'ENOTFOUND' });
    };
    for (const resolve of [notFound, answer()]) {
      const e = await refusedBy('https://nowhere.example/x?token=secret', resolve);
      expect(e.code).toBe('invalid_request');
      expect(e.message).toBe('lurkd could not look up nowhere.example. Check the spelling of the address and that this computer is online.');
      expect(e.message).not.toContain('secret');
    }
  });

  it('turns a malformed resolver answer into the same "could not look up" refusal', async () => {
    const malformed: unknown[] = [null, undefined, 'not a list', 42, { address: '93.184.215.14' }, [null], ['93.184.215.14'], [{ family: 4 }], [{ address: 7, family: 4 }]];
    for (const value of malformed) {
      const resolve = (async () => value) as unknown as ResolveHost;
      const e = await refusedBy('https://odd.example/', resolve);
      expect(e.code, JSON.stringify(value)).toBe('invalid_request');
      expect(e.message, JSON.stringify(value)).toBe('lurkd could not look up odd.example. Check the spelling of the address and that this computer is online.');
    }
    // One malformed entry among good ones is still refused: lurkd cannot tell where it points.
    const mixed = (async () => [{ address: '93.184.215.14', family: 4 }, { family: 4 }]) as unknown as ResolveHost;
    expect((await refusedBy('https://odd.example/', mixed)).code).toBe('invalid_request');
  });

  it('skips the lookup only for 127.0.0.1 and localhost, and only with the test-only loopback allowance', async () => {
    const tests = { allowLoopback: true };
    const resolve = vi.fn(answer('127.0.0.1'));
    await checkResolvesPublic(new URL('http://127.0.0.1:4123/'), resolve, tests);
    await checkResolvesPublic(new URL('http://localhost:4123/'), resolve, tests);
    expect(resolve).not.toHaveBeenCalled();
    expect((await refusedBy('https://localtest.me/', resolve, tests)).message).toBe(local);
    expect((await refusedBy('http://127.0.0.1:4123/', resolve)).message).toBe(local);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

describe('idForHost and analyseSource', () => {
  it('turns a host into a source id', () => {
    expect(idForHost('forum.example.org')).toBe('forum-example-org');
    expect(idForHost('www.bench.example')).toBe('bench-example');
    expect(idForHost('127.0.0.1')).toBe('127-0-0-1');
    const long = idForHost(`${'a'.repeat(60)}.example`);
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{1,62}$/);
    expect(long.endsWith('-')).toBe(false);
  });

  it('builds a read-only generic source for the host, with the draft limits and no own deny rules', () => {
    const s = analyseSource(new URL('https://plants.example/community/t/x/1'), '2026-11-10');
    expect(s).toMatchObject({
      engine: 'generic',
      base_url: 'https://plants.example',
      domains: ['plants.example'],
      deny_paths: [],
      enabled: false,
      show_real_names: false,
      allow_beacons: false,
      read_endpoints: [],
      rate_limit: { min_delay_s: 2, max_requests_per_run: 60, max_requests_per_day: 300 },
      pagination: { max_pages_per_thread: 20 },
    });
  });
});

describe('parseAddDraft', () => {
  const base = { engine: 'discourse', name: 'Plant Growers', base_url: 'https://plants.example', topics: ['gardening'] };
  const parsed = (body: Record<string, unknown>) => {
    const r = parseAddDraft(body, '2026-11-10');
    return { ...r, doc: YAML.parse(r.yaml) as Record<string, unknown> };
  };

  it('builds the source YAML with the safe values and today as checked_at', () => {
    const r = parsed({ ...base, login_url: 'https://plants.example/login', signup_url: 'https://plants.example/signup', search_url: null });
    expect(r.host).toBe('plants.example');
    expect(r.doc).toEqual({
      id: 'plants-example',
      name: 'Plant Growers',
      status: 'untested',
      topics: ['gardening'],
      engine: 'discourse',
      base_url: 'https://plants.example',
      domains: ['plants.example'],
      login_url: 'https://plants.example/login',
      signup_url: 'https://plants.example/signup',
      automation: { policy: 'unknown', rule_url: 'https://plants.example', rule_quote: null, checked_at: '2026-11-10' },
      enabled: false,
    });
  });

  it('drops every field the form does not have, so a forged body cannot loosen anything', () => {
    const r = parsed({
      ...base,
      status: 'verified',
      enabled: true,
      show_real_names: true,
      allow_beacons: true,
      rate_limit: { min_delay_s: 0.1, max_requests_per_run: 600 },
      pagination: { max_pages_per_thread: 999 },
      read_endpoints: [{ method: 'POST', path: '/search', note: 'x' }],
      selectors: { post: 'article' },
      session_check: { url: 'https://plants.example/', logged_in_selector: 'body' },
      deny_paths: [],
      description: 'x',
      automation: { policy: 'allowed', rule_url: 'https://plants.example/tos', rule_quote: 'Bots are welcome.', checked_at: '1999-01-01', extra: true },
    });
    expect(r.doc.status).toBe('untested');
    expect(r.doc.enabled).toBe(false);
    for (const k of ['show_real_names', 'allow_beacons', 'rate_limit', 'pagination', 'read_endpoints', 'selectors', 'session_check', 'deny_paths', 'description'])
      expect(r.doc, k).not.toHaveProperty(k);
    expect(r.doc.automation).toEqual({ policy: 'allowed', rule_url: 'https://plants.example/tos', rule_quote: 'Bots are welcome.', checked_at: '2026-11-10' });
    expect(r.yaml).not.toMatch(/[&*!]/);
  });

  it('reads topics as a list or as comma-separated text, and takes an id when given', () => {
    expect(parsed({ ...base, topics: ' gardening, indoor-plants ,, ' }).doc.topics).toEqual(['gardening', 'indoor-plants']);
    expect(parsed({ ...base, id: 'my-garden' }).doc.id).toBe('my-garden');
    expect(parsed({ ...base, domains: ['plants.example', 'www.plants.example'] }).doc.domains).toEqual(['plants.example', 'www.plants.example']);
  });

  it('refuses an engine lurkd cannot read by itself and a missing or unusable base_url', () => {
    const fail = (body: Record<string, unknown>) => {
      try {
        parseAddDraft(body, '2026-11-10');
      } catch (e) {
        return e as LurkdError;
      }
      throw new Error('expected a refusal');
    };
    for (const engine of ['custom', 'generic', 'phpbb', undefined, 3]) {
      const e = fail({ ...base, engine });
      expect(e).toMatchObject({ code: 'invalid_request', details: { field: 'engine' } });
    }
    expect(fail({ ...base, engine: 'custom' }).message).toBe('engine must be discourse or xenforo. For other forums, ask your agent to add the site.');
    for (const base_url of [undefined, '', 'not a url', 'ftp://plants.example/', 42])
      expect(fail({ ...base, base_url }), String(base_url)).toMatchObject({ code: 'invalid_request', details: { field: 'base_url' } });
    expect(fail({ ...base, automation: 'allowed' })).toMatchObject({ code: 'invalid_request', details: { field: 'automation' } });
  });

  it('refuses a user name or password in any address of the form, as analysableUrl does, without echoing it', () => {
    const fail = (body: Record<string, unknown>) => {
      try {
        parseAddDraft(body, '2026-11-10');
      } catch (e) {
        return e as LurkdError;
      }
      throw new Error('expected a refusal');
    };
    const cases: [Record<string, unknown>, string][] = [
      [{ base_url: 'https://alice:secret@plants.example/' }, 'base_url'],
      [{ base_url: 'https://alice@plants.example' }, 'base_url'],
      [{ login_url: 'https://alice:secret@plants.example/login' }, 'login_url'],
      [{ signup_url: 'https://alice:secret@plants.example/signup' }, 'signup_url'],
      [{ search_url: 'https://alice:secret@plants.example/search?q={query}' }, 'search_url'],
      [{ automation: { rule_url: 'https://alice:secret@plants.example/tos' } }, 'automation.rule_url'],
    ];
    for (const [over, field] of cases) {
      const e = fail({ ...base, ...over });
      expect(e, field).toMatchObject({ code: 'invalid_request', details: { field } });
      expect(e.message, field).toBe(`${field} must not carry a user name or password.`);
      expect(JSON.stringify({ m: e.message, d: e.details ?? null })).not.toMatch(/alice|secret/);
    }
  });
});

// 0.2.1: the addresses of an agent's draft (source.sample with draft_yaml) under the rules of "Add a forum".
describe('draftAddressErrors', () => {
  const base = {
    base_url: 'https://forum.example',
    domains: ['forum.example'],
    login_url: 'https://forum.example/login',
    signup_url: null,
    search_url: 'https://forum.example/search?q={query}',
    session_check: null,
  };

  it('passes public https addresses', () => expect(draftAddressErrors(base)).toEqual([]));

  it('names each field that breaks a rule, once, without the address', () => {
    const lines = draftAddressErrors({
      base_url: 'https://192.168.1.4',
      domains: ['forum.example', 'nas.local', 'printer.internal'],
      login_url: 'http://forum.example/login',
      signup_url: 'https://www.reddit.com/register',
      search_url: 'https://me:pw@forum.example/search?q={query}',
      session_check: { url: 'https://[::1]/me', logged_in_selector: '.me' },
    });
    expect(lines).toEqual([
      'base_url: lurkd opens public forums only, not addresses on your own network.',
      'domains: lurkd opens public forums only, not addresses on your own network.',
      'login_url: lurkd opens forums over https only. Give the https address of the forum.',
      'signup_url: lurkd never reads Reddit live; Reddit threads come from files you saved (lurkd import reddit).',
      'search_url: lurkd does not open addresses that carry a user name or password.',
      'session_check.url: lurkd opens public forums only, not addresses on your own network.',
    ]);
    expect(lines.join('\n')).not.toMatch(/192\.168|nas\.local|printer|me:pw|::1/);
  });

  it('refuses a Reddit domain', () => {
    expect(draftAddressErrors({ ...base, domains: ['forum.example', 'old.reddit.com'] })).toEqual([
      'domains: lurkd never reads Reddit live; Reddit threads come from files you saved (lurkd import reddit).',
    ]);
  });

  it('lets 127.0.0.1 and localhost through, over http too, only for the tests', () => {
    const loop = { ...base, base_url: 'http://127.0.0.1:4100', domains: ['127.0.0.1', 'localhost'], login_url: 'http://localhost:4100/login', search_url: null };
    expect(draftAddressErrors(loop, { allowLoopback: true })).toEqual([]);
    expect(draftAddressErrors(loop)).toHaveLength(3);
  });

  // M3: the rules page follows the same rules as the form.
  it('checks automation.rule_url like the other addresses', () => {
    const rule = (rule_url: string) => draftAddressErrors({ ...base, automation: { rule_url } });
    expect(rule('https://forum.example/tos')).toEqual([]);
    expect(rule('https://me:pw@forum.example/tos')).toEqual(['automation.rule_url: lurkd does not open addresses that carry a user name or password.']);
    expect(rule('http://forum.example/tos')).toEqual(['automation.rule_url: lurkd opens forums over https only. Give the https address of the forum.']);
    expect(rule('ftp://forum.example/tos')).toEqual(['automation.rule_url: Give the address of a forum page, starting with https://.']);
    for (const local of ['https://127.0.0.1/tos', 'https://localhost/tos', 'https://10.1.2.3/tos', 'https://nas.local/tos', 'https://[::1]/tos'])
      expect(rule(local), local).toEqual(['automation.rule_url: lurkd opens public forums only, not addresses on your own network.']);
    expect(draftAddressErrors({ ...base, automation: { rule_url: 'http://127.0.0.1:4100/tos' } }, { allowLoopback: true })).toEqual([]);
  });
});

// M3: the DNS half of the address rules, for a draft, before it is stored.
describe('draftResolveErrors', () => {
  const base = { base_url: 'https://forum.example', domains: ['forum.example', 'cdn.forum.example'] };
  const resolver = (map: Record<string, string[]>): ResolveHost =>
    vi.fn(async (host: string) => (map[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

  it('passes names that resolve to public addresses, looking each one up once', async () => {
    const resolve = resolver({ 'forum.example': ['93.184.215.14'], 'cdn.forum.example': ['2606:2800:21f:cb07:6820:80da:af6b:8b2c'] });
    expect(await draftResolveErrors(base, resolve)).toEqual([]);
    expect((resolve as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).sort()).toEqual(['cdn.forum.example', 'forum.example']);
  });

  it('refuses a base host or a domain that resolves to a private address, or does not resolve', async () => {
    expect(await draftResolveErrors(base, resolver({ 'forum.example': ['10.0.0.1'], 'cdn.forum.example': ['93.184.215.14'] }))).toEqual([
      'base_url: lurkd opens public forums only, not addresses on your own network.',
      'domains: lurkd opens public forums only, not addresses on your own network.',
    ]);
    expect(await draftResolveErrors(base, resolver({ 'forum.example': ['93.184.215.14'], 'cdn.forum.example': ['127.0.0.1'] }))).toEqual([
      'domains: lurkd opens public forums only, not addresses on your own network.',
    ]);
    const missing = await draftResolveErrors(base, resolver({ 'forum.example': ['93.184.215.14'] }));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/^domains: lurkd could not look up/);
  });

  it('does not look up 127.0.0.1 and localhost with the test-only loopback allowance', async () => {
    const resolve = resolver({});
    expect(await draftResolveErrors({ base_url: 'http://127.0.0.1:4100', domains: ['127.0.0.1', 'localhost'] }, resolve, { allowLoopback: true })).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });
});
