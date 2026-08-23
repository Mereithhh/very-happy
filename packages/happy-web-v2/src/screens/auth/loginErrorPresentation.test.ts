import { describe, expect, it } from 'vitest';
import { classifyPasswordLoginFailure } from './loginErrorPresentation';

describe('password login error presentation', () => {
  it('preserves wrapped 401 and 429 meanings instead of reporting network failure', () => {
    expect(classifyPasswordLoginFailure({ code: 'invalid-credentials' })).toBe('invalid-credentials');
    expect(classifyPasswordLoginFailure({ code: 'rate-limited' })).toBe('rate-limited');
    expect(classifyPasswordLoginFailure(new Error('offline'))).toBe('network');
  });
});
