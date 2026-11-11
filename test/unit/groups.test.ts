import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openArchive } from '../../src/archive/db.js';
import { LurkdError } from '../../src/errors.js';
import { checkGroupName, GroupStore, MAX_GROUP_NAME, MAX_GROUPS, planBulkEnable, type BulkCandidate } from '../../src/sources/groups.js';

// D51: custom groups in the archive, and the rule a bulk switch-on follows.

type Policy = BulkCandidate['policy'];
const cand = (id: string, o: Partial<BulkCandidate> = {}): BulkCandidate => ({
  id,
  engine: 'discourse',
  policy: 'allowed',
  enabled: false,
  needsAcknowledgment: false,
  ...o,
});

describe('planBulkEnable (D51)', () => {
  it('switches on at once only the allowed and the already acknowledged sources', () => {
    const plan = planBulkEnable([
      cand('allowed-off'),
      cand('unknown-acked', { policy: 'unknown' }),
      cand('unknown-new', { policy: 'unknown', needsAcknowledgment: true }),
      cand('forbidden-off', { policy: 'forbidden', needsAcknowledgment: true }),
      cand('allowed-on', { enabled: true }),
    ]);
    expect(plan).toEqual({
      enableNow: ['allowed-off', 'unknown-acked'],
      alreadyOn: ['allowed-on'],
      needsAcknowledgment: ['unknown-new'],
      forbidden: ['forbidden-off'],
      notSwitchable: [],
    });
  });

  it('never switches on a forbidden source in bulk, even one the user acknowledged before', () => {
    const plan = planBulkEnable([
      cand('fb-acked-off', { policy: 'forbidden', needsAcknowledgment: false }),
      cand('fb-new', { policy: 'forbidden', needsAcknowledgment: true }),
      cand('fb-stale-on', { policy: 'forbidden', enabled: true, needsAcknowledgment: true }),
    ]);
    expect(plan.enableNow).toEqual([]);
    expect(plan.needsAcknowledgment).toEqual([]);
    expect(plan.forbidden).toEqual(['fb-acked-off', 'fb-new', 'fb-stale-on']);
  });

  it('keeps an acknowledged forbidden source that is on as it is', () => {
    expect(planBulkEnable([cand('fb-on', { policy: 'forbidden', enabled: true })])).toMatchObject({ alreadyOn: ['fb-on'], forbidden: [] });
  });

  it('asks again for an unknown source that is on but whose acknowledgment is missing or stale', () => {
    expect(planBulkEnable([cand('uk-on', { policy: 'unknown', enabled: true, needsAcknowledgment: true })])).toMatchObject({
      alreadyOn: [],
      needsAcknowledgment: ['uk-on'],
    });
  });

  it('leaves out a source of imported threads (D50)', () => {
    const plan = planBulkEnable([cand('reddit-import', { engine: 'import', policy: 'forbidden' }), cand('a')]);
    expect(plan).toMatchObject({ enableNow: ['a'], forbidden: [], notSwitchable: ['reddit-import'] });
  });

  it('puts every source in exactly one list, and none that needs a decision among those switched on', () => {
    const policies: Policy[] = ['allowed', 'unknown', 'forbidden'];
    const all: BulkCandidate[] = [];
    let n = 0;
    for (const policy of policies)
      for (const enabled of [false, true])
        for (const needsAcknowledgment of [false, true])
          for (const engine of ['discourse', 'import'] as const) all.push(cand(`s${n++}`, { policy, enabled, needsAcknowledgment, engine }));
    const plan = planBulkEnable(all);
    const lists = [plan.enableNow, plan.alreadyOn, plan.needsAcknowledgment, plan.forbidden, plan.notSwitchable];
    expect(lists.flat().sort()).toEqual(all.map((c) => c.id).sort());
    expect(new Set(lists.flat()).size).toBe(all.length);
    const by = new Map(all.map((c) => [c.id, c]));
    for (const id of plan.enableNow) {
      const c = by.get(id)!;
      // Allowed, or acknowledged under the current rules: nothing else goes on at once.
      expect([c.engine, c.policy === 'forbidden', c.policy === 'allowed' || !c.needsAcknowledgment]).toEqual(['discourse', false, true]);
    }
    for (const id of plan.needsAcknowledgment) expect([by.get(id)!.policy, by.get(id)!.engine]).toEqual(['unknown', 'discourse']);
    for (const id of plan.forbidden) expect(by.get(id)!.policy).toBe('forbidden');
    for (const id of plan.notSwitchable) expect(by.get(id)!.engine).toBe('import');
  });
});

describe('checkGroupName', () => {
  it('trims and folds runs of spaces, and keeps the case', () => {
    expect(checkGroupName('  Home   lab ')).toBe('Home lab');
    expect(checkGroupName('Équipe GPU')).toBe('Équipe GPU');
  });

  it('refuses an empty, overlong or control-character name', () => {
    for (const bad of ['', '   ', 'x'.repeat(MAX_GROUP_NAME + 1), 'a\u0000b', 'a\nb', 'tab\there', 'a‮b', 'ab', 42, null, undefined]) {
      expect(() => checkGroupName(bad), JSON.stringify(bad)).toThrow(LurkdError);
    }
    expect(checkGroupName('x'.repeat(MAX_GROUP_NAME))).toHaveLength(MAX_GROUP_NAME);
  });

  // A8 L1: SQLite would store a lone surrogate as U+FFFD, so two different names could land as one.
  it('refuses a name that is not well-formed text (a lone surrogate)', () => {
    for (const bad of ['a\uD800', '\uDC00b', 'x\uD83D', 'mid\uDFFFdle']) {
      expect(() => checkGroupName(bad), JSON.stringify(bad)).toThrow(/not valid text/);
    }
    // A pair is a character like any other.
    expect(checkGroupName('Plants \uD83C\uDF31')).toBe('Plants \u{1F331}');
  });

  // A8 L2: format characters (Cf) are invisible, so two names that look the same could differ.
  it('refuses format characters, and a name of nothing but them is empty', () => {
    for (const bad of ['Smart\u200Bhome', '\uFEFFHome', 'soft\u00ADhyphen', 'a\u2060b', 'a\u061Cb', 'a\uFFF9b', 'a\u{E0041}b', '\u{1F3F4}\u{E0041}']) {
      expect(() => checkGroupName(bad), JSON.stringify(bad)).toThrow(/invisible characters/);
    }
    for (const empty of ['\u200B', '\u00AD\u200B ', ' \uFEFF ', '\u2060\u200C', '\u200D', '\u200C \u200D', '\uFE0F', ' \u200D\uFE0F ']) {
      expect(() => checkGroupName(empty), JSON.stringify(empty)).toThrow('Give the group a name.');
    }
  });

  // L3: characters that are not format characters but show nothing, or a blank: the Hangul
  // fillers, the braille blank, the Mongolian variation selectors, the combining grapheme joiner,
  // the Khmer inherent vowels, the Khitan filler, the null notehead, unassigned default-ignorables.
  it('refuses blank and default-ignorable look-alikes, and a name of nothing but them is empty (L3)', () => {
    const blanks = [
      '\u3164', '\u115F', '\u1160', '\uFFA0', '\u2800', '\u180B', '\u180C', '\u180D', '\u180E', '\u180F',
      '\u034F', '\u17B4', '\u17B5', '\u{16FE4}', '\u{1D159}', '\u2065', '\uFFF0', '\u{E0000}', '\u{E0080}', '\u{E01F0}',
    ];
    for (const b of blanks) {
      expect(() => checkGroupName(`Home${b}`), JSON.stringify(b)).toThrow(/invisible characters/);
      expect(() => checkGroupName(`Ho${b}me lab`), JSON.stringify(b)).toThrow(/invisible characters/);
      expect(() => checkGroupName(b), JSON.stringify(b)).toThrow('Give the group a name.');
      expect(() => checkGroupName(` ${b}${b} \u200B`), JSON.stringify(b)).toThrow('Give the group a name.');
    }
  });

  // L3: a flag tag sequence is a black flag, a two-letter country code, a subdivision of one to
  // four letters or digits and the cancel tag (England is gbeng, Texas would be ustx).
  it('keeps only real subdivision flag tag sequences (L3)', () => {
    const tags = (ascii: string) => [...ascii].map((ch) => String.fromCodePoint(0xe0000 + ch.charCodeAt(0))).join('');
    const flag = (code: string) => `\u{1F3F4}${tags(code)}\u{E007F}`;
    for (const ok of ['gbeng', 'gbsct', 'gbwls', 'ustx', 'fr75', 'itrm', 'ab1', 'ab1c2d']) {
      expect(checkGroupName(`Flag ${flag(ok)}`), ok).toBe(`Flag ${flag(ok)}`);
    }
    for (const bad of ['gb', 'g', 'gbengla', 'abcdefghij', 'g1eng', '12eng', 'GBENG', 'gb eng', 'gb-en', 'x'.repeat(30)]) {
      expect(() => checkGroupName(`Flag ${flag(bad)}`), bad).toThrow(/invisible characters/);
    }
    // Tags without the black flag, or without the cancel tag, carry hidden text.
    expect(() => checkGroupName(`Flag ${tags('gbeng')}\u{E007F}`)).toThrow(/invisible characters/);
    expect(() => checkGroupName(`Flag \u{1F3F4}${tags('gbeng')}`)).toThrow(/invisible characters/);
  });

  // A9 M2: the joiners U+200C and U+200D are part of how some scripts and emoji are written.
  it('keeps zero-width joiners and non-joiners, emoji sequences among them', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const rainbow = '\u{1F3F3}\uFE0F\u200D\u{1F308}';
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    const persian = '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645';
    for (const ok of [`Family ${family}`, `Pride ${rainbow}`, `Football ${england}`, persian, `Keycap 1\uFE0F\u20E3`, 'Flags \u{1F1EE}\u{1F1F9}']) {
      expect(checkGroupName(ok), JSON.stringify(ok)).toBe(ok);
    }
    // The bidirectional controls stay refused, joiners or not.
    expect(() => checkGroupName(`${persian}\u200F`)).toThrow(LurkdError);
    expect(() => checkGroupName(`a\u200D\u202Eb`)).toThrow(LurkdError);
  });
});

describe('GroupStore', () => {
  let tmp: string;
  let file: string;
  let db: Database.Database;
  let groups: GroupStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-groups-'));
    file = path.join(tmp, 'archive.db');
    db = openArchive(file);
    groups = new GroupStore(db, () => '2026-11-11T10:00:00.000Z');
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return e instanceof LurkdError ? e.code : 'not a LurkdError';
    }
    return undefined;
  };

  it('creates, lists by name, renames and deletes groups', () => {
    const b = groups.create('Smart home');
    const a = groups.create('GPU research');
    expect(groups.list().map((g) => g.name)).toEqual(['GPU research', 'Smart home']);
    expect(b).toEqual({ id: b.id, name: 'Smart home', sourceIds: [], createdAt: '2026-11-11T10:00:00.000Z' });
    expect(groups.rename(a.id, 'Graphics cards').name).toBe('Graphics cards');
    expect(groups.list().map((g) => g.name)).toEqual(['Graphics cards', 'Smart home']);
    expect(groups.remove(b.id)).toBe(true);
    expect(groups.remove(b.id)).toBe(false);
    expect(groups.list().map((g) => g.name)).toEqual(['Graphics cards']);
  });

  it('refuses a second group with the same name in any case, ASCII or not', () => {
    groups.create('Équipe');
    groups.create('Home');
    expect(codeOf(() => groups.create('équipe'))).toBe('invalid_request');
    expect(codeOf(() => groups.create(' HOME '))).toBe('invalid_request');
    const other = groups.create('Other');
    expect(codeOf(() => groups.rename(other.id, 'home'))).toBe('invalid_request');
    // A group may change the case of its own name.
    expect(groups.rename(other.id, 'OTHER').name).toBe('OTHER');
  });

  it('answers not_found for a group id it does not hold', () => {
    expect(codeOf(() => groups.rename(999, 'x'))).toBe('not_found');
    expect(codeOf(() => groups.addMembers(999, ['a']))).toBe('not_found');
    expect(codeOf(() => groups.removeMembers(999, ['a']))).toBe('not_found');
    expect(groups.get(999)).toBeNull();
  });

  it('keeps a source in several groups, adds and removes members once each', () => {
    const a = groups.create('A');
    const b = groups.create('B');
    groups.addMembers(a.id, ['lg', 'fb', 'lg']);
    groups.addMembers(a.id, ['lg']);
    groups.addMembers(b.id, ['lg']);
    expect(groups.get(a.id)!.sourceIds).toEqual(['fb', 'lg']);
    expect(groups.get(b.id)!.sourceIds).toEqual(['lg']);
    expect(groups.removeMembers(a.id, ['lg', 'zz']).sourceIds).toEqual(['fb']);
    expect(groups.get(b.id)!.sourceIds).toEqual(['lg']);
  });

  it('drops the members of a deleted group and forgets a removed source everywhere', () => {
    const a = groups.create('A');
    const b = groups.create('B');
    groups.addMembers(a.id, ['lg', 'fb']);
    groups.addMembers(b.id, ['lg']);
    groups.remove(a.id);
    expect(db.prepare('SELECT count(*) AS n FROM custom_group_members WHERE group_id = ?').get(a.id)).toEqual({ n: 0 });
    groups.forgetSource('lg');
    expect(groups.get(b.id)!.sourceIds).toEqual([]);
  });

  it('folds the joiners and variation selectors in the clash key, so look-alike names clash (A9 M2)', () => {
    groups.create('Home');
    expect(codeOf(() => groups.create('Ho\u200Dme'))).toBe('invalid_request');
    expect(codeOf(() => groups.create('Ho\u200Cme'))).toBe('invalid_request');
    expect(codeOf(() => groups.create('Home\uFE0F'))).toBe('invalid_request');
    const persian = groups.create('\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645');
    expect(codeOf(() => groups.create('\u0645\u06CC\u062E\u0648\u0627\u0647\u0645'))).toBe('invalid_request');
    expect(groups.byName('\u0645\u06CC\u062E\u0648\u0627\u0647\u0645')?.id).toBe(persian.id);
    const family = groups.create('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}');
    expect(groups.get(family.id)!.name).toBe('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}');
    expect(groups.byName('Ho\u200Dme')?.name).toBe('Home');
    expect(codeOf(() => groups.rename(family.id, 'H\u200Come'))).toBe('invalid_request');
  });

  // L3: full case folding, so a letter whose capital is two letters, or the Turkish dotted
  // capital I, clashes with its folded form; NFKC folds full-width and compatibility forms.
  it('clashes names that differ only by full case folding or compatibility forms (L3)', () => {
    const strasse = groups.create('Straße');
    expect(codeOf(() => groups.create('STRASSE'))).toBe('invalid_request');
    expect(codeOf(() => groups.create('strasse'))).toBe('invalid_request');
    expect(groups.byName('STRASSE')?.id).toBe(strasse.id);
    const istanbul = groups.create('İstanbul');
    expect(codeOf(() => groups.create('istanbul'))).toBe('invalid_request');
    expect(codeOf(() => groups.create('ISTANBUL'))).toBe('invalid_request');
    expect(groups.byName('istanbul')?.id).toBe(istanbul.id);
    const plain = groups.create('Home lab');
    expect(codeOf(() => groups.create('\uFF28\uFF4F\uFF4D\uFF45 lab'))).toBe('invalid_request');
    expect(groups.byName('\uFF28OME LAB')?.id).toBe(plain.id);
    groups.create('Fish');
    const pond = groups.create('Pond');
    expect(codeOf(() => groups.rename(pond.id, '\uFB01sh'))).toBe('invalid_request');
    // Greek final sigma folds with the other sigma.
    groups.create('ΟΔΟΣ');
    expect(codeOf(() => groups.create('οδοσ'))).toBe('invalid_request');
    expect(codeOf(() => groups.create('οδος'))).toBe('invalid_request');
    // Accents still count: these are two names.
    expect(groups.create('Equipe').name).toBe('Equipe');
    expect(groups.create('Équipe').name).toBe('Équipe');
  });

  it('finds a group by name whatever the case and the spaces', () => {
    const g = groups.create('Smart home');
    expect(groups.byName('smart HOME')?.id).toBe(g.id);
    expect(groups.byName('  Smart   home ')?.id).toBe(g.id);
    expect(groups.byName('Smart')).toBeNull();
    expect(groups.byName('')).toBeNull();
  });

  it('answers a clash the store missed with the clean error, never a raw constraint failure (A8 L1)', () => {
    groups.create('Home');
    // As if the clash check had let a duplicate through: the UNIQUE constraint still answers cleanly.
    const spy = vi.spyOn(GroupStore.prototype as unknown as { refuseClash: () => void }, 'refuseClash').mockImplementation(() => {});
    try {
      let err: unknown;
      try {
        groups.create('HOME');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LurkdError);
      expect((err as LurkdError).code).toBe('invalid_request');
      expect((err as LurkdError).message).toBe('A group named "Home" exists already.');
      const other = groups.create('Other');
      expect(() => groups.rename(other.id, 'home')).toThrow('A group named "Home" exists already.');
    } finally {
      spy.mockRestore();
    }
    // Two lone surrogates that SQLite would store alike: both refused before the database.
    expect(codeOf(() => groups.create('x\uD800'))).toBe('invalid_request');
    expect(codeOf(() => groups.create('x\uD801'))).toBe('invalid_request');
    expect(groups.list().map((g) => g.name)).toEqual(['Home', 'Other']);
  });

  it(`holds at most ${MAX_GROUPS} groups`, () => {
    for (let i = 0; i < MAX_GROUPS; i++) groups.create(`g${i}`);
    expect(codeOf(() => groups.create('one more'))).toBe('invalid_request');
  });

  it('keeps the groups in the archive file', () => {
    const g = groups.create('Kept');
    groups.addMembers(g.id, ['lg']);
    db.close();
    db = openArchive(file);
    expect(new GroupStore(db).list()).toEqual([{ id: g.id, name: 'Kept', sourceIds: ['lg'], createdAt: '2026-11-11T10:00:00.000Z' }]);
  });
});
