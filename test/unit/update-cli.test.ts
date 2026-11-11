import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openArchive, setSetting } from '../../src/archive/db.js';
import { updateNotice, wantsNotice } from '../../src/cli/notice.js';
import { lurkdPaths, PACKAGE_ROOT, type LurkdPaths } from '../../src/paths.js';
import { runUpdate, type UpdateDeps } from '../../src/update/install.js';

// D53: the stderr line after a command, and `lurkd update`. Nothing here reaches the network or
// runs npm: the registry answer, npm and `lurkd --version` are all fakes.

describe('the update notice after a CLI command', () => {
  it('is printed after the commands that talk to the server, never with --json, and never for mcp, status, stop or update', () => {
    for (const argv of [['start'], ['open', '--no-open'], ['sources'], ['fetch', 'a', '--query', 'q'], ['search', 'gpu'], ['session'], ['sample', 'https://a.example/t/1'], ['author', 'a', 'author-0a'], ['add', 'https://a.example'], ['import', 'reddit', 'f.json']])
      expect(wantsNotice(argv), argv.join(' ')).toBe(true);
    for (const argv of [['sources', '--json'], ['fetch', 'a', '--json', '--query', 'q'], ['status'], ['status', '--json'], ['stop'], ['mcp'], ['update'], ['update', '--yes'], ['--version'], ['--help'], [], ['nonsense']])
      expect(wantsNotice(argv), argv.join(' ')).toBe(false);
  });

  it('reads the version from the running server and words it as one line', async () => {
    const get = vi.fn(async () => ({ update: { current: '0.2.1', latest: '0.3.0', checkedAt: '2026-11-11T09:00:00.000Z' } }));
    expect(await updateNotice({ get } as never, '0.2.1')).toBe('lurkd 0.3.0 is available: run lurkd update');
    expect(get).toHaveBeenCalledWith('/api/update');
  });

  it('says nothing when there is no newer version, the answer is odd, or the server cannot tell', async () => {
    const answer = (v: unknown) => ({ get: async () => v }) as never;
    expect(await updateNotice(answer({ update: null }), '0.2.1')).toBeNull();
    // The CLI compares with its own version: a server of another version may know an older one.
    expect(await updateNotice(answer({ update: { current: '0.2.0', latest: '0.2.1', checkedAt: 'x' } }), '0.2.1')).toBeNull();
    expect(await updateNotice(answer({ update: { current: '0.2.1', latest: '9.9.9\nrm -rf', checkedAt: 'x' } }), '0.2.1')).toBeNull();
    expect(await updateNotice(answer(null), '0.2.1')).toBeNull();
    expect(await updateNotice({ get: async () => Promise.reject(new Error('No such route.')) } as never, '0.2.1')).toBeNull();
  });
});

describe('lurkd update', () => {
  let home: string;
  let paths: LurkdPaths;
  let out: string[];
  let err: string[];
  let globalRoot: string;
  let prefix: string;
  let calls: { cmd: string; args: string[] }[];
  let deps: UpdateDeps;
  let stopServer: ReturnType<typeof vi.fn<() => Promise<'stopped' | 'not_running'>>>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-update-'));
    paths = lurkdPaths({ LURKD_HOME: path.join(home, 'state') });
    prefix = path.join(home, 'prefix');
    globalRoot = path.join(prefix, 'lib', 'node_modules');
    fs.mkdirSync(path.join(globalRoot, 'lurkd'), { recursive: true });
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    const db = openArchive(paths.archiveDb);
    setSetting(db, 'marker', 'kept');
    db.close();
    out = [];
    err = [];
    calls = [];
    stopServer = vi.fn<() => Promise<'stopped' | 'not_running'>>(async () => 'stopped');
    deps = {
      version: '0.2.1',
      paths,
      packageRoot: path.join(globalRoot, 'lurkd'),
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      isTTY: false,
      confirm: vi.fn(async () => true),
      fetchLatest: vi.fn(async () => '0.3.0'),
      npmGlobal: vi.fn(async () => ({ root: globalRoot, prefix })),
      stopServer,
      run: vi.fn(async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return 0;
      }),
      capture: vi.fn(async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { code: 0, stdout: '0.3.0\n' };
      }),
      now: () => new Date('2026-11-11T09:08:07.000Z'),
    };
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const text = () => out.join('\n');
  const backups = () => (fs.existsSync(path.join(paths.home, 'backups')) ? fs.readdirSync(path.join(paths.home, 'backups')) : []);

  it('refuses anything but --yes', async () => {
    expect(await runUpdate(['--force'], deps)).toBe(2);
    expect(err.join('\n')).toContain('--force');
    expect(deps.fetchLatest).not.toHaveBeenCalled();
  });

  it('says so when this is the latest version, and changes nothing', async () => {
    deps.fetchLatest = vi.fn(async () => '0.2.1');
    expect(await runUpdate(['--yes'], deps)).toBe(0);
    expect(text()).toContain('lurkd 0.2.1 is the latest version.');
    expect(stopServer).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('changes nothing when this lurkd is newer than the release on npm', async () => {
    deps.fetchLatest = vi.fn(async () => '0.2.0');
    expect(await runUpdate(['--yes'], deps)).toBe(0);
    expect(text()).toContain('0.2.0');
    expect(calls).toEqual([]);
  });

  it('stops with a message when the registry cannot be reached', async () => {
    deps.fetchLatest = vi.fn(async () => {
      throw new Error('The registry did not answer within 5 s.');
    });
    expect(await runUpdate(['--yes'], deps)).toBe(1);
    expect(err.join('\n')).toContain('The registry did not answer within 5 s.');
    expect(stopServer).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('without a terminal and without --yes, prints the plan and exits 2', async () => {
    expect(await runUpdate([], deps)).toBe(2);
    expect(text()).toContain('npm i -g lurkd@0.3.0');
    expect(text()).toContain(path.join(paths.home, 'backups', 'archive-0.2.1-20261111T090807Z.db'));
    expect(text()).toContain('lurkd update --yes');
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(stopServer).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it('on a terminal, asks first, and a no changes nothing', async () => {
    deps.isTTY = true;
    deps.confirm = vi.fn(async () => false);
    expect(await runUpdate([], deps)).toBe(1);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Nothing changed.');
    expect(stopServer).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('stops the server, backs up the archive at 0600 in a 0700 folder, runs npm, checks the new version and says how to go back', async () => {
    deps.isTTY = true;
    expect(await runUpdate([], deps)).toBe(0);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(stopServer).toHaveBeenCalledTimes(1);
    const dir = path.join(paths.home, 'backups');
    const file = path.join(dir, 'archive-0.2.1-20261111T090807Z.db');
    expect(backups()).toEqual(['archive-0.2.1-20261111T090807Z.db']);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // The copy is a whole archive.
    const copy = openArchive(file);
    expect(copy.prepare("SELECT value FROM settings WHERE key = 'marker'").pluck().get()).toBe('kept');
    copy.close();
    expect(calls).toEqual([
      { cmd: 'npm', args: ['i', '-g', 'lurkd@0.3.0'] },
      { cmd: path.join(prefix, 'bin', 'lurkd'), args: ['--version'] },
    ]);
    const t = text();
    expect(t).toContain('lurkd 0.3.0 is installed.');
    expect(t).toContain('npm i -g lurkd@0.2.1');
    expect(t).toContain(`cp ${file} ${paths.archiveDb}`);
    expect(t).toContain('lurkd start');
    // M1: agents' lurkd mcp processes keep the old code until their session restarts.
    expect(t).toContain('Restart your agent sessions');
    // The order: stop before the backup, the backup before npm.
    const stopOrder = stopServer.mock.invocationCallOrder[0]!;
    const runOrder = (deps.run as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(stopOrder).toBeLessThan(runOrder);
  });

  it('runs without asking with --yes, also without a terminal', async () => {
    expect(await runUpdate(['--yes'], deps)).toBe(0);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(calls[0]).toEqual({ cmd: 'npm', args: ['i', '-g', 'lurkd@0.3.0'] });
  });

  it('runs npm with no shell and the terminal passed through', async () => {
    // The default runner is checked in its own unit; here, the command and arguments are separate words.
    await runUpdate(['--yes'], deps);
    for (const c of calls) expect(c.args.join(' ')).not.toMatch(/[;&|`$]/);
  });

  it('copes with no archive yet', async () => {
    fs.rmSync(paths.archiveDb);
    for (const s of ['-wal', '-shm']) fs.rmSync(`${paths.archiveDb}${s}`, { force: true });
    expect(await runUpdate(['--yes'], deps)).toBe(0);
    expect(backups()).toEqual([]);
    expect(text()).toContain('no archive');
    expect(calls[0]!.cmd).toBe('npm');
  });

  it('reports a failed npm install and says the archive is untouched', async () => {
    deps.run = vi.fn(async () => 1);
    expect(await runUpdate(['--yes'], deps)).toBe(1);
    const e = err.join('\n');
    expect(e).toContain('npm i -g lurkd@0.3.0 failed');
    expect(e).toContain('archive-0.2.1-20261111T090807Z.db');
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it('reports a new install that prints another version', async () => {
    deps.capture = vi.fn(async () => ({ code: 0, stdout: '0.2.1\n' }));
    expect(await runUpdate(['--yes'], deps)).toBe(1);
    expect(err.join('\n')).toContain('0.2.1');
    // How to go back is still printed.
    expect(text()).toContain('npm i -g lurkd@0.2.1');
  });

  it('changes nothing when lurkd is not the global npm install (a clone or npx), and prints the command', async () => {
    deps.packageRoot = path.join(home, 'clone', 'lurkd');
    fs.mkdirSync(deps.packageRoot, { recursive: true });
    deps.isTTY = true;
    expect(await runUpdate(['--yes'], deps)).toBe(1);
    const t = [...out, ...err].join('\n');
    expect(t).toContain(deps.packageRoot);
    expect(t).toContain('npm i -g lurkd@0.3.0');
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(stopServer).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it('changes nothing when npm cannot say where global packages live', async () => {
    deps.npmGlobal = vi.fn(async () => null);
    expect(await runUpdate(['--yes'], deps)).toBe(1);
    expect([...out, ...err].join('\n')).toContain('npm i -g lurkd@0.3.0');
    expect(stopServer).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('changes nothing when the global folder is not writable, and prints the command', async () => {
    fs.chmodSync(globalRoot, 0o500);
    try {
      expect(await runUpdate(['--yes'], deps)).toBe(1);
    } finally {
      fs.chmodSync(globalRoot, 0o700);
    }
    const t = [...out, ...err].join('\n');
    expect(t).toContain(globalRoot);
    expect(t).toContain('npm i -g lurkd@0.3.0');
    expect(stopServer).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it('follows symlinks when it compares the install with the global folder', async () => {
    const link = path.join(home, 'linked-root');
    fs.symlinkSync(globalRoot, link);
    deps.npmGlobal = vi.fn(async () => ({ root: link, prefix }));
    expect(await runUpdate(['--yes'], deps)).toBe(0);
  });
});

describe('lurkd update, fix round', () => {
  let home: string;
  let paths: LurkdPaths;
  let out: string[];
  let err: string[];
  let globalRoot: string;
  let prefix: string;
  let deps: UpdateDeps;

  const setup = (stateDir: string) => {
    paths = lurkdPaths({ LURKD_HOME: stateDir });
    prefix = path.join(home, 'prefix');
    globalRoot = path.join(prefix, 'lib', 'node_modules');
    fs.mkdirSync(path.join(globalRoot, 'lurkd'), { recursive: true });
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    const db = openArchive(paths.archiveDb);
    setSetting(db, 'marker', 'kept');
    db.close();
    out = [];
    err = [];
    deps = {
      version: '0.2.1',
      paths,
      packageRoot: path.join(globalRoot, 'lurkd'),
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      isTTY: false,
      confirm: vi.fn(async () => true),
      fetchLatest: vi.fn(async () => '0.3.0'),
      npmGlobal: vi.fn(async () => ({ root: globalRoot, prefix })),
      stopServer: vi.fn(async () => 'not_running' as const),
      run: vi.fn(async () => 0),
      capture: vi.fn(async () => ({ code: 0, stdout: '0.3.0\n' })),
      now: () => new Date('2026-11-11T09:08:07.000Z'),
    };
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-update-fix-'));
    setup(path.join(home, 'state'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const backupFile = () => path.join(paths.home, 'backups', 'archive-0.2.1-20261111T090807Z.db');

  // L2: the rollback lines work when pasted into a shell, even for a home with spaces or quotes.
  it('prints rollback commands with the paths shell-quoted, and removes the WAL files before the copy', async () => {
    setup(path.join(home, "it's my state"));
    expect(await runUpdate(['--yes'], deps)).toBe(0);
    const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    const lines = out.slice(out.indexOf('To go back to lurkd 0.2.1, run:') + 1, out.indexOf('To go back to lurkd 0.2.1, run:') + 5);
    expect(lines).toEqual([
      '  lurkd stop',
      '  npm i -g lurkd@0.2.1',
      `  rm -f ${q(`${paths.archiveDb}-wal`)} ${q(`${paths.archiveDb}-shm`)}`,
      `  cp ${q(backupFile())} ${q(paths.archiveDb)}`,
    ]);
  });

  it('leaves a plain path bare in the rollback commands', async () => {
    expect(await runUpdate(['--yes'], deps)).toBe(0);
    expect(out).toContain(`  rm -f ${paths.archiveDb}-wal ${paths.archiveDb}-shm`);
    expect(out).toContain(`  cp ${backupFile()} ${paths.archiveDb}`);
  });

  // L3: the copy is taken through SQLite, so it holds what is committed even when another
  // connection keeps the write-ahead log from being folded back into the file.
  it('backs up what is committed while another connection holds the archive open', async () => {
    const writer = openArchive(paths.archiveDb);
    const reader = openArchive(paths.archiveDb);
    try {
      // A read transaction opened before the write pins the WAL: no checkpoint can fold the write in.
      reader.prepare('BEGIN').run();
      reader.prepare('SELECT count(*) FROM settings').get();
      setSetting(writer, 'marker', 'written after');
      expect(await runUpdate(['--yes'], deps)).toBe(0);
    } finally {
      reader.prepare('ROLLBACK').run();
      reader.close();
      writer.close();
    }
    const copy = openArchive(backupFile());
    expect(copy.prepare("SELECT value FROM settings WHERE key = 'marker'").pluck().get()).toBe('written after');
    copy.close();
    expect(fs.statSync(backupFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(backupFile())).mode & 0o777).toBe(0o700);
  }, 20_000);

  const SAME_NAME = 'A backup with this name already exists; wait a second and run lurkd update again.';

  // lurkd update run twice within the same second names the backup the same way.
  it('never overwrites a backup that is already there: it says to wait a second and changes nothing', async () => {
    fs.mkdirSync(path.dirname(backupFile()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(backupFile(), 'older backup', { mode: 0o600 });
    expect(await runUpdate(['--yes'], deps)).toBe(1);
    expect(err).toEqual([SAME_NAME]);
    expect(err.join('\n')).not.toContain('EEXIST');
    expect(fs.readFileSync(backupFile(), 'utf8')).toBe('older backup');
    expect(fs.readdirSync(path.dirname(backupFile()))).toEqual([path.basename(backupFile())]);
    expect(deps.stopServer).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it('says the same when the backup appears after the server stopped, and does not run npm', async () => {
    deps.stopServer = vi.fn(async () => {
      fs.mkdirSync(path.dirname(backupFile()), { recursive: true, mode: 0o700 });
      fs.writeFileSync(backupFile(), 'older backup', { mode: 0o600 });
      return 'not_running' as const;
    });
    expect(await runUpdate(['--yes'], deps)).toBe(1);
    expect(err).toEqual([SAME_NAME]);
    expect(fs.readFileSync(backupFile(), 'utf8')).toBe('older backup');
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('runs twice within the same second: the second run stops with the message and leaves the first backup alone', async () => {
    expect(await runUpdate(['--yes'], deps)).toBe(0);
    const first = fs.readFileSync(backupFile());
    out = [];
    err = [];
    (deps.run as ReturnType<typeof vi.fn>).mockClear();
    expect(await runUpdate(['--yes'], deps)).toBe(1);
    expect(err).toEqual([SAME_NAME]);
    expect(fs.readFileSync(backupFile()).equals(first)).toBe(true);
    expect(deps.run).not.toHaveBeenCalled();
  });

  // L4: `npm link` puts a symlink into a clone where the global install would be.
  it('treats an npm link of a clone as not a global install', async () => {
    const clone = path.join(home, 'clone', 'lurkd');
    fs.mkdirSync(clone, { recursive: true });
    fs.rmSync(path.join(globalRoot, 'lurkd'), { recursive: true });
    fs.symlinkSync(clone, path.join(globalRoot, 'lurkd'));
    for (const root of [clone, path.join(globalRoot, 'lurkd')]) {
      out = [];
      deps.packageRoot = root;
      expect(await runUpdate(['--yes'], deps)).toBe(1);
      expect(out.join('\n')).toContain('not the global npm install');
      expect(out).toContain('  npm i -g lurkd@0.3.0');
    }
    expect(deps.stopServer).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });
});

describe('who may run npm', () => {
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []));

  it('keeps lurkd update out of the server, the MCP server and the API client', () => {
    for (const dir of ['server', 'mcp', 'client', 'fetch', 'browser']) {
      for (const f of files(path.join(PACKAGE_ROOT, 'src', dir))) {
        const body = fs.readFileSync(f, 'utf8');
        expect(body, f).not.toContain('update/install');
        expect(body, f).not.toMatch(/['"]npm['"]/);
      }
    }
  });
});
