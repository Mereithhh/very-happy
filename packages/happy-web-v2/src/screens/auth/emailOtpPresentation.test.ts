import { describe, expect, it } from 'vitest';
import { emailOtpTiming, publicAuthMethodState, shouldResetEmailChallenge } from './emailOtpPresentation';

describe('Email OTP presentation state', () => {
  it('counts down expiry and enforces a 30-second resend cooldown', () => {
    expect(emailOtpTiming(10_000, 5_000, 12_500)).toEqual({ remainingSeconds: 3, resendSeconds: 25 });
    expect(emailOtpTiming(40_000, 5_000, 12_500)).toEqual({ remainingSeconds: 0, resendSeconds: 0 });
  });

  it('clears a consumed challenge after signup-policy rejection', () => {
    expect(shouldResetEmailChallenge('capacity-reached')).toBe(true);
    expect(shouldResetEmailChallenge('signup-closed')).toBe(true);
    expect(shouldResetEmailChallenge('invite-required')).toBe(true);
    expect(shouldResetEmailChallenge('invalid-email-code')).toBe(false);
    expect(shouldResetEmailChallenge('network')).toBe(false);
  });

  it('makes Email default while preserving explicit compatibility fallbacks', () => {
    expect(publicAuthMethodState({
      emailOtpEnabled: true,
      passwordLoginEnabled: true,
      googleClientId: 'google',
      signup: { mode: 'open', maxAccounts: null, registeredAccounts: 0, remainingAccounts: null, atCapacity: false },
    })).toEqual({ emailEnabled: true, passwordEnabled: true, googleEnabled: true, oidcEnabled: false, oidcDisplayName: '', expandPasswordAfterLoad: false });
    expect(publicAuthMethodState({
      emailOtpEnabled: true,
      passwordLoginEnabled: false,
      signup: { mode: 'open', maxAccounts: null, registeredAccounts: 0, remainingAccounts: null, atCapacity: false },
    })).toEqual({ emailEnabled: true, passwordEnabled: false, googleEnabled: false, oidcEnabled: false, oidcDisplayName: '', expandPasswordAfterLoad: false });
    expect(publicAuthMethodState(null)).toEqual({ emailEnabled: false, passwordEnabled: true, googleEnabled: false, oidcEnabled: false, oidcDisplayName: '', expandPasswordAfterLoad: true });
  });

  it('B-620: SSO keeps the password form folded and carries the provider name', () => {
    expect(publicAuthMethodState({
      emailOtpEnabled: false,
      passwordLoginEnabled: true,
      oidc: { displayName: 'Apodex SSO' },
      signup: { mode: 'invite', maxAccounts: null, registeredAccounts: 3, remainingAccounts: null, atCapacity: false },
    })).toEqual({ emailEnabled: false, passwordEnabled: true, googleEnabled: false, oidcEnabled: true, oidcDisplayName: 'Apodex SSO', expandPasswordAfterLoad: false });
  });
});
