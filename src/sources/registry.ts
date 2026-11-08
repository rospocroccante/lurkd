import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { SourceOverride, StateStore, StoredSessionState } from '../archive/state.js';
import { LurkdError } from '../errors.js';
import type { Engine } from '../types.js';
import { parseSource, type SourceConfig } from './schema.js';

export type SessionView = StoredSessionState | 'disabled';

export interface SourceView {
  id: string;
  name: string;
  description: string | null;
  topics: string[];
  engine: Engine;
  status: SourceConfig['status'];
  policy: SourceConfig['automation']['policy'];
  ruleUrl: string;
  ruleQuote: string | null;
  domains: string[];
  loginUrl: string | null;
  enabled: boolean;
  needsAcknowledgment: boolean;
  session: SessionView;
  showRealNames: boolean;
  allowBeacons: boolean;
  searchSupported: boolean;
  seed: boolean;
}

/**
 * Whether lurkd can search this source (P15, D6). The Registry reports it as `searchSupported`,
 * and the engine adapters' `search` must answer `search_unsupported` exactly when it is false:
 * when the adapters land they own this rule and the Registry calls theirs.
 * Discourse searches with GET; XenForo through `search_url` or a declared POST read endpoint
 * (D14, Task 11); every other engine through `search_url` or the D14 form (`search_form`,
 * `search_input` and a read endpoint).
 */
export function canSearch(source: SourceConfig): boolean {
  if (source.search_url !== null) return true;
  if (source.engine === 'discourse') return true;
  if (source.engine === 'xenforo') return source.read_endpoints.length > 0;
  const sel = source.selectors;
  return sel?.search_form !== undefined && sel.search_input !== undefined && source.read_endpoints.length > 0;
}

interface Entry {
  // The source as its file declares it, before the user's overrides.
  file: SourceConfig;
  // Path relative to its root, as printed in errors().
  rel: string;
  seed: boolean;
}

const SPLIT = /[^\p{L}\p{N}]+/u;
const NAME_ORDER = new Intl.Collator('en', { sensitivity: 'base' });

function tokensOf(text: string): string[] {
  return text.toLowerCase().split(SPLIT).filter((t) => t !== '');
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `.yaml` files under `dir`, root-relative with `/`, sorted; `recursive` walks subfolders. */
function yamlFiles(dir: string, recursive: boolean, errors: string[]): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir, { recursive, encoding: 'utf8' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${dir}: cannot read the folder: ${message(e)}`);
    return [];
  }
  return names
    .filter((n) => n.endsWith('.yaml'))
    .map((n) => n.split(path.sep).join('/'))
    .filter((n) => {
      try {
        return fs.statSync(path.join(dir, n)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Seed sources (shipped with the package) and user sources (`~/.lurkd/sources`), merged with the
 * user's overrides from the state store. `get` is the only way any other module reads a source,
 * so the overrides apply everywhere.
 */
export class Registry {
  private entries = new Map<string, Entry>();
  private loadErrors: string[] = [];

  private constructor(private readonly opts: { seedDir: string; userDir: string; state: StateStore }) {}

  static load(opts: { seedDir: string; userDir: string; state: StateStore }): Registry {
    const r = new Registry(opts);
    r.reload();
    return r;
  }

  /**
   * Reads every file again. An invalid file, a user file that reuses a seed id, a second file with
   * an id already loaded, or a file with a domain another source claims is skipped and listed in
   * `errors()`. Seed files load first, so a seed source always wins; within a root, files load in
   * path order and the first file to claim an id or a domain keeps it.
   */
  reload(): void {
    const errors: string[] = [];
    const entries = new Map<string, Entry>();
    const owners = new Map<string, string>();
    const roots = [
      { dir: this.opts.seedDir, seed: true, recursive: true },
      { dir: this.opts.userDir, seed: false, recursive: false },
    ];
    for (const root of roots) {
      for (const rel of yamlFiles(root.dir, root.recursive, errors)) {
        let text: string;
        try {
          text = fs.readFileSync(path.join(root.dir, rel), 'utf8');
        } catch (e) {
          errors.push(`${rel}: cannot read the file: ${message(e)}`);
          continue;
        }
        // P5: the root-relative path is the file name parseSource prints; no prefix is added here.
        const parsed = parseSource(text, { file: rel });
        if (!parsed.ok) {
          errors.push(...parsed.errors);
          continue;
        }
        const source = parsed.source;
        const taken = entries.get(source.id);
        if (taken) {
          errors.push(
            taken.seed && !root.seed
              ? `${rel}: id "${source.id}" belongs to a seed source (${taken.rel}), so this file is skipped; give it another id`
              : `${rel}: id "${source.id}" is already used by ${taken.rel}, so this file is skipped`,
          );
          continue;
        }
        const clash = source.domains.find((d) => owners.has(d));
        if (clash !== undefined) {
          const owner = entries.get(owners.get(clash)!)!;
          errors.push(`${rel}: domain ${clash} is already claimed by ${owner.file.id} (${owner.rel}), so this file is skipped`);
          continue;
        }
        // P9 seam (Task 23): merge engine preset fields here, resolving a relative preset
        // search_url against base_url, before anything reads the source or calls canSearch.
        entries.set(source.id, { file: source, rel, seed: root.seed });
        for (const d of source.domains) owners.set(d, source.id);
      }
    }
    this.entries = entries;
    this.loadErrors = errors;
  }

  /** One line per skipped file problem: `<path relative to its root>: <message>`. */
  errors(): string[] {
    return [...this.loadErrors];
  }

  ids(): string[] {
    return [...this.entries.keys()].sort();
  }

  /**
   * The effective config: the file with the user's overrides merged into enabled, show_real_names
   * and allow_beacons. While the acknowledgment is stale (the policy changed since), a stored
   * "switched on" is ignored and the file's `enabled` applies; a stored "switched off" still holds.
   */
  get(id: string): SourceConfig {
    const { file } = this.entry(id);
    const o = this.opts.state.getOverride(id);
    const ignoreOn = acknowledgment(file.automation.policy, o) === 'stale' && o.enabled === true;
    // A deep copy, so a caller that edits the result cannot change the loaded source.
    return {
      ...structuredClone(file),
      enabled: ignoreOn ? file.enabled : (o.enabled ?? file.enabled),
      show_real_names: o.showRealNames ?? file.show_real_names,
      allow_beacons: o.allowBeacons ?? file.allow_beacons,
    };
  }

  view(id: string): SourceView {
    const entry = this.entry(id);
    const s = this.get(id);
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      topics: [...s.topics],
      engine: s.engine,
      status: s.status,
      policy: s.automation.policy,
      ruleUrl: s.automation.rule_url,
      ruleQuote: s.automation.rule_quote,
      domains: [...s.domains],
      loginUrl: s.login_url,
      enabled: s.enabled,
      needsAcknowledgment: this.needsAcknowledgment(s),
      session: s.enabled ? this.opts.state.getSession(id).state : 'disabled',
      showRealNames: s.show_real_names,
      allowBeacons: s.allow_beacons,
      searchSupported: canSearch(s),
      seed: entry.seed,
    };
  }

  /** Every source, by id. */
  views(): SourceView[] {
    return this.ids().map((id) => this.view(id));
  }

  /**
   * Sources whose id, name, description, topics and domains, joined, contain every token of `query`.
   * Sources with a token among their topics (a whole topic or one word of it) come first, then by
   * name. An empty query returns every source, by first topic then name. `topic` keeps only the
   * sources that list it.
   */
  search(query: string, topic?: string): SourceView[] {
    const tokens = tokensOf(query);
    const wanted = topic?.trim().toLowerCase() ?? '';
    const pool = this.views().filter((v) => wanted === '' || v.topics.includes(wanted));
    const byName = (a: SourceView, b: SourceView) => NAME_ORDER.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (tokens.length === 0) return pool.sort((a, b) => NAME_ORDER.compare(a.topics[0] ?? '', b.topics[0] ?? '') || byName(a, b));
    const topicHit = (v: SourceView) => v.topics.some((t) => tokens.includes(t) || tokensOf(t).some((w) => tokens.includes(w)));
    return pool
      .filter((v) => {
        const hay = [v.id, v.name, v.description ?? '', ...v.topics, ...v.domains].join(' ').toLowerCase();
        return tokens.every((t) => hay.includes(t));
      })
      .sort((a, b) => Number(topicHit(b)) - Number(topicHit(a)) || byName(a, b));
  }

  /** The effective config of the source that lists `hostname` in its domains, or null. */
  sourceForHost(hostname: string): SourceConfig | null {
    const host = hostname.toLowerCase();
    for (const [id, e] of this.entries) if (e.file.domains.includes(host)) return this.get(id);
    return null;
  }

  /** The effective config when the source may be used now; throws `disabled` or `needs_acknowledgment`. */
  assertUsable(id: string): SourceConfig {
    const s = this.get(id);
    const details = { sourceId: id };
    // A stale acknowledgment comes first: the user has to read the new rules, whatever the switch says.
    if (this.acknowledgmentOf(s) === 'stale')
      throw new LurkdError('needs_acknowledgment', `${staleReason(s)} Open the lurkd page and read the warning for this source.`, details);
    if (!s.enabled) {
      if (s.automation.policy === 'forbidden')
        throw new LurkdError(
          'disabled',
          `${s.name} is switched off because its rules forbid automated access: "${s.automation.rule_quote ?? ''}" (${s.automation.rule_url}). Switch it on from the lurkd page if you accept that.`,
          details,
        );
      throw new LurkdError('disabled', `${s.name} is switched off. Switch it on from the lurkd page.`, details);
    }
    if (this.needsAcknowledgment(s))
      throw new LurkdError(
        'needs_acknowledgment',
        `${s.name} has not been acknowledged yet. Open the lurkd page and read the warning for this source.`,
        details,
      );
    return s;
  }

  /**
   * Switches a source on. `acknowledge` records that the user read the warning, together with the
   * policy the source has now; for policy unknown or forbidden the acknowledgment counts only while
   * the policy stays the same. Without a current acknowledgment such a source is refused with
   * `needs_acknowledgment`.
   */
  enable(id: string, acknowledge: boolean): void {
    const s = this.get(id);
    if (acknowledge) {
      this.opts.state.setOverride(id, { enabled: true, acknowledgedAt: new Date().toISOString(), acknowledgedPolicy: s.automation.policy });
      return;
    }
    const ack = this.acknowledgmentOf(s);
    if (ack === 'missing' || ack === 'stale') {
      const why =
        ack === 'stale'
          ? staleReason(s)
          : s.automation.policy === 'forbidden'
            ? `${s.name}'s rules forbid automated access: "${s.automation.rule_quote ?? ''}" (${s.automation.rule_url}).`
            : `${s.name} has not been acknowledged yet.`;
      throw new LurkdError('needs_acknowledgment', `${why} Read the warning for this source and acknowledge it to switch it on.`, {
        sourceId: id,
      });
    }
    this.opts.state.setOverride(id, { enabled: true });
  }

  disable(id: string): void {
    this.entry(id);
    this.opts.state.setOverride(id, { enabled: false });
  }

  setShowRealNames(id: string, show: boolean): void {
    this.entry(id);
    this.opts.state.setOverride(id, { showRealNames: show });
  }

  setAllowBeacons(id: string, allow: boolean): void {
    this.entry(id);
    this.opts.state.setOverride(id, { allowBeacons: allow });
  }

  /**
   * Validates `yamlText` and writes it to `<userDir>/<id>.yaml` at 0600, replacing an earlier user
   * source with the same id. Refuses with `invalid_request` an invalid source, a seed id, or a
   * domain another source claims; nothing is written then. Returns the effective config.
   */
  writeUserSource(yamlText: string): SourceConfig {
    const declared = declaredId(yamlText);
    // The file name follows the id; an id that cannot be a file name gets a placeholder name,
    // and the schema's id error is enough, so the name-mismatch error is dropped.
    const usable = declared !== null && /^[a-z0-9-]+$/.test(declared);
    const label = usable ? `${declared}.yaml` : 'source.yaml';
    const parsed = parseSource(yamlText, { file: label });
    if (!parsed.ok) {
      const errors = usable ? parsed.errors : parsed.errors.filter((e) => !e.includes('must equal the file name "source"'));
      throw new LurkdError('invalid_request', `The source is not valid:\n${errors.join('\n')}`, { errors });
    }
    const source = parsed.source;
    const existing = this.entries.get(source.id);
    if (existing?.seed)
      throw new LurkdError('invalid_request', `"${source.id}" is the id of a seed source (${existing.rel}); give the new source another id.`, {
        sourceId: source.id,
      });
    for (const [id, e] of this.entries) {
      if (id === source.id) continue;
      const clash = source.domains.find((d) => e.file.domains.includes(d));
      if (clash !== undefined)
        throw new LurkdError('invalid_request', `The domain ${clash} is already claimed by ${id} (${e.rel}).`, { sourceId: source.id, domain: clash });
    }

    const dir = this.opts.userDir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A folder that already existed keeps its mode through mkdirSync; every state folder is 0700.
    fs.chmodSync(dir, 0o700);
    const target = path.join(dir, `${source.id}.yaml`);
    // Written beside the target under a name the loader ignores, then renamed into place.
    const tmp = path.join(dir, `.${source.id}.yaml.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, yamlText, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, target);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    this.reload();
    return this.get(source.id);
  }

  private entry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new LurkdError('unknown_source', `No source has the id "${id}".`, { sourceId: id });
    return e;
  }

  private acknowledgmentOf(s: SourceConfig): Acknowledgment {
    return acknowledgment(s.automation.policy, this.opts.state.getOverride(s.id));
  }

  private needsAcknowledgment(s: SourceConfig): boolean {
    const ack = this.acknowledgmentOf(s);
    return ack === 'missing' || ack === 'stale';
  }
}

// `stale`: acknowledged under another policy (or under none recorded), so the warning is due again.
type Acknowledgment = 'not_needed' | 'missing' | 'current' | 'stale';

function acknowledgment(policy: SourceConfig['automation']['policy'], o: SourceOverride): Acknowledgment {
  if (policy === 'allowed') return 'not_needed';
  if (o.acknowledgedAt === null) return 'missing';
  return o.acknowledgedPolicy === policy ? 'current' : 'stale';
}

function staleReason(s: SourceConfig): string {
  const { policy, rule_quote, rule_url } = s.automation;
  return policy === 'forbidden'
    ? `${s.name} changed its rules after you acknowledged them, and they now forbid automated access: "${rule_quote ?? ''}" (${rule_url}).`
    : `${s.name} changed its rules after you acknowledged them, and lurkd no longer knows whether they allow automated access (${rule_url}).`;
}

/** The `id` the YAML declares, or null when the text does not parse or has no string id. */
function declaredId(yamlText: string): string | null {
  try {
    const doc = parseDocument(yamlText);
    if (doc.errors.length > 0) return null;
    const value: unknown = doc.toJS();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const id = (value as Record<string, unknown>).id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}
