import { describe, expect, it } from 'vitest';
import { classifyPasswordLoginFailure } from './loginErrorPresentation';
import { ReadyTimeoutError } from '@/encryption/readyDeadline';
import { SyncNotStartedError } from '@/sync/syncNotStarted';

describe('password login error presentation', () => {
  it('preserves wrapped 401 and 429 meanings instead of reporting network failure', () => {
    expect(classifyPasswordLoginFailure({ code: 'invalid-credentials' })).toBe('invalid-credentials');
    expect(classifyPasswordLoginFailure({ code: 'rate-limited' })).toBe('rate-limited');
    expect(classifyPasswordLoginFailure(new Error('offline'))).toBe('network');
  });

  it('reports a crypto module that never loaded instead of blaming the server (B-859c)', () => {
    const timeout = new ReadyTimeoutError('libsodium', 12_000);
    expect(classifyPasswordLoginFailure(new SyncNotStartedError(timeout))).toBe('crypto-not-ready');
    expect(classifyPasswordLoginFailure(timeout)).toBe('crypto-not-ready');
    expect(classifyPasswordLoginFailure(new SyncNotStartedError(new Error('bad key')))).toBe('network');
  });
});
