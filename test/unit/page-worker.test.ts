import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { LurkdError } from '../../src/errors.js';
import { readabilityInWorker, readabilityThread } from '../../src/extract/generic.js';
import { activePageWorkers, runPageTask, workerEntry } from '../../src/extract/page-worker.js';
import { parseSelectorPage, readThreadList, readThreadPage, selectorPosts } from '../../src/extract/selectors.js';
import type { Selectors } from '../../src/sources/schema.js';
import { fixture, testSource } from '../helpers/common.js';

// The page worker (src/extract/page-worker.ts): same results as the in-process functions, a hard
// deadline that ends hostile pages as extraction_failed, no worker left behind, and a worker
// module that loads both from source (tsx, here) and from the built JavaScript.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE = 'https://forum.example.org';
const THREAD = `${BASE}/thread/42`;
const SEL: Selectors = {
  title: 'h1.thread-title',
  post: 'article.post',
  author: '.post-author .name',
  author_signals: '.post-author .stats',
  date: 'time',
  body: '.post-body',
  quote: 'div.quote',
  next_page: 'a[rel=next]',
  thread_list: 'ol.results li a.thread-title',
};
const source = testSource({ id: 'test-custom', engine: 'custom', base_url: BASE, selectors: SEL });

afterAll(() => {
  // Every call settles only after its worker exited.
  expect(activePageWorkers()).toBe(0);
});

async function timed<T>(p: Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const t0 = performance.now();
  try {
    const value = await p;
    return { ms: performance.now() - t0, value };
  } catch (error) {
    return { ms: performance.now() - t0, error };
  }
}

describe('workerEntry', () => {
  it('starts the .ts module with the tsx loader from source and the .js module as it is from dist', () => {
    const here = pathToFileURL(path.join(ROOT, 'src/extract/page-worker.ts')).href;
    const src = workerEntry(here);
    expect(src.url.href).toBe(new URL('./page-worker-entry.ts', here).href);
    expect(src.execArgv[0]).toBe('--import');
    expect(src.execArgv[1]).toMatch(/^file:\/\/.*\/tsx\/dist\/loader\.mjs$/);
    expect(workerEntry('file:///app/dist/extract/page-worker.js')).toEqual({ url: new URL('file:///app/dist/extract/page-worker-entry.js'), execArgv: [] });
  });
});

describe('page tasks in the worker', () => {
  it('give the same posts, hits and readability thread as the in-process functions', async () => {
    const html = fixture('custom/thread-1.html');
    const page = await readThreadPage(source, html, THREAD, SEL, 2, 10);
    const local = selectorPosts(parseSelectorPage(html, THREAD, SEL, source), 2, source, 10);
    expect(page.posts.map((p) => [p.number, p.author, p.signals, p.notes, p.postedAt])).toEqual(local.map((p) => [p.number, p.author, p.signals, p.notes, p.postedAt]));
    // Marked names cross the thread boundary intact.
    expect(page.posts.map((p) => p.bodyMd)).toEqual(local.map((p) => p.bodyMd));
    expect(page).toMatchObject({ title: 'Sourdough starter smells of acetone', next: `${THREAD}?page=2` });
    expect(page.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await readThreadList(source, fixture('custom/list.html'), `${BASE}/find?q=x`, SEL)).toHaveLength(3);
    const article = fixture('generic/article.html');
    expect(await readabilityInWorker(article, 'https://f.example/a/1')).toEqual(readabilityThread(article, 'https://f.example/a/1'));
    expect(activePageWorkers()).toBe(0);
  });

  it('passes a LurkdError from the worker on with its code and message', async () => {
    const bad = { ...SEL, author: 'span[[' };
    await expect(readThreadPage(source, fixture('custom/thread-1.html'), THREAD, bad, 1, 0)).rejects.toMatchObject({
      code: 'extraction_failed',
      message: expect.stringContaining('selectors.author'),
    });
    await expect(readabilityInWorker('<html><body></body></html>', 'https://f.example/a/1')).rejects.toBeInstanceOf(LurkdError);
  });

  it('stops a task at the deadline, terminates the worker and names the selectors', async () => {
    const wide = `<html><body>${Array.from({ length: 9 }, () => `<div>${'<i class="post">x</i>'.repeat(4_900)}</div>`).join('')}</body></html>`;
    const sel: Selectors = { post: 'i:first-of-type', author: 'b' };
    const r = await timed(readThreadPage(source, wide, THREAD, sel, 1, 0));
    expect(r.error).toMatchObject({ code: 'extraction_failed', message: expect.stringMatching(/selectors\.post, selectors\.author .*took too long/) });
    expect(r.ms).toBeLessThan(4_000);
    expect(activePageWorkers()).toBe(0);
    // A deadline shorter than the work: the same path, deterministic.
    const short = await timed(runPageTask({ kind: 'readability', html: fixture('generic/article.html'), url: THREAD }, () => new LurkdError('extraction_failed', 'too long'), 1));
    expect(short.error).toMatchObject({ code: 'extraction_failed', message: 'too long' });
    expect(activePageWorkers()).toBe(0);
  });

  it('ends the review worst in-bounds page shapes as a result or extraction_failed in under 4 s each', async () => {
    const flatSel: Selectors = { post: 'i.post', author: 'b' };
    const flat = `<!doctype html><html><body>${Array.from({ length: 10 }, () => `<div>${'<i class="post">x</i>'.repeat(4_900)}</div>`).join('')}</body></html>`;
    const chain = (d: number) => `${'<div>'.repeat(d)}<p>x</p>${'</div>'.repeat(d)}`;
    const deep = `<!doctype html><html><body>${chain(995).repeat(49)}${chain(950)}</body></html>`;
    const hasList = Array.from({ length: 50 }, (_, i) => `:has(.z${i})`).join(', ');
    const cases: Array<[string, string, Selectors]> = [
      ['flat i:first-of-type', flat, { ...flatSel, post: 'i:first-of-type' }],
      ['flat i:only-child', flat, { ...flatSel, post: 'i:only-child' }],
      ['flat i:nth-child(1 of .post)', flat, { ...flatSel, post: 'i:nth-child(1 of .post)' }],
      ['flat *:nth-child(2n+1)', flat, { ...flatSel, post: '*:nth-child(2n+1)' }],
      ['deep post body', deep, { post: 'body', author: 'b' }],
      ['deep :is(50 x :has)', deep, { post: `:is(${hasList})`, author: 'b' }],
      ['deep list of 50 :has', deep, { post: hasList, author: 'b' }],
      ['deep quote div:has(p)', deep, { post: 'body', author: 'b', quote: 'div:has(p)' }],
      ['deep quote *', deep, { post: 'body', author: 'b', quote: '*' }],
    ];
    for (const [label, html, sel] of cases) {
      const r = await timed(readThreadPage(source, html, THREAD, sel, 1, 0));
      expect(r.ms, label).toBeLessThan(4_000);
      if (r.error !== undefined) expect(r.error, label).toMatchObject({ code: 'extraction_failed' });
      expect(activePageWorkers(), label).toBe(0);
    }
    const r = await timed(readabilityInWorker(deep, THREAD));
    expect(r.ms).toBeLessThan(4_000);
    expect(r.error).toMatchObject({ code: 'extraction_failed' });
  }, 60_000);

  it('runs from the built JavaScript in plain Node, and the process exits with no worker left', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-dist-'));
    try {
      const build = spawnSync(path.join(ROOT, 'node_modules/.bin/tsc'), ['-p', path.join(ROOT, 'tsconfig.build.json'), '--outDir', out], { encoding: 'utf8' });
      expect(build.status, build.stdout + build.stderr).toBe(0);
      fs.writeFileSync(path.join(out, 'package.json'), '{"type":"module"}');
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(out, 'node_modules'), 'dir');
      const script = `
        const { readThreadPage } = await import(${JSON.stringify(path.join(out, 'extract/selectors.js'))});
        const { workerEntry, activePageWorkers } = await import(${JSON.stringify(path.join(out, 'extract/page-worker.js'))});
        const source = JSON.parse(process.env.SOURCE);
        const sel = source.selectors;
        const page = await readThreadPage(source, process.env.HTML, ${JSON.stringify(THREAD)}, sel, 1, 0);
        let slow = 'none';
        try {
          await readThreadPage(source, '<div>' + '<i class="post">x</i>'.repeat(4900) + '</div>', ${JSON.stringify(THREAD)}, { post: 'i:first-of-type', author: 'b' }, 1, 0);
        } catch (e) { slow = e.code; }
        console.log(JSON.stringify({ entry: workerEntry().url.href, execArgv: workerEntry().execArgv, posts: page.posts.length, slow, active: activePageWorkers() }));
      `;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, SOURCE: JSON.stringify(source), HTML: fixture('custom/thread-1.html') },
      });
      // A worker left running would keep the process alive past the timeout (status null).
      expect(run.status, run.stderr).toBe(0);
      const result = JSON.parse(run.stdout.trim().split('\n').pop()!) as { entry: string; execArgv: string[]; posts: number; slow: string; active: number };
      expect(result.entry).toMatch(/^file:\/\/.*\/lurkd-dist-[^/]+\/extract\/page-worker-entry\.js$/);
      expect(result).toMatchObject({ execArgv: [], posts: 3, active: 0 });
      expect(['extraction_failed', 'none']).toContain(result.slow);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
