import { performance } from 'node:perf_hooks';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { checkNavigable } from '../../src/policy/urls.js';
import {
  analyseSource,
  collectPageText,
  findAutomationClause,
  MAX_CLAUSE_LENGTH,
  MAX_RULES_PAGES,
  PAGE_TEXT_LIMIT,
  rulesPageUrls,
  type ForumDetection,
} from '../../src/sources/analyse.js';
import { fixture } from '../helpers/common.js';

// D49: the rules pages "Analyse" reads, and the sentence that forbids automated access. Pure: no
// browser, no network. The fixture pages are read as the browser would hand their text over.

const DISCOURSE_CLAUSE =
  'You may not automate access to the forum, or monitor the forum, such as with a web crawler, browser plug-in or add-on, or other computer program that is not a web browser.';
const SEARCH_ENGINE_SENTENCE = 'You may crawl the forum to index it for a publicly available search engine, if you run one.';

/** The text of a fixture page, through the same function the browser runs. */
function textOf(file: string): string {
  const doc = parseHTML(fixture(`analyse/rules/${file}`)).document as unknown as Document;
  return collectPageText(PAGE_TEXT_LIMIT, doc);
}

describe('findAutomationClause on the fixture rules pages', () => {
  it('finds the sentence of the default Discourse terms of service', () => {
    expect(findAutomationClause(textOf('discourse-tos.html'))).toBe(DISCOURSE_CLAUSE);
  });

  it('finds nothing in a terms page without a clause (SustainOSS style)', () => {
    const text = textOf('sustain-tos.html');
    // The page has every distractor: "automatically", "crawl", "robots", and "may not" elsewhere.
    expect(text).toContain('automatically renew');
    expect(text).toContain(SEARCH_ENGINE_SENTENCE);
    expect(findAutomationClause(text)).toBeNull();
  });

  it('finds the owner rule on a XenForo terms page, and nothing in the default XenForo text', () => {
    const page = fixture('analyse/rules/xenforo-terms.html');
    const doc = parseHTML(page).document as unknown as Document;
    expect(findAutomationClause(collectPageText(PAGE_TEXT_LIMIT, doc))).toBe(
      'The use of bots, scrapers or other automated tools to read or copy content from this forum is not permitted.',
    );
    const plain = parseHTML(page.replace(/<p id="owner-rule">.*<\/p>/, '')).document as unknown as Document;
    expect(findAutomationClause(collectPageText(PAGE_TEXT_LIMIT, plain))).toBeNull();
  });

  it('reads the copy Discourse serves inside noscript', () => {
    const text = textOf('discourse-guidelines.html');
    expect(text).toContain('Community Guidelines');
    expect(findAutomationClause(text)).toBe('Do not use bots, scrapers or other automated tools to read or copy this forum.');
  });

  it('joins a list item to the lead-in that forbids it', () => {
    expect(findAutomationClause(fixture('analyse/rules/list-tos.txt'))).toBe(
      'When you use the forum, you agree not to: use any robot, spider, scraper or other automated means to access the forum;',
    );
  });
});

describe('findAutomationClause on single sentences', () => {
  it('recognises typical prohibitions with scrape, crawl, bot, automated, robot or spider', () => {
    for (const sentence of [
      'Scraping this forum is prohibited.',
      'You must not crawl the forum.',
      'Bots are not allowed.',
      'Automated access to the site is strictly prohibited.',
      'Users shall not use robots or spiders to collect content.',
      "Don't run scrapers against this forum.",
      'No bots, scrapers or crawlers.',
      'We forbid the use of automated tools to read the forum.',
      'You agree not to access the forum by automated means.',
      'Members cannot use a web crawler on the forum.',
      'You will not use any spider to copy posts.',
      'Accessing the forum with a bot is not permitted without our written consent.',
    ])
      expect(findAutomationClause(`Welcome to the forum. ${sentence} Have fun.`), sentence).toBe(sentence);
  });

  it('does not take the search engine sentence as a permission for lurkd, nor as a prohibition on its own', () => {
    expect(findAutomationClause(SEARCH_ENGINE_SENTENCE)).toBeNull();
    // Next to the prohibition, the prohibition is what comes back.
    expect(findAutomationClause(`${DISCOURSE_CLAUSE} ${SEARCH_ENGINE_SENTENCE}`)).toBe(DISCOURSE_CLAUSE);
    expect(findAutomationClause(`${SEARCH_ENGINE_SENTENCE} ${DISCOURSE_CLAUSE}`)).toBe(DISCOURSE_CLAUSE);
  });

  it('does not flag unrelated sentences', () => {
    for (const sentence of [
      'Your subscription will automatically renew.',
      'Action will be taken, either automatically or by moderator intervention.',
      'Posts are checked automatically and you may not see them at once.',
      'Our bot welcomes new members.',
      'Search engine robots read the public pages.',
      'You may not post spam. Our forum runs on a server in a basement, and many search engines crawl the public pages of most forums on the internet every day.',
      'You may not share your password. Sharing it breaks the rules.',
      'Both members and guests may not post links.',
      'Ask a robotics question in the right category.',
    ])
      expect(findAutomationClause(sentence), sentence).toBeNull();
  });

  it('keeps the exact sentence: one line, with its own words and punctuation', () => {
    expect(findAutomationClause('Rules\n\nYou   may not\tuse  bots.\nOther text.')).toBe('You may not use bots.');
    // A line break ends a unit: a heading never joins the sentence under it.
    expect(findAutomationClause('Acceptable Use\nYou may not use bots.')).toBe('You may not use bots.');
    expect(findAutomationClause('Rules: e.g. scraping is not allowed here. Thanks.')).toBe('Rules: e.g. scraping is not allowed here.');
    expect(findAutomationClause('You can’t use bots here.')).toBe('You can’t use bots here.');
  });

  it('ignores an over-long block and text that is not a string', () => {
    expect(findAutomationClause(`You may not use bots ${'and so on '.repeat(200)}.`)).toBeNull();
    expect(MAX_CLAUSE_LENGTH).toBeLessThan(2100);
    expect(findAutomationClause('')).toBeNull();
    expect(findAutomationClause(undefined as unknown as string)).toBeNull();
  });

  it('recognises the established forms', () => {
    for (const sentence of [
      'You may not use any robot, spider, scraper or other automated means to access the forum.',
      'Automated access is not permitted.',
      'Scraping is prohibited.',
      'Scraping is not allowed.',
      'On this forum, scraping is prohibited.',
      'You are not allowed to use bots on this forum.',
      'Users are prohibited from scraping the forum.',
      'You may not collect posts by means of a script.',
      'The forum may not be accessed by bots.',
      'Bots are blocked and scraping is prohibited.',
      'Use of bots is prohibited.',
      'We prohibit bots and scrapers.',
    ])
      expect(findAutomationClause(`Welcome to the forum. ${sentence} Have fun.`), sentence).toBe(sentence);
  });

  it('needs the prohibition to govern access by automated means, not something else near an automation word', () => {
    for (const sentence of [
      'We use automated tools to detect spam; posting spam is prohibited.',
      'You may not post spam, and our automated filters remove it.',
      'Registration bots are blocked and spam accounts are banned.',
      'Do not post about robots in the off-topic category.',
      'No robot vacuum discussions outside the hardware category.',
      'Posting about scrapers, crawlers and bots is prohibited.',
      'Discussing spam or robots is not allowed.',
      'Scraping is not prohibited.',
      'You may not use the forum to advertise robots.',
    ]) {
      expect(findAutomationClause(sentence), sentence).toBeNull();
      expect(findAutomationClause(`Welcome to the forum. ${sentence} Have fun.`), sentence).toBeNull();
    }
  });
});

describe('findAutomationClause on lists as the browser hands them over', () => {
  const ITEM = 'Use any robot, spider, scraper or other automated means to access the forum.';

  it('reads the lines under a lead-in as its items, without bullets and capitalised (Chrome innerText of li)', () => {
    expect(findAutomationClause(`You agree not to:\nPost spam or advertisements.\n${ITEM}\nShare your password.`)).toBe(`You agree not to: ${ITEM}`);
    // A <p> lead-in before a <ul>: innerText puts a blank line between them.
    expect(findAutomationClause(`Terms\n\nYou agree not to:\n\nPost spam or advertisements.\n${ITEM}\n\nContact us.`)).toBe(`You agree not to: ${ITEM}`);
    expect(findAutomationClause('The following is prohibited:\nSpam.\nBots, scrapers and crawlers.')).toBe('The following is prohibited: Bots, scrapers and crawlers.');
  });

  it('ends the list at a blank line after its items and after a bounded number of lines', () => {
    expect(findAutomationClause(`You agree not to:\nPost spam.\n\n${ITEM}`)).toBeNull();
    const many = Array.from({ length: 30 }, (_, i) => `Item number ${i}.`).join('\n');
    expect(findAutomationClause(`You agree not to:\n${many}\n${ITEM}`)).toBeNull();
    // A list without a prohibition in its lead-in forbids nothing.
    expect(findAutomationClause(`You must agree with the following rules:\n${ITEM}`)).toBeNull();
  });
});

describe('findAutomationClause in linear time (H1)', () => {
  const timed = (text: string): { ms: number; out: string | null } => {
    const t0 = performance.now();
    const out = findAutomationClause(text);
    return { ms: performance.now() - t0, out };
  };
  // Well under 200 ms on an idle machine; 500 ms leaves room for a loaded one. Before the fix the
  // first two took 69 s and 16.6 s.
  const BOUND_MS = 500;

  it('returns at once on a list item of 300 000 characters', () => {
    for (const text of ['You agree not to:\n- ' + 'bot '.repeat(75_000), 'You agree not to:\nuse ' + 'crawler '.repeat(37_500)]) {
      const { ms, out } = timed(text);
      expect(out).toBeNull();
      expect(ms).toBeLessThan(BOUND_MS);
    }
  });

  it('reads 300 KB of near misses, long lines and long lists, and finds the clause at the end', () => {
    const nearMiss =
      'Do not post about robots, spam is prohibited and spam accounts are banned, you may not post spam, and our automated filters remove it, no robot vacuum discussions; posting spam is not allowed, ';
    const sentence = `${nearMiss.repeat(Math.floor((MAX_CLAUSE_LENGTH - 1) / nearMiss.length))}.`;
    // One line of 100 sentences just under the clause length, each full of prohibitions and automation words.
    const longLine = Array.from({ length: 100 }, () => sentence).join(' ');
    // One line of 50 000 characters without a sentence end.
    const block = `You may not use with by the any bot crawler scraper ${'may not use with by the a any bot , and ; '.repeat(1_200)}`;
    // A lead-in with 800 lines under it.
    const list = `You agree not to:\n${Array.from({ length: 800 }, () => 'Post spam about robots and bots in the off-topic category.').join('\n')}`;
    const parts = [longLine, block, list];
    let text = '';
    for (let i = 0; text.length + parts[i % 3]!.length + 2 < PAGE_TEXT_LIMIT - DISCOURSE_CLAUSE.length - 2; i++) text += `${parts[i % 3]}\n\n`;
    text += DISCOURSE_CLAUSE;
    expect(text.length).toBeGreaterThan(290_000);
    expect(text.length).toBeLessThanOrEqual(PAGE_TEXT_LIMIT);
    const { ms, out } = timed(text);
    expect(out).toBe(DISCOURSE_CLAUSE);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe('collectPageText', () => {
  it('reads the body and its noscript copy, and stops at the limit', () => {
    const doc = parseHTML('<html><body><p>You may not use bots.</p><noscript><p>Copy for readers without scripts.</p></noscript></body></html>')
      .document as unknown as Document;
    const text = collectPageText(PAGE_TEXT_LIMIT, doc);
    expect(text).toContain('You may not use bots.');
    expect(text).toContain('Copy for readers without scripts.');
    expect(collectPageText(10, doc).length).toBeLessThanOrEqual(10);
  });
});

describe('rulesPageUrls', () => {
  const page = 'https://forum.example/latest';
  const forum = (over: Partial<ForumDetection>): ForumDetection => ({
    engine: 'discourse',
    name: 'Forum',
    base_url: 'https://forum.example',
    domains: ['forum.example'],
    login_url: null,
    search_url: null,
    signup_url: null,
    termsLinks: [],
    ...over,
  });
  const source = analyseSource(new URL(page), '2026-11-10');
  const allowed = (url: string): boolean => {
    try {
      checkNavigable(source, url);
      return true;
    } catch {
      return false;
    }
  };

  it('reads /tos and /guidelines on Discourse, linked or not, under the forum path', () => {
    expect(rulesPageUrls(forum({}), page, allowed)).toEqual(['https://forum.example/tos', 'https://forum.example/guidelines']);
    const prefixed = analyseSource(new URL('https://forum.example/community/latest'), '2026-11-10');
    expect(
      rulesPageUrls(forum({ base_url: 'https://forum.example/community', termsLinks: [{ href: 'https://forum.example/rules', text: 'Rules' }] }), 'https://forum.example/community/latest', (u) => {
        checkNavigable(prefixed, u);
        return true;
      }),
    ).toEqual(['https://forum.example/community/tos', 'https://forum.example/community/guidelines']);
  });

  it('reads /help/terms/ on XenForo', () => {
    expect(rulesPageUrls(forum({ engine: 'xenforo', termsLinks: [{ href: 'https://forum.example/rules/', text: 'Rules' }] }), page, allowed)).toEqual([
      'https://forum.example/help/terms/',
    ]);
  });

  it('reads the first rules link on the same host that the deny rules let through for other engines', () => {
    const links = [
      { href: 'https://other.example/rules/', text: 'Rules' },
      { href: 'http://forum.example:8080/rules/', text: 'Rules on another port' },
      { href: 'https://forum.example/session/logout?rules', text: 'Rules' },
      { href: 'https://forum.example/regolamento/', text: 'Regolamento' },
      { href: 'https://forum.example/faq/', text: 'FAQ' },
    ];
    expect(rulesPageUrls(forum({ engine: null, termsLinks: links }), page, allowed)).toEqual(['https://forum.example/regolamento/']);
    expect(rulesPageUrls(forum({ engine: null, termsLinks: [] }), page, allowed)).toEqual([]);
  });

  it('requests a rules link of another engine only over https, on the page scheme, with the rules word in the path', () => {
    const links = [
      { href: 'http://forum.example/rules/', text: 'Rules' },
      { href: 'https://forum.example/page?section=rules', text: 'Rules' },
      { href: 'https://forum.example/p/42', text: 'Forum rules' },
      { href: 'https://forum.example/norme/', text: 'Norme' },
    ];
    expect(rulesPageUrls(forum({ engine: null, termsLinks: links }), page, () => true)).toEqual(['https://forum.example/norme/']);
    // A page over http (never one lurkd analyses, outside the test loopback allowance).
    const plain = [{ href: 'http://forum.example/rules/', text: 'Rules' }];
    expect(rulesPageUrls(forum({ engine: null, termsLinks: plain }), 'http://forum.example/', () => true)).toEqual([]);
    expect(rulesPageUrls(forum({ base_url: 'http://forum.example' }), 'http://forum.example/latest', () => true)).toEqual([]);
    // The test loopback allowance keeps http on 127.0.0.1, as the analysed page had it.
    const loop = 'http://127.0.0.1:4100';
    const loopLinks = [{ href: `${loop}/regolamento/`, text: 'Regolamento' }];
    expect(rulesPageUrls(forum({ engine: null, termsLinks: loopLinks }), `${loop}/`, () => true, { allowLoopback: true })).toEqual([`${loop}/regolamento/`]);
    expect(rulesPageUrls(forum({ engine: null, termsLinks: loopLinks }), `${loop}/`, () => true)).toEqual([]);
    expect(rulesPageUrls(forum({ engine: null, termsLinks: [{ href: `https://127.0.0.1:4100/rules/`, text: 'Rules' }] }), `${loop}/`, () => true, { allowLoopback: true })).toEqual([]);
  });

  it('never returns more than two pages, nor one the deny rules refuse', () => {
    expect(MAX_RULES_PAGES).toBe(2);
    expect(rulesPageUrls(forum({}), page, () => false)).toEqual([]);
    expect(rulesPageUrls(forum({}), page, (u) => !u.endsWith('/tos'))).toEqual(['https://forum.example/guidelines']);
    // A base on another host (a forged detection) gives nothing.
    expect(rulesPageUrls(forum({ base_url: 'https://other.example' }), page, () => true)).toEqual([]);
    expect(rulesPageUrls(forum({ base_url: 'ftp://forum.example' }), page, () => true)).toEqual([]);
  });
});
