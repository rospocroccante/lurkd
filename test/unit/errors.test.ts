import { describe, expect, it } from 'vitest';
import { EXIT_CODE, HTTP_STATUS, LurkdError, toErrorBody } from '../../src/errors.js';

describe('error codes', () => {
  it('maps user-action codes to exit 3, caps to exit 4, usage to exit 2', () => {
    for (const c of ['needs_login', 'challenge', 'needs_acknowledgment', 'disabled', 'handoff_in_progress'] as const)
      expect(EXIT_CODE[c]).toBe(3);
    expect([EXIT_CODE.run_cap, EXIT_CODE.daily_cap, EXIT_CODE.invalid_request]).toEqual([4, 4, 2]);
  });

  it('maps every other code to exit 1', () => {
    const special = new Set(['needs_login', 'challenge', 'needs_acknowledgment', 'disabled', 'handoff_in_progress', 'run_cap', 'daily_cap', 'invalid_request']);
    const rest = Object.entries(EXIT_CODE).filter(([c]) => !special.has(c));
    expect(rest).toHaveLength(12);
    for (const [, exit] of rest) expect(exit).toBe(1);
  });

  it('maps every code to its HTTP status', () => {
    expect(HTTP_STATUS).toEqual({
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
      handoff_in_progress: 423,
      run_cap: 429,
      daily_cap: 429,
      internal: 500,
      extraction_failed: 502,
      browser_unavailable: 503,
      server_unavailable: 503,
      timeout: 504,
    });
  });
});

describe('LurkdError', () => {
  it('carries its code, message and details', () => {
    const e = new LurkdError('not_found', 'No such thread', { url: 'u' });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('LurkdError');
    expect([e.code, e.message, e.details]).toEqual(['not_found', 'No such thread', { url: 'u' }]);
  });

  it('serialises a LurkdError with its details', () => {
    expect(toErrorBody(new LurkdError('needs_login', 'Log in first', { url: 'u' }))).toEqual({
      error: { code: 'needs_login', message: 'Log in first', details: { url: 'u' } },
    });
  });

  it('omits details when a LurkdError has none', () => {
    expect(Object.keys(toErrorBody(new LurkdError('timeout', 'Too slow')).error)).toEqual(['code', 'message']);
  });

  it('serialises unknown errors as internal without the stack', () => {
    expect(toErrorBody(new Error('boom')).error).toEqual({ code: 'internal', message: 'boom' });
  });

  it('serialises thrown non-errors as internal', () => {
    expect(toErrorBody('kaput').error).toEqual({ code: 'internal', message: 'kaput' });
  });
});
