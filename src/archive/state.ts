import type Database from 'better-sqlite3';

export type StoredSessionState = 'logged_in' | 'expired' | 'never';

export interface SessionRow {
  sourceId: string;
  state: StoredSessionState;
  lastLoginAt: string | null;
  lastCheckAt: string | null;
  lastBlockUrl: string | null;
  lastBlockKind: 'login' | 'challenge' | null;
}

export interface SourceOverride {
  enabled: boolean | null;
  acknowledgedAt: string | null;
  // The automation policy the source had when the user acknowledged it; an acknowledgment holds
  // only while the source keeps that policy.
  acknowledgedPolicy: 'allowed' | 'forbidden' | 'unknown' | null;
  showRealNames: boolean | null;
  allowBeacons: boolean | null;
}

export type FetchKind = 'navigate' | 'fetch' | 'form' | 'blocked' | 'beacon_allowed' | 'detection';

export interface FetchLogEntry {
  sourceId: string | null;
  jobId: string | null;
  url: string;
  method: string;
  kind: FetchKind;
  status: number | null;
  note?: string;
}

interface SessionDbRow {
  state: StoredSessionState;
  last_login_at: string | null;
  last_check_at: string | null;
  last_block_url: string | null;
  last_block_kind: 'login' | 'challenge' | null;
}

interface OverrideDbRow {
  enabled: number | null;
  acknowledged_at: string | null;
  acknowledged_policy: 'allowed' | 'forbidden' | 'unknown' | null;
  show_real_names: number | null;
  allow_beacons: number | null;
}

const toBool = (v: number | null): boolean | null => (v === null ? null : v !== 0);
const toInt = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);

/** Per-source session state, user overrides and the request log, all in the archive database. */
export class StateStore {
  constructor(private readonly db: Database.Database) {}

  /** The stored session; state `never` with null fields when the source has no row. */
  getSession(sourceId: string): SessionRow {
    const r = this.db.prepare('SELECT * FROM sessions WHERE source_id = ?').get(sourceId) as SessionDbRow | undefined;
    return {
      sourceId,
      state: r?.state ?? 'never',
      lastLoginAt: r?.last_login_at ?? null,
      lastCheckAt: r?.last_check_at ?? null,
      lastBlockUrl: r?.last_block_url ?? null,
      lastBlockKind: r?.last_block_kind ?? null,
    };
  }

  /** Merges `patch` into the stored session; a field set to null is cleared, an absent field is kept. */
  setSession(sourceId: string, patch: Partial<Omit<SessionRow, 'sourceId'>>): void {
    this.db
      .transaction(() => {
        const s = { ...this.getSession(sourceId), ...definedOnly(patch) };
        this.db
          .prepare(
            `INSERT OR REPLACE INTO sessions (source_id, state, last_login_at, last_check_at, last_block_url, last_block_kind)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(sourceId, s.state, s.lastLoginAt, s.lastCheckAt, s.lastBlockUrl, s.lastBlockKind);
      })
      .immediate();
  }

  /** The user's overrides for a source; null means "not set, use the source file". */
  getOverride(sourceId: string): SourceOverride {
    const r = this.db.prepare('SELECT * FROM source_state WHERE source_id = ?').get(sourceId) as OverrideDbRow | undefined;
    return {
      enabled: toBool(r?.enabled ?? null),
      acknowledgedAt: r?.acknowledged_at ?? null,
      acknowledgedPolicy: r?.acknowledged_policy ?? null,
      showRealNames: toBool(r?.show_real_names ?? null),
      allowBeacons: toBool(r?.allow_beacons ?? null),
    };
  }

  /** Merges `patch` into the stored overrides; a field set to null is cleared, an absent field is kept. */
  setOverride(sourceId: string, patch: Partial<SourceOverride>): void {
    this.db
      .transaction(() => {
        const o = { ...this.getOverride(sourceId), ...definedOnly(patch) };
        this.db
          .prepare(
            `INSERT OR REPLACE INTO source_state
               (source_id, enabled, acknowledged_at, acknowledged_policy, show_real_names, allow_beacons)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(sourceId, toInt(o.enabled), o.acknowledgedAt, o.acknowledgedPolicy, toInt(o.showRealNames), toInt(o.allowBeacons));
      })
      .immediate();
  }

  logFetch(e: FetchLogEntry, at: string = new Date().toISOString()): void {
    this.db
      .prepare('INSERT INTO fetch_log (source_id, job_id, url, method, kind, status, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.sourceId, e.jobId, e.url, e.method, e.kind, e.status, e.note ?? null, at);
  }

  /** Requests the tool made for the source since `sinceIso`: kinds navigate, fetch and form. */
  countRequests(sourceId: string, sinceIso: string): number {
    const r = this.db
      .prepare(
        `SELECT count(*) AS n FROM fetch_log
         WHERE source_id = ? AND at >= ? AND kind IN ('navigate', 'fetch', 'form')`,
      )
      .get(sourceId, sinceIso) as { n: number };
    return r.n;
  }

  /** D35 counters since `sinceIso`: all blocked requests, the blocked ones that were beacons, and challenge detections. */
  recentCounts(sourceId: string, sinceIso: string): { blocked: number; beaconsBlocked: number; challenges: number } {
    const r = this.db
      .prepare(
        `SELECT
           coalesce(sum(kind = 'blocked'), 0) AS blocked,
           coalesce(sum(kind = 'blocked' AND note LIKE 'beacon:%'), 0) AS beaconsBlocked,
           coalesce(sum(kind = 'detection' AND note = 'challenge'), 0) AS challenges
         FROM fetch_log WHERE source_id = ? AND at >= ?`,
      )
      .get(sourceId, sinceIso) as { blocked: number; beaconsBlocked: number; challenges: number };
    return { blocked: r.blocked, beaconsBlocked: r.beaconsBlocked, challenges: r.challenges };
  }
}

// Drops keys whose value is undefined so a spread keeps the stored value for them.
function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}
