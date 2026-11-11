import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LaunchFn } from '../../src/browser/manager.js';
import { runCommand } from '../../src/cli/commands.js';
import { createApiClient } from '../../src/client/api.js';
import { readRunFile } from '../../src/launcher/runfile.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { lurkdPaths, type LurkdPaths } from '../../src/paths.js';
import { startServer } from '../../src/server/main.js';
import { pageCookie, pageLink } from '../helpers/common.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

// D52 end to end: a server started as lurkd start starts it, with the real page files. The page
// secret reaches the browser only through a one-time link that the Bearer route mints; the run
// file, every file under the lurkd home, the CLI and the MCP server never hold it, and the token
// opens nothing in the browser. Chromium runs headless; `elsewhere.test` is mapped to 127.0.0.1
// inside Chromium, as another site whose link leads to lurkd. The server's own browser cannot
// launch, so nothing here leaves 127.0.0.1.

type Started = Awaited<ReturnType<typeof startServer>>;

let home: string;
let paths: LurkdPaths;
let s: Started;
let chrome: Browser;
/** Another site, on 127.0.0.1 but reached as http://elsewhere.test:<port>: its page holds `link`. */
let elsewhere: FixtureServer;
let link = '';
/** What the server printed or logged while the tests ran. */
const printed: string[] = [];

const noBrowser: LaunchFn = async () => {
  throw new Error('no browser here');
};

/** Every file under `dir`, as bytes read as latin1 so a secret in any encoding of ASCII shows. */
function filesUnder(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push({ file: p, text: fs.readFileSync(p).toString('latin1') });
  }
  return out;
}

beforeAll(async () => {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-page-secret-'));
  const seedDir = path.join(home, 'seed');
  fs.mkdirSync(seedDir);
  paths = lurkdPaths({ LURKD_HOME: home });
  s = await startServer({ paths, seedDir, launch: noBrowser });
  elsewhere = await startFixtureServer({
    '/': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Another site</title><a id="go" href="${link}">Open lurkd</a>`);
    },
  });
  chrome = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP elsewhere.test 127.0.0.1'] });
});

afterAll(async () => {
  await chrome?.close();
  await elsewhere?.close();
  await s?.close();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const secretOf = (cookie: string) => cookie.slice('lurkd_page='.length);

describe('the page secret and the one-time page links (D52)', () => {
  const origin = () => `http://127.0.0.1:${s.port}`;
  const ready = (page: import('playwright').Page) => expect.poll(() => page.locator('#directory').getAttribute('aria-busy'), { timeout: 8000 }).toBe('false');

  it('reaches the browser through a one-time link only: an HttpOnly, SameSite=Strict cookie that is not the token, and the page works with it', async () => {
    const context = await chrome.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    const r = await page.goto(await pageLink(s.port, s.token));
    expect(r?.status()).toBe(200);
    await ready(page);
    // The used link leaves the address bar.
    expect(page.url()).toBe(`${origin()}/`);
    const cookies = await context.cookies();
    expect(cookies.map((c) => [c.name, c.httpOnly, c.sameSite, c.path])).toEqual([['lurkd_page', true, 'Strict', '/']]);
    expect(cookies[0]!.value).toMatch(/^[0-9a-f]{64}$/);
    expect(cookies[0]!.value).not.toBe(s.token);
    expect(cookies[0]!.value).toBe(secretOf(await pageCookie(s.port, s.token)));
    // The page's script cannot read it, and its own calls go through with it.
    expect(await page.evaluate(() => document.cookie)).toBe('');
    const state = await page.evaluate(async () => (await fetch('/api/state')).status);
    expect(state).toBe(200);
    const change = await page.evaluate(async () => (await fetch('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"From the page"}' })).status);
    expect(change).toBe(200);
    // A reload asks for / with the cookie.
    await page.reload();
    await ready(page);
    expect(problems).toEqual([]);
    await context.close();
  });

  it('opens the page from a link followed on another site (M1)', async () => {
    link = await pageLink(s.port, s.token);
    const context = await chrome.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    let site: string | undefined;
    const seen: Promise<void>[] = [];
    page.on('request', (q) => {
      if (q.url() === link) seen.push(q.allHeaders().then((h) => void (site = h['sec-fetch-site'])));
    });
    await page.goto(`http://elsewhere.test:${new URL(elsewhere.origin).port}/`);
    await page.locator('#go').click();
    await ready(page);
    await Promise.all(seen);
    expect(site).toBe('cross-site');
    expect(page.url()).toBe(`${origin()}/`);
    expect((await context.cookies()).map((c) => [c.name, c.sameSite])).toEqual([['lurkd_page', 'Strict']]);
    expect(await page.evaluate(async () => (await fetch('/api/state')).status)).toBe(200);
    expect(problems).toEqual([]);
    await context.close();
  });

  it('refuses a used link, and answers a browser without the cookie with the HTML page that says to run lurkd open', async () => {
    const used = await pageLink(s.port, s.token);
    const first = await chrome.newContext();
    expect((await (await first.newPage()).goto(used))?.status()).toBe(200);
    await first.close();
    const context = await chrome.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    // The browser logs the 401 of each answer itself; anything else (a CSP refusal) is a problem.
    page.on('console', (m) => {
      if (!/status of 401/.test(m.text())) problems.push(`console ${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    const again = await page.goto(used);
    expect(again?.status()).toBe(401);
    await expect.poll(() => page.locator('h1').textContent()).toBe('Open lurkd from the terminal');
    expect(await page.locator('main').innerText()).toContain('This link has been used or has expired.');
    expect(await page.locator('main').innerText()).toContain('Run lurkd open in a terminal.');
    const plain = await page.goto(`${origin()}/`);
    expect(plain?.status()).toBe(401);
    expect(await page.locator('main').innerText()).toContain('lurkd start');
    expect(await context.cookies()).toEqual([]);
    expect(problems).toEqual([]);
    await context.close();
  });

  it('uses up a link opened in a browser that already has the cookie, so another browser gets the 401 page for it (M1)', async () => {
    // Browser A holds the cookie from an earlier link, as after a first `lurkd open`.
    const a = await chrome.newContext();
    const pageA = await a.newPage();
    await pageA.goto(await pageLink(s.port, s.token));
    await ready(pageA);
    const cookieA = (await a.cookies()).find((c) => c.name === 'lurkd_page')!.value;
    // A second `lurkd open`: A opens the new link and sees the page, with the same cookie.
    const repeat = await pageLink(s.port, s.token);
    expect((await pageA.goto(repeat))?.status()).toBe(200);
    await ready(pageA);
    expect((await a.cookies()).map((c) => [c.name, c.value])).toEqual([['lurkd_page', cookieA]]);
    // Browser B, without cookies, opens the same link (read from `ps` or A's history).
    const b = await chrome.newContext();
    const pageB = await b.newPage();
    const stolen = await pageB.goto(repeat);
    expect(stolen?.status()).toBe(401);
    await expect.poll(() => pageB.locator('h1').textContent()).toBe('Open lurkd from the terminal');
    expect(await pageB.locator('main').innerText()).toContain('This link has been used or has expired.');
    expect(await b.cookies()).toEqual([]);
    await a.close();
    await b.close();
  });

  it('explains the 401 page to a browser with the cookie that follows a plain link to / from another site (L2)', async () => {
    const context = await chrome.newContext();
    const page = await context.newPage();
    await page.goto(await pageLink(s.port, s.token));
    await ready(page);
    link = `${origin()}/`;
    await page.goto(`http://elsewhere.test:${new URL(elsewhere.origin).port}/`);
    const answer = page.waitForResponse((r) => r.url() === link);
    await page.locator('#go').click();
    expect((await answer).status()).toBe(401);
    await expect.poll(() => page.locator('h1').textContent()).toBe('Open lurkd from the terminal');
    expect(await page.locator('main').innerText()).toContain('A plain link to lurkd from another page does not open it either');
    // The cookie is still there: the same browser opens / itself.
    expect((await page.goto(link))?.status()).toBe(200);
    await context.close();
  });

  it('never opens the page for the token, in the address or set as a cookie by hand', async () => {
    const context = await chrome.newContext();
    const page = await context.newPage();
    for (const p of [`/?t=${s.token}`, `/?n=${s.token}`]) {
      const r = await page.goto(`${origin()}${p}`);
      expect([p, r?.status()]).toEqual([p, 401]);
      expect(await context.cookies()).toEqual([]);
    }
    for (const name of ['lurkd_token', 'lurkd_page']) {
      await context.clearCookies();
      await context.addCookies([{ name, value: s.token, url: origin() }]);
      const r = await page.goto(`${origin()}/`);
      expect([name, r?.status()]).toEqual([name, 401]);
    }
    await context.close();
  });

  it('clears an old lurkd_token cookie once a link opens the page (L2)', async () => {
    const context = await chrome.newContext();
    await context.addCookies([{ name: 'lurkd_token', value: s.token, url: origin() }]);
    const page = await context.newPage();
    await page.goto(await pageLink(s.port, s.token));
    await ready(page);
    expect((await context.cookies()).map((c) => c.name)).toEqual(['lurkd_page']);
    await context.close();
  });

  it('mints no link for a web page: not for another site, not for the lurkd page itself', async () => {
    const context = await chrome.newContext();
    const page = await context.newPage();
    await page.goto(`http://elsewhere.test:${new URL(elsewhere.origin).port}/`);
    const mint = `${origin()}/api/page-link`;
    // With the token: the browser asks first (CORS preflight), and lurkd refuses another site's Origin.
    const withToken = await page.evaluate(
      async ([url, token]) => {
        try {
          const r = await fetch(url!, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
          return `answered ${r.status}`;
        } catch (e) {
          return `refused: ${(e as Error).name}`;
        }
      },
      [mint, s.token],
    );
    expect(withToken).toBe('refused: TypeError');
    // A plain form-like POST goes out without a preflight; its answer is a refusal the page cannot read.
    const answered = page.waitForResponse((r) => r.url() === mint);
    await page.evaluate(async (url) => void (await fetch(url, { method: 'POST', mode: 'no-cors' }).catch(() => null)), mint);
    expect((await answered).status()).toBe(403);
    // From the lurkd page itself, cookie and all: refused too.
    await page.goto(await pageLink(s.port, s.token));
    await ready(page);
    const own = await page.evaluate(async () => {
      const r = await fetch('/api/page-link', { method: 'POST' });
      return [r.status, await r.text()] as const;
    });
    expect(own[0]).toBe(403);
    expect(own[1]).not.toContain('?n=');
    await context.close();
  });

  it('never puts the page secret in the run file, any file under the lurkd home, the CLI, the MCP server or the server output', async () => {
    const secret = secretOf(await pageCookie(s.port, s.token));
    const runFile = fs.readFileSync(paths.runFile, 'utf8');
    expect(runFile).toContain(s.token);
    expect(runFile).not.toContain(secret);
    expect(readRunFile(paths)).not.toHaveProperty('pageSecret');

    // The CLI as bin/lurkd.ts wires it, over the run file.
    const cliOut: string[] = [];
    for (const argv of [['sources'], ['sources', '--json'], ['session', '--json'], ['search', 'anything'], ['search', 'anything', '--json']]) {
      const lines: string[] = [];
      const code = await runCommand(argv, {
        client: createApiClient(paths),
        out: (l) => lines.push(l),
        err: (l) => lines.push(l),
        readFile: (p) => fs.readFileSync(p, 'utf8'),
      });
      expect([argv.join(' '), code]).toEqual([argv.join(' '), 0]);
      cliOut.push(...lines);
    }
    expect(cliOut.length).toBeGreaterThan(0);
    expect(cliOut.join('\n')).not.toContain(secret);

    // The MCP server over its real client: the tool list and every read-only tool.
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(createApiClient(paths), 'dot').connect(serverSide);
    const mcp = new Client({ name: 'test', version: '0.0.0' });
    await mcp.connect(clientSide);
    const answers: unknown[] = [await mcp.listTools()];
    for (const [name, args] of [
      ['sources.search', {}],
      ['session.status', {}],
      ['archive.search', { query: 'anything' }],
    ] as const) {
      answers.push(await mcp.callTool({ name, arguments: args }));
    }
    await mcp.close();
    const mcpText = JSON.stringify(answers);
    expect(mcpText).toContain('reddit-import');
    expect(mcpText).not.toContain(secret);

    // Nothing the server wrote to disk or printed holds it.
    const files = filesUnder(home);
    expect(files.map((f) => f.file)).toContain(paths.runFile);
    expect(files.filter((f) => f.text.includes(secret)).map((f) => f.file)).toEqual([]);
    expect(printed.filter((l) => l.includes(secret))).toEqual([]);
  });
});
