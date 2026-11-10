import { parseArgs } from 'node:util';
import type { ApiClient, Query } from '../client/api.js';
import { formatArchive, formatError, formatFetch, formatSample, formatSession, formatSignals, formatSources } from '../client/format.js';
import { EXIT_CODE, LurkdError } from '../errors.js';
import type { ArchiveHitOut, AuthorSignalsOut, FetchResponse, SampleOut, SessionStatusOut } from '../fetch/service.js';
import type { SourceView } from '../sources/registry.js';

// The six agent tools as shell commands (D4): each one is one call to the lurkd API and prints what
// the MCP tool prints. `--json` prints the raw answer instead, except that session entries are
// projected like the attention entries of `lurkd status --json`: no login URL, no block URL.
// Errors go through `formatError` on stderr, so no token, run file content or `details` is printed.
// Exit codes: 0 ok, 2 usage, then EXIT_CODE of the error (3 the user has to act, 4 a cap).

export interface CommandDeps {
  client: ApiClient;
  out: (s: string) => void;
  err: (s: string) => void;
  readFile: (p: string) => string;
  /** Size and kind of a path, before it is read; throws when it cannot be statted. */
  statFile?: (p: string) => { isFile: boolean; size: number };
}

/** The largest draft file `sample --draft` reads. */
const MAX_DRAFT_BYTES = 1024 * 1024;

interface Command {
  usage: string;
  summary: string[];
  run: (argv: string[], deps: CommandDeps) => Promise<void>;
}

class UsageError extends Error {}

type Options = NonNullable<Parameters<typeof parseArgs>[0]>['options'];

const COMMANDS: Record<string, Command> = {
  sources: {
    usage: 'lurkd sources [query] [--topic t] [--json]',
    summary: ['List the sources that match a query or a topic.'],
    run: sources,
  },
  fetch: {
    usage: 'lurkd fetch <source> (--query q | --url u) [--max-threads n] [--refresh] [--from-post n] [--max-chars n] [--json]',
    summary: ['Read threads from one source: search it with --query, or read one thread with --url.'],
    run: fetchThreads,
  },
  search: {
    usage: 'lurkd search <query> [--source id] [--limit n] [--json]',
    summary: ['Search the threads lurkd has already read, offline.'],
    run: search,
  },
  session: {
    usage: 'lurkd session [source] [--check] [--json]',
    summary: ['Show the login state per source; --check asks the forum.'],
    run: session,
  },
  sample: {
    usage: 'lurkd sample <url> [--draft file] [--json]',
    summary: ['Print the structure of a page for drafting a source, or submit a drafted YAML file.'],
    run: sample,
  },
  author: {
    usage: 'lurkd author <source> <pseudonym> [--json]',
    summary: ['Show the total posts and join date of one pseudonymised author.'],
    run: author,
  },
};

export const MIRROR_COMMANDS: readonly string[] = Object.keys(COMMANDS);

/** The help lines of the six mirror commands, for the bin's `--help`. */
export const MIRROR_HELP: string = Object.values(COMMANDS)
  .map((c) => `  ${c.usage.slice('lurkd '.length)}\n${c.summary.map((l) => `                      ${l}`).join('\n')}`)
  .join('\n');

const JSON_FLAG = { json: { type: 'boolean' } } as const;

/**
 * Parses one command's arguments. `names` are the positionals, in order; the first `min` are
 * required. An empty string is a usage error, never "not given": `empty` can word it for a flag.
 */
function parse(argv: string[], options: Options, names: string[], min: number, empty: Record<string, string> = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { ...options, ...JSON_FLAG }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError((e instanceof Error ? e.message : String(e)).split('\n')[0]!);
  }
  for (const [k, v] of Object.entries(parsed.values)) {
    if ((v as unknown) === '') throw new UsageError(empty[k] ?? `--${k} is empty: give it a value.`);
  }
  const n = parsed.positionals.length;
  if (n < min) throw new UsageError(`Missing argument: <${names[n]}>.`);
  if (n > names.length) {
    throw new UsageError(
      `Too many arguments: expected ${names.length === 0 ? 'none' : names.map((x, i) => (i < min ? `<${x}>` : `[${x}]`)).join(' ')}. Put a value that has spaces in quotes.`,
    );
  }
  parsed.positionals.forEach((v, i) => {
    if (v === '') throw new UsageError(`The ${names[i]} argument is empty: give it a value.`);
  });
  return { values: parsed.values as Record<string, string | boolean | undefined>, positionals: parsed.positionals };
}

/** The value of a flag that takes a whole number; the server checks the range. */
function intFlag(v: string | boolean | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new UsageError(`${flag} takes a whole number.`);
  return Number(v);
}

const strFlag = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** The object without the keys whose value is undefined. */
function defined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** A session entry for --json: every field except the login URL, and the block URL as `block` (the kind only). */
function sessionEntry(s: SessionStatusOut): Record<string, unknown> {
  return defined({
    id: s.id,
    name: s.name,
    state: s.state,
    lastLoginAt: s.lastLoginAt,
    lastCheckAt: s.lastCheckAt,
    needsAcknowledgment: s.needsAcknowledgment,
    block: s.lastBlock?.kind ?? null,
    checkError: s.checkError,
  });
}

/** A source for --json: the login URL stays out. */
function sourceEntry(v: SourceView): Omit<SourceView, 'loginUrl'> {
  const { loginUrl: _loginUrl, ...rest } = v;
  return rest;
}

/** One line: the raw answer as JSON with --json, else the formatted text. */
function print(deps: CommandDeps, json: unknown, raw: () => unknown, text: () => string): void {
  deps.out(json === true ? JSON.stringify(raw()) : text());
}

async function sources(argv: string[], deps: CommandDeps): Promise<void> {
  const { values, positionals } = parse(argv, { topic: { type: 'string' } }, ['query'], 0);
  const query: Query = defined({ q: positionals[0], topic: strFlag(values.topic) });
  const list = await deps.client.get<SourceView[]>('/api/sources', query);
  print(deps, values.json, () => list.map(sourceEntry), () => formatSources(list));
}

async function fetchThreads(argv: string[], deps: CommandDeps): Promise<void> {
  const { values, positionals } = parse(
    argv,
    {
      query: { type: 'string' },
      url: { type: 'string' },
      'max-threads': { type: 'string' },
      refresh: { type: 'boolean' },
      'from-post': { type: 'string' },
      'max-chars': { type: 'string' },
    },
    ['source'], 1,
  );
  const query = strFlag(values.query);
  const url = strFlag(values.url);
  if ((query === undefined) === (url === undefined)) throw new UsageError('Give --query or --url, not both and not neither.');
  const body = defined({
    source: positionals[0],
    query,
    url,
    max_threads: intFlag(values['max-threads'], '--max-threads'),
    refresh: values.refresh === true ? true : undefined,
    from_post: intFlag(values['from-post'], '--from-post'),
    max_chars: intFlag(values['max-chars'], '--max-chars'),
  });
  const r = await deps.client.post<FetchResponse>('/api/fetch', body);
  print(deps, values.json, () => r, () => formatFetch(r));
}

async function search(argv: string[], deps: CommandDeps): Promise<void> {
  const { values, positionals } = parse(
    argv,
    { source: { type: 'string' }, limit: { type: 'string' } },
    ['query'],
    1,
  );
  const query: Query = defined({ q: positionals[0], source: strFlag(values.source), limit: intFlag(values.limit, '--limit') });
  const hits = await deps.client.get<ArchiveHitOut[]>('/api/archive/search', query);
  print(deps, values.json, () => hits, () => formatArchive(hits));
}

async function session(argv: string[], deps: CommandDeps): Promise<void> {
  const { values, positionals } = parse(argv, { check: { type: 'boolean' } }, ['source'], 0);
  const query: Query = defined({ source: positionals[0], check: values.check === true ? true : undefined });
  const list = await deps.client.get<SessionStatusOut[]>('/api/session', query);
  print(deps, values.json, () => list.map(sessionEntry), () => formatSession(list));
}

async function sample(argv: string[], deps: CommandDeps): Promise<void> {
  const { values, positionals } = parse(argv, { draft: { type: 'string' } }, ['url'], 1, { draft: 'The draft path is empty: give --draft a file.' });
  const file = strFlag(values.draft);
  let draft: string | undefined;
  if (file !== undefined) {
    // The kind and size are checked before the file is opened: a FIFO or a device would block, a huge file would fill memory.
    if (deps.statFile !== undefined) {
      let st;
      try {
        st = deps.statFile(file);
      } catch {
        throw new UsageError(`Cannot read the draft file ${file}.`);
      }
      if (!st.isFile) throw new UsageError(`The draft file ${file} is not a regular file.`);
      if (st.size > MAX_DRAFT_BYTES) throw new UsageError(`The draft file ${file} is larger than 1 MB.`);
    }
    try {
      draft = deps.readFile(file);
    } catch {
      // The reason is not repeated: the path is what the user needs.
      throw new UsageError(`Cannot read the draft file ${file}.`);
    }
    if (draft.trim() === '') throw new UsageError(`The draft file ${file} is empty.`);
  }
  const s = await deps.client.post<SampleOut>('/api/sample', defined({ url: positionals[0], draft_yaml: draft }));
  print(deps, values.json, () => s, () => formatSample(s));
}

async function author(argv: string[], deps: CommandDeps): Promise<void> {
  const { values, positionals } = parse(argv, {}, ['source', 'pseudonym'], 2);
  const s = await deps.client.post<AuthorSignalsOut>('/api/author-signals', { source: positionals[0], author: positionals[1] });
  print(deps, values.json, () => s, () => formatSignals(s));
}

/** Runs one mirror command and returns the process exit code. */
export async function runCommand(argv: string[], deps: CommandDeps): Promise<number> {
  const [name, ...rest] = argv;
  const command = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  try {
    if (command === undefined) throw new UsageError(name === undefined ? 'No command given.' : `Unknown command: ${name}`);
    await command.run(rest, deps);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      deps.err(e.message);
      deps.err(command === undefined ? `Usage:\n${Object.values(COMMANDS).map((c) => `  ${c.usage}`).join('\n')}` : `Usage: ${command.usage}`);
      return EXIT_CODE.invalid_request;
    }
    // Anything that is not a LurkdError may carry a path or a body: only the fact is printed.
    const le = e instanceof LurkdError ? e : new LurkdError('internal', 'lurkd hit an unexpected error.');
    deps.err(formatError(le));
    return EXIT_CODE[le.code];
  }
}
