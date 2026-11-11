import type Database from 'better-sqlite3';
import { LurkdError } from '../errors.js';
import type { SourceView } from './registry.js';

// D51: groups of sources the user makes on the lurkd page, and the rule a bulk switch-on follows.
// Groups live in the archive (schema version 5), never in the source files. Only the page's routes
// change them; an agent may only ask for the sources of a group by its name.

export const MAX_GROUPS = 100;
export const MAX_GROUP_NAME = 60;

export interface CustomGroup {
  id: number;
  name: string;
  /** Member source ids, sorted. Ids of sources that are not loaded now stay listed here. */
  sourceIds: string[];
  createdAt: string;
}

// Control characters, bidirectional overrides and private-use characters (the name markers of
// src/pseudonym.ts among them) have no place in a label the page and the agent both print.
const FORBIDDEN_CHARS = /[\p{Cc}\p{Co}\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
// A8 L2, A9 M2: format characters (Cf) do not show, so two names that look alike could be
// different names: zero-width spaces, the word joiner, the BOM, the soft hyphen, the bidirectional
// marks above, tag characters, which can also carry hidden ASCII to an agent. Three kinds are part
// of how text is written, and stay: the zero-width non-joiner U+200C (Persian, Indic scripts), the
// zero-width joiner U+200D (emoji sequences and those scripts), and the tag characters of a
// subdivision flag (the flag of England, of Scotland, of Wales).
// L3: the same goes for every other default-ignorable code point (the Hangul fillers U+115F,
// U+1160, U+3164 and U+FFA0, the Mongolian variation selectors U+180B to U+180F, the combining
// grapheme joiner, the Khmer inherent vowels, the unassigned ones) and for three characters that
// draw a blank: the braille blank U+2800, the Khitan filler U+16FE4 and the null notehead U+1D159.
// The variation selectors U+FE00 to U+FE0F and U+E0100 to U+E01EF stay, for emoji presentation and
// keycaps; the clash key drops them.
const JOINERS = /[\u200C\u200D]/gu;
/**
 * A subdivision flag, kept whole (group 1): the black flag, the tags of a two-letter country code,
 * the tags of one to four letters or digits, the cancel tag. At most six tags before the cancel
 * tag, as in Unicode's subdivision ids (gbeng, ustx). Or one invisible character a name may not
 * hold: any format or default-ignorable character or blank filler but the joiners and the
 * variation selectors.
 */
const HIDDEN =
  /(\u{1F3F4}[\u{E0061}-\u{E007A}]{2}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,4}\u{E007F})|(?![\u200C\u200D\uFE00-\uFE0F\u{E0100}-\u{E01EF}])[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800\u{16FE4}\u{1D159}]/gu;
/** Every invisible character, the kept ones too: what is left of a name without them must not be empty. */
const ANY_INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800\u{16FE4}\u{1D159}]/gu;
/** Variation selectors: they show nothing of their own, and after a letter they change nothing. */
const VARIATION_SELECTORS = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

/**
 * The text without the invisible characters a name may not show (every format and
 * default-ignorable character and the blank fillers, except the two joiners, the variation
 * selectors and the tags of a subdivision flag). For text that is printed back, such as an
 * unknown group name in an error: an emoji ZWJ sequence or a Persian word stays whole.
 */
export function withoutHiddenFormat(text: string): string {
  return text.replace(HIDDEN, (_m, seq: string | undefined) => seq ?? '');
}

function invalid(message: string): LurkdError {
  return new LurkdError('invalid_request', message, { field: 'name' });
}

/**
 * The group name to store: trimmed, runs of spaces folded to one, NFC. Refuses with
 * `invalid_request` a value that is not text or not well-formed text (a lone surrogate, which
 * SQLite would store as U+FFFD), an empty name (also one of nothing but format characters,
 * joiners and variation selectors), one longer than MAX_GROUP_NAME characters, or one with
 * control, bidirectional, private-use or hidden format characters (`withoutHiddenFormat`).
 */
export function checkGroupName(raw: unknown): string {
  if (typeof raw !== 'string') throw invalid('name must be text.');
  if (!raw.isWellFormed()) throw invalid('This group name is not valid text: it holds half of a character pair. Type the name again.');
  if (FORBIDDEN_CHARS.test(raw)) throw invalid('A group name cannot hold line breaks, tabs or other control characters.');
  if (raw.replace(ANY_INVISIBLE, '').replace(/\s+/gu, '') === '') throw invalid('Give the group a name.');
  if (withoutHiddenFormat(raw) !== raw)
    throw invalid('A group name cannot hold invisible characters, such as zero-width spaces, soft hyphens or blank filler characters.');
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (name === '') throw invalid('Give the group a name.');
  if ([...name].length > MAX_GROUP_NAME) throw invalid(`A group name has at most ${MAX_GROUP_NAME} characters.`);
  return name;
}

/**
 * The key two names clash on: case and spacing do not count, in any script, and neither do the
 * joiners and variation selectors a name may hold, so "Ho\u200Dme" clashes with "Home". L3: NFKC
 * first (full-width letters, ligatures), then full case folding through upper case and back, so
 * "Straße" clashes with "STRASSE"; the dot that the lower case of the Turkish capital I keeps goes
 * too, so "İstanbul" clashes with "istanbul".
 */
function nameKey(name: string): string {
  return name
    .normalize('NFKC')
    .replace(JOINERS, '')
    .replace(VARIATION_SELECTORS, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toUpperCase()
    .toLowerCase()
    .replace(/i\u0307/gu, 'i')
    .normalize('NFC');
}

interface GroupRow {
  id: number;
  name: string;
  created_at: string;
}

export class GroupStore {
  constructor(
    private readonly db: Database.Database,
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {}

  /** Every group, by name, with its members. */
  list(): CustomGroup[] {
    const rows = this.db.prepare('SELECT id, name, created_at FROM custom_groups').all() as GroupRow[];
    const members = this.db.prepare('SELECT group_id, source_id FROM custom_group_members ORDER BY source_id').all() as {
      group_id: number;
      source_id: string;
    }[];
    const by = new Map<number, string[]>();
    for (const m of members) {
      const list = by.get(m.group_id);
      if (list) list.push(m.source_id);
      else by.set(m.group_id, [m.source_id]);
    }
    return rows
      .map((r) => ({ id: r.id, name: r.name, sourceIds: by.get(r.id) ?? [], createdAt: r.created_at }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id);
  }

  get(id: number): CustomGroup | null {
    const r = this.db.prepare('SELECT id, name, created_at FROM custom_groups WHERE id = ?').get(id) as GroupRow | undefined;
    if (!r) return null;
    const ids = (this.db.prepare('SELECT source_id FROM custom_group_members WHERE group_id = ? ORDER BY source_id').all(id) as { source_id: string }[]).map(
      (m) => m.source_id,
    );
    return { id: r.id, name: r.name, sourceIds: ids, createdAt: r.created_at };
  }

  /** The group with this name, whatever its case and spacing; null for none or for a value that cannot be a name. */
  byName(name: string): CustomGroup | null {
    const key = nameKey(name);
    if (key === '') return null;
    const hit = (this.db.prepare('SELECT id, name FROM custom_groups').all() as { id: number; name: string }[]).find((r) => nameKey(r.name) === key);
    return hit ? this.get(hit.id) : null;
  }

  create(rawName: string): CustomGroup {
    const name = checkGroupName(rawName);
    const id = this.db
      .transaction(() => {
        const n = (this.db.prepare('SELECT count(*) AS n FROM custom_groups').get() as { n: number }).n;
        if (n >= MAX_GROUPS) throw invalid(`lurkd keeps at most ${MAX_GROUPS} groups. Delete one first.`);
        this.refuseClash(name, null);
        return Number(this.unique(name, () => this.db.prepare('INSERT INTO custom_groups (name, created_at) VALUES (?, ?)').run(name, this.nowIso())).lastInsertRowid);
      })
      .immediate();
    return this.get(id)!;
  }

  rename(id: number, rawName: string): CustomGroup {
    const name = checkGroupName(rawName);
    this.db
      .transaction(() => {
        this.must(id);
        this.refuseClash(name, id);
        this.unique(name, () => this.db.prepare('UPDATE custom_groups SET name = ? WHERE id = ?').run(name, id));
      })
      .immediate();
    return this.get(id)!;
  }

  /** Deletes the group and its memberships; false when there was no such group. */
  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM custom_groups WHERE id = ?').run(id).changes > 0;
  }

  /** Adds the ids to the group; ids already in it stay once. The caller checks the ids are sources. */
  addMembers(id: number, sourceIds: readonly string[]): CustomGroup {
    this.db
      .transaction(() => {
        this.must(id);
        const add = this.db.prepare('INSERT OR IGNORE INTO custom_group_members (group_id, source_id, added_at) VALUES (?, ?, ?)');
        const at = this.nowIso();
        for (const s of sourceIds) add.run(id, s, at);
      })
      .immediate();
    return this.get(id)!;
  }

  /** Takes the ids out of the group; an id that is not in it is skipped. */
  removeMembers(id: number, sourceIds: readonly string[]): CustomGroup {
    this.db
      .transaction(() => {
        this.must(id);
        const del = this.db.prepare('DELETE FROM custom_group_members WHERE group_id = ? AND source_id = ?');
        for (const s of sourceIds) del.run(id, s);
      })
      .immediate();
    return this.get(id)!;
  }

  /** Takes a removed source out of every group (D46: a source added later under the id starts afresh). */
  forgetSource(sourceId: string): void {
    this.db.prepare('DELETE FROM custom_group_members WHERE source_id = ?').run(sourceId);
  }

  private must(id: number): void {
    if (!this.db.prepare('SELECT 1 FROM custom_groups WHERE id = ?').get(id)) throw new LurkdError('not_found', 'No group has this id. Reload the lurkd page.');
  }

  private refuseClash(name: string, self: number | null): void {
    const key = nameKey(name);
    const rows = this.db.prepare('SELECT id, name FROM custom_groups').all() as { id: number; name: string }[];
    const clash = rows.find((r) => r.id !== self && nameKey(r.name) === key);
    if (clash) throw invalid(`A group named "${clash.name}" exists already.`);
  }

  /**
   * Runs a write of `name` and answers the table's UNIQUE constraint (NOCASE) with the same
   * error as refuseClash, should a name ever pass refuseClash and still clash in SQLite.
   */
  private unique<T>(name: string, write: () => T): T {
    try {
      return write();
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw e;
      const held = this.db.prepare('SELECT name FROM custom_groups WHERE name = ?').pluck().get(name) as string | undefined;
      throw invalid(`A group named "${held ?? name}" exists already.`);
    }
  }
}

// ---- the bulk switch-on rule ----

export type BulkCandidate = Pick<SourceView, 'id' | 'engine' | 'policy' | 'enabled' | 'needsAcknowledgment'>;

/** Where each source of a bulk switch-on goes. Every source is in exactly one list, in input order. */
export interface BulkPlan {
  /** Off now, and allowed or already acknowledged: switched on at once. */
  enableNow: string[];
  /** On and usable already: nothing to do. */
  alreadyOn: string[];
  /** Rules silent (policy unknown) and no current acknowledgment: listed in one dialog. */
  needsAcknowledgment: string[];
  /** Rules forbid automated access: never switched on in bulk, named in the dialog (D6). */
  forbidden: string[];
  /** Imported threads only (D50): never part of a bulk switch. */
  notSwitchable: string[];
}

/**
 * D51. A bulk switch-on switches on at once only the sources whose rules allow automated access
 * or that the user acknowledged under their current rules. Sources with silent rules and no
 * current acknowledgment wait for one dialog. A forbidden source never goes on in bulk, not even
 * one acknowledged before: the user switches it on alone, with its own warning. A forbidden
 * source that is on and acknowledged stays as it is.
 */
export function planBulkEnable(sources: readonly BulkCandidate[]): BulkPlan {
  const plan: BulkPlan = { enableNow: [], alreadyOn: [], needsAcknowledgment: [], forbidden: [], notSwitchable: [] };
  for (const s of sources) {
    if (s.engine === 'import') plan.notSwitchable.push(s.id);
    else if (s.enabled && !s.needsAcknowledgment) plan.alreadyOn.push(s.id);
    else if (s.policy === 'forbidden') plan.forbidden.push(s.id);
    // Rules that allow automation need no acknowledgment (Registry.enable takes them as they are).
    else if (s.policy === 'unknown' && s.needsAcknowledgment) plan.needsAcknowledgment.push(s.id);
    else plan.enableNow.push(s.id);
  }
  return plan;
}
