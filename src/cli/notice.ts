import type { ApiClient } from '../client/api.js';
import { isNewerVersion, parseStableVersion } from '../update/version.js';
import { MIRROR_COMMANDS } from './commands.js';

// D53: after a CLI command, one line on stderr when the running server knows of a newer lurkd.
// The CLI never asks the registry itself: it reads what the server found (GET /api/update). The
// line never goes into --json output, and the MCP server never asks for it.

/** The commands after which the notice may be printed: those that talk to a running server. */
const NOTICE_COMMANDS: ReadonlySet<string> = new Set(['start', 'open', ...MIRROR_COMMANDS]);

/**
 * True when `argv` is a command after which the notice is printed. Not with --json, and not for
 * `status` (its own output names the update), `stop` (no server is left to ask), `mcp` (stdout
 * is the protocol and the agent never sees the notice), `update`, `--version` or `--help`.
 */
export function wantsNotice(argv: readonly string[]): boolean {
  const [cmd, ...rest] = argv;
  return cmd !== undefined && NOTICE_COMMANDS.has(cmd) && !rest.includes('--json');
}

/** The notice line, or null when the server knows of no newer version or cannot tell. Never throws. */
export async function updateNotice(client: Pick<ApiClient, 'get'>, version: string): Promise<string | null> {
  let answer: unknown;
  try {
    answer = await client.get<unknown>('/api/update');
  } catch {
    // An older server has no such route; a stopped one cannot answer. Either way, nothing to say.
    return null;
  }
  const update = typeof answer === 'object' && answer !== null ? (answer as { update?: unknown }).update : null;
  const latest = typeof update === 'object' && update !== null ? (update as { latest?: unknown }).latest : null;
  if (parseStableVersion(latest) === null || !isNewerVersion(latest as string, version)) return null;
  return `lurkd ${latest as string} is available: run lurkd update`;
}
