import { describe, expect, it } from 'vitest';
import { accountIdentityAction, accountIdentityState } from './accountIdentityPresentation';

describe('account identity presentation', () => {
  it('keeps a linked identity visible while config loads, fails, or disables the provider', () => {
    const base = { methodsLoaded: true, methodsError: false, connected: true };
    expect(accountIdentityState({ ...base, configEnabled: null, configError: false })).toBe('linked-config-loading');
    expect(accountIdentityState({ ...base, configEnabled: null, configError: true })).toBe('linked-config-error');
    expect(accountIdentityState({ ...base, configEnabled: false, configError: false })).toBe('linked-disabled');
    expect(accountIdentityState({ ...base, configEnabled: true, configError: false })).toBe('linked-enabled');
  });

  it('offers only safe retry or explicit link actions', () => {
    expect(accountIdentityAction('methods-error')).toBe('retry-methods');
    expect(accountIdentityAction('linked-config-error')).toBe('retry-config');
    expect(accountIdentityAction('unlinked-config-error')).toBe('retry-config');
    expect(accountIdentityAction('unlinked-enabled')).toBe('link');
    expect(accountIdentityAction('linked-enabled')).toBeNull();
    expect(accountIdentityAction('unlinked-disabled')).toBeNull();
  });
});
