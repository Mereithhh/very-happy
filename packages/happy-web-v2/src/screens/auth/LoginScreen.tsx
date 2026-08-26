import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { loginWithPassword } from '@/auth/passwordUnlock';
import { CloudAuthError, loadPublicAuthConfig, loginWithGoogle, type PublicAuthConfig } from '@/auth/cloudAuth';
import { useAuth } from '@/auth/AuthContext';
import { Button, Input, CyberMark, useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { CyberBackdrop } from '@/screens/common/CyberBackdrop';
import { GoogleLoginButton } from './GoogleLoginButton';
import './auth.css';
import { authReturnTarget, peekPersistedAuthReturnTarget } from '@/app/authReturnTarget';
import { classifyPasswordLoginFailure } from './loginErrorPresentation';
import { EmailOtpForm } from './EmailOtpForm';
import { publicAuthMethodState } from './emailOtpPresentation';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { useKeyboardViewportPin } from '@/app/useKeyboardViewportPin';

export function LoginScreen() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { t, lang } = useTranslation();
  const pageRef = useRef<HTMLDivElement>(null);
  useKeyboardViewportPin(pageRef);

  useEffect(() => { document.title = t('login.pageTitle'); }, [lang, t]);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [authConfig, setAuthConfig] = useState<PublicAuthConfig | null>(null);
  const [passwordExpanded, setPasswordExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadPublicAuthConfig().then((config) => {
      if (cancelled) return;
      setAuthConfig(config);
      if (publicAuthMethodState(config).expandPasswordAfterLoad) setPasswordExpanded(true);
    });
    return () => { cancelled = true; };
  }, []);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setGoogleError(null);
    try {
      const creds = await loginWithPassword(username, password);
      await login(creds.token, creds.secret);
      toast.success(t('common.success'));
      navigate(authReturnTarget(location.state), { replace: true });
    } catch (err) {
      const failure = classifyPasswordLoginFailure(err);
      if (failure === 'invalid-credentials') {
        setError(t('errors.authenticationFailed'));
      } else if (failure === 'rate-limited') {
        setError(t('signup.errorRateLimited'));
      } else {
        setError('Could not reach the server. Check your connection and server address.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function onGoogleCredential(credential: string, nonce: string) {
    setBusy(true);
    setGoogleError(null);
    try {
      const creds = await loginWithGoogle(credential, nonce);
      await login(creds.token, creds.secret);
      navigate(authReturnTarget(location.state), { replace: true });
    } catch (err) {
      if (err instanceof CloudAuthError && err.code === 'capacity-reached') setGoogleError(t('signup.errorCapacityReached'));
      else if (err instanceof CloudAuthError && err.code === 'signup-closed') setGoogleError(t('signup.errorSignupClosed'));
      else if (err instanceof CloudAuthError && err.code === 'invite-required') {
        toast.error(t('signup.errorInviteRequiredGoogle'));
        navigate('/signup', { state: location.state });
      }
      else if (err instanceof CloudAuthError && err.code === 'network') setGoogleError(t('errors.networkError'));
      else setGoogleError(t('signup.errorGoogle'));
    } finally {
      setBusy(false);
    }
  }

  async function finishLogin(creds: { token: string; secret: string }) {
    await login(creds.token, creds.secret);
    toast.success(t('common.success'));
    navigate(authReturnTarget(location.state), { replace: true });
  }

  const { emailEnabled, passwordEnabled, googleEnabled } = publicAuthMethodState(authConfig);
  const reauthTarget = peekPersistedAuthReturnTarget();
  const reauthMessage = reauthTarget === '/settings/google'
    ? t('reauth.google')
    : reauthTarget === '/settings/email'
      ? t('reauth.email')
      : null;

  return (
    <div className="auth-page" ref={pageRef}>
      <CyberBackdrop />
      <main className="auth-card auth-card--login">
        <section className="auth-brand-panel" aria-labelledby="login-brand-title">
          <div className="auth-brand">
            <CyberMark size={44} />
            <div className="auth-wordmark">very happy</div>
          </div>
          <div className="auth-brand-message">
            <div className="auth-brand-label">{t('login.consoleLabel')}</div>
            <h1 id="login-brand-title">{t('login.title')}</h1>
            <p>{t('login.subtitle')}</p>
          </div>
          <div className="auth-console" aria-hidden="true">
            <div className="auth-console-bar">
              <span>very-happy://web</span>
              <span>AUTH</span>
            </div>
            <div className="auth-console-line">
              <span className="auth-console-prompt">❯</span>
              <span>{t('login.waiting')}</span>
              <i />
            </div>
          </div>
        </section>

        <section className="auth-form-panel" aria-labelledby="login-form-title">
          <LanguageSwitcher className="auth-language-switcher" />
          <header className="auth-form-header">
            <span>{t('login.accountStep')}</span>
            <h2 id="login-form-title">{t('settings.connectAccount')}</h2>
          </header>
          {reauthMessage && <div className="auth-reauth-note" role="status">{reauthMessage}</div>}

          {emailEnabled && <EmailOtpForm busy={busy} onBusyChange={setBusy} onCredentials={finishLogin} />}

          <GoogleLoginButton
            disabled={busy}
            leadingDividerLabel={emailEnabled ? t('emailAuth.orGoogle') : undefined}
            retryLabel={t('common.retry')}
            unavailableLabel={t('signup.errorGoogle')}
            onCredential={onGoogleCredential}
          />
          {googleError && <div className="auth-error" role="alert">{googleError}</div>}

          {passwordEnabled && <>
            {(emailEnabled || googleEnabled) && <div className="auth-divider"><span>{t('signup.orPassword')}</span></div>}
            <button type="button" className="auth-method-toggle" aria-expanded={passwordExpanded} onClick={() => setPasswordExpanded((value) => !value)}>
              {passwordExpanded ? t('emailAuth.hidePassword') : t('emailAuth.usePassword')}
            </button>
            {passwordExpanded && <form className="auth-password-form" onSubmit={onSubmit}>
              <Input
                label={t('common.name')}
                autoFocus={!emailEnabled}
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username"
              />
              <Input
                label={t('settingsAccount.password')}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={error}
                placeholder="••••••••"
              />
              <Button type="submit" variant="primary" fullWidth loading={busy} disabled={!canSubmit}>
                {t('common.continue')}
              </Button>
            </form>}
          </>}

          <footer className="auth-footer">
            <div className="auth-help">{t('authCommon.helpPrefix')} <Link to="/docs/troubleshooting">{t('authCommon.troubleshooting')}</Link></div>
            <div className="auth-legal">
              <Link to="/">{t('authCommon.home')}</Link>
              <span aria-hidden="true">·</span>
              <Link to="/docs">{t('authCommon.docs')}</Link>
              <span aria-hidden="true">·</span>
              <Link to="/privacy">{t('authCommon.privacy')}</Link>
              <span aria-hidden="true">·</span>
              <Link to="/terms">{t('authCommon.terms')}</Link>
            </div>
          </footer>
        </section>
      </main>
    </div>
  );
}
