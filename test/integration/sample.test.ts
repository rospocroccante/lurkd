import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchLogEntry } from '../../src/archive/state.js';
import { BrowserManager } from '../../src/browser/manager.js';
import { PageReader } from '../../src/browser/reader.js';
import { formatStructure, reduceStructure, SAMPLE_LIMITS, type StructNode } from '../../src/extract/sample.js';
import { lurkdPaths } from '../../src/paths.js';
import { HostPacer, RunLimiter } from '../../src/policy/limiter.js';
import { fixture, testSource } from '../helpers/common.js';
import { html, startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

// Real Chromium, always headless: BrowserManager launches headed only inside beginHandoff,
// which no test here calls.

const page = fixture('sample/page.html');
let server: FixtureServer;
let home: string;
let browser: BrowserManager;
const log: FetchLogEntry[] = [];

beforeAll(async () => {
  server = await startFixtureServer({ '/threads/test.55/': html(page) });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-sample-'));
  browser = new BrowserManager({ profileDir: lurkdPaths({ LURKD_HOME: home }).profileDir, log: (e) => log.push(e) });
  await browser.start();
  expect(browser.state).toBe('ready');
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

const unitOutput = () => formatStructure(reduceStructure(SAMPLE_LIMITS, parseHTML(page).document as unknown as Document));

function inPage<T>(fn: (reader: PageReader) => Promise<T>): Promise<T> {
  const source = testSource({ id: 'sample-host', base_url: server.origin });
  return browser.withPage({ source, jobId: 'sample' }, async (p, arm) => {
    const limiter = new RunLimiter({ minIntervalMs: 0, maxRequestsPerRun: 60, maxRequestsPerDay: 300, deadlineMs: 600_000 }, new HostPacer(), () => 0);
    const reader = new PageReader(p, source, { limiter, log: (e) => log.push(e), jobId: 'sample', arm });
    await reader.open(`${server.origin}/threads/test.55/`);
    return fn(reader);
  });
}

describe('reduceStructure in headless Chromium', () => {
  it('runs inside the page and matches the unit output', async () => {
    const tree = await inPage((reader) => reader.page.evaluate(reduceStructure, SAMPLE_LIMITS));
    const out = formatStructure(tree);
    expect(out).toBe(unitOutput());
    expect(out).not.toMatch(/alice|bob|carol|dave|secret-token-123|Original question/);
    expect(out).toMatch(/^\s*article(#[\w-]+)?\.message\.message--post \[data-author\] text=\d+ x\d+$/m);
  });

  it('runs as a string expression through PageReader.evaluate', async () => {
    const code = `(${reduceStructure.toString()})(${JSON.stringify(SAMPLE_LIMITS)})`;
    const tree = await inPage((reader) => reader.evaluate<StructNode>(code));
    expect(formatStructure(tree)).toBe(unitOutput());
  });
});
