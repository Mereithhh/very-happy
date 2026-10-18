import type { CloudAuthErrorCode, PublicAuthConfig } from '@/auth/cloudAuth';

export function emailOtpTiming(now: number, sentAt: number | null, expiresAt: number | null) {
  return {
    remainingSeconds: expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1_000)) : 0,
    resendSeconds: sentAt ? Math.max(0, 30 - Math.floor((now - sentAt) / 1_000)) : 0,
  };
}

export function shouldResetEmailChallenge(code: CloudAuthErrorCode): boolean {
  return code === 'capacity-reached' || code === 'signup-closed' || code === 'invite-required';
}

export function publicAuthMethodState(config: PublicAuthConfig | null) {
  const emailEnabled = config?.emailOtpEnabled === true;
  const passwordEnabled = config?.passwordLoginEnabled !== false;
  const oidcEnabled = !!config?.oidc;
  return {
    emailEnabled,
    passwordEnabled,
    googleEnabled: !!config?.googleClientId,
    oidcEnabled,
    oidcDisplayName: config?.oidc?.displayName ?? '',
    // With SSO on the page the password form stays folded: SSO is the primary path.
    expandPasswordAfterLoad: !emailEnabled && !oidcEnabled && passwordEnabled,
  };
}
