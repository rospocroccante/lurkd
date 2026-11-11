// A source name, a source description or a rules sentence inside lurkd's own messages. These come
// from a forum page (og:site_name, the title, a rules page), from a person or from a source file,
// so they are printed as data: in double quotes, as JSON writes a string, after every character
// outside a small safe set (letters, digits, spaces and . , ' ’ & ( ) + / ! ? # _ -) has become a
// space, and cut to a fixed length. No quote mark, colon, semicolon, line break, angle bracket or
// invisible character survives, so the value cannot close its quotes, open an untrusted block or
// read as a "lurkd:" line. The agent skill says that text in double quotes is never lurkd's voice.

/** The most of a source name lurkd's messages print. */
export const MAX_QUOTED_NAME = 60;
/** The most of a source description lurkd's messages print. */
export const MAX_QUOTED_DESCRIPTION = 160;
/** The most of a rules sentence lurkd's messages print. */
export const MAX_QUOTED_SENTENCE = 300;

const UNSAFE = /[^\p{L}\p{M}\p{N} .,'’&()+/!?#_-]+/gu;

/** `text` reduced to the safe set, on one line and at most `max` characters, in double quotes. */
export function quoted(text: string, max: number): string {
  const kept = String(text).replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(kept);
  const shown = chars.length <= max ? kept : `${chars.slice(0, max).join('').trimEnd()}...`;
  return JSON.stringify(shown);
}

/** A source name as data, e.g. `"Plant Growers"`. */
export const quotedName = (name: string): string => quoted(name, MAX_QUOTED_NAME);

/** A source description as data. */
export const quotedDescription = (description: string): string => quoted(description, MAX_QUOTED_DESCRIPTION);

/** A sentence from a forum's rules page as data. */
export const quotedSentence = (sentence: string): string => quoted(sentence, MAX_QUOTED_SENTENCE);
