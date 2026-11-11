import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lurkdPaths } from '../../src/paths.js';
import { startServer } from '../../src/server/main.js';
import type { AnalyseOut } from '../../src/sources/analyse.js';
import { fixture, pageCookie } from '../helpers/common.js';
import { html, startFixtureServer, type FixtureServer, type Handler } from '../helpers/fixture-server.js';

// D49 end to end: "Analyse" reads the rules pages of fixture forums on 127.0.0.1 with a real
// headless Chromium, finds the sentence that forbids automated access, prefills the form and
// writes the forbidden log; the page's "Add anyway" and "Dismiss" act on the log. Every fixture
// forum is on 127.0.0.1, so they share one log entry: the tests run in order.

type Started = Awaited<ReturnType<typeof startServer>>;
type Analysed = Extract<AnalyseOut, { status: 'analysed' }>;

const DISCOURSE_CLAUSE =
  'You may not automate access to the forum, or monitor the forum, such as with a web crawler, browser plug-in or add-on, or other computer program that is not a web browser.';
const GUIDELINES_CLAUSE = 'Do not use bots, scrapers or other automated tools to read or copy this forum.';
const XENFORO_CLAUSE = 'The use of bots, scrapers or other automated tools to read or copy content from this forum is not permitted.';

const status = (code: number, body: string): Handler => (_req, res) => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};
const rules = (file: string) => html(fixture(`analyse/rules/${file}`));

let sustain: FixtureServer;
let withTos: FixtureServer;
let noTos: FixtureServer;
let challenged: FixtureServer;
let xf: FixtureServer;
let other: FixtureServer;
let home: string;
let s: Started;
/** D52: the page secret's cookie, from a one-time page link. */
let page: string;

const api = (p: string) => `http://127.0.0.1:${s.port}${p}`;
const pageHeaders = () => ({ cookie: page, origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/json' });
const agentHeaders = () => ({ authorization: `Bearer ${s.token}`, 'content-type': 'application/json' });
const fromPage = (method: string, p: string, body?: unknown) =>
  fetch(api(p), { method, headers: pageHeaders(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const analyse = async (url: string): Promise<Analysed> => {
  const r = await fromPage('POST', '/api/add/analyse', { url });
  expect(r.status).toBe(200);
  const body = (await r.json()) as AnalyseOut;
  expect(body.status).toBe('analysed');
  return body as Analysed;
};
const pageState = async () =>
  (await (await fetch(api('/api/state'), { headers: { cookie: page } })).json()) as {
    forbidden: { host: string; name: string; engine: string | null; baseUrl: string; ruleUrl: string; sentence: string; foundAt: string; sourceId: string | null }[];
    drafts: { id: number; sourceId: string; yaml: string }[];
    sources: { id: string; enabled: boolean; policy: string; needsAcknowledgment: boolean }[];
  };
/** The pages a fixture forum served, without the images, styles and favicon the pages load. */
const served = (f: FixtureServer) => f.requests.map((r) => r.url).filter((u) => !/\.(?:png|jpe?g|gif|svg|ico|css|js|woff2?)(?:\?|$)/.test(u));

beforeAll(async () => {
  sustain = await startFixtureServer({ '/': html(fixture('analyse/discourse.html')), '/tos': rules('sustain-tos.html'), '/guidelines': rules('sustain-tos.html') });
  withTos = await startFixtureServer({ '/': html(fixture('analyse/discourse.html')), '/tos': rules('discourse-tos.html'), '/guidelines': rules('discourse-guidelines.html') });
  noTos = await startFixtureServer({ '/': html(fixture('analyse/discourse.html')), '/guidelines': rules('discourse-guidelines.html') });
  challenged = await startFixtureServer({
    '/': html(fixture('analyse/discourse.html')),
    '/tos': status(403, fixture('detect/cloudflare-challenge.synthetic.html')),
    '/guidelines': rules('discourse-guidelines.html'),
  });
  xf = await startFixtureServer({ '/': html(fixture('analyse/xenforo.html')), '/help/terms/': rules('xenforo-terms.html') });
  other = await startFixtureServer({
    '/': html(fixture('analyse/unknown.html')),
    '/regolamento/': html('<!DOCTYPE html><html><head><title>Regolamento</title></head><body><h1>Rules</h1><p>Bots, scrapers and other automated tools are not allowed on this forum.</p></body></html>'),
    '/faq/': html('<!DOCTYPE html><html><body><p>You may not use bots.</p></body></html>'),
  });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-rules-'));
  const seedDir = path.join(home, 'seed');
  const uiDir = path.join(home, 'ui-files');
  fs.mkdirSync(seedDir);
  fs.mkdirSync(uiDir);
  for (const f of ['index.html', 'app.js', 'view.js', 'app.css']) fs.writeFileSync(path.join(uiDir, f), '');
  s = await startServer({ paths: lurkdPaths({ LURKD_HOME: home }), seedDir, uiDir, allowLoopbackForTests: true });
  page = await pageCookie(s.port, s.token);
});

afterAll(async () => {
  await s?.close();
  for (const f of [sustain, withTos, noTos, challenged, xf, other]) await f?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('Rules pages and the forbidden log (D49)', () => {
  it('reads /tos and /guidelines of a Discourse forum without a clause and leaves the policy unknown', async () => {
    const out = await analyse(`${sustain.origin}/`);
    expect(out.rules).toEqual({
      pages: [
        { url: `${sustain.origin}/tos`, outcome: 'read' },
        { url: `${sustain.origin}/guidelines`, outcome: 'read' },
      ],
      clause: null,
    });
    expect(out.automation).toEqual({ policy: 'unknown', rule_url: null, rule_quote: null });
    expect(served(sustain)).toEqual(['/', '/tos', '/guidelines']);
    expect(sustain.requests.every((r) => r.method === 'GET')).toBe(true);
    expect((await pageState()).forbidden).toEqual([]);
  });

  it('finds the default Discourse clause on /tos, prefills the form, logs it and reads no further page', async () => {
    const out = await analyse(`${withTos.origin}/`);
    expect(out.rules).toEqual({ pages: [{ url: `${withTos.origin}/tos`, outcome: 'read' }], clause: { url: `${withTos.origin}/tos`, sentence: DISCOURSE_CLAUSE } });
    expect(out.automation).toEqual({ policy: 'forbidden', rule_url: `${withTos.origin}/tos`, rule_quote: DISCOURSE_CLAUSE });
    expect(served(withTos)).toEqual(['/', '/tos']);
    expect((await pageState()).forbidden).toEqual([
      {
        host: '127.0.0.1',
        name: 'Plant Growers',
        engine: 'discourse',
        baseUrl: withTos.origin,
        ruleUrl: `${withTos.origin}/tos`,
        sentence: DISCOURSE_CLAUSE,
        foundAt: expect.any(String),
        sourceId: null,
      },
    ]);
  });

  it('counts the rules pages like every other request of the job', () => {
    const db = new Database(lurkdPaths({ LURKD_HOME: home }).archiveDb, { readonly: true });
    try {
      const rows = db.prepare("SELECT url FROM fetch_log WHERE source_id = '127-0-0-1' AND kind = 'navigate'").all() as { url: string }[];
      expect(rows.map((r) => r.url)).toEqual(expect.arrayContaining([`${withTos.origin}/`, `${withTos.origin}/tos`, `${sustain.origin}/guidelines`]));
    } finally {
      db.close();
    }
  });

  it('reads the copy Discourse serves in noscript when /tos is missing, and the latest clause wins', async () => {
    const out = await analyse(`${noTos.origin}/`);
    expect(out.rules).toEqual({
      pages: [
        { url: `${noTos.origin}/tos`, outcome: 'unavailable' },
        { url: `${noTos.origin}/guidelines`, outcome: 'read' },
      ],
      clause: { url: `${noTos.origin}/guidelines`, sentence: GUIDELINES_CLAUSE },
    });
    const { forbidden } = await pageState();
    expect(forbidden).toHaveLength(1);
    expect(forbidden[0]).toMatchObject({ ruleUrl: `${noTos.origin}/guidelines`, sentence: GUIDELINES_CLAUSE });
  });

  it('stops at a human check on a rules page and reads no further page', async () => {
    const out = await analyse(`${challenged.origin}/`);
    expect(out.rules).toEqual({ pages: [{ url: `${challenged.origin}/tos`, outcome: 'challenge' }], clause: null });
    // The challenge page loads its own script; lurkd itself opens no page after /tos.
    expect(served(challenged).filter((u) => !u.startsWith('/cdn-cgi/'))).toEqual(['/', '/tos']);
    // The earlier entry stays: an analysis without a clause does not clear the log.
    expect((await pageState()).forbidden).toHaveLength(1);
  });

  it('reads only the first rules link of an unknown engine; "Add anyway" refuses that engine and "Dismiss" clears the entry', async () => {
    const out = await analyse(`${other.origin}/`);
    expect(out.rules).toEqual({
      pages: [{ url: `${other.origin}/regolamento/`, outcome: 'read' }],
      clause: { url: `${other.origin}/regolamento/`, sentence: 'Bots, scrapers and other automated tools are not allowed on this forum.' },
    });
    expect(served(other)).toEqual(['/', '/regolamento/']);
    expect((await pageState()).forbidden).toMatchObject([{ engine: null, name: 'Il Forum dei Modellisti' }]);
    const refused = await fromPage('POST', '/api/forbidden/127.0.0.1/draft', { topics: 'modelling' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { details: { field: string } } }).error.details.field).toBe('engine');
    const dismissed = await fromPage('DELETE', '/api/forbidden/127.0.0.1');
    expect(await dismissed.json()).toEqual({ dismissed: '127.0.0.1' });
    expect((await pageState()).forbidden).toEqual([]);
  });

  it('keeps the log away from agents', async () => {
    await analyse(`${xf.origin}/`);
    expect((await fetch(api('/api/state'), { headers: agentHeaders() })).status).toBe(401);
    for (const [method, p] of [
      ['POST', '/api/forbidden/127.0.0.1/draft'],
      ['DELETE', '/api/forbidden/127.0.0.1'],
    ] as const) {
      const r = await fetch(api(p), { method, headers: { ...agentHeaders(), origin: `http://127.0.0.1:${s.port}` }, body: JSON.stringify({ topics: 'electronics' }) });
      expect([p, r.status]).toEqual([p, 401]);
    }
    expect((await pageState()).forbidden).toMatchObject([{ engine: 'xenforo', sentence: XENFORO_CLAUSE, ruleUrl: `${xf.origin}/help/terms/` }]);
    expect(served(xf)).toEqual(['/', '/help/terms/']);
  });

  it('"Add anyway" drafts a XenForo source that lands switched off with policy forbidden and needs "I accept"', async () => {
    const r = await fromPage('POST', '/api/forbidden/127.0.0.1/draft', { topics: 'electronics' });
    expect(r.status).toBe(200);
    const out = (await r.json()) as { status: string; draftId: number; sourceId: string };
    expect(out).toMatchObject({ status: 'draft_saved', host: '127.0.0.1', sourceId: '127-0-0-1' });
    const st = await pageState();
    expect(st.forbidden).toEqual([]);
    const draft = st.drafts.find((d) => d.id === out.draftId)!;
    expect(YAML.parse(draft.yaml)).toMatchObject({
      engine: 'xenforo',
      enabled: false,
      status: 'untested',
      automation: { policy: 'forbidden', rule_url: `${xf.origin}/help/terms/`, rule_quote: XENFORO_CLAUSE },
    });
    expect((await fromPage('POST', `/api/drafts/${out.draftId}/approve`, {})).status).toBe(200);
    expect((await pageState()).sources.find((x) => x.id === '127-0-0-1')).toMatchObject({ enabled: false, policy: 'forbidden', needsAcknowledgment: true });
    const on = await fromPage('POST', '/api/sources/127-0-0-1/enable', {});
    expect(((await on.json()) as { error: { code: string } }).error.code).toBe('needs_acknowledgment');
    expect((await fromPage('POST', '/api/sources/127-0-0-1/enable', { acknowledge: true })).status).toBe(200);
  });
});
