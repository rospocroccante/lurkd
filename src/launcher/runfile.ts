import fs from 'node:fs';
import type { LurkdPaths } from '../paths.js';

// `run/server.json`: how a client finds the running server. It holds the token, so it is 0600 and
// written to a temp file first, then renamed into place: a reader never sees half a file.

export interface RunInfo {
  pid: number;
  port: number;
  token: string;
  version: string;
  startedAt: string;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The run file, or null when it is missing, unreadable or not a run file. */
export function readRunFile(paths: LurkdPaths): RunInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(paths.runFile, 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.pid) || !isInt(r.port) || r.port > 65535 || !isText(r.token) || !isText(r.version) || !isText(r.startedAt)) return null;
  return { pid: r.pid, port: r.port, token: r.token, version: r.version, startedAt: r.startedAt };
}

/** Writes the run file at 0600 through a temp file and a rename. */
export function writeRunFile(paths: LurkdPaths, info: RunInfo): void {
  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  const tmp = `${paths.runFile}.${process.pid}.tmp`;
  const data: RunInfo = { pid: info.pid, port: info.port, token: info.token, version: info.version, startedAt: info.startedAt };
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    // The mode of writeFileSync passes through the umask, and a leftover temp file keeps its own.
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, paths.runFile);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function removeRunFile(paths: LurkdPaths): void {
  fs.rmSync(paths.runFile, { force: true });
}
