// The only networked script. It starts the built server (dist/server/main.js) with a temporary
// LURKD_HOME, headless, acknowledges each public_read source in that state, reads one public
// thread per source, checks the result and prints one line per source: counts only, never a user
// name or a post text. Nothing is written into the repository. Run `npm run build` first.
//
//   npm run smoke
//
// Exit 0 when every public_read source passes, 1 otherwise. No source is logged into, no forbidden
// source is touched, and the temporary home is removed at the end (LURKD_SMOKE_KEEP=1 keeps it).

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { createApiClient, type ApiClient } from '../src/client/api.js';
import { ensureServer, isOurServer, stopServer } from '../src/launcher/launcher.js';
import { readRunFile } from '../src/launcher/runfile.js';
import { lurkdPaths, PACKAGE_ROOT, type LurkdPaths } from '../src/paths.js';
import { findLeaks } from '../src/pseudonym.js';
import { parseSource, type SourceConfig } from '../src/sources/schema.js';

/** One public thread per public_read source (two pages or 40 posts at least). Edit here when one disappears. */
const THREADS: Record<string, string> = {
  'level1techs': 'https://forum.level1techs.com/t/devember-2026-home-lab-edition/257902',
  'servethehome': 'https://forums.servethehome.com/index.php?threads/amd-v620.55929/',
  'openwrt': 'https://forum.openwrt.org/t/shunt-policy-based-routing-for-any-dns-backend/252748',
  'hardforum': 'https://hardforum.com/threads/anyone-like-to-share-their-3d-mark-fire-strike-score.1772471/',
  'letsencrypt': 'https://community.letsencrypt.org/t/secondary-servfail-dns-error-running-certbot/244512',
  'pi-hole': 'https://discourse.pi-hole.net/t/unable-to-install-pi-hole-dependency-package/87986',
  'bitwarden': 'https://community.bitwarden.com/t/desktop-app-redesign-update/97342',
  'veganforum': 'https://www.veganforum.org/threads/is-sea-moss-really-as-great-for-nutrition.18094/',
  'home-assistant': 'https://community.home-assistant.io/t/slightly-improved-weather-forecast-card-for-home-assistant/966687',
  'openhab': 'https://community.openhab.org/t/withings-health-binding-5-0-0-0-6-0-0-0/168979',
};

const MIN_POSTS = 40;
const MIN_PAGES = 2;

interface FetchResponse {
  threads: { url: string; markdown: string; truncated: boolean; quality: 'full' | 'low' }[];
  stopped: { code: string; message: string } | null;
  requestsUsed: number;
}

interface SignalsResponse {
  postCount: number | null;
  joinedAt: string | null;
  extra: string[];
}

/** The public_read sources of the seed directory, parsed with the same parser the server uses. */
function publicReadSources(): SourceConfig[] {
  const root = path.join(PACKAGE_ROOT, 'sources');
  const out: SourceConfig[] = [];
  for (const rel of fs.globSync('**/*.yaml', { cwd: root }).sort()) {
    const r = parseSource(fs.readFileSync(path.join(root, rel), 'utf8'), { file: path.basename(rel) });
    if (!r.ok) throw new Error(r.errors.join('\n'));
    if (r.source.status === 'public_read') out.push(r.source);
  }
  return out;
}

/** The page routes want the cookie and the page's Origin; this is what the lurkd page sends. */
function pagePost(port: number, token: string, route: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        headers: {
          cookie: `lurkd_token=${token}`,
          origin: `http://127.0.0.1:${port}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

interface Facts {
  numbers: number[];
  pages: number | null;
  postsExpected: number | null;
  names: string[];
  detections: number;
  /** Posts the extractor marked as topic events (Discourse small actions). */
  events: number;
}

/** What the archive holds for the thread: post numbers, the page count, and the real author names for the leak check. */
function archiveFacts(db: Database.Database, sourceId: string): Facts {
  const thread = db.prepare('SELECT id, pages, posts_expected FROM threads WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(sourceId) as
    | { id: number; pages: number | null; posts_expected: number | null }
    | undefined;
  if (!thread) return { numbers: [], pages: null, postsExpected: null, names: [], detections: 0, events: 0 };
  const numbers = (db.prepare('SELECT number FROM posts WHERE thread_id = ? ORDER BY number').all(thread.id) as { number: number }[]).map((r) => r.number);
  const names = (db.prepare('SELECT DISTINCT author FROM posts WHERE thread_id = ?').all(thread.id) as { author: string }[]).map((r) => r.author);
  const known = db.prepare('SELECT username FROM authors WHERE source_id = ?').all(sourceId) as { username: string }[];
  const detections = (db.prepare("SELECT COUNT(*) AS n FROM fetch_log WHERE source_id = ? AND kind = 'detection'").get(sourceId) as { n: number }).n;
  const events = (db.prepare("SELECT COUNT(*) AS n FROM posts WHERE thread_id = ? AND notes LIKE '%topic event%'").get(thread.id) as { n: number }).n;
  return {
    numbers,
    events,
    pages: thread.pages,
    postsExpected: thread.posts_expected,
    names: [...new Set([...names, ...known.map((k) => k.username)])].filter((n) => n.trim() !== ''),
    detections,
  };
}

const front = (md: string, key: string): string | null => new RegExp(`^${key}: (.*)$`, 'm').exec(md)?.[1]?.trim() ?? null;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Splits the Markdown into the text where a name sits in a structural position (post headers,
 * quote headers, `@mentions`, "#12 by name" link text) and the rest, which is free text. `names`
 * are the real author names of the thread: a name with spaces ("Erin Smith") is matched whole
 * after `@` and after `#12 by`, so none of it is left behind in the free text. A mention or link
 * text with a name that is not in the list still counts as structural, up to the next space.
 */
export function structural(md: string, names: readonly string[] = []): { structural: string; free: string } {
  const known = names
    .filter((n) => n.trim() !== '')
    .sort((x, y) => y.length - x.length)
    .map(escapeRe);
  const who = known.length > 0 ? `(?:${known.join('|')})(?![\\p{L}\\p{N}_])|\\S+` : '\\S+';
  const spot = new RegExp(`@(?:${who})|#\\d+ by (?:${who})`, 'giu');
  const s: string[] = [];
  const f: string[] = [];
  for (const line of md.split('\n')) {
    if (/^## #\d+/.test(line) || /^(?:>\s*)+\S.* wrote\b/.test(line)) s.push(line);
    else {
      for (const m of line.matchAll(spot)) s.push(m[0]);
      f.push(line.replace(spot, ' '));
    }
  }
  return { structural: s.join('\n'), free: f.join('\n') };
}

const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

interface Result {
  line: string;
  ok: boolean;
}

async function smokeOne(
  source: SourceConfig,
  ctx: { api: ApiClient; db: Database.Database; port: number; token: string; seen: Map<string, string> },
): Promise<Result> {
  const id = source.id;
  const url = THREADS[id];
  if (url === undefined) return { ok: false, line: `FAIL ${id}: no thread named in scripts/smoke.ts` };
  const problems: string[] = [];
  const status = await pagePost(ctx.port, ctx.token, `/api/sources/${encodeURIComponent(id)}/enable`, { acknowledge: true });
  if (status !== 200) return { ok: false, line: `FAIL ${id}: could not acknowledge the source (HTTP ${status})` };

  let res: FetchResponse;
  try {
    res = await ctx.api.post<FetchResponse>('/api/fetch', { source: id, url, max_threads: 1, max_chars: 200_000 });
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'error';
    // lurkd's own messages carry no author names (D20); one line, cut short.
    const why = e instanceof Error ? e.message.split('\n')[0]!.slice(0, 200) : '';
    return { ok: false, line: `FAIL ${id}: fetch stopped with ${code}: ${why}` };
  }
  const t = res.threads[0];
  if (res.stopped !== null) problems.push(`stopped ${res.stopped.code}`);
  if (!t) return { ok: false, line: `FAIL ${id}: no thread came back` };

  const md = t.markdown;
  const postCount = Number(front(md, 'post_count') ?? Number.NaN);
  const expectedRaw = front(md, 'posts_expected');
  const facts = archiveFacts(ctx.db, id);
  const enough = postCount >= MIN_POSTS || (facts.pages ?? 1) >= MIN_PAGES;
  if (!enough) problems.push(`only ${postCount} posts on ${facts.pages ?? 1} page(s)`);
  if (t.truncated) problems.push('truncated');
  if (t.quality !== 'full') problems.push(`quality ${t.quality}`);

  if (source.engine === 'discourse') {
    // Topic events (C8) stay in the thread as posts of their own, so posts_expected, which counts
    // posts only, equals post_count once the events are taken off.
    const expected = Number(expectedRaw);
    if (expectedRaw === null || expectedRaw === 'unknown' || (expected !== postCount && expected !== postCount - facts.events))
      problems.push(`post_count ${postCount} (${facts.events} topic events) != posts_expected ${expectedRaw}`);
  } else {
    // DOM engines have no expected count: the numbering has to run from 1 without a gap.
    const n = facts.numbers;
    if (n.length !== postCount || n.some((v, i) => v !== i + 1)) problems.push('numbering is not continuous from 1');
  }

  const names = facts.names;
  const parts = structural(md, names);
  const structLeaks = sum(findLeaks(parts.structural, names));
  const freeLeaks = sum(findLeaks(parts.free, names));
  const freeNames = findLeaks(parts.free, names).size;
  if (structLeaks > 0) problems.push(`${structLeaks} real name(s) in structural positions`);
  if (!/author-[0-9a-f]{10}/.test(md)) problems.push('no pseudonym in the output');
  if (facts.detections > 0) problems.push(`${facts.detections} detection(s)`);

  const pseudonym = /author-[0-9a-f]{10}/.exec(md)?.[0];
  if (source.engine === 'discourse' && pseudonym !== undefined) ctx.seen.set(id, pseudonym);

  const line =
    `${id} engine=${source.engine} posts=${Number.isNaN(postCount) ? '?' : postCount}` +
    `${source.engine === 'discourse' ? `/${expectedRaw ?? '?'} events=${facts.events}` : ` pages=${facts.pages ?? '?'}`} requests=${res.requestsUsed}` +
    ` struct_leaks=${structLeaks} free_text_names=${freeNames} free_text_hits=${freeLeaks} detections=${facts.detections}`;
  return problems.length === 0 ? { ok: true, line: `ok   ${line}` } : { ok: false, line: `FAIL ${line} :: ${problems.join('; ')}` };
}

/**
 * P34 and Task 10: which fields a Discourse profile JSON (`/u/<name>.json`) served, through the real
 * adapter, by field name. One request per source, made after its thread was checked: a forum that
 * hides profiles from visitors answers 403, which lurkd reads as a login page.
 */
async function profileFields(api: ApiClient, id: string, pseudonym: string | undefined): Promise<string> {
  if (pseudonym === undefined) return `profile ${id}: skipped (no pseudonym in the thread)`;
  try {
    const s = await api.post<SignalsResponse>('/api/author-signals', { source: id, author: pseudonym });
    const extra = (prefix: string): string => (s.extra.some((e) => e.startsWith(prefix)) ? 'served' : 'absent');
    return (
      `profile ${id} /u/<name>.json: ` +
      `user.post_count=${s.postCount === null ? 'null' : 'served'} user.created_at=${s.joinedAt === null ? 'null' : 'served'} ` +
      `user.trust_level=${extra('trust level')} user.badge_count=${extra('badge')}`
    );
  } catch (e) {
    return `profile ${id} /u/<name>.json: not served to visitors (${(e as { code?: string }).code ?? 'error'})`;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ShutdownDeps {
  stop: (paths: LurkdPaths) => Promise<'stopped' | 'not_running'>;
  readRun: (paths: LurkdPaths) => { pid: number } | null;
  isOurServer: (pid: number) => boolean;
  isAlive: (pid: number) => boolean;
  kill: (pid: number) => void;
  wait: (ms: number) => Promise<void>;
  rmHome: (home: string) => void;
}

const REAL_SHUTDOWN: ShutdownDeps = {
  stop: stopServer,
  readRun: readRunFile,
  isOurServer,
  isAlive,
  kill: (pid) => process.kill(pid, 'SIGKILL'),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  rmHome: (home) => fs.rmSync(home, { recursive: true, force: true }),
};

/**
 * Stops the server of the temporary home, then removes the home (it holds the real author names of
 * the threads read). When `stopServer` throws, the pid of the run file is killed, but only when
 * `isOurServer` says it is lurkd's server. The home is never removed while that pid is alive.
 * Returns what happened, for one printed line.
 */
export async function shutdownSmoke(
  paths: LurkdPaths,
  home: string,
  opts: { keep?: boolean } = {},
  deps: ShutdownDeps = REAL_SHUTDOWN,
): Promise<{ server: 'stopped' | 'not_running' | 'killed' | 'alive'; homeRemoved: boolean; error: string | null }> {
  const pid = deps.readRun(paths)?.pid ?? null;
  let server: 'stopped' | 'not_running' | 'killed' | 'alive' = 'stopped';
  let error: string | null = null;
  try {
    server = await deps.stop(paths);
  } catch (e) {
    error = e instanceof Error ? e.message.split('\n')[0]! : 'error';
    const now = deps.readRun(paths)?.pid ?? pid;
    if (now !== null && deps.isAlive(now) && deps.isOurServer(now)) {
      deps.kill(now);
      for (let i = 0; i < 20 && deps.isAlive(now); i++) await deps.wait(100);
    }
    server = now !== null && deps.isAlive(now) ? 'alive' : 'killed';
  }
  const alive = pid !== null && deps.isAlive(pid);
  if (server === 'alive' || alive) return { server: 'alive', homeRemoved: false, error };
  if (opts.keep) return { server, homeRemoved: false, error };
  deps.rmHome(home);
  return { server, homeRemoved: true, error };
}

async function main(): Promise<number> {
  const sources = publicReadSources();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-smoke-'));
  process.env.LURKD_HOME = home;
  const paths: LurkdPaths = lurkdPaths(process.env);
  const keep = process.env.LURKD_SMOKE_KEEP === '1';
  let failed = 0;
  let db: Database.Database | null = null;
  let starting: Promise<unknown> = Promise.resolve();
  let finishing = false;

  // Ctrl-C or a kill: the server runs detached, so it and its temp home (which holds real author
  // names) would stay behind. Stop it, remove the home, then exit with the signal's code.
  const onSignal = (signal: 'SIGINT' | 'SIGTERM', code: number): void => {
    if (finishing) return;
    finishing = true;
    void (async () => {
      console.log(`smoke: ${signal}, stopping the server and removing the temp home`);
      // A server that is still starting writes its run file late: wait for that first.
      await starting.catch(() => {});
      db?.close();
      const r = await shutdownSmoke(paths, home, { keep });
      console.log(r.homeRemoved ? `smoke: server ${r.server}, temp home removed` : `smoke: server ${r.server}, temp home left at ${home}`);
      process.exit(code);
    })();
  };
  process.on('SIGINT', () => onSignal('SIGINT', 130));
  process.on('SIGTERM', () => onSignal('SIGTERM', 143));

  try {
    if (!fs.existsSync(path.join(PACKAGE_ROOT, 'dist', 'server', 'main.js'))) throw new Error('dist/server/main.js is missing: run npm run build first');
    starting = ensureServer(paths, { open: false });
    await starting;
    const info = readRunFile(paths);
    if (info === null) throw new Error('the server did not write its run file');
    const api = createApiClient(paths);
    db = new Database(paths.archiveDb, { readonly: true });
    const ctx = { api, db, port: info.port, token: info.token, seen: new Map<string, string>() };
    console.log(`smoke: ${sources.length} public_read sources, temp home ${path.basename(home)}`);
    for (const s of sources) {
      let r: Result;
      try {
        r = await smokeOne(s, ctx);
      } catch (e) {
        r = { ok: false, line: `FAIL ${s.id}: ${(e as { code?: string }).code ?? 'unexpected error'}` };
      }
      if (!r.ok) failed += 1;
      console.log(r.line);
    }
    for (const s of sources) {
      if (s.engine !== 'discourse') continue;
      // A seed file turns lookups off where an earlier run saw the forum hide profiles from visitors.
      console.log(s.author_signals.profile_lookup ? await profileFields(api, s.id, ctx.seen.get(s.id)) : `profile ${s.id}: lookups are off in the seed file`);
    }
  } catch (e) {
    failed += 1;
    console.log(`FAIL smoke: ${e instanceof Error ? e.message.split('\n')[0] : 'unexpected error'}`);
  } finally {
    if (!finishing) {
      finishing = true;
      db?.close();
      const r = await shutdownSmoke(paths, home, { keep });
      console.log(`server: ${r.server}`);
      if (r.error !== null || r.server === 'alive') {
        failed += 1;
        console.log(`FAIL could not stop the server cleanly${r.error ? `: ${r.error}` : ''}${r.homeRemoved ? '' : `; temp home left at ${home}`}`);
      } else if (keep) console.log(`smoke: kept ${home}`);
    }
  }
  console.log(failed === 0 ? `smoke: all ${sources.length} sources ok` : `smoke: ${failed} failure(s)`);
  return failed === 0 ? 0 : 1;
}

// Only when run as a script: the unit tests import structural() and shutdownSmoke().
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
