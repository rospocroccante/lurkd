import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  findLeaks,
  markName,
  NAME_CLOSE,
  NAME_OPEN,
  namesIn,
  pseudonym,
  renderNames,
  stripMarkers,
} from '../../src/pseudonym.js';

const SALT_A = 'a'.repeat(64);
const SALT_B = 'b'.repeat(64);

describe('pseudonym', () => {
  it('is stable for the same source, name and salt', () => {
    const p = pseudonym('forum-example', 'alice', SALT_A);
    expect(p).toMatch(/^author-[0-9a-f]{10}$/);
    expect(pseudonym('forum-example', 'alice', SALT_A)).toBe(p);
  });
  it('ignores username case and surrounding spaces', () => {
    expect(pseudonym('forum-example', ' Alice ', SALT_A)).toBe(pseudonym('forum-example', 'alice', SALT_A));
  });
  it('depends on the salt', () => {
    expect(pseudonym('forum-example', 'alice', SALT_A)).not.toBe(pseudonym('forum-example', 'alice', SALT_B));
  });
  it('depends on the source, so the same name on two forums does not link', () => {
    expect(pseudonym('forum-example', 'alice', SALT_A)).not.toBe(pseudonym('other-example', 'alice', SALT_A));
  });
  it('leak check matches whole words only', () => {
    const hits = findLeaks('thanks Bob, bobby and BOB.', ['bob']);
    expect(hits.get('bob')).toBe(2);
  });
  it('formats a pseudonym', () => expect(pseudonym('level1techs', 'Alice', 'a'.repeat(64))).toMatch(/^author-[0-9a-f]{10}$/));
  it('follows the D20 formula: SHA-256 over salt, sourceId and the lowercased name', () => {
    const digest = crypto.createHash('sha256').update(`${SALT_A}\nlevel1techs\nalice`).digest('hex');
    expect(pseudonym('level1techs', '  ALICE ', SALT_A)).toBe(`author-${digest.slice(0, 10)}`);
  });
  it('marks names and renders them back', () => {
    const t = `> ${markName('Alice')} wrote:`;
    expect(renderNames(t, (u) => u.toUpperCase())).toBe('> ALICE wrote:');
    expect(namesIn(t)).toEqual(['Alice']);
  });
  it('uses U+E000 and U+E001 as markers', () => {
    expect(NAME_OPEN).toBe('\uE000');
    expect(NAME_CLOSE).toBe('\uE001');
    expect(markName('@bob')).toBe('\uE000bob\uE001');
  });
  it('lists each marked name once, in order of first appearance', () => {
    const t = `${markName('bob')} and ${markName('carol')} and ${markName('bob')}`;
    expect(namesIn(t)).toEqual(['bob', 'carol']);
  });
  it('strips markers smuggled into forum text', () => expect(stripMarkers('a\uE000b\uE001c')).toBe('abc'));
});
