import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openArchive } from '../../src/archive/db.js';
import { StateStore } from '../../src/archive/state.js';
import { PACKAGE_ROOT } from '../../src/paths.js';
import { Registry } from '../../src/sources/registry.js';
import { parseSource, type SourceConfig } from '../../src/sources/schema.js';

const SEED = path.join(PACKAGE_ROOT, 'sources');
const files = fs.globSync('**/*.yaml', { cwd: SEED }).sort();
const read = (rel: string): string => fs.readFileSync(path.join(SEED, rel), 'utf8');

function load(): { rel: string; source: SourceConfig }[] {
  return files.map((rel) => {
    const r = parseSource(read(rel), { file: path.basename(rel) });
    if (!r.ok) throw new Error(r.errors.join('\n'));
    return { rel, source: r.source };
  });
}

const TOPIC_FOLDERS = ['hardware-gpu', 'cybersecurity', 'vegetarian-nutrition', 'home-automation', 'tools'];

describe('seed directory', () => {
  it('has seed files at all', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('parses every seed file, named after its id', () => {
    for (const f of files) {
      const r = parseSource(read(f), { file: path.basename(f) });
      expect(r.ok, f + (r.ok ? '' : `: ${r.errors.join('; ')}`)).toBe(true);
    }
  });

  it('ships every forbidden source switched off', () => {
    for (const { rel, source } of load()) {
      if (source.automation.policy === 'forbidden') expect(source.enabled, rel).toBe(false);
    }
  });

  it('has exactly 10 public_read sources and 30 to 50 in total', () => {
    const all = load();
    expect(all.filter((s) => s.source.status === 'public_read')).toHaveLength(10);
    expect(all.filter((s) => s.source.status === 'untested').length).toBeGreaterThanOrEqual(20);
    expect(all.filter((s) => s.source.status === 'untested').length).toBeLessThanOrEqual(40);
    expect(all.length).toBeGreaterThanOrEqual(30);
    expect(all.length).toBeLessThanOrEqual(50);
  });

  it('never ships verified and never marks a forbidden source public_read', () => {
    for (const { rel, source } of load()) {
      expect(source.status, rel).not.toBe('verified');
      if (source.automation.policy === 'forbidden') expect(source.status, rel).not.toBe('public_read');
    }
  });

  it('cites a rule page for every source and a quote for allowed and forbidden', () => {
    for (const { rel, source } of load()) {
      const a = source.automation;
      expect(a.rule_url, rel).toMatch(/^https:\/\//);
      expect(a.checked_at, rel).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const day = new Date(`${a.checked_at}T00:00:00Z`);
      expect(Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== a.checked_at, `${rel}: not a real date`).toBe(false);
      expect(a.checked_at <= new Date().toISOString().slice(0, 10), `${rel}: checked_at is in the future`).toBe(true);
      if (a.policy === 'unknown') expect(a.rule_quote, rel).toBeNull();
      else expect((a.rule_quote ?? '').trim().length, rel).toBeGreaterThan(10);
    }
  });

  it('claims each domain once', () => {
    const seen = new Map<string, string>();
    for (const { rel, source } of load()) {
      for (const d of source.domains) {
        expect(seen.has(d), `${d} in ${rel} and ${seen.get(d)}`).toBe(false);
        seen.set(d, rel);
      }
    }
  });

  it('keeps cybercrime and dark-web forums out', () => {
    const bad = /carding|onion|darknet|leak|hack-?for-?hire|exploit-?market/i;
    for (const { rel, source } of load()) {
      for (const text of [source.id, source.name, ...source.domains]) expect(text, rel).not.toMatch(bad);
    }
  });

  it('files each source under its first topic, from the five seed folders', () => {
    for (const { rel, source } of load()) {
      const [folder, name, ...rest] = rel.split('/');
      expect(rest, rel).toHaveLength(0);
      expect(folder, rel).toBe(source.topics[0]);
      expect(TOPIC_FOLDERS, rel).toContain(folder);
      expect(name, rel).toBe(`${source.id}.yaml`);
    }
  });

  it('gives every public_read source an engine the smoke run reads and a policy that is not forbidden', () => {
    for (const { rel, source } of load().filter((s) => s.source.status === 'public_read')) {
      expect(['discourse', 'xenforo'], rel).toContain(source.engine);
      expect(source.automation.policy, rel).not.toBe('forbidden');
      expect(source.enabled, rel).toBe(true);
    }
  });

  it('covers every topic folder and the four spike forums', () => {
    const all = load();
    for (const t of ['hardware-gpu', 'cybersecurity', 'vegetarian-nutrition', 'home-automation', 'tools'])
      expect(all.some((s) => s.source.topics[0] === t), t).toBe(true);
    for (const id of ['level1techs', 'home-assistant', 'obsidian', 'servethehome']) expect(all.some((s) => s.source.id === id), id).toBe(true);
  });

  it('loads through the Registry with no error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkd-seed-'));
    try {
      const db = openArchive(path.join(dir, 'archive.db'));
      const registry = Registry.load({ seedDir: SEED, userDir: path.join(dir, 'user'), state: new StateStore(db) });
      expect(registry.errors()).toEqual([]);
      expect(registry.ids()).toHaveLength(files.length);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
