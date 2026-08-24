import { describe, expect, it } from 'vitest';
import { createDaemonControlToken, isAuthorizedDaemonControlRequest } from './controlAuth';

describe('daemon control authentication', () => {
  it('creates a fresh 256-bit base64url token', () => {
    const first = createDaemonControlToken();
    const second = createDaemonControlToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it('accepts only the exact bearer token', () => {
    const token = createDaemonControlToken();

    expect(isAuthorizedDaemonControlRequest(`Bearer ${token}`, token)).toBe(true);
    expect(isAuthorizedDaemonControlRequest(undefined, token)).toBe(false);
    expect(isAuthorizedDaemonControlRequest('', token)).toBe(false);
    expect(isAuthorizedDaemonControlRequest(token, token)).toBe(false);
    expect(isAuthorizedDaemonControlRequest(`Basic ${token}`, token)).toBe(false);
    expect(isAuthorizedDaemonControlRequest(`Bearer ${token}x`, token)).toBe(false);
    expect(isAuthorizedDaemonControlRequest(undefined, '')).toBe(false);
    expect(isAuthorizedDaemonControlRequest('Bearer short', 'short')).toBe(false);
  });
});
