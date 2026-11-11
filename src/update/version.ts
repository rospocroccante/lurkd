// D53: the versions the update check compares. Only a stable semver (three whole numbers, no
// pre-release or build part, no leading zeros) is ever offered as a new version.

const STABLE = /^(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})$/;
/** The version this lurkd runs may carry a pre-release part: 0.3.0-beta.1. */
const RUNNING = /^(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

type Triple = [number, number, number];

/** The three numbers of a stable version, or null for anything else. */
export function parseStableVersion(v: unknown): Triple | null {
  if (typeof v !== 'string') return null;
  const m = STABLE.exec(v);
  if (!m) return null;
  const t = [Number(m[1]), Number(m[2]), Number(m[3])] as Triple;
  return t.every(Number.isSafeInteger) ? t : null;
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

/**
 * True when `latest` is a stable version higher than `current`. A running pre-release is behind
 * the release of the same numbers. Anything that does not parse is never newer.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const l = parseStableVersion(latest);
  const m = RUNNING.exec(current);
  if (l === null || m === null) return false;
  const c = [Number(m[1]), Number(m[2]), Number(m[3])] as Triple;
  const order = compare(l, c);
  return order > 0 || (order === 0 && m[4] !== undefined);
}

/**
 * The order of two running versions: -1 when `a` is older, 1 when it is newer, 0 when they are
 * the same release, null when either does not parse or both are pre-releases of the same numbers.
 */
export function compareRunningVersions(a: string, b: string): -1 | 0 | 1 | null {
  const ma = RUNNING.exec(a);
  const mb = RUNNING.exec(b);
  if (ma === null || mb === null) return null;
  const order = compare([Number(ma[1]), Number(ma[2]), Number(ma[3])], [Number(mb[1]), Number(mb[2]), Number(mb[3])]);
  if (order !== 0) return order as -1 | 1;
  const pa = ma[4] !== undefined;
  const pb = mb[4] !== undefined;
  if (pa === pb) return pa ? (a === b ? 0 : null) : 0;
  return pa ? -1 : 1;
}
