import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LurkdPaths {
  home: string;
  runDir: string;
  runFile: string;
  startLock: string;
  profileDir: string;
  archiveDb: string;
  userSourcesDir: string;
  logFile: string;
}

// This file sits one level below the package root both as src/paths.ts and as dist/paths.js.
export const PACKAGE_ROOT: string = path.resolve(import.meta.dirname, '..');

export const VERSION: string = (
  JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

// All state lives under ~/.lurkd unless LURKD_HOME points elsewhere.
export function lurkdPaths(env: NodeJS.ProcessEnv = process.env): LurkdPaths {
  const home = env.LURKD_HOME ? path.resolve(env.LURKD_HOME) : path.join(os.homedir(), '.lurkd');
  const runDir = path.join(home, 'run');
  return {
    home,
    runDir,
    runFile: path.join(runDir, 'server.json'),
    startLock: path.join(runDir, 'start.lock'),
    profileDir: path.join(home, 'profiles', 'default'),
    archiveDb: path.join(home, 'archive.db'),
    userSourcesDir: path.join(home, 'sources'),
    logFile: path.join(home, 'logs', 'server.log'),
  };
}

// Creates every state directory and forces 0700 on each, including ones that already existed.
export function ensureHome(paths: LurkdPaths): void {
  const dirs = [
    paths.home,
    paths.runDir,
    path.dirname(paths.profileDir),
    paths.profileDir,
    paths.userSourcesDir,
    path.dirname(paths.logFile),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}
