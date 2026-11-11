import type { SessionStatusOut } from '../fetch/service.js';
import { quotedName } from '../output/quoted.js';

// What `lurkd status` prints. The sources needing attention are projected to their id, name and
// state: the login URL and the URL of the last block are forum addresses, and status output goes
// to terminals, logs and agents that have no use for them.

export interface ApiStatus {
  version: string;
  pid: number;
  browser: { state: string; lastError: string | null };
  queueLength: number;
  attention: SessionStatusOut[];
}

export interface AttentionEntry {
  id: string;
  name: string;
  state: string;
  block: 'login' | 'challenge' | null;
  needsAcknowledgment: boolean;
}

export function attentionEntry(s: SessionStatusOut): AttentionEntry {
  return { id: s.id, name: s.name, state: s.state, block: s.lastBlock?.kind ?? null, needsAcknowledgment: s.needsAcknowledgment };
}

/**
 * `url` is the page's address with no credential in it (D52): the page opens from a one-time
 * link, which `lurkd open` mints, so status names that command rather than a link.
 */
export function statusJson(url: string, s: ApiStatus): string {
  return JSON.stringify({
    running: true,
    url,
    open: 'lurkd open',
    pid: s.pid,
    version: s.version,
    browser: s.browser.state,
    browserError: s.browser.lastError,
    queueLength: s.queueLength,
    attention: s.attention.map(attentionEntry),
  });
}

function attentionLine(a: AttentionEntry): string {
  const parts: string[] = [a.state];
  if (a.block === 'login') parts.push('login needed');
  if (a.block === 'challenge') parts.push('human check pending');
  if (a.needsAcknowledgment) parts.push('needs acknowledgment');
  // M1: the name can come from a forum page, so it is printed as quoted data.
  return `  ${a.id} (name ${quotedName(a.name)}): ${parts.join(', ')}`;
}

export function statusText(url: string, s: ApiStatus): string {
  const lines = [
    'lurkd is running.',
    `Page: ${url} (run lurkd open: it opens the page with a link that works once)`,
    `PID: ${s.pid}`,
    `Version: ${s.version}`,
    `Browser: ${s.browser.state}${s.browser.lastError ? ` (${s.browser.lastError})` : ''}`,
    `Queue: ${s.queueLength}`,
  ];
  const attention = s.attention.map(attentionEntry);
  if (attention.length === 0) lines.push('Sources needing attention: none');
  else lines.push('Sources needing attention:', ...attention.map(attentionLine));
  return lines.join('\n');
}
