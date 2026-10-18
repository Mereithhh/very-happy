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
    })).toEqual({ emailEnabled: true, passwordEnabled: true, googleEnabled: true, oidcEnabled: false, oidcDisplayName: '', oidcSignupMode: 'open', oidcSelfServe: false, expandPasswordAfterLoad: false });
    expect(publicAuthMethodState({
      emailOtpEnabled: true,
      passwordLoginEnabled: false,
      signup: { mode: 'open', maxAccounts: null, registeredAccounts: 0, remainingAccounts: null, atCapacity: false },
    })).toEqual({ emailEnabled: true, passwordEnabled: false, googleEnabled: false, oidcEnabled: false, oidcDisplayName: '', oidcSignupMode: 'open', oidcSelfServe: false, expandPasswordAfterLoad: false });
    expect(publicAuthMethodState(null)).toEqual({ emailEnabled: false, passwordEnabled: true, googleEnabled: false, oidcEnabled: false, oidcDisplayName: '', oidcSignupMode: 'closed', oidcSelfServe: false, expandPasswordAfterLoad: true });
  });

  it('B-620: SSO keeps the password form folded and carries the provider name', () => {
    expect(publicAuthMethodState({
      emailOtpEnabled: false,
      passwordLoginEnabled: true,
      oidc: { displayName: 'Apodex SSO' },
      signup: { mode: 'invite', maxAccounts: null, registeredAccounts: 3, remainingAccounts: null, atCapacity: false },
    })).toEqual({ emailEnabled: false, passwordEnabled: true, googleEnabled: false, oidcEnabled: true, oidcDisplayName: 'Apodex SSO', oidcSignupMode: 'invite', oidcSelfServe: false, expandPasswordAfterLoad: false });
  });

  it('B-623: SSO self-serve is on only when OIDC signup is open while the relay itself is not', () => {
    const base = { emailOtpEnabled: false, passwordLoginEnabled: true, signup: { mode: 'invite' as const, maxAccounts: null, registeredAccounts: 3, remainingAccounts: null, atCapacity: false } };
    expect(publicAuthMethodState({ ...base, oidc: { displayName: 'Apodex SSO', signupMode: 'open' } })).toMatchObject({ oidcSignupMode: 'open', oidcSelfServe: true });
    expect(publicAuthMethodState({ ...base, oidc: { displayName: 'Apodex SSO', signupMode: 'closed' } })).toMatchObject({ oidcSignupMode: 'closed', oidcSelfServe: false });
    // Older servers omit signupMode: SSO follows the relay policy.
    expect(publicAuthMethodState({ ...base, oidc: { displayName: 'Apodex SSO' } })).toMatchObject({ oidcSignupMode: 'invite', oidcSelfServe: false });
    expect(publicAuthMethodState({ ...base, signup: { ...base.signup, mode: 'open' }, oidc: { displayName: 'Apodex SSO', signupMode: 'open' } })).toMatchObject({ oidcSelfServe: false });
  });
});
