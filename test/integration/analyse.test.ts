import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LaunchFn } from '../../src/browser/manager.js';
import { lurkdPaths } from '../../src/paths.js';
import { startServer } from '../../src/server/main.js';
import type { AnalyseOut } from '../../src/sources/analyse.js';
import { fixture, pageCookie } from '../helpers/common.js';
import { html, startFixtureServer, type FixtureServer, type Handler } from '../helpers/fixture-server.js';

// D45 end to end: a real lurkd server with a real headless Chromium, against fixture forums on
// 127.0.0.1. The agent's token can queue an address; only the page's cookie and Origin make
// lurkd load one, through the read-only guard, once.

type Started = Awaited<ReturnType<typeof startServer>>;

const status = (code: number, body: string): Handler => (_req, res) => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};
const redirect = (to: string): Handler => (_req, res) => {
  res.writeHead(302, { location: to });
  res.end();
};

let dsc: FixtureServer;
let xf: FixtureServer;
let other: FixtureServer;
let home: string;
let s: Started;
/** D52: the page secret's cookie, from a one-time page link. */
let page: string;

const api = (p: string) => `http://127.0.0.1:${s.port}${p}`;
const pageHeaders = () => ({ cookie: page, origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/json' });
const agentHeaders = () => ({ authorization: `Bearer ${s.token}`, 'content-type': 'application/json' });
const fromPage = (p: string, body: unknown) => fetch(api(p), { method: 'POST', headers: pageHeaders(), body: JSON.stringify(body) });
const fromAgent = (p: string, body: unknown, extra: Record<string, string> = {}) =>
  fetch(api(p), { method: 'POST', headers: { ...agentHeaders(), ...extra }, body: JSON.stringify(body) });
const analyse = async (url: string) => {
  const r = await fromPage('/api/add/analyse', { url });
  return { status: r.status, body: (await r.json()) as AnalyseOut & { error?: { code: string; message: string } } };
};
const pageState = async () =>
  (await (await fetch(api('/api/state'), { headers: { cookie: page } })).json()) as {
    drafts: { id: number; sourceId: string; yaml: string; warnings: string[] }[];
    addRequests: { host: string; url: string }[];
  };

beforeAll(async () => {
  dsc = await startFixtureServer({
    '/': html(fixture('analyse/discourse.html')),
    '/private': redirect('/login'),
    '/login': html(fixture('analyse/discourse.html')),
  });
  xf = await startFixtureServer({ '/': html(fixture('analyse/xenforo.html')) });
  other = await startFixtureServer({
    '/': html(fixture('analyse/unknown.html')),
    '/challenge': status(403, fixture('detect/cloudflare-challenge.synthetic.html')),
    '/posting': html(
      fixture('analyse/unknown.html').replace(
        '</body>',
        `<script>fetch('/collect', { method: 'POST', body: 'x' }).catch(() => {}); navigator.sendBeacon('/collect', 'y');</script></body>`,
      ),
    ),
  });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-analyse-'));
  const seedDir = path.join(home, 'seed');
  const uiDir = path.join(home, 'ui-files');
  fs.mkdirSync(seedDir);
  fs.mkdirSync(uiDir);
  for (const f of ['index.html', 'app.js', 'view.js', 'app.css']) fs.writeFileSync(path.join(uiDir, f), '');
  // The fixture forums live on 127.0.0.1: only a test may let lurkd open loopback addresses.
  s = await startServer({ paths: lurkdPaths({ LURKD_HOME: home }), seedDir, uiDir, allowLoopbackForTests: true });
  page = await pageCookie(s.port, s.token);
});

afterAll(async () => {
  await s?.close();
  for (const f of [dsc, xf, other]) await f?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('Add a forum (D45)', () => {
  it('lets an agent queue an address but never makes lurkd load it', async () => {
    const r = await fromAgent('/api/add', { url: `${dsc.origin}/` });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'queued', host: '127.0.0.1', url: `${dsc.origin}/` });
    // The agent's token opens neither the analysis nor the draft, a forged Origin included.
    for (const p of ['/api/add/analyse', '/api/add/draft']) {
      expect((await fromAgent(p, { url: `${dsc.origin}/` })).status, p).toBe(401);
      expect((await fromAgent(p, { url: `${dsc.origin}/` }, { origin: `http://127.0.0.1:${s.port}` })).status, p).toBe(401);
    }
    expect(dsc.requests).toEqual([]);
    expect((await pageState()).addRequests).toEqual([{ host: '127.0.0.1', url: `${dsc.origin}/`, requestedAt: expect.any(String) }]);
  });

  it('analyses a Discourse page, reads its two rules pages and saves the draft, which shows in /api/state', async () => {
    const { status: code, body } = await analyse(`${dsc.origin}/`);
    expect(code).toBe(200);
    expect(body).toEqual({
      status: 'analysed',
      host: '127.0.0.1',
      block: null,
      forum: {
        engine: 'discourse',
        name: 'Plant Growers',
        base_url: dsc.origin,
        domains: ['127.0.0.1'],
        login_url: `${dsc.origin}/login`,
        search_url: null,
        signup_url: `${dsc.origin}/signup`,
        termsLinks: [
          { href: `${dsc.origin}/guidelines`, text: 'Guidelines' },
          { href: `${dsc.origin}/tos`, text: 'Terms of Service' },
        ],
      },
      // D49: this fixture forum has no rules pages, so nothing is prefilled.
      rules: {
        pages: [
          { url: `${dsc.origin}/tos`, outcome: 'unavailable' },
          { url: `${dsc.origin}/guidelines`, outcome: 'unavailable' },
        ],
        clause: null,
      },
      automation: { policy: 'unknown', rule_url: null, rule_quote: null },
    });
    expect(dsc.requests.filter((r) => r.url === '/')).toHaveLength(1);
    expect(dsc.requests.every((r) => r.method === 'GET')).toBe(true);
    // Only the two rules pages of D49 were read after it; no other link of the page was followed.
    const read = dsc.requests.map((r) => r.url).filter((u) => !/\.(?:png|jpe?g|gif|svg|ico|css|js|woff2?)(?:\?|$)/.test(u));
    expect(read).toEqual(['/', '/tos', '/guidelines']);

    const forum = (body as Extract<AnalyseOut, { status: 'analysed' }>).forum;
    const saved = await fromPage('/api/add/draft', { ...forum, topics: 'gardening, indoor-plants', automation: { policy: 'unknown', rule_url: `${dsc.origin}/tos` } });
    expect(saved.status).toBe(200);
    const out = (await saved.json()) as { status: string; draftId: number; sourceId: string };
    expect(out).toMatchObject({ status: 'draft_saved', host: '127.0.0.1', sourceId: '127-0-0-1' });
    const st = await pageState();
    expect(st.drafts.map((d) => d.id)).toEqual([out.draftId]);
    expect(st.drafts[0]!.yaml).toContain('status: untested');
    expect(st.drafts[0]!.yaml).toContain('enabled: false');
    expect(st.drafts[0]!.warnings).toContain(`signup_url: ${dsc.origin}/signup`);
    // The draft clears the request lurkd add queued for that host.
    expect(st.addRequests).toEqual([]);
  });

  it('recognises XenForo, and reports the schema errors of the form field by field', async () => {
    const { body } = await analyse(`${xf.origin}/`);
    expect(body).toMatchObject({
      status: 'analysed',
      forum: {
        engine: 'xenforo',
        name: 'Bench Electronics',
        base_url: xf.origin,
        login_url: `${xf.origin}/login/`,
        signup_url: `${xf.origin}/register/`,
        search_url: `${xf.origin}/search/?q={query}&o=date`,
        termsLinks: [{ href: `${xf.origin}/help/terms/`, text: 'Terms and rules' }],
      },
    });
    const forum = (body as Extract<AnalyseOut, { status: 'analysed' }>).forum;
    const refused = await fromPage('/api/add/draft', { ...forum, id: 'bench', topics: ['electronics'], automation: { policy: 'allowed', rule_url: `${xf.origin}/help/terms/` } });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { details: { errors: string[] } } }).error.details.errors).toEqual([
      'bench.yaml: automation.rule_quote is required when automation.policy is allowed',
    ]);
    const ok = await fromPage('/api/add/draft', {
      ...forum,
      id: 'bench',
      topics: ['electronics'],
      enabled: true,
      show_real_names: true,
      automation: { policy: 'allowed', rule_url: `${xf.origin}/help/terms/`, rule_quote: 'Automated reading is allowed.' },
    });
    expect(ok.status).toBe(200);
    const d = (await pageState()).drafts.find((x) => x.sourceId === 'bench')!;
    expect(d.yaml).toContain('enabled: false');
    expect(d.yaml).not.toContain('show_real_names');
  });

  it('lists the rules links of an unknown engine and keeps the guard on while it reads', async () => {
    const { body } = await analyse(`${other.origin}/posting`);
    expect(body).toMatchObject({ status: 'analysed', block: null, forum: { engine: null, name: 'Il Forum dei Modellisti', login_url: null, search_url: null } });
    expect((body as Extract<AnalyseOut, { status: 'analysed' }>).forum.termsLinks).toHaveLength(8);
    // The page's POST and beacon never left the browser.
    expect(other.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(other.requests.map((r) => r.url)).not.toContain('/collect');
  });

  it('returns a human check and a login wall to the page instead of failing', async () => {
    const challenge = await analyse(`${other.origin}/challenge`);
    expect(challenge.status).toBe(200);
    expect(challenge.body).toEqual({
      status: 'blocked',
      host: '127.0.0.1',
      block: { kind: 'challenge', message: '127.0.0.1 shows a human check, so lurkd could not read the page. lurkd does not try to get past it.' },
    });
    const login = await analyse(`${dsc.origin}/private`);
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ status: 'analysed', block: { kind: 'login' }, forum: { engine: 'discourse', base_url: dsc.origin } });
    expect(dsc.requests.filter((r) => r.url === '/private')).toHaveLength(1);
  });

  it('refuses an address it would not open before any request', async () => {
    const before = dsc.requests.length;
    for (const [url, code] of [
      [`${dsc.origin}/session/logout`, 'denied_path'],
      [`${dsc.origin}/t/x/1/vote`, 'denied_path'],
      [`http://alice:secret@127.0.0.1:${new URL(dsc.origin).port}/`, 'invalid_request'],
      ['https://10.0.0.8/', 'invalid_request'],
      ['file:///etc/passwd', 'invalid_request'],
    ] as const) {
      const r = await analyse(url);
      expect([url, r.body.error?.code]).toEqual([url, code]);
      expect(JSON.stringify(r.body)).not.toContain('secret');
    }
    expect(dsc.requests.length).toBe(before);
  });

  it('answers with the source id once a source claims the host, and loads nothing', async () => {
    const { drafts } = await pageState();
    const id = drafts.find((d) => d.sourceId === '127-0-0-1')!.id;
    expect((await fromPage(`/api/drafts/${id}/approve`, {})).status).toBe(200);
    const before = xf.requests.length;
    expect((await analyse(`${xf.origin}/`)).body).toEqual({ status: 'known', host: '127.0.0.1', sourceId: '127-0-0-1' });
    expect(await (await fromAgent('/api/add', { url: `${xf.origin}/` })).json()).toEqual({ status: 'known', host: '127.0.0.1', sourceId: '127-0-0-1' });
    expect(xf.requests.length).toBe(before);
  });
});

describe('Add a forum on a server started as lurkd start does (M1)', () => {
  let prod: Started;
  let prodHome: string;

  beforeAll(async () => {
    prodHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-analyse-prod-'));
    const seedDir = path.join(prodHome, 'seed');
    const uiDir = path.join(prodHome, 'ui-files');
    fs.mkdirSync(seedDir);
    fs.mkdirSync(uiDir);
    // No browser is needed: every loopback address is refused before one would open.
    const noBrowser: LaunchFn = async () => {
      throw new Error('no browser here');
    };
    prod = await startServer({ paths: lurkdPaths({ LURKD_HOME: prodHome }), seedDir, uiDir, launch: noBrowser });
  });

  afterAll(async () => {
    await prod?.close();
    if (prodHome) fs.rmSync(prodHome, { recursive: true, force: true });
  });

  it('refuses loopback addresses through lurkd add and the page, whatever their spelling or port', async () => {
    const at = (p: string) => `http://127.0.0.1:${prod.port}${p}`;
    const port = new URL(dsc.origin).port;
    const before = dsc.requests.length;
    for (const url of [`${dsc.origin}/`, `http://localhost:${port}/`, `http://127.1:${port}/`, `http://0x7f.0.0.1:${port}/`, `http://2130706433:${port}/`, `http://[::1]:${port}/`]) {
      const queued = await fetch(at('/api/add'), { method: 'POST', headers: { authorization: `Bearer ${prod.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
      expect([url, queued.status]).toEqual([url, 400]);
      expect(((await queued.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
      const analysed = await fetch(at('/api/add/analyse'), {
        method: 'POST',
        headers: { cookie: await pageCookie(prod.port, prod.token), origin: `http://127.0.0.1:${prod.port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      expect([url, analysed.status]).toEqual([url, 400]);
    }
    expect(dsc.requests.length).toBe(before);
  });
});
