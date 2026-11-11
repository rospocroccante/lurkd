import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSetting, openArchive } from '../../src/archive/db.js';
import { UpdateStore } from '../../src/update/check.js';
import { openArchive as openArchive020 } from '../fixtures/archive/db-0.2.0.js';

// D53 fix round: the update check keeps its data in the settings table, so the archive stays at
// schema version 6 and lurkd 0.2.0 still opens an archive that 0.2.1 has used.

describe('archive compatibility with lurkd 0.2.0', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-compat-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('leaves user_version at 6 after the update check has stored its data', () => {
    const file = path.join(tmp, 'archive.db');
    const db = openArchive(file);
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    const store = new UpdateStore(db, { version: '0.2.1', env: {} });
    store.recordSuccess('0.3.0', '2026-11-11T09:00:00.000Z');
    store.recordAttempt('2026-11-11T10:00:00.000Z');
    store.setUserEnabled(false);
    store.setDismissed('0.3.0');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'update_check'").pluck().get()).toBeUndefined();
    db.close();

    // What lurkd 0.2.0 does on start: its own migrate, unchanged.
    const old = openArchive020(file);
    expect(old.pragma('user_version', { simple: true })).toBe(6);
    expect(getSetting(old, 'update_check')).toBe('off');
    old.close();

    // And back to 0.2.1: everything it stored is still there.
    const again = openArchive(file);
    const s = new UpdateStore(again, { version: '0.2.1', env: {} });
    expect(s.stored()).toEqual({ latest: '0.3.0', checkedAt: '2026-11-11T09:00:00.000Z', attemptedAt: '2026-11-11T10:00:00.000Z' });
    expect(s.userEnabled()).toBe(false);
    expect(s.dismissed()).toBe('0.3.0');
    again.close();
  });

  it('opens an archive that lurkd 0.2.0 created', () => {
    const file = path.join(tmp, 'archive.db');
    openArchive020(file).close();
    const db = openArchive(file);
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    expect(new UpdateStore(db, { version: '0.2.1', env: {} }).stored()).toEqual({ latest: null, checkedAt: null, attemptedAt: null });
    db.close();
  });
});
