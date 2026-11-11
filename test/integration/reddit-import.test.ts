import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LaunchFn } from '../../src/browser/manager.js';
import { runCommand } from '../../src/cli/commands.js';
import { createApiClient } from '../../src/client/api.js';
import { lurkdPaths, PACKAGE_ROOT, type LurkdPaths } from '../../src/paths.js';
import { findLeaks } from '../../src/pseudonym.js';
import { startServer } from '../../src/server/main.js';
import { pageCookie } from '../helpers/common.js';

// D50 end to end: a lurkd server started as lurkd start starts it, the CLI reading a saved
// thread file and sending its content, the page's upload route, and the archive answering for
// the thread afterwards. The browser cannot launch here, so any attempt to read a page would
// fail: every answer below comes from the file and the archive.

type Started = Awaited<ReturnType<typeof startServer>>;

const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin'];
const FIXTURES = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'reddit');

let home: string;
let paths: LurkdPaths;
let s: Started;
/** D52: the page secret's cookie, from a one-time page link. */
let pageCookieValue: string;
let launches = 0;

const cli = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCommand(argv, {
    client: createApiClient(paths),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    statFile: (p) => {
      const st = fs.statSync(p);
      return { isFile: st.isFile(), size: st.size };
    },
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

const page = (p: string, body: string) =>
  fetch(`http://127.0.0.1:${s.port}${p}`, {
    method: 'POST',
    headers: { cookie: pageCookieValue, origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/json' },
    body,
  });

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-reddit-import-'));
  const seedDir = path.join(home, 'seed');
  const uiDir = path.join(home, 'ui-files');
  fs.mkdirSync(seedDir);
  fs.mkdirSync(uiDir);
  const noBrowser: LaunchFn = async () => {
    launches += 1;
    throw new Error('no browser here');
  };
  paths = lurkdPaths({ LURKD_HOME: home });
  s = await startServer({ paths, seedDir, uiDir, launch: noBrowser });
  pageCookieValue = await pageCookie(s.port, s.token);
});

afterAll(async () => {
  await s?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('lurkd import reddit against a running server', () => {
  it('imports the saved file, then search and fetch answer from the archive under pseudonyms', async () => {
    const before = launches;
    const imported = await cli(['import', 'reddit', path.join(FIXTURES, 'thread.json')]);
    expect(imported.err).toBe('');
    expect(imported.code).toBe(0);
    expect(imported.out).toContain('Imported the saved Reddit thread into the archive as thread 1 of reddit-import: 8 posts, the post and 7 comments. 11 more comments were not in the saved file.');
    expect(findLeaks(imported.out, NAMES)).toEqual(new Map());

    const found = await cli(['search', 'extension cable']);
    expect(found.code).toBe(0);
    expect(found.out).toContain('Hit 1: reddit-import, post ');
    expect(findLeaks(found.out, NAMES)).toEqual(new Map());

    const read = await cli(['fetch', 'reddit-import', '--url', 'https://redd.it/1k2m3n4']);
    expect(read.code).toBe(0);
    expect(read.out).toContain('Thread 1 of 1 (source reddit-import), from the archive, quality full.');
    expect(read.out).toContain('imported: "from a saved file; lurkd did not contact the site"');
    expect(read.out).toContain('imported_by: "lurkd import / API"');
    expect(read.out).not.toContain('replaced:');
    expect(read.out).toContain('_7 more comments are not in the saved file._');
    expect(findLeaks(read.out, NAMES)).toEqual(new Map());

    const again = await cli(['import', 'reddit', path.join(FIXTURES, 'thread.json')]);
    expect(again.out).toMatch(/Replaced the earlier import of this thread from \d{4}-\d\d-\d\d \d\d:\d\d UTC in the archive \(thread 1 of reddit-import\)/);
    const json = await cli(['import', 'reddit', path.join(FIXTURES, 'thread.json'), '--json']);
    const answer = JSON.parse(json.out) as { replaced: boolean; replacedImportAt: string; importedAt: string; importedBy: string };
    expect([answer.replaced, answer.importedBy]).toEqual([true, 'lurkd import / API']);
    expect(Date.parse(answer.replacedImportAt)).toBeLessThanOrEqual(Date.parse(answer.importedAt));
    const reread = await cli(['fetch', 'reddit-import', '--url', 'https://redd.it/1k2m3n4']);
    expect(reread.out).toContain(`replaced: "${answer.replacedImportAt}"`);
    expect(launches).toBe(before);
  });

  it('answers a live read of any Reddit address with the import steps', async () => {
    const r = await cli(['fetch', 'reddit-import', '--url', 'https://www.reddit.com/r/homeassistant/comments/9zy8x7/backups/']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^Error unsupported: lurkd does not read Reddit\. .*https:\/\/www\.reddit\.com\/comments\/9zy8x7\.json.*lurkd import reddit <file>/);
    const q = await cli(['fetch', 'reddit-import', '--query', 'zigbee']);
    expect(q.err).toMatch(/^Error unsupported: /);
    const refresh = await cli(['fetch', 'reddit-import', '--url', 'https://redd.it/1k2m3n4', '--refresh']);
    expect(refresh.err).toMatch(/^Error unsupported: /);
    const added = await cli(['add', 'https://old.reddit.com/r/homeassistant/']);
    expect(added.err).toMatch(/^Error unsupported: /);
  });

  it('refuses a file that is not one thread and saves nothing', async () => {
    const bad = path.join(home, 'listing.json');
    fs.copyFileSync(path.join(FIXTURES, 'subreddit-listing.json'), bad);
    const r = await cli(['import', 'reddit', bad]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^Error invalid_request: The file holds a list of posts, not one thread\./);
    const dir = await cli(['import', 'reddit', FIXTURES]);
    expect(dir.err).toMatch(/is not a regular file/);
    const up = await page('/api/import/reddit/upload', '{"kind":"Listing","data":{"children":[]}}');
    expect(up.status).toBe(400);
    expect(((await up.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('takes the same file through the page upload, and lists the built-in source', async () => {
    const up = await page('/api/import/reddit/upload', fs.readFileSync(path.join(FIXTURES, 'thread-escaped.json'), 'utf8'));
    expect(up.status).toBe(200);
    expect(await up.json()).toMatchObject({
      source: 'reddit-import',
      url: 'https://www.reddit.com/comments/9zy8x7/',
      posts: 2,
      comments: 1,
      replaced: false,
      replacedImportAt: null,
      importedBy: 'page upload',
    });
    const read = await cli(['fetch', 'reddit-import', '--url', 'https://redd.it/9zy8x7']);
    expect(read.out).toContain('imported_by: "page upload"');
    const bearer = await fetch(`http://127.0.0.1:${s.port}/api/import/reddit/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: '[]',
    });
    expect(bearer.status).toBe(401);
    const state = (await (await fetch(`http://127.0.0.1:${s.port}/api/state`, { headers: { cookie: pageCookieValue } })).json()) as {
      sources: { id: string; engine: string; enabled: boolean; seed: boolean }[];
    };
    expect(state.sources.find((v) => v.id === 'reddit-import')).toMatchObject({ engine: 'import', enabled: false, seed: true });
    const on = await page('/api/sources/reddit-import/enable', JSON.stringify({ acknowledge: true }));
    expect(on.status).toBe(400);
  });

  it('imports a body of 1,000,000 spaces through both routes without holding up the server (H1)', async () => {
    const doc = JSON.stringify([
      { kind: 'Listing', data: { children: [{ kind: 't3', data: { id: 'sp4ce', title: 'Spaces', author: 'alice', selftext: `${' '.repeat(1_000_000)}x` } }] } },
      { kind: 'Listing', data: { children: [] } },
    ]);
    for (const send of [
      () => page('/api/import/reddit/upload', doc),
      () =>
        fetch(`http://127.0.0.1:${s.port}/api/import/reddit`, {
          method: 'POST',
          headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
          body: doc,
        }),
    ]) {
      const t0 = performance.now();
      const r = await send();
      expect(r.status).toBe(200);
      expect(performance.now() - t0).toBeLessThan(2000);
    }
    const read = await cli(['fetch', 'reddit-import', '--url', 'https://redd.it/sp4ce']);
    expect(read.out).toMatch(/\n\nx\n/);
  });

  it('logged no request at all', () => {
    const db = new Database(paths.archiveDb, { readonly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM fetch_log').get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM threads WHERE source_id = 'reddit-import'").get()).toEqual({ n: 3 });
    } finally {
      db.close();
    }
  });
});
