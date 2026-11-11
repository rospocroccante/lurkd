// Rewriting a long text through its UTF-16 code units, in one loop. A split and a join, a replace,
// or an array of slices joined costs tens of nanoseconds for each of millions of matches; a loop
// over a Uint16Array costs a few. Short texts keep the plain string functions.

/** Texts at least this long are rewritten through their code units. */
export const UNIT_LOOP_MIN = 65_536;

/** The code units of s, in a buffer of its own that the caller may overwrite. */
export function codeUnits(s: string): Uint16Array {
  const b = Buffer.from(s, 'utf16le');
  const aligned = b.byteOffset % 2 === 0 ? b : Buffer.from(b);
  return new Uint16Array(aligned.buffer, aligned.byteOffset, aligned.length / 2);
}

/** The text of the first `length` code units of u. Lone surrogates come back as they went in. */
export function fromCodeUnits(u: Uint16Array, length: number): string {
  return Buffer.from(u.buffer, u.byteOffset, length * 2).toString('utf16le');
}
