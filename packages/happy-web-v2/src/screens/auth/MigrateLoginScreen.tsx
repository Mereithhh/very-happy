import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CloudAuthError, completeMigrationLogin, loadPublicAuthConfig, type PublicAuthConfig } from '@/auth/cloudAuth';
import { useAuth } from '@/auth/AuthContext';
import { Button, Spinner } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { CyberBackdrop } from '@/screens/common/CyberBackdrop';
import { authReturnTarget } from '@/app/authReturnTarget';
import { BrandMark } from '@/ui/BrandMark';
import { BRAND, brandText } from '@/app/brand';
import { OidcLoginButton } from './OidcLoginButton';
import { migrateLoginMode, parseMigrationHandoff } from './migrateLoginPresentation';
import './auth.css';

/**
 * B-627: landing page on the NEW relay for people arriving from the old one's
 * "we moved" banner. See migrateLoginPresentation.ts for the two paths.
 */
export function MigrateLoginScreen() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, lang } = useTranslation();
  const handoff = parseMigrationHandoff(location.search);
  const [config, setConfig] = useState<PublicAuthConfig | null | 'loading'>('loading');
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => { document.title = brandText(t('migration.loginTitle')); }, [lang, t]);

  useEffect(() => {
    let cancelled = false;
    void loadPublicAuthConfig().then((loaded) => { if (!cancelled) setConfig(loaded); });
    return () => { cancelled = true; };
  }, []);

  const mode = migrateLoginMode(handoff, config);

  useEffect(() => {
    if (mode !== 'direct' || !handoff || started.current) return;
    // The ticket is single-use: guard against StrictMode's double effect.
    started.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const creds = await completeMigrationLogin(handoff);
        if (cancelled) return;
        await login(creds.token, creds.secret);
        navigate(authReturnTarget(null), { replace: true });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof CloudAuthError && err.code === 'invalid-migration-handoff') setError(t('oidc.errors.invalid_migration_handoff'));
        else if (err instanceof CloudAuthError && err.code === 'rate-limited') setError(t('signup.errorRateLimited'));
        else setError(t('oidc.errors.network'));
      }
    })();
    return () => { cancelled = true; };
  }, [mode, handoff, login, navigate, t]);

  return (
    <div className="auth-page">
      <CyberBackdrop />
      <div className="auth-card auth-card--oidc-return">
        <BrandMark size={40} className="auth-brand" wordmarkClassName="auth-wordmark" />
        {mode === 'invalid' || error ? (
          <>
            <div className="auth-eyebrow eyebrow">{t('oidc.failedTitle')}</div>
            <div className="auth-policy" role="alert">{error ?? t('oidc.errors.invalid_migration_handoff')}</div>
            <Button type="button" variant="primary" fullWidth onClick={() => navigate('/login', { replace: true })}>
              {t('oidc.backToLogin')}
            </Button>
          </>
        ) : mode === 'sso' && config !== 'loading' && config?.oidc ? (
          <>
            <div className="auth-brand-message">
              <div className="auth-brand-label">{t('migration.loginEyebrow')}</div>
              <h1>{t('migration.loginHeading', { name: BRAND.name })}</h1>
              <p>{t('migration.loginSso', { provider: config.oidc.displayName })}</p>
            </div>
            <OidcLoginButton displayName={config.oidc.displayName} migrationHandoff={handoff ?? undefined} label={t('migration.loginSsoButton', { provider: config.oidc.displayName })} />
          </>
        ) : (
          <div className="auth-oidc-status" role="status" aria-live="polite">
            <Spinner size={18} />
            <div>
              <strong>{t('migration.finishingTitle')}</strong>
              <span>{t('migration.finishing')}</span>
            </div>
          </div>
        )}
        <footer className="auth-footer">
          <div className="auth-help">{t('authCommon.helpPrefix')} <Link to="/docs/troubleshooting">{t('authCommon.troubleshooting')}</Link></div>
        </footer>
      </div>
    </div>
  );
}
