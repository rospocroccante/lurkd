import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunFile } from '../../src/launcher/runfile.js';
import { lurkdPaths, PACKAGE_ROOT, type LurkdPaths } from '../../src/paths.js';

// The server entry point as its own process (headless Chromium, as `lurkd start` runs it), one
// node process through `--import tsx`, so the signal reaches the server itself.

const MAIN = path.join(PACKAGE_ROOT, 'src', 'server', 'main.ts');
const homes: string[] = [];
const children: ChildProcess[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(probe: () => T | null | false, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(100);
  }
}

/** Processes whose command line names the profile folder: the Chromium of this server. */
function browserPids(paths: LurkdPaths): number[] {
  const r = spawnSync('pgrep', ['-f', paths.profileDir], { encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean).map(Number);
}

async function startProcess(): Promise<{ child: ChildProcess; paths: LurkdPaths; exited: Promise<number | null> }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-proc-'));
  homes.push(home);
  const paths = lurkdPaths({ LURKD_HOME: home });
  const child = spawn(process.execPath, ['--import', 'tsx', MAIN], { cwd: PACKAGE_ROOT, env: { ...process.env, LURKD_HOME: home }, stdio: 'ignore' });
  children.push(child);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  await until(() => readRunFile(paths), 30_000);
  await until(() => browserPids(paths).length > 0, 10_000);
  return { child, paths, exited };
}

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

describe('the server process', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`closes cleanly on ${signal}`, async () => {
      const { child, paths, exited } = await startProcess();
      expect(readRunFile(paths)?.pid).toBe(child.pid);
      child.kill(signal);
      expect(await exited).toBe(0);
      const log = fs.readFileSync(paths.logFile, 'utf8');
      expect(log).toContain(`${signal}: shutting down`);
      expect(log).toContain('stopped');
      expect(readRunFile(paths)).toBeNull();
      await until(() => browserPids(paths).length === 0, 5_000);
    });
  }

  it('takes Chromium down with it when it is killed hard', async () => {
    const { child, paths, exited } = await startProcess();
    child.kill('SIGKILL');
    await exited;
    await until(() => browserPids(paths).length === 0, 10_000);
  });
});
