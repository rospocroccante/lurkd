import type Database from 'better-sqlite3';
import { type Document, isAlias, isMap, isNode, parseDocument, visit } from 'yaml';
import { StateStore } from '../archive/state.js';
import { LurkdError } from '../errors.js';
import { checkSelector } from '../extract/selectors.js';
import type { Registry } from './registry.js';
import { parseSource, type Selectors, type SourceConfig } from './schema.js';

// D15: the agent samples a page (`SampleStore`) and drafts a source YAML from it (`DraftStore`);
// the user approves the draft on the lurkd page before the source exists. The YAML an agent
// submits is untrusted: it is size-capped, refused with anchors, aliases, tags or directives,
// validated by `parseSource` and the selector checks of Task 12. A draft cannot loosen what
// protects the forum or the user: status is forced to `untested`, `show_real_names`,
// `allow_beacons` and `enabled` to false, and the rate limit and page cap to the defaults or
// stricter; each change is listed among the warnings. The user loosens them later through the
// normal settings, never through a draft. Approval is the only path from a draft to
// `Registry.writeUserSource`, and it checks the stored text again.

/** A draft larger than this (UTF-8 bytes) is refused before it is parsed. */
export const MAX_DRAFT_BYTES = 64 * 1024;

/** How long a read endpoint note may be in a warning. */
const MAX_NOTE = 200;

/** The loosest limits a draft may set: the schema defaults (global constraints, D31). */
export const DRAFT_LIMITS = { min_delay_s: 2, max_requests_per_run: 60, max_requests_per_day: 300, max_pages_per_thread: 20 } as const;

/** The file name drafts are reported under before their id is known. */
const DRAFT_FILE = 'draft.yaml';

type Clock = () => Date;

interface SampleRow {
  host: string;
  url: string;
  structure: string | null;
  requested_at: string;
  sampled_at: string | null;
}

/** Pages to sample, one per host: requested by the agent, captured headless or through the UI. */
export class SampleStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: Clock = () => new Date(),
  ) {}

  /** Asks for a sample of `url`. A host asked again gets the new URL and loses its earlier sample. */
  request(host: string, url: string): void {
    this.db
      .prepare(
        `INSERT INTO samples (host, url, structure, requested_at, sampled_at) VALUES (?, ?, NULL, ?, NULL)
         ON CONFLICT (host) DO UPDATE SET url = excluded.url, structure = NULL, requested_at = excluded.requested_at, sampled_at = NULL`,
      )
      .run(hostKey(host), url, this.now().toISOString());
  }

  /** Stores the formatted structure of `url`; a host nobody requested gets `requestedAt` now. */
  save(host: string, url: string, structure: string): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO samples (host, url, structure, requested_at, sampled_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (host) DO UPDATE SET url = excluded.url, structure = excluded.structure, sampled_at = excluded.sampled_at`,
      )
      .run(hostKey(host), url, structure, at, at);
  }

  get(host: string): { host: string; url: string; structure: string | null; requestedAt: string; sampledAt: string | null } | null {
    const r = this.db.prepare('SELECT * FROM samples WHERE host = ?').get(hostKey(host)) as SampleRow | undefined;
    if (!r) return null;
    return { host: r.host, url: r.url, structure: r.structure, requestedAt: r.requested_at, sampledAt: r.sampled_at };
  }

  /** Requests still waiting for a sample, oldest first. */
  pending(): { host: string; url: string; requestedAt: string }[] {
    const rows = this.db.prepare('SELECT host, url, requested_at FROM samples WHERE structure IS NULL ORDER BY requested_at, host').all() as SampleRow[];
    return rows.map((r) => ({ host: r.host, url: r.url, requestedAt: r.requested_at }));
  }
}

/** At most this many hosts wait in the "Add a forum" queue: an agent cannot flood the lurkd page. */
export const MAX_ADD_REQUESTS = 20;

interface AddRequestRow {
  host: string;
  url: string;
  requested_at: string;
}

/**
 * Forums `lurkd add` queued for the lurkd page (D45), one per host. Nothing here opens an address:
 * the user presses "Analyse" on the page, and only that loads it. A host keeps the first address
 * it was queued with, so the address the page shows cannot change under the user. A request goes
 * away when the user dismisses it, a draft is saved or rejected for its host, or a source already
 * claims it.
 */
export class AddRequestStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: Clock = () => new Date(),
  ) {}

  /**
   * Queues `url` for `host` and answers with the address now waiting for it: a host already
   * waiting keeps its first address (`kept` true when `url` differs from it). `invalid_request`
   * when the queue is full.
   */
  request(host: string, url: string): { url: string; kept: boolean } {
    const key = hostKey(host);
    return this.db
      .transaction(() => {
        const waiting = this.db.prepare('SELECT url FROM add_requests WHERE host = ?').get(key) as { url: string } | undefined;
        if (waiting) return { url: waiting.url, kept: waiting.url !== url };
        const count = (this.db.prepare('SELECT count(*) AS n FROM add_requests').get() as { n: number }).n;
        if (count >= MAX_ADD_REQUESTS)
          throw new LurkdError(
            'invalid_request',
            `${MAX_ADD_REQUESTS} forums are already waiting on the lurkd page. Ask the user to analyse or dismiss some of them under "Add a forum" first.`,
          );
        this.db.prepare('INSERT INTO add_requests (host, url, requested_at) VALUES (?, ?, ?)').run(key, url, this.now().toISOString());
        return { url, kept: false };
      })
      .immediate();
  }

  /** The queued forums, oldest first. */
  pending(): { host: string; url: string; requestedAt: string }[] {
    const rows = this.db.prepare('SELECT host, url, requested_at FROM add_requests ORDER BY requested_at, host').all() as AddRequestRow[];
    return rows.map((r) => ({ host: r.host, url: r.url, requestedAt: r.requested_at }));
  }

  /** Drops the request of `host`; false when none was waiting. */
  remove(host: string): boolean {
    return this.db.prepare('DELETE FROM add_requests WHERE host = ?').run(hostKey(host)).changes > 0;
  }
}

/** One forum whose rules forbid automated access (D49). */
export interface ForbiddenEntry {
  host: string;
  /** The forum's name as the analysed page gave it: forum text. */
  name: string;
  engine: 'discourse' | 'xenforo' | null;
  baseUrl: string;
  loginUrl: string | null;
  signupUrl: string | null;
  searchUrl: string | null;
  /** The rules page the sentence is on. */
  ruleUrl: string;
  /** The exact sentence that forbids automated access: forum text. */
  sentence: string;
  foundAt: string;
}

interface ForbiddenRow {
  host: string;
  name: string;
  engine: ForbiddenEntry['engine'];
  base_url: string;
  login_url: string | null;
  signup_url: string | null;
  search_url: string | null;
  rule_url: string;
  sentence: string;
  found_at: string;
}

/**
 * Forums whose rules forbid automated access, as "Analyse" found them on the lurkd page (D49), one
 * per host; a later clause for the same host replaces the earlier one. Only the page's routes
 * write here: the user dismisses an entry, or drafts the source from it with "Add anyway".
 */
export class ForbiddenLog {
  constructor(
    private readonly db: Database.Database,
    private readonly now: Clock = () => new Date(),
  ) {}

  /** Stores the clause found for `e.host`, replacing any earlier one, and returns the entry. */
  record(e: Omit<ForbiddenEntry, 'foundAt'>): ForbiddenEntry {
    const host = hostKey(e.host);
    this.db
      .prepare(
        `INSERT INTO forbidden_log (host, name, engine, base_url, login_url, signup_url, search_url, rule_url, sentence, found_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (host) DO UPDATE SET name = excluded.name, engine = excluded.engine, base_url = excluded.base_url,
           login_url = excluded.login_url, signup_url = excluded.signup_url, search_url = excluded.search_url,
           rule_url = excluded.rule_url, sentence = excluded.sentence, found_at = excluded.found_at`,
      )
      .run(host, e.name, e.engine, e.baseUrl, e.loginUrl, e.signupUrl, e.searchUrl, e.ruleUrl, e.sentence, this.now().toISOString());
    return this.get(host)!;
  }

  /** Every entry, the most recent first. */
  list(): ForbiddenEntry[] {
    return (this.db.prepare('SELECT * FROM forbidden_log ORDER BY found_at DESC, host').all() as ForbiddenRow[]).map(toForbidden);
  }

  get(host: string): ForbiddenEntry | null {
    const r = this.db.prepare('SELECT * FROM forbidden_log WHERE host = ?').get(hostKey(host)) as ForbiddenRow | undefined;
    return r ? toForbidden(r) : null;
  }

  /** Drops the entry of `host`; false when there was none. */
  remove(host: string): boolean {
    return this.db.prepare('DELETE FROM forbidden_log WHERE host = ?').run(hostKey(host)).changes > 0;
  }
}

function toForbidden(r: ForbiddenRow): ForbiddenEntry {
  return {
    host: r.host,
    name: r.name,
    engine: r.engine,
    baseUrl: r.base_url,
    loginUrl: r.login_url,
    signupUrl: r.signup_url,
    searchUrl: r.search_url,
    ruleUrl: r.rule_url,
    sentence: r.sentence,
    foundAt: r.found_at,
  };
}

export interface DraftView {
  id: number;
  sourceId: string;
  host: string;
  yaml: string;
  warnings: string[];
  state: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

interface DraftRow {
  id: number;
  source_id: string;
  host: string;
  yaml: string;
  warnings: string;
  state: DraftView['state'];
  created_at: string;
}

/** The error a caller throws for a refused draft (P36): `invalid_request` with `details.errors`. */
export function draftRefused(errors: string[]): LurkdError {
  return new LurkdError('invalid_request', `The draft is not valid:\n${errors.join('\n')}`, { errors });
}

type Checked = { ok: true; yaml: string; source: SourceConfig; warnings: string[] } | { ok: false; errors: string[] };

/** YAML drafts of new sources, waiting for the user's approval. */
export class DraftStore {
  private readonly state: StateStore;
  private readonly now: Clock;

  /**
   * `opts.state` is the store the Registry reads its overrides from (by default one on `db`);
   * approval clears the acknowledgment and the on/off switch stored for the draft's id.
   */
  constructor(
    private readonly db: Database.Database,
    private readonly registry: Registry,
    opts: { state?: StateStore; now?: Clock } = {},
  ) {
    this.state = opts.state ?? new StateStore(db);
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Checks `yamlText` as a draft for `host` (the host of the sampled page) and stores it as
   * pending. Refused, with every error listed: a text over 64 KB, YAML with anchors, aliases,
   * tags or directives, a source `parseSource` refuses (file `<id>.yaml`), a seed id, `domains`
   * without `host`, a domain another source claims, a selector lurkd cannot run or that costs too
   * much. `status` is rewritten to `untested`; `show_real_names`, `allow_beacons` and `enabled`
   * to false; `rate_limit` and `pagination.max_pages_per_thread` clamped to `DRAFT_LIMITS`. Each
   * rewrite except the status adds a warning after the policy line.
   */
  submit(yamlText: string, host: string): { ok: true; draft: DraftView } | { ok: false; errors: string[] } {
    const checked = this.check(yamlText, host, true);
    if (!checked.ok) return checked;
    const createdAt = this.now().toISOString();
    const info = this.db
      .prepare('INSERT INTO drafts (source_id, host, yaml, warnings, state, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(checked.source.id, hostKey(host), checked.yaml, JSON.stringify(checked.warnings), 'pending', createdAt);
    return { ok: true, draft: this.view(Number(info.lastInsertRowid)) };
  }

  /** Drafts by id, oldest first; only those in `state` when given. */
  list(state?: DraftView['state']): DraftView[] {
    const rows = (
      state === undefined
        ? this.db.prepare('SELECT * FROM drafts ORDER BY id').all()
        : this.db.prepare('SELECT * FROM drafts WHERE state = ? ORDER BY id').all(state)
    ) as DraftRow[];
    return rows.map(toView);
  }

  /**
   * Registers a pending draft with `registry.writeUserSource`, after checking the stored text
   * again (`invalid_request` with `details.errors` when it no longer passes). The source's stored
   * overrides (on/off switch, acknowledgment, real names, beacons) are cleared, so a draft that
   * replaces a user source never inherits the user's earlier choices: it lands switched off, and
   * policy `unknown` or `forbidden` needs the acknowledgment again (Task 4 rules). `not_found` for
   * an unknown id, `invalid_request` for a draft that is not pending.
   */
  approve(id: number): SourceConfig {
    const row = this.pendingRow(id);
    const checked = this.check(row.yaml, row.host, false);
    if (!checked.ok) throw draftRefused(checked.errors);
    const sourceId = checked.source.id;
    // One transaction: the overrides are cleared first and the draft marked approved last, so a
    // failed override write leaves no file behind, and a failed file write rolls the cleared
    // overrides and the draft state back (the draft stays pending). It covers the state store
    // only when that store uses this database, as the server wires it.
    this.db.transaction(() => {
      this.state.setOverride(sourceId, { enabled: null, acknowledgedAt: null, acknowledgedPolicy: null, showRealNames: null, allowBeacons: null });
      this.registry.writeUserSource(checked.yaml);
      this.db.prepare("UPDATE drafts SET state = 'approved' WHERE id = ?").run(id);
    })();
    return this.registry.get(sourceId);
  }

  /** Marks a pending draft rejected and returns it; `not_found` for an unknown id, `invalid_request` when not pending. */
  reject(id: number): DraftView {
    this.pendingRow(id);
    this.db.prepare("UPDATE drafts SET state = 'rejected' WHERE id = ?").run(id);
    return this.view(id);
  }

  private view(id: number): DraftView {
    return toView(this.row(id));
  }

  private row(id: number): DraftRow {
    const r = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined;
    if (!r) throw new LurkdError('not_found', `No draft has the id ${id}.`, { draftId: id });
    return r;
  }

  private pendingRow(id: number): DraftRow {
    const r = this.row(id);
    if (r.state !== 'pending') throw new LurkdError('invalid_request', `Draft ${id} is already ${r.state}.`, { draftId: id, state: r.state });
    return r;
  }

  /**
   * Every check of `submit`. `rewrite` applies the forced values (the stored text already has
   * them); without it, a stored text that breaks them is refused.
   */
  private check(yamlText: string, host: string, rewrite: boolean): Checked {
    if (Buffer.byteLength(yamlText, 'utf8') > MAX_DRAFT_BYTES)
      return { ok: false, errors: [`${DRAFT_FILE}: the draft is larger than ${MAX_DRAFT_BYTES / 1024} KB`] };
    const doc = parseDocument(yamlText, { uniqueKeys: true });
    if (doc.errors.length > 0) return { ok: false, errors: doc.errors.map((e) => `${DRAFT_FILE}: ${e.message.split('\n')[0]!.replace(/:$/, '')}`) };

    const errors: string[] = [];
    if (doc.directives?.yaml.explicit === true || Object.keys(doc.directives?.tags ?? {}).some((h) => h !== '!!'))
      errors.push(`${DRAFT_FILE}: YAML directives (%YAML, %TAG) are not allowed in a draft`);
    let anchors = false;
    let tags = false;
    visit(doc, {
      Node(_key, node) {
        if (isAlias(node) || (isNode(node) && node.anchor !== undefined && node.anchor !== null)) anchors = true;
        if (isNode(node) && typeof node.tag === 'string' && node.tag !== '') tags = true;
      },
    });
    if (anchors) errors.push(`${DRAFT_FILE}: YAML anchors and aliases (& and *) are not allowed in a draft`);
    if (tags) errors.push(`${DRAFT_FILE}: YAML tags (!! or !) are not allowed in a draft`);
    if (errors.length > 0) return { ok: false, errors };

    const changed: string[] = [];
    if (rewrite && isMap(doc.contents)) {
      doc.set('status', 'untested');
      changed.push(...forceSafe(doc));
    }
    const yaml = rewrite ? doc.toString() : yamlText;
    const declared = isMap(doc.contents) ? doc.get('id') : undefined;
    // An id that cannot be a file name is reported by the schema; the file-name error would repeat it.
    const usable = typeof declared === 'string' && /^[a-z0-9-]+$/.test(declared);
    const file = usable ? `${declared}.yaml` : DRAFT_FILE;
    const parsed = parseSource(yaml, { file });
    if (!parsed.ok) return { ok: false, errors: usable ? parsed.errors : parsed.errors.filter((e) => !e.includes('must equal the file name')) };
    const source = parsed.source;
    if (source.status !== 'untested') errors.push(`${file}: status must be untested in a draft`);
    if (source.show_real_names) errors.push(`${file}: show_real_names must be false in a draft; real names are switched on from the lurkd page`);
    if (source.allow_beacons) errors.push(`${file}: allow_beacons must be false in a draft`);
    if (source.enabled) errors.push(`${file}: enabled must be false in a draft`);
    const { min_delay_s, max_requests_per_run, max_requests_per_day } = source.rate_limit;
    if (min_delay_s < DRAFT_LIMITS.min_delay_s) errors.push(`${file}: rate_limit.min_delay_s must be at least ${DRAFT_LIMITS.min_delay_s} in a draft`);
    if (max_requests_per_run > DRAFT_LIMITS.max_requests_per_run)
      errors.push(`${file}: rate_limit.max_requests_per_run must be at most ${DRAFT_LIMITS.max_requests_per_run} in a draft`);
    if (max_requests_per_day > DRAFT_LIMITS.max_requests_per_day)
      errors.push(`${file}: rate_limit.max_requests_per_day must be at most ${DRAFT_LIMITS.max_requests_per_day} in a draft`);
    if (source.pagination.max_pages_per_thread > DRAFT_LIMITS.max_pages_per_thread)
      errors.push(`${file}: pagination.max_pages_per_thread must be at most ${DRAFT_LIMITS.max_pages_per_thread} in a draft`);

    const known = new Set(this.registry.ids());
    const replaces = known.has(source.id) && !this.registry.view(source.id).seed;
    if (known.has(source.id) && !replaces) errors.push(`${file}: "${source.id}" is the id of a seed source; give the new source another id`);
    const sampled = hostKey(host);
    if (!source.domains.includes(sampled)) errors.push(`${file}: domains does not list ${sampled}, the host of the sampled page`);
    for (const other of this.registry.views()) {
      if (other.id === source.id) continue;
      const clash = source.domains.find((d) => other.domains.includes(d));
      if (clash !== undefined) errors.push(`${file}: domain ${clash} is already claimed by ${other.id}`);
    }
    errors.push(...selectorErrors(source, file));
    if (errors.length > 0) return { ok: false, errors };

    const warnings = [...warningsFor(source), ...changed];
    if (replaces) warnings.push(`replaces the user source ${source.id}`);
    return { ok: true, yaml, source, warnings };
  }
}

/**
 * Sets the fields a draft may not loosen to their safe values and returns one warning per field
 * changed. A value of the wrong type is left for `parseSource` to report.
 */
function forceSafe(doc: Document): string[] {
  const out: string[] = [];
  const flag = (key: string, why: string) => {
    const v: unknown = doc.get(key);
    if (v === true || (key === 'enabled' && v === undefined)) {
      doc.set(key, false);
      out.push(`${key} set to false: ${why}`);
    }
  };
  flag('show_real_names', 'real names are switched on from the lurkd page');
  flag('allow_beacons', 'beacons are allowed from the lurkd page');
  flag('enabled', 'switch the source on from the lurkd page after approval');
  const clamp = (path: [string, string], limit: number, atLeast: boolean) => {
    const v: unknown = doc.getIn(path);
    if (typeof v !== 'number' || (atLeast ? v >= limit : v <= limit)) return;
    doc.setIn(path, limit);
    out.push(`${path.join('.')} set to ${limit} (the draft had ${v}): a draft can only keep the default or a stricter value`);
  };
  clamp(['rate_limit', 'min_delay_s'], DRAFT_LIMITS.min_delay_s, true);
  clamp(['rate_limit', 'max_requests_per_run'], DRAFT_LIMITS.max_requests_per_run, false);
  clamp(['rate_limit', 'max_requests_per_day'], DRAFT_LIMITS.max_requests_per_day, false);
  clamp(['pagination', 'max_pages_per_thread'], DRAFT_LIMITS.max_pages_per_thread, false);
  return out;
}

/** The selector checks the extractors run before their first request (Task 12), as error lines. */
function selectorErrors(source: SourceConfig, file: string): string[] {
  const out: string[] = [];
  const run = (key: Parameters<typeof checkSelector>[1], selector: string) => {
    try {
      checkSelector(source, key, selector);
    } catch (e) {
      out.push(`${file}: ${key} ${e instanceof LurkdError ? e.message : String(e)}`);
    }
  };
  for (const [key, selector] of Object.entries(source.selectors ?? {}) as [keyof Selectors, string | undefined][]) {
    if (selector !== undefined) run(`selectors.${key}`, selector);
  }
  if (source.session_check !== null) run('session_check.logged_in_selector', source.session_check.logged_in_selector);
  return out;
}

/**
 * What the user must look at before approving, in this order: every read endpoint as
 * `POST <path>: <note>`, the domains, `login_url`, `signup_url` (D47: the handoff window opens it),
 * `search_url`, `allow_beacons: true` when set, and the policy with its rule.
 */
function warningsFor(s: SourceConfig): string[] {
  const out = s.read_endpoints.map((e) => `POST ${e.path}: ${oneLine(e.note)}`);
  out.push(`domains: ${s.domains.join(', ')}`);
  if (s.login_url !== null) out.push(`login_url: ${s.login_url}`);
  if (s.signup_url !== null) out.push(`signup_url: ${s.signup_url}`);
  if (s.search_url !== null) out.push(`search_url: ${s.search_url}`);
  if (s.allow_beacons) out.push('allow_beacons: true');
  const { policy, rule_quote, rule_url } = s.automation;
  out.push(rule_quote === null ? `policy ${policy} (${rule_url})` : `policy ${policy}: "${oneLine(rule_quote)}" (${rule_url})`);
  return out;
}

function oneLine(text: string): string {
  const t = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  return t.length > MAX_NOTE ? `${t.slice(0, MAX_NOTE - 3)}...` : t;
}

function hostKey(host: string): string {
  return host.trim().toLowerCase();
}

function toView(r: DraftRow): DraftView {
  return {
    id: r.id,
    sourceId: r.source_id,
    host: r.host,
    yaml: r.yaml,
    warnings: JSON.parse(r.warnings) as string[],
    state: r.state,
    createdAt: r.created_at,
  };
}
