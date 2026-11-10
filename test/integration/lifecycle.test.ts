import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRunFile } from '../../src/launcher/runfile.js';
import { lurkdPaths, PACKAGE_ROOT, VERSION, type LurkdPaths } from '../../src/paths.js';

// The built CLI against a real detached server (headless Chromium), in a temp LURKD_HOME.
// `--no-open` everywhere: no test opens the system browser.

const CLI = path.join(PACKAGE_ROOT, 'dist', 'bin', 'lurkd.js');
let home: string;
let paths: LurkdPaths;

function lurkd(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: PACKAGE_ROOT, env: { ...process.env, LURKD_HOME: home }, encoding: 'utf8', timeout: 45_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  const build = spawnSync('npm', ['run', 'build'], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`npm run build failed:\n${build.stdout}\n${build.stderr}`);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-life-'));
  paths = lurkdPaths({ LURKD_HOME: home });
}, 120_000);

afterAll(() => {
  // A server the test left behind, only when it is ours.
  const info = readRunFile(paths);
  if (info) {
    const ps = spawnSync('ps', ['-ww', '-p', String(info.pid), '-o', 'command='], { encoding: 'utf8' });
    if (ps.stdout.includes('lurkd')) process.kill(info.pid, 'SIGKILL');
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('lurkd start, status, stop', () => {
  it('start, start, status, stop', () => {
    const first = lurkd('start', '--no-open');
    expect(first.code).toBe(0);
    const [line1, url1] = first.stdout.trim().split('\n');
    expect(line1).toBe(`Started lurkd ${VERSION}.`);
    expect(url1).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}$/);
    expect(fs.statSync(paths.logFile).mode & 0o777).toBe(0o600);
    // The token stays out of the log.
    const token = new URL(url1!).searchParams.get('t')!;
    expect(fs.readFileSync(paths.logFile, 'utf8')).not.toContain(token);

    const second = lurkd('start', '--no-open');
    expect(second.code).toBe(0);
    expect(second.stdout.trim().split('\n')).toEqual(['lurkd is already running.', url1]);

    const status = lurkd('status', '--json');
    expect(status.code).toBe(0);
    const s = JSON.parse(status.stdout) as Record<string, unknown>;
    expect(s).toMatchObject({ running: true, url: url1, version: VERSION, browser: 'ready', queueLength: 0 });
    expect(s.pid).toBe(readRunFile(paths)?.pid);
    expect(Array.isArray(s.attention)).toBe(true);
    // No forum address reaches status output: the only URL is the lurkd page.
    expect(status.stdout.split(url1!).join('')).not.toContain('http');

    const text = lurkd('status');
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('lurkd is running.');
    expect(text.stdout).toContain(url1);
    expect(text.stdout.split(url1!).join('')).not.toContain('http');

    const stop = lurkd('stop');
    expect(stop.code).toBe(0);
    expect(stop.stdout.trim()).toBe('Stopped.');
    expect(fs.existsSync(paths.runFile)).toBe(false);
    expect(spawnSync('pgrep', ['-f', paths.profileDir]).status).toBe(1);

    const again = lurkd('stop');
    expect(again.code).toBe(0);
    expect(again.stdout.trim()).toBe('lurkd is not running.');

    const down = lurkd('status', '--json');
    expect(down.code).toBe(1);
    expect(JSON.parse(down.stdout)).toEqual({ running: false });
    const downText = lurkd('status');
    expect(downText.code).toBe(1);
    expect(downText.stdout.trim()).toBe('lurkd is not running.');
  });
});

describe('lurkd mcp', () => {
  it('starts the server on the first tool call and keeps stdout to the protocol', async () => {
    expect(readRunFile(paths)).toBeNull();
    // One user source with a login page, so the answer has a line to check (no request reaches it).
    fs.mkdirSync(paths.userSourcesDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(paths.userSourcesDir, 'alpha.yaml'),
      [
        'id: alpha',
        'name: Alpha forum',
        'topics: [hardware]',
        'engine: discourse',
        'base_url: https://alpha.example.org',
        'login_url: https://alpha.example.org/login',
        'domains: [alpha.example.org]',
        'automation:',
        '  policy: allowed',
        '  rule_url: https://alpha.example.org/rules',
        '  rule_quote: Automated reading is allowed.',
        '  checked_at: 2026-11-08',
        '',
      ].join('\n'),
    );
    const child = spawn(process.execPath, [CLI, 'mcp'], { cwd: PACKAGE_ROOT, env: { ...process.env, LURKD_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const answered = async (id: number, ms: number) => {
      const end = Date.now() + ms;
      while (!stdout.split('\n').some((l) => l.includes(`"id":${id}`))) {
        if (Date.now() > end) throw new Error(`no answer to ${id}; stderr: ${stderr}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
      await answered(1, 15_000);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      // No live request: session.status without check reads the server's own state.
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session.status', arguments: {} } });
      await answered(2, 45_000);
      child.stdin.end();
      expect(await exited).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }

    const info = readRunFile(paths);
    expect(info).not.toBeNull();
    const lines = stdout.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe('2.0');
    const result = (JSON.parse(lines[1]!) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('alpha (Alpha forum): never');
    // No token and no forum address in what the agent sees.
    expect(stdout).not.toContain(info!.token);
    expect(result.content[0]!.text).not.toContain('http');

    const stop = lurkd('stop');
    expect(stop.code).toBe(0);
    expect(stop.stdout.trim()).toBe('Stopped.');
    expect(spawnSync('pgrep', ['-f', paths.profileDir]).status).toBe(1);
  }, 90_000);
});
