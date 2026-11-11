#!/usr/bin/env node
import fs from 'node:fs';
import { createApiClient, skewMessage } from '../client/api.js';
import { MIRROR_COMMANDS, MIRROR_HELP, runCommand } from '../cli/commands.js';
import { updateNotice, wantsNotice } from '../cli/notice.js';
import { EXIT_CODE, LurkdError } from '../errors.js';
import { checkHealth, ensureServer, openPage, serverUrl, stopServer } from '../launcher/launcher.js';
import { readRunFile, type RunInfo } from '../launcher/runfile.js';
import { statusJson, statusText, type ApiStatus } from '../launcher/status.js';
import { runMcpStdio } from '../mcp/server.js';
import { lurkdPaths, VERSION, type LurkdPaths } from '../paths.js';
import { defaultUpdateDeps, runUpdate } from '../update/install.js';

const USAGE = `Usage: lurkd <command>

Commands:
  start [--no-open]   Start the lurkd server if it is not running and open the lurkd page in
                      your browser. With --no-open, print a link to the page instead.
  open [--no-open]    Open the lurkd page in your browser, starting the server if needed.
                      With --no-open, print the link instead. A link works once, within
                      60 seconds, and never holds the lurkd token.
  stop                Stop the lurkd server.
  status [--json]     Show whether the server is running, its browser, queue, the sources
                      that need you and a newer lurkd version, if there is one. Exits 1 when
                      the server is not running.
  update [--yes]      Install the latest lurkd with npm: stop the server, copy the archive to
                      ~/.lurkd/backups/, run npm i -g lurkd@<latest>, check the new version and
                      print how to go back. Asks first; --yes skips the question.
  mcp [--tool-names=dot|underscore]
                      Serve the agent tools over MCP on stdin and stdout. The server starts
                      on the first tool call. underscore names the tools sources_search and
                      so on, for clients that refuse dots.

The agent tools as commands, plus add and import. They start the server when it is not
running, without opening the page. Every one takes --json to print the raw answer. Exit codes:
0 done, 2 usage error, 3 you have to act in the lurkd page, 4 a request cap was hit, 1 anything
else.
${MIRROR_HELP}

Options:
  --help              Show this help.
  --version           Print the lurkd version.
`;

const out = (line: string): void => void process.stdout.write(`${line}\n`);
const err = (line: string): void => void process.stderr.write(`${line}\n`);

class UsageError extends Error {}

/** Parses the flags of one command; anything else is a usage error. */
function flags(args: string[], allowed: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const a of args) {
    if (!allowed.includes(a)) throw new UsageError(`Unknown option for this command: ${a}`);
    set.add(a);
  }
  return set;
}

function windowsCheck(): void {
  if (process.platform === 'win32') throw new LurkdError('internal', 'lurkd does not support Windows yet.');
}

/**
 * `lurkd start` and `lurkd open` (D52): the server, then a one-time link to the page, opened in
 * the browser, or printed with --no-open or when this system has no way to open one. The token is
 * never printed, nor handed to the browser or to `open`.
 */
async function start(paths: LurkdPaths, args: string[], command: 'start' | 'open'): Promise<number> {
  const f = flags(args, ['--no-open']);
  windowsCheck();
  const { info, started } = await ensureServer(paths);
  if (started) out(`Started lurkd ${info.version}.`);
  else if (command === 'start') out('lurkd is already running.');
  // D53: a server an earlier (or later) lurkd started keeps running until it is restarted.
  if (!started && info.version !== VERSION) err(skewMessage(info.version, VERSION));
  const { link, opened } = await openPage(info, { open: !f.has('--no-open') });
  if (opened) out('Opened the lurkd page in your browser.');
  else {
    out('Open this link in your browser. It works once, within 60 seconds; lurkd open makes another.');
    out(link);
  }
  return 0;
}

async function stop(paths: LurkdPaths, args: string[]): Promise<number> {
  flags(args, []);
  windowsCheck();
  out((await stopServer(paths)) === 'stopped' ? 'Stopped.' : 'lurkd is not running.');
  return 0;
}

async function fetchStatus(info: RunInfo): Promise<ApiStatus> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}/api/status`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new LurkdError('server_unavailable', 'The lurkd server stopped answering. Run lurkd start again.');
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new LurkdError('server_unavailable', `The lurkd server answered /api/status with HTTP ${res.status}. Run lurkd stop and lurkd start.`);
  }
  return (await res.json()) as ApiStatus;
}

async function status(paths: LurkdPaths, args: string[]): Promise<number> {
  const f = flags(args, ['--json']);
  windowsCheck();
  const json = f.has('--json');
  const info = readRunFile(paths);
  if (info === null || !(await checkHealth(info))) {
    out(json ? JSON.stringify({ running: false }) : 'lurkd is not running.');
    return 1;
  }
  if (info.version !== VERSION) err(skewMessage(info.version, VERSION));
  const s = await fetchStatus(info);
  const url = serverUrl(info);
  out(json ? statusJson(url, s) : statusText(url, s));
  return 0;
}

async function mcp(paths: LurkdPaths, args: string[]): Promise<number> {
  let naming: 'dot' | 'underscore' = 'dot';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = a.startsWith('--tool-names=') ? a.slice('--tool-names='.length) : a === '--tool-names' ? args[++i] : null;
    if (value === null) throw new UsageError(`Unknown option for this command: ${a}`);
    if (value !== 'dot' && value !== 'underscore') throw new UsageError('--tool-names takes dot or underscore.');
    naming = value;
  }
  windowsCheck();
  await runMcpStdio(paths, naming);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === '--version' && rest.length === 0) {
    out(VERSION);
    return 0;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const paths = lurkdPaths();
  switch (cmd) {
    case 'start':
    case 'open':
      return start(paths, rest, cmd);
    case 'stop':
      return stop(paths, rest);
    case 'status':
      return status(paths, rest);
    case 'mcp':
      return mcp(paths, rest);
    case 'update':
      windowsCheck();
      return runUpdate(rest, defaultUpdateDeps(paths));
    default:
      if (cmd !== undefined && MIRROR_COMMANDS.includes(cmd)) {
        windowsCheck();
        return runCommand(argv, {
          client: createApiClient(paths, { autoStart: true, onSkew: err }),
          out,
          err,
          readFile: (p) => fs.readFileSync(p, 'utf8'),
          statFile: (p) => {
            const st = fs.statSync(p);
            return { isFile: st.isFile(), size: st.size };
          },
        });
      }
      throw new UsageError(cmd === undefined ? 'No command given.' : `Unknown command: ${cmd}`);
  }
}

/**
 * D53: after a command, one stderr line when the running server knows of a newer lurkd. The CLI
 * reads it from the server and never asks the registry itself. Never with --json, never under mcp.
 */
async function notice(argv: string[]): Promise<void> {
  if (!wantsNotice(argv)) return;
  try {
    const paths = lurkdPaths();
    if (readRunFile(paths) === null) return;
    const line = await updateNotice(createApiClient(paths, { timeoutMs: 2_000 }), VERSION);
    if (line !== null) err(line);
  } catch {
    // the notice is never worth an error
  }
}

const argv = process.argv.slice(2);
main(argv).then(
  async (code) => {
    process.exitCode = code;
    await notice(argv);
  },
  (e: unknown) => {
    if (e instanceof UsageError) {
      err(e.message);
      process.stderr.write(USAGE);
      process.exitCode = EXIT_CODE.invalid_request;
    } else if (e instanceof LurkdError) {
      err(e.message);
      process.exitCode = EXIT_CODE[e.code];
    } else {
      err(`lurkd: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  },
);
