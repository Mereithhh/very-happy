import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CloudAuthError, completeOidcLogin } from '@/auth/cloudAuth';
import { useAuth } from '@/auth/AuthContext';
import { Button, Spinner } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { CyberBackdrop } from '@/screens/common/CyberBackdrop';
import { authReturnTarget } from '@/app/authReturnTarget';
import { oidcCompleteErrorKey, parseOidcReturn, type OidcReturnErrorKey } from './oidcReturnPresentation';
import './auth.css';
import { BrandLockup } from '@/ui/BrandMark';
import { brandText } from '@/app/brand';

/**
 * B-620: landing page after the identity provider sends the browser back.
 * `?handoff=` is exchanged exactly once for the login token + account secret;
 * `?error=` renders the reason with a way back to the sign-in page.
 */
export function OidcReturnScreen() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, lang } = useTranslation();
  const [errorKey, setErrorKey] = useState<OidcReturnErrorKey | null>(null);
  const [sendToSignup, setSendToSignup] = useState(false);
  const started = useRef(false);

  useEffect(() => { document.title = brandText(t('login.pageTitle')); }, [lang, t]);

  useEffect(() => {
    // The handoff is single-use: guard against StrictMode's double effect.
    if (started.current) return;
    started.current = true;
    const input = parseOidcReturn(location.search);
    if (input.kind === 'error') {
      setErrorKey(input.messageKey);
      setSendToSignup(input.sendToSignup);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const creds = await completeOidcLogin(input.handoff);
        if (cancelled) return;
        await login(creds.token, creds.secret);
        navigate(authReturnTarget(null), { replace: true });
      } catch (err) {
        if (cancelled) return;
        setErrorKey(oidcCompleteErrorKey(err instanceof CloudAuthError ? err.code : 'unknown'));
      }
    })();
    return () => { cancelled = true; };
  }, [location.search, login, navigate]);

  return (
    <div className="auth-page">
      <CyberBackdrop />
      <div className="auth-card auth-card--oidc-return">
        <BrandLockup height={36} size={40} className="auth-brand" wordmarkClassName="auth-wordmark" />
        {errorKey === null ? (
          <div className="auth-oidc-status" role="status" aria-live="polite">
            <Spinner size={18} />
            <div>
              <strong>{t('oidc.finishingTitle')}</strong>
              <span>{t('oidc.finishing')}</span>
            </div>
          </div>
        ) : (
          <>
            <div className="auth-eyebrow eyebrow">{t('oidc.failedTitle')}</div>
            <div className="auth-policy" role="alert">{t(errorKey)}</div>
            <Button type="button" variant="primary" fullWidth onClick={() => navigate(sendToSignup ? '/signup' : '/login', { replace: true })}>
              {sendToSignup ? t('oidc.goToSignup') : t('oidc.backToLogin')}
            </Button>
          </>
        )}
        <footer className="auth-footer">
          <div className="auth-help">{t('authCommon.helpPrefix')} <Link to="/docs/troubleshooting">{t('authCommon.troubleshooting')}</Link></div>
        </footer>
      </div>
    </div>
  );
}
