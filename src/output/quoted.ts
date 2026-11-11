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

// 0.2.1: an address inside lurkd's messages (a rules page, an address the forum chose, an address
// redacted to its origin and path) is data as well. `quotedUrl` keeps it readable: the characters
// an address uses stay, everything else (spaces, quote marks, angle brackets, line breaks,
// invisible characters) is percent-encoded, so the value cannot close its quotes or start a line.

/** The most of an address lurkd's messages print. */
export const MAX_QUOTED_URL = 300;

const URL_KEPT = /^[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]$/;

/** `url` in double quotes, with every character outside the address set percent-encoded, cut to `max`. */
export function quotedUrl(url: string, max: number = MAX_QUOTED_URL): string {
  let out = '';
  for (const ch of String(url).toWellFormed()) {
    out += URL_KEPT.test(ch) ? ch : [...Buffer.from(ch, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  }
  const chars = Array.from(out);
  return JSON.stringify(chars.length <= max ? out : `${chars.slice(0, max).join('')}...`);
}

/**
 * An http(s) address in a message, already in double quotes or bare. A bare address runs to the
 * next space or angle bracket: a quote mark inside it is part of it (L5), so `quotedUrl` encodes
 * it rather than letting it end the address next to the closing quote. A double quote right
 * before a bare address is taken in as well, so it does not stand next to the new opening quote.
 */
const ADDRESS_IN_TEXT = /"(https?:\/\/[^\s"<>]+)"|"?(https?:\/\/[^\s<>]+)/gi;

/**
 * `message` with every http(s) address in it passed through `quotedUrl`. Punctuation right after a
 * bare address (a single quote included) stays outside the quotes; an address already quoted is
 * quoted the same way again, so the result does not change when it runs twice.
 */
export function quoteAddresses(message: string): string {
  return message.replace(ADDRESS_IN_TEXT, (_m: string, inner: string | undefined, bare: string | undefined) => {
    if (inner !== undefined) return quotedUrl(inner);
    const m = bare ?? '';
    const tail = /[.,;:!?)\]']+$/.exec(m)?.[0] ?? '';
    return quotedUrl(tail === '' ? m : m.slice(0, -tail.length)) + tail;
  });
}
