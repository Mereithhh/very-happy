import type { CloudAuthErrorCode } from '@/auth/cloudAuth';

/**
 * B-620: pure state for the `/login/oidc` landing page. The server sends the
 * browser here with exactly one of `?handoff=<code>` or `?error=<code>`.
 */
export type OidcReturnErrorKey =
  | 'oidc.errors.invalid_state'
  | 'oidc.errors.exchange_failed'
  | 'oidc.errors.invalid_id_token'
  | 'oidc.errors.email_domain_not_allowed'
  | 'oidc.errors.account_link_ambiguous'
  | 'oidc.errors.invalid_migration_handoff'
  | 'oidc.errors.migration_conflict'
  | 'oidc.errors.provider_error'
  | 'oidc.errors.not_configured'
  | 'oidc.errors.invalid_handoff'
  | 'oidc.errors.network'
  | 'signup.errorSignupClosed'
  | 'signup.errorInviteRequired'
  | 'signup.errorCapacityReached';

export type OidcReturnInput =
  | { kind: 'handoff'; handoff: string }
  | { kind: 'error'; messageKey: OidcReturnErrorKey; sendToSignup: boolean };

const HANDOFF = /^[A-Za-z0-9_-]{16,256}$/;

export function parseOidcReturn(search: string): OidcReturnInput {
  const params = new URLSearchParams(search);
  const handoff = params.get('handoff');
  if (handoff && HANDOFF.test(handoff)) return { kind: 'handoff', handoff };
  return { kind: 'error', ...oidcCallbackErrorCopy(params.get('error') ?? 'invalid_state') };
}

export function oidcCallbackErrorCopy(error: string): { messageKey: OidcReturnErrorKey; sendToSignup: boolean } {
  switch (error) {
    case 'signup-closed': return { messageKey: 'signup.errorSignupClosed', sendToSignup: false };
    case 'invite-required': return { messageKey: 'signup.errorInviteRequired', sendToSignup: true };
    case 'capacity-reached': return { messageKey: 'signup.errorCapacityReached', sendToSignup: false };
    case 'exchange_failed': return { messageKey: 'oidc.errors.exchange_failed', sendToSignup: false };
    case 'invalid_id_token': return { messageKey: 'oidc.errors.invalid_id_token', sendToSignup: false };
    case 'email_domain_not_allowed': return { messageKey: 'oidc.errors.email_domain_not_allowed', sendToSignup: false };
    case 'account_link_ambiguous': return { messageKey: 'oidc.errors.account_link_ambiguous', sendToSignup: false };
    case 'invalid_migration_handoff': return { messageKey: 'oidc.errors.invalid_migration_handoff', sendToSignup: false };
    case 'migration_conflict': return { messageKey: 'oidc.errors.migration_conflict', sendToSignup: false };
    case 'provider_error': return { messageKey: 'oidc.errors.provider_error', sendToSignup: false };
    case 'not_configured': return { messageKey: 'oidc.errors.not_configured', sendToSignup: false };
    default: return { messageKey: 'oidc.errors.invalid_state', sendToSignup: false };
  }
}

export function oidcCompleteErrorKey(code: CloudAuthErrorCode | 'unknown'): OidcReturnErrorKey {
  switch (code) {
    case 'invalid-handoff': return 'oidc.errors.invalid_handoff';
    case 'oidc-not-configured': return 'oidc.errors.not_configured';
    case 'rate-limited':
    case 'network': return 'oidc.errors.network';
    default: return 'oidc.errors.invalid_handoff';
  }
}
