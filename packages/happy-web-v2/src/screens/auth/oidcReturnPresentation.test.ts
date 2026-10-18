import { describe, expect, it } from 'vitest';
import { oidcCallbackErrorCopy, oidcCompleteErrorKey, parseOidcReturn } from './oidcReturnPresentation';

describe('B-620 OIDC return page state', () => {
  it('accepts an opaque handoff code and refuses anything else as a stale state', () => {
    expect(parseOidcReturn('?handoff=' + 'a'.repeat(43))).toEqual({ kind: 'handoff', handoff: 'a'.repeat(43) });
    expect(parseOidcReturn('?handoff=short')).toEqual({ kind: 'error', messageKey: 'oidc.errors.invalid_state', sendToSignup: false });
    expect(parseOidcReturn('?handoff=has%20space' + 'b'.repeat(20))).toMatchObject({ kind: 'error' });
    expect(parseOidcReturn('')).toEqual({ kind: 'error', messageKey: 'oidc.errors.invalid_state', sendToSignup: false });
  });

  it('maps server callback error codes to copy, sending invite-required users to signup', () => {
    expect(parseOidcReturn('?error=invite-required')).toEqual({ kind: 'error', messageKey: 'signup.errorInviteRequired', sendToSignup: true });
    expect(oidcCallbackErrorCopy('signup-closed').messageKey).toBe('signup.errorSignupClosed');
    expect(oidcCallbackErrorCopy('capacity-reached').messageKey).toBe('signup.errorCapacityReached');
    expect(oidcCallbackErrorCopy('email_domain_not_allowed').messageKey).toBe('oidc.errors.email_domain_not_allowed');
    expect(oidcCallbackErrorCopy('provider_error').messageKey).toBe('oidc.errors.provider_error');
    expect(oidcCallbackErrorCopy('exchange_failed').messageKey).toBe('oidc.errors.exchange_failed');
    expect(oidcCallbackErrorCopy('invalid_id_token').messageKey).toBe('oidc.errors.invalid_id_token');
    expect(oidcCallbackErrorCopy('something-new').messageKey).toBe('oidc.errors.invalid_state');
  });

  it('maps completion failures', () => {
    expect(oidcCompleteErrorKey('invalid-handoff')).toBe('oidc.errors.invalid_handoff');
    expect(oidcCompleteErrorKey('network')).toBe('oidc.errors.network');
    expect(oidcCompleteErrorKey('rate-limited')).toBe('oidc.errors.network');
    expect(oidcCompleteErrorKey('oidc-not-configured')).toBe('oidc.errors.not_configured');
    expect(oidcCompleteErrorKey('unknown')).toBe('oidc.errors.invalid_handoff');
  });
});
