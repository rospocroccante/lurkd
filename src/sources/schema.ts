import { basename } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { BUILTIN_DENY, isRedditHost, writeWordIn } from '../policy/urls.js';
import type { Engine } from '../types.js';

export interface Selectors {
  search_form?: string;
  search_input?: string;
  thread_list?: string;
  title?: string;
  post?: string;
  author?: string;
  author_signals?: string;
  date?: string;
  body?: string;
  quote?: string;
  next_page?: string;
}

export interface SourceConfig {
  id: string;
  name: string;
  description: string | null;
  status: 'verified' | 'public_read' | 'untested';
  topics: string[];
  engine: Engine;
  base_url: string;
  domains: string[];
  login_url: string | null;
  // D47: the forum's registration page, opened in the handoff window; the person signs up by hand.
  signup_url: string | null;
  // Contains {query}.
  search_url: string | null;
  // D14: the only POSTs that may leave the browser.
  read_endpoints: { method: 'POST'; path: string; note: string }[];
  session_check: { url: string; logged_in_selector: string } | null;
  // D15
  selectors: Selectors | null;
  // D33
  author_signals: { profile_lookup: boolean };
  automation: { policy: 'allowed' | 'forbidden' | 'unknown'; rule_url: string; rule_quote: string | null; checked_at: string };
  rate_limit: { min_delay_s: number; max_requests_per_run: number; max_requests_per_day: number };
  pagination: { max_pages_per_thread: number };
  deny_paths: string[];
  show_real_names: boolean;
  allow_beacons: boolean;
  enabled: boolean;
}

/** Path segments that name a write action; the same list as `BUILTIN_DENY` (src/policy/urls.ts). */
export const WRITE_WORDS: readonly string[] = BUILTIN_DENY;

// `import` is left out on purpose: only the built-in reddit-import source has it (src/sources/builtin.ts, D50).
const ENGINES = ['discourse', 'xenforo', 'phpbb', 'vbulletin', 'generic', 'custom'] as const satisfies readonly Engine[];
const PROFILE_LOOKUP_ENGINES: ReadonlySet<Engine> = new Set(['discourse', 'xenforo']);
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);
const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Every message follows its field path: "<file>: <field path> <message>".
const typed = (message: string) => ({ error: (iss: { input?: unknown }) => (iss.input === undefined ? 'is required' : message) });

function show(value: unknown): string {
  const s = JSON.stringify(value) ?? String(value);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function listOr(values: readonly string[]): string {
  return values.length === 1 ? values[0]! : `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;
}

const oneOf = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values, { error: (iss) => (iss.input === undefined ? 'is required' : `must be ${listOr(values)}, not ${show(iss.input)}`) });

const text = () => z.string(typed('must be a string')).refine((s) => s.trim() !== '', 'must not be empty');

function parseAbsolute(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// A URL the browser opens: https, or http on 127.0.0.1 and localhost (tests).
const browserUrl = () =>
  z.string(typed('must be a string')).superRefine((s, ctx) => {
    const u = parseAbsolute(s.replaceAll('{query}', 'q'));
    if (!u) ctx.addIssue({ code: 'custom', message: 'must be an absolute URL' });
    else if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)))
      ctx.addIssue({ code: 'custom', message: 'must use https (http only for 127.0.0.1 and localhost)' });
  });

const ruleUrl = z.string(typed('must be a string')).refine((s) => {
  const u = parseAbsolute(s);
  return u !== null && (u.protocol === 'https:' || u.protocol === 'http:');
}, 'must be an absolute http(s) URL');

function isRealDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const endpointPath = z.string(typed('must be a string')).superRefine((path, ctx) => {
  if (!path.startsWith('/')) ctx.addIssue({ code: 'custom', message: 'must start with /' });
  // `/**` or `/*` would declare every POST on the host read-only (D14).
  const segments = path.split(/[/\\?&=;]/).filter((seg) => seg !== '');
  if (segments.length > 0 && segments.every((seg) => /^\*+$/.test(seg)))
    ctx.addIssue({
      code: 'custom',
      message: 'matches every path on the host, which would make every POST read-only; give the path of the search endpoint',
    });
  const word = writeWordIn(path);
  if (word !== null) ctx.addIssue({ code: 'custom', message: `has the segment "${word}", which looks like a write action` });
});

const denyRule = z.string(typed('must be a string')).superRefine((rule, ctx) => {
  if (rule.trim() === '') ctx.addIssue({ code: 'custom', message: 'must not be empty' });
  else if (!rule.startsWith('/') && rule.includes('/'))
    ctx.addIssue({ code: 'custom', message: 'must be a word without "/" or a path pattern starting with "/"' });
  else if (!rule.startsWith('/') && /[\\?&=;]/.test(rule))
    ctx.addIssue({ code: 'custom', message: 'can never match: a word rule is compared with one segment, and segments are split on / \\ ? & = ;' });
});

const count = (min: number) =>
  z.number(typed('must be a number')).int('must be a whole number').min(min, `must be at least ${min}`);

const selectors = z.strictObject(
  {
    search_form: text().optional(),
    search_input: text().optional(),
    thread_list: text().optional(),
    title: text().optional(),
    post: text().optional(),
    author: text().optional(),
    author_signals: text().optional(),
    date: text().optional(),
    body: text().optional(),
    quote: text().optional(),
    next_page: text().optional(),
  },
  typed('must be a mapping of CSS selectors, or null'),
);

const sourceSchema = z
  .strictObject(
    {
      id: z.string(typed('must be a string')).regex(ID, 'must be 2 to 63 lowercase letters, digits or hyphens, starting with a letter or digit'),
      name: text(),
      description: z.string(typed('must be a string or null')).nullable().default(null),
      status: oneOf(['verified', 'public_read', 'untested']).default('untested'),
      topics: z
        .array(z.string(typed('must be a string')).regex(KEBAB, 'must be kebab-case (lowercase letters, digits, hyphens)'), typed('must be a list of topics'))
        .min(1, 'must list at least one topic'),
      engine: oneOf(ENGINES),
      base_url: browserUrl(),
      domains: z
        .array(
          z
            .string(typed('must be a string'))
            .regex(HOSTNAME, 'must be a bare lowercase hostname, without scheme, port, path or wildcard')
            // D50: Reddit is only imported from saved files, so no file can make it a live source.
            .refine(
              (d) => !isRedditHost(d),
              'is a Reddit host: lurkd does not read Reddit live, so no source can list it. Import saved threads with lurkd import reddit <file>.',
            ),
          typed('must be a list of hostnames'),
        )
        .min(1, 'must list at least one hostname'),
      login_url: browserUrl().nullable().default(null),
      signup_url: browserUrl().nullable().default(null),
      search_url: browserUrl()
        .refine((s) => s.includes('{query}'), 'must contain {query}')
        .nullable()
        .default(null),
      read_endpoints: z
        .array(
          z.strictObject(
            { method: z.literal('POST', typed('must be POST')), path: endpointPath, note: text() },
            typed('must be a mapping with method, path and note'),
          ),
          typed('must be a list'),
        )
        .default([]),
      session_check: z
        .strictObject({ url: browserUrl(), logged_in_selector: text() }, typed('must be a mapping with url and logged_in_selector, or null'))
        .nullable()
        .default(null),
      selectors: selectors.nullable().default(null),
      author_signals: z
        .strictObject({ profile_lookup: z.boolean(typed('must be true or false')).optional() }, typed('must be a mapping'))
        .prefault({}),
      automation: z.strictObject(
        {
          policy: oneOf(['allowed', 'forbidden', 'unknown']),
          rule_url: ruleUrl,
          rule_quote: z.string(typed('must be a string or null')).nullable().default(null),
          checked_at: z.string(typed('must be a date written YYYY-MM-DD')).refine(isRealDate, 'must be a date written YYYY-MM-DD'),
        },
        typed('must be a mapping with policy, rule_url, rule_quote and checked_at'),
      ),
      rate_limit: z
        .strictObject(
          {
            min_delay_s: z.number(typed('must be a number')).min(1, 'must be at least 1').default(2),
            max_requests_per_run: count(1).max(60, 'must be at most 60').default(60),
            max_requests_per_day: count(1).default(300),
          },
          typed('must be a mapping'),
        )
        .prefault({}),
      pagination: z.strictObject({ max_pages_per_thread: count(1).default(20) }, typed('must be a mapping')).prefault({}),
      deny_paths: z.array(denyRule, typed('must be a list')).default([]),
      show_real_names: z.boolean(typed('must be true or false')).default(false),
      allow_beacons: z.boolean(typed('must be true or false')).default(false),
      enabled: z.boolean(typed('must be true or false')).default(true),
    },
    typed('must be a mapping'),
  )
  // Cross-field rules run even when a field failed, so one pass reports every error.
  .superRefine((value, ctx) => crossFieldChecks(value, (path, message) => ctx.addIssue({ code: 'custom', path, message })), {
    when: () => true,
  });

type Report = (path: (string | number)[], message: string) => void;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// `value` may be partly invalid here, so every rule checks the types it relies on.
function crossFieldChecks(value: unknown, report: Report): void {
  if (!isRecord(value)) return;
  if (Array.isArray(value.domains)) {
    const domains = value.domains;
    const session = isRecord(value.session_check) ? value.session_check.url : undefined;
    const urls: [(string | number)[], unknown][] = [
      [['base_url'], value.base_url],
      [['login_url'], value.login_url],
      [['signup_url'], value.signup_url],
      [['search_url'], value.search_url],
      [['session_check', 'url'], session],
    ];
    for (const [path, url] of urls) {
      if (typeof url !== 'string') continue;
      const u = parseAbsolute(url.replaceAll('{query}', 'q'));
      if (u && !domains.includes(u.hostname)) report(path, `host ${u.hostname} is not listed in domains`);
    }
  }
  if (value.engine === 'custom') {
    const sel = isRecord(value.selectors) ? value.selectors : {};
    for (const key of ['post', 'author']) if (sel[key] === undefined) report(['selectors', key], 'is required for engine custom');
  }
  const automation = isRecord(value.automation) ? value.automation : {};
  const policy = automation.policy;
  if (policy === 'forbidden' && value.enabled !== false) report(['automation', 'policy'], 'forbidden requires enabled: false');
  if (policy === 'allowed' || policy === 'forbidden') {
    const quote = automation.rule_quote;
    if (typeof quote !== 'string' || quote.trim() === '') report(['automation', 'rule_quote'], `is required when automation.policy is ${policy}`);
  }
  if (policy === 'forbidden' && value.status === 'public_read')
    report(['status'], 'public_read is not allowed when automation.policy is forbidden');
}

function fieldPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : out === '' ? String(p) : `.${String(p)}`;
  return out;
}

function formatIssue(file: string, issue: z.core.$ZodIssue): string[] {
  if (issue.code === 'unrecognized_keys') return issue.keys.map((k) => `${file}: ${fieldPath([...issue.path, k])} is not a known field`);
  const at = fieldPath(issue.path);
  return [at === '' ? `${file}: ${issue.message}` : `${file}: ${at} ${issue.message}`];
}

/**
 * Parses and validates one source file. `opts.file` is the path the caller shows (root-relative for
 * the Registry); only its basename, without `.yaml`, is compared with `id`. Errors read
 * `<file>: <field path> <message>`, and every error is listed, not only the first.
 */
export function parseSource(yamlText: string, opts: { file: string }): { ok: true; source: SourceConfig } | { ok: false; errors: string[] } {
  const { file } = opts;
  const doc = parseDocument(yamlText, { uniqueKeys: true });
  // yaml appends a code frame after the first line; the first line already names line and column.
  if (doc.errors.length > 0) return { ok: false, errors: doc.errors.map((e) => `${file}: ${e.message.split('\n')[0]!.replace(/:$/, '')}`) };
  let value: unknown;
  try {
    value = doc.toJS();
  } catch (e) {
    return { ok: false, errors: [`${file}: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!isRecord(value)) return { ok: false, errors: [`${file}: the file must be a YAML mapping of source fields`] };

  const parsed = sourceSchema.safeParse(value);
  const errors = parsed.success ? [] : parsed.error.issues.flatMap((issue) => formatIssue(file, issue));
  const expectedId = basename(file).replace(/\.yaml$/, '');
  if (typeof value.id === 'string' && value.id !== expectedId) errors.push(`${file}: id "${value.id}" must equal the file name "${expectedId}"`);
  if (!parsed.success || errors.length > 0) return { ok: false, errors };

  const data = parsed.data;
  return {
    ok: true,
    source: {
      ...data,
      author_signals: { profile_lookup: data.author_signals.profile_lookup ?? PROFILE_LOOKUP_ENGINES.has(data.engine) },
    },
  };
}
