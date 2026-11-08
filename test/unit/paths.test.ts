import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureHome, lurkdPaths, PACKAGE_ROOT, VERSION } from '../../src/paths.js';

describe('lurkdPaths', () => {
  it('puts all state under LURKD_HOME', () => {
    const p = lurkdPaths({ LURKD_HOME: '/tmp/lh' });
    expect(p.home).toBe('/tmp/lh');
    expect(p.runDir).toBe('/tmp/lh/run');
    expect(p.runFile).toBe('/tmp/lh/run/server.json');
    expect(p.startLock).toBe('/tmp/lh/run/start.lock');
    expect(p.profileDir).toBe('/tmp/lh/profiles/default');
    expect(p.archiveDb).toBe('/tmp/lh/archive.db');
    expect(p.userSourcesDir).toBe('/tmp/lh/sources');
    expect(p.logFile).toBe('/tmp/lh/logs/server.log');
  });

  it('defaults to ~/.lurkd', () => expect(lurkdPaths({}).home).toBe(path.join(os.homedir(), '.lurkd')));

  it('treats an empty LURKD_HOME as unset', () =>
    expect(lurkdPaths({ LURKD_HOME: '' }).home).toBe(path.join(os.homedir(), '.lurkd')));

  it('resolves a relative LURKD_HOME against the working directory', () =>
    expect(lurkdPaths({ LURKD_HOME: 'rel/home' }).home).toBe(path.resolve('rel/home')));
});

describe('ensureHome', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-paths-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('creates every directory with mode 0700 and tightens existing ones', () => {
    const p = lurkdPaths({ LURKD_HOME: path.join(tmp, 'home') });
    fs.mkdirSync(p.profileDir, { recursive: true });
    for (const d of [p.home, path.dirname(p.profileDir), p.profileDir]) fs.chmodSync(d, 0o755);

    ensureHome(p);

    const dirs = [p.home, p.runDir, path.dirname(p.profileDir), p.profileDir, p.userSourcesDir, path.dirname(p.logFile)];
    for (const d of dirs) {
      expect(fs.statSync(d).isDirectory()).toBe(true);
      expect(fs.statSync(d).mode & 0o777).toBe(0o700);
    }
  });

  it('is idempotent', () => {
    const p = lurkdPaths({ LURKD_HOME: path.join(tmp, 'home') });
    ensureHome(p);
    expect(() => ensureHome(p)).not.toThrow();
    expect(fs.statSync(p.runDir).mode & 0o777).toBe(0o700);
  });
});

describe('package metadata', () => {
  it('reads VERSION from package.json', () => expect(VERSION).toBe('0.1.0'));

  it('points PACKAGE_ROOT at the folder holding package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('lurkd');
  });
});
