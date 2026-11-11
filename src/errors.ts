export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'bad_host'
  | 'unknown_source'
  | 'not_found'
  | 'disabled'
  | 'needs_acknowledgment'
  | 'needs_login'
  | 'challenge'
  | 'off_domain'
  | 'denied_path'
  | 'search_unsupported'
  // D50: lurkd does not do this at all (Reddit is never read live); the message says what to do instead.
  | 'unsupported'
  | 'run_cap'
  | 'daily_cap'
  | 'timeout'
  | 'handoff_in_progress'
  | 'browser_unavailable'
  | 'extraction_failed'
  | 'server_unavailable'
  | 'internal';

export class LurkdError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'LurkdError';
    this.code = code;
    this.details = details;
  }
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  bad_host: 403,
  off_domain: 403,
  denied_path: 403,
  unknown_source: 404,
  not_found: 404,
  disabled: 409,
  needs_acknowledgment: 409,
  needs_login: 409,
  challenge: 409,
  search_unsupported: 422,
  unsupported: 422,
  handoff_in_progress: 423,
  run_cap: 429,
  daily_cap: 429,
  internal: 500,
  extraction_failed: 502,
  browser_unavailable: 503,
  server_unavailable: 503,
  timeout: 504,
};

// 3: the user has to act (log in, solve a challenge, acknowledge, enable, finish a handoff).
// 4: a request cap was hit. 2: usage error. 1: anything else.
export const EXIT_CODE: Record<ErrorCode, number> = {
  invalid_request: 2,
  unauthorized: 1,
  bad_host: 1,
  unknown_source: 1,
  not_found: 1,
  disabled: 3,
  needs_acknowledgment: 3,
  needs_login: 3,
  challenge: 3,
  off_domain: 1,
  denied_path: 1,
  search_unsupported: 1,
  unsupported: 1,
  run_cap: 4,
  daily_cap: 4,
  timeout: 1,
  handoff_in_progress: 3,
  browser_unavailable: 1,
  extraction_failed: 1,
  server_unavailable: 1,
  internal: 1,
};

export function toErrorBody(e: unknown): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
  if (e instanceof LurkdError) {
    const { code, message, details } = e;
    return { error: details === undefined ? { code, message } : { code, message, details } };
  }
  return { error: { code: 'internal', message: e instanceof Error ? e.message : String(e) } };
}
