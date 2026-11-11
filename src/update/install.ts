import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import Database from 'better-sqlite3';
import { stopServer } from '../launcher/launcher.js';
import { PACKAGE_ROOT, VERSION, type LurkdPaths } from '../paths.js';
import { fetchLatestVersion } from './check.js';
import { isNewerVersion, parseStableVersion } from './version.js';

// D53: `lurkd update [--yes]`, run by the user in a terminal. Never from the server or an MCP
// tool: only the CLI entry point imports this file. It asks the registry for the latest version
// itself, and changes nothing unless lurkd is a global npm install the user can write to. Then:
// stop the server, copy the archive to ~/.lurkd/backups/ (0600 in a 0700 folder), run
// `npm i -g lurkd@<latest>` (no shell, the terminal passed through), check the new install with
// `lurkd --version`, and print how to go back. Exit codes: 0 done or nothing to do, 2 usage or no
// terminal to ask on, 1 anything else.

export interface UpdateDeps {
  /** The version of this lurkd. */
  version: string;
  paths: LurkdPaths;
  /** Where this lurkd runs from. */
  packageRoot: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** True when lurkd can ask a question on the terminal. */
  isTTY: boolean;
  confirm: (question: string) => Promise<boolean>;
  /** The latest stable version on the registry; throws with a short reason. */
  fetchLatest: () => Promise<string>;
  /** Where npm puts global packages (`npm root -g`) and its prefix (`npm prefix -g`); null when npm cannot say. */
  npmGlobal: () => Promise<{ root: string; prefix: string } | null>;
  stopServer: () => Promise<'stopped' | 'not_running'>;
  /** Runs a command with the terminal passed through and no shell; resolves with its exit code. */
  run: (cmd: string, args: string[]) => Promise<number>;
  /** Runs a command with no shell and returns its exit code and output. */
  capture: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  now: () => Date;
}

class UsageError extends Error {}

/** What `lurkd update` prints when the backup it would write already exists. */
const SAME_BACKUP_NAME = 'A backup with this name already exists; wait a second and run lurkd update again.';

/** `2026-11-11T09:08:07.123Z` as `20261111T090807Z`, for a file name. */
function stamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

function writable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function realpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** One short line of a program's output, safe to print. */
function shown(text: string): string {
  const line = (text.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  const safe = line.replace(/[^\w.+-]/g, '?');
  return safe.length > 40 ? `${safe.slice(0, 40)}...` : safe === '' ? '(nothing)' : safe;
}

/**
 * Writes a copy of the archive into the backups folder and returns its path; null when there is
 * no archive yet. The copy is made by SQLite (`VACUUM INTO`) while lurkd holds the archive open,
 * so it is one consistent state with everything committed, the write-ahead log included, even if
 * another connection has the file open (L3). The server is stopped first, but an agent can start
 * it again at any moment: its `lurkd mcp` starts the server on its next tool call, also while npm
 * runs. The guide says so (getting-started.md, "Updating"). The target is created empty first,
 * with `wx` at 0600, so an existing backup is never overwritten and the copy is never readable by
 * others; `VACUUM INTO` accepts an empty file.
 */
function backupArchive(paths: LurkdPaths, file: string): string | null {
  if (!fs.existsSync(paths.archiveDb)) return null;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.closeSync(fs.openSync(file, 'wx', 0o600));
  try {
    fs.chmodSync(file, 0o600);
    const db = new Database(paths.archiveDb, { fileMustExist: true, readonly: true });
    try {
      db.prepare('VACUUM INTO ?').run(file);
    } finally {
      db.close();
    }
    fs.chmodSync(file, 0o600);
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
  return file;
}

/** `p` as one word for a POSIX shell: bare when it holds only safe characters, else in single quotes. */
export function shellQuote(p: string): string {
  return /^[A-Za-z0-9_./@%+=:,-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

type InstallCheck = { ok: true; bin: string } | { ok: false; lines: string[] };

/** Whether `npm i -g` would replace this very lurkd, and can. */
async function checkInstall(deps: UpdateDeps, latest: string): Promise<InstallCheck> {
  const command = `  npm i -g lurkd@${latest}`;
  const g = await deps.npmGlobal();
  if (g === null)
    return { ok: false, lines: ['lurkd could not ask npm where it keeps global packages, so lurkd update changes nothing.', 'To install the new version with npm, run:', command] };
  const installed = path.join(g.root, 'lurkd');
  const here = realpath(deps.packageRoot);
  const root = realpath(g.root);
  // L4: `npm link` leaves a symlink into a clone where the global package would be; that clone is
  // a dev install, and npm i -g would replace the link, not update the clone.
  const linked = isSymlink(installed);
  if (here === null || root === null || linked || here !== realpath(installed) || !here.startsWith(root + path.sep))
    return {
      ok: false,
      lines: [
        `This lurkd runs from ${deps.packageRoot}, which is not the global npm install, so lurkd update changes nothing.`,
        'That is the case for a clone of the repository (npm link included), for npx and for other package managers.',
        'To install the new version globally with npm, run:',
        command,
      ],
    };
  const bin = path.join(g.prefix, 'bin');
  if (![g.root, installed, bin].every(writable))
    return {
      ok: false,
      lines: [
        `npm keeps global packages in ${g.root}, and your user cannot write there, so lurkd update changes nothing.`,
        'Run the install yourself, as the user that owns that folder:',
        command,
      ],
    };
  return { ok: true, bin: path.join(bin, 'lurkd') };
}

/** `lurkd update [--yes]`; returns the exit code. */
export async function runUpdate(args: string[], deps: UpdateDeps): Promise<number> {
  try {
    for (const a of args) if (a !== '--yes') throw new UsageError(`Unknown option for this command: ${a}`);
  } catch (e) {
    deps.err((e as Error).message);
    deps.err('Usage: lurkd update [--yes]');
    return 2;
  }
  const yes = args.includes('--yes');
  const current = deps.version;

  let latest: string;
  try {
    latest = await deps.fetchLatest();
  } catch (e) {
    deps.err(`lurkd could not ask the npm registry for the latest version: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]} Nothing changed.`);
    return 1;
  }
  if (parseStableVersion(latest) === null) {
    deps.err('The npm registry did not name a valid version. Nothing changed.');
    return 1;
  }
  if (!isNewerVersion(latest, current)) {
    deps.out(latest === current ? `lurkd ${current} is the latest version.` : `This is lurkd ${current}; the latest release on npm is ${latest}. Nothing to do.`);
    return 0;
  }

  const install = await checkInstall(deps, latest);
  if (!install.ok) {
    for (const l of install.lines) deps.out(l);
    return 1;
  }

  // The name has a one-second stamp, so a second run within the same second names the same file,
  // which is never overwritten: stop before anything changes.
  const backup = path.join(deps.paths.home, 'backups', `archive-${current}-${stamp(deps.now())}.db`);
  if (fs.existsSync(deps.paths.archiveDb) && fs.lstatSync(backup, { throwIfNoEntry: false }) !== undefined) {
    deps.err(SAME_BACKUP_NAME);
    return 1;
  }
  deps.out(`lurkd ${latest} is available; this is lurkd ${current}. lurkd update will:`);
  deps.out('  1. stop the lurkd server, if it is running;');
  deps.out(`  2. copy ${deps.paths.archiveDb} to ${backup};`);
  deps.out(`  3. run npm i -g lurkd@${latest};`);
  deps.out('  4. check the new install with lurkd --version.');
  if (!yes) {
    if (!deps.isTTY) {
      deps.out('Run lurkd update --yes to go ahead, or run lurkd update in a terminal to be asked.');
      return 2;
    }
    if (!(await deps.confirm('Update now? [y/N] '))) {
      deps.out('Nothing changed.');
      return 1;
    }
  }

  const stopped = (await deps.stopServer()) === 'stopped';
  if (stopped) deps.out('Stopped the lurkd server.');
  let saved: string | null;
  try {
    saved = backupArchive(deps.paths, backup);
  } catch (e) {
    // The same name appeared after the check above (another lurkd update): the file is left alone.
    if ((e as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
      deps.err(SAME_BACKUP_NAME);
      if (stopped) deps.err(`Run lurkd start to start lurkd ${current} again.`);
      return 1;
    }
    deps.err(`lurkd could not copy the archive (${(e instanceof Error ? e.message : String(e)).split('\n')[0]}), so it did not run npm. Run lurkd start to start lurkd ${current} again.`);
    return 1;
  }
  deps.out(saved === null ? 'There is no archive yet, so there is nothing to back up.' : `Copied the archive to ${saved}.`);

  const code = await deps.run('npm', ['i', '-g', `lurkd@${latest}`]);
  if (code !== 0) {
    deps.err(
      `npm i -g lurkd@${latest} failed (exit ${code}). lurkd did not change your archive${saved === null ? '' : `, and a copy is at ${saved}`}. Unless npm says otherwise above, lurkd ${current} is still installed: run lurkd start to start it again.`,
    );
    return 1;
  }

  let ok = false;
  try {
    const v = await deps.capture(install.bin, ['--version']);
    ok = v.code === 0 && v.stdout.trim() === latest;
    if (ok) deps.out(`lurkd ${latest} is installed.`);
    else deps.err(`npm finished, but ${install.bin} --version printed ${shown(v.stdout)}, not ${latest}. Check the npm output above.`);
  } catch {
    deps.err(`npm finished, but lurkd could not run ${install.bin} --version. Check the npm output above.`);
  }

  // L2: every path shell-quoted. The WAL and shared-memory files go before the copy: left in
  // place, SQLite would replay the newer version's log onto the restored file.
  const db = deps.paths.archiveDb;
  deps.out(`To go back to lurkd ${current}, run:`);
  deps.out('  lurkd stop');
  deps.out(`  npm i -g lurkd@${current}`);
  if (saved !== null) {
    deps.out(`  rm -f ${shellQuote(`${db}-wal`)} ${shellQuote(`${db}-shm`)}`);
    deps.out(`  cp ${shellQuote(saved)} ${shellQuote(db)}`);
  }
  deps.out(`Run lurkd start to start lurkd ${latest}. Agents start it on their next lurkd call.`);
  // M1: a lurkd mcp process lives as long as its agent session and keeps the old code.
  deps.out(`Restart your agent sessions too: a lurkd mcp process an agent started before the update keeps running lurkd ${current} until its session restarts.`);
  return ok ? 0 : 1;
}

function execOut(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (e, stdout) => {
      const code = e === null ? 0 : typeof (e as { code?: unknown }).code === 'number' ? ((e as { code: number }).code) : 1;
      resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });
}

/** The real deps: the registry, npm, the launcher and the terminal. */
export function defaultUpdateDeps(paths: LurkdPaths): UpdateDeps {
  return {
    version: VERSION,
    paths,
    packageRoot: PACKAGE_ROOT,
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    confirm: async (question) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(question)).trim());
      } finally {
        rl.close();
      }
    },
    fetchLatest: () => fetchLatestVersion({ version: VERSION }),
    npmGlobal: async () => {
      const [root, prefix] = await Promise.all([execOut('npm', ['root', '-g'], 30_000), execOut('npm', ['prefix', '-g'], 30_000)]);
      const r = root.stdout.trim();
      const p = prefix.stdout.trim();
      return root.code === 0 && prefix.code === 0 && path.isAbsolute(r) && path.isAbsolute(p) ? { root: r, prefix: p } : null;
    },
    stopServer: () => stopServer(paths),
    run: (cmd, args) =>
      new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: 'inherit', shell: false });
        child.once('error', () => resolve(127));
        child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
      }),
    capture: (cmd, args) => execOut(cmd, args, 60_000),
    now: () => new Date(),
  };
}
