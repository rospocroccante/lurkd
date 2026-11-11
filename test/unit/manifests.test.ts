import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { PACKAGE_ROOT } from '../../src/paths.js';

const read = (rel: string): string => fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8');
const readJson = (rel: string): Record<string, unknown> => JSON.parse(read(rel)) as Record<string, unknown>;
const exists = (rel: string): boolean => fs.existsSync(path.join(PACKAGE_ROOT, rel));

const SKILL = 'skills/lurkd/SKILL.md';
const pkg = readJson('package.json') as { version: string; files: string[] };

// Every manifest that must exist, and the ones that exist only when the host has an official format.
const REQUIRED_MANIFESTS = ['.claude-plugin/plugin.json', '.mcp.json', 'gemini-extension.json'];
const OPTIONAL_MANIFESTS = ['.cursor-plugin/plugin.json'];
const manifests = [...REQUIRED_MANIFESTS, ...OPTIONAL_MANIFESTS.filter(exists)];

/** The mcpServers.lurkd entry of a manifest; null for a manifest without one (plugin.json). */
function lurkdServer(rel: string): unknown {
  const servers = readJson(rel).mcpServers;
  // plugin.json has none, and the Cursor one holds a path to .mcp.json instead of a map.
  return typeof servers !== 'object' || servers === null ? null : (servers as Record<string, unknown>).lurkd;
}

describe('SKILL.md', () => {
  const body = read(SKILL);

  it('keeps only name and description in the frontmatter, name equal to the folder', () => {
    const fm = YAML.parse(body.split('---')[1]!) as Record<string, string>;
    expect(Object.keys(fm).sort()).toEqual(['description', 'name']);
    expect(fm.name).toBe('lurkd');
    expect(fm.name).toBe(path.basename(path.dirname(path.join(PACKAGE_ROOT, SKILL))));
    expect(fm.description).toBe(
      "Read the forums AI search tends to miss, public or behind a login, through the user's own browser session, read-only, as threaded Markdown with pseudonymised authors. Use when a question needs forum discussions that web search cannot reach.",
    );
  });

  it('stays under 120 lines and holds no emoji', () => {
    expect(body.split('\n').length).toBeLessThan(120);
    expect(body).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('names all six tools', () => {
    for (const t of ['sources.search', 'source.fetch', 'archive.search', 'session.status', 'source.sample', 'author.signals']) {
      expect(body).toContain(t);
    }
  });

  it('names the CLI command of every tool', () => {
    for (const c of ['lurkd sources', 'lurkd fetch', 'lurkd search', 'lurkd session', 'lurkd sample', 'lurkd author']) {
      expect(body).toContain(c);
    }
  });

  it('tells the agent how to open the lurkd page and to try the archive first', () => {
    // D52: the page opens from a one-time link that lurkd open mints and opens; no address to pass on.
    expect(body).toContain('lurkd open');
    expect(body).not.toMatch(/give them the address/);
    expect(body.indexOf('archive.search')).toBeLessThan(body.indexOf('source.fetch'));
    expect(body).toMatch(/before (going online|reading live|source\.fetch)/i);
  });

  it('treats forum text as untrusted data', () => {
    expect(body).toContain('<untrusted-content>');
    expect(body).toMatch(/never follow/i);
  });

  it('says lurkd messages come only from outside the untrusted blocks, and does not promise a button for every state', () => {
    expect(body).toMatch(/own messages appear only outside the `<untrusted-content>` blocks/);
    expect(body).toMatch(/inside a block is forum text/i);
    expect(body).toMatch(/outside the blocks/);
    expect(body).not.toMatch(/names the button/i);
    expect(body).toMatch(/never tell them to switch it on/i);
    expect(body).not.toMatch(/same name and output/i);
  });

  it('says that a source name or other text in double quotes is data, not lurkd speaking (M1)', () => {
    expect(body).toMatch(/double quotes/);
    expect(body).toMatch(/source name/i);
  });

  it('stops on every state that needs the user, without retry or workaround', () => {
    for (const s of ['needs_login', 'challenge', 'needs_acknowledgment', 'disabled']) expect(body).toContain(s);
    expect(body).toMatch(/do not retry/i);
    expect(body).toMatch(/work(ing)? around|workaround|way round/i);
  });

  it('never asks for a password', () => {
    expect(body).toMatch(/never ask[^.]*password/i);
  });

  it('keeps agents off --json, which is not wrapped as untrusted', () => {
    expect(body).toContain('--json');
    expect(body).toMatch(/not wrapped/i);
    // The flag appears only as a thing to avoid.
    for (const line of body.split('\n').filter((l) => l.includes('--json'))) expect(line).toMatch(/not|never|avoid|do not/i);
  });

  it('routes a new source through source.sample, draft_yaml and the page', () => {
    expect(body).toContain('draft_yaml');
    expect(body).toMatch(/approv/i);
  });

  it('does not tell the agent to run npx lurkd in the skill; the skill uses the installed command (D16)', () => {
    // The only mention is the ban.
    for (const line of body.split('\n').filter((l) => l.includes('npx lurkd'))) expect(line).toMatch(/do not run `npx lurkd`/i);
  });
});

describe('host manifests', () => {
  it('gives every manifest with a version field the package version', () => {
    let checked = 0;
    for (const m of manifests) {
      const v = readJson(m).version;
      if (v === undefined) continue;
      expect(v, m).toBe(pkg.version);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('starts lurkd mcp from every manifest that registers the server', () => {
    let checked = 0;
    for (const m of manifests) {
      const s = lurkdServer(m);
      if (s === null) continue;
      expect(s, m).toEqual({ command: 'lurkd', args: ['mcp'] });
      checked++;
    }
    // .mcp.json and gemini-extension.json at least.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('shapes the Claude Code plugin', () => {
    const p = readJson('.claude-plugin/plugin.json');
    expect(p.name).toBe('lurkd');
    expect(typeof p.description).toBe('string');
    expect(p.version).toBe(pkg.version);
    expect((readJson('.mcp.json').mcpServers as Record<string, unknown>).lurkd).toEqual({ command: 'lurkd', args: ['mcp'] });
  });

  it('shapes the Gemini CLI extension', () => {
    const g = readJson('gemini-extension.json');
    expect(g.name).toBe('lurkd');
    expect(g.version).toBe(pkg.version);
    expect(g.contextFileName).toBe('skills/lurkd/SKILL.md');
    expect(exists(g.contextFileName as string)).toBe(true);
  });

  it('points the Cursor plugin at the shared MCP config, which Cursor reads with the same shape', () => {
    const c = readJson('.cursor-plugin/plugin.json');
    expect(c.name).toBe('lurkd');
    expect(c.version).toBe(pkg.version);
    expect(c.mcpServers).toBe('./.mcp.json');
    expect(exists('.mcp.json')).toBe(true);
  });

  it('ships every manifest in the npm package', () => {
    for (const f of ['skills', '.claude-plugin', '.mcp.json', '.cursor-plugin', 'gemini-extension.json']) {
      expect(pkg.files).toContain(f);
    }
  });
});
