import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import { Button } from '@/ui';
import { CloudAuthError, startOidcLogin } from '@/auth/cloudAuth';
import { persistAuthReturnTarget } from '@/app/authReturnTarget';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * B-620: "Continue with <SSO>" — the primary action when the server has a
 * generic OIDC issuer. The round trip leaves this app, so the in-app return
 * target is persisted before the browser navigates to the provider.
 */
export function OidcLoginButton({ displayName, inviteCode, migrationHandoff, label, disabled, trailingDividerLabel, onBusyChange }: {
  displayName: string;
  inviteCode?: string;
  /** B-627: signed ticket from the old relay; the SSO callback then claims that account. */
  migrationHandoff?: string;
  /** Overrides the default "Continue with <name>" label. */
  label?: string;
  disabled?: boolean;
  /** Divider shown under the button when other sign-in methods follow it. */
  trailingDividerLabel?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const from = (location.state as { from?: { pathname: string; search?: string; hash?: string } } | null)?.from;
      if (from) persistAuthReturnTarget({ pathname: from.pathname, search: from.search ?? '', hash: from.hash ?? '' });
      const { authorizationUrl } = await startOidcLogin(inviteCode, migrationHandoff);
      window.location.assign(authorizationUrl);
      // Keep the button busy: the page is being replaced by the provider.
    } catch (err) {
      setBusy(false);
      onBusyChange?.(false);
      if (err instanceof CloudAuthError && err.code === 'rate-limited') setError(t('signup.errorRateLimited'));
      else if (err instanceof CloudAuthError && err.code === 'oidc-provider-unavailable') setError(t('oidc.errors.exchange_failed'));
      else if (err instanceof CloudAuthError && err.code === 'oidc-not-configured') setError(t('oidc.errors.not_configured'));
      else if (err instanceof CloudAuthError && err.code === 'invalid-migration-handoff') setError(t('oidc.errors.invalid_migration_handoff'));
      else setError(t('oidc.errors.network'));
    }
  }

  return <>
    <Button type="button" variant="primary" fullWidth loading={busy} disabled={disabled || busy} leftIcon={<KeyRound size={16} />} onClick={() => void start()}>
      {label ?? t('oidc.continueWith', { name: displayName })}
    </Button>
    {error && <div className="auth-error" role="alert">{error}</div>}
    {trailingDividerLabel && <div className="auth-divider"><span>{trailingDividerLabel}</span></div>}
  </>;
}
