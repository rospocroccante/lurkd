import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRunFile, removeRunFile, writeRunFile, type RunInfo } from '../../src/launcher/runfile.js';
import { ensureHome, lurkdPaths, type LurkdPaths } from '../../src/paths.js';

describe('run file', () => {
  let home: string;
  let paths: LurkdPaths;
  const info: RunInfo = { pid: 4242, port: 51234, token: 'ab'.repeat(32), version: '0.1.0', startedAt: '2026-11-09T12:00:00.000Z' };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-runfile-'));
    paths = lurkdPaths({ LURKD_HOME: home });
    ensureHome(paths);
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('writes the run file at 0600 and reads it back', () => {
    writeRunFile(paths, info);
    expect(fs.statSync(paths.runFile).mode & 0o777).toBe(0o600);
    expect(readRunFile(paths)).toEqual(info);
    // No temp file is left beside it.
    expect(fs.readdirSync(paths.runDir)).toEqual(['server.json']);
  });

  it('keeps 0600 when it replaces a file with a looser mode', () => {
    fs.writeFileSync(paths.runFile, '{}', { mode: 0o644 });
    fs.chmodSync(paths.runFile, 0o644);
    writeRunFile(paths, info);
    expect(fs.statSync(paths.runFile).mode & 0o777).toBe(0o600);
  });

  it('reads null when the file is missing, not JSON or has the wrong shape', () => {
    expect(readRunFile(paths)).toBeNull();
    fs.writeFileSync(paths.runFile, 'not json');
    expect(readRunFile(paths)).toBeNull();
    fs.writeFileSync(paths.runFile, JSON.stringify({ ...info, port: 'x' }));
    expect(readRunFile(paths)).toBeNull();
    fs.writeFileSync(paths.runFile, JSON.stringify({ ...info, token: undefined }));
    expect(readRunFile(paths)).toBeNull();
  });

  it('removes the file, and a missing file is fine', () => {
    writeRunFile(paths, info);
    removeRunFile(paths);
    expect(fs.existsSync(paths.runFile)).toBe(false);
    expect(() => removeRunFile(paths)).not.toThrow();
  });
});
