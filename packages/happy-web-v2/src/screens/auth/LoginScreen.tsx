import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { loginWithPassword } from '@/auth/passwordUnlock';
import { CloudAuthError, loginWithGoogle } from '@/auth/cloudAuth';
import { useAuth } from '@/auth/AuthContext';
import { Button, Input, CyberMark, useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { CyberBackdrop } from '@/screens/common/CyberBackdrop';
import { GoogleLoginButton } from './GoogleLoginButton';
import './auth.css';

export function LoginScreen() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);

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
      navigate('/', { replace: true });
    } catch (err: any) {
      const msg =
        err?.response?.status === 401 || err?.response?.status === 403
          ? t('errors.authenticationFailed')
          : err?.message || t('errors.networkError');
      setError(msg);
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
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof CloudAuthError && err.code === 'capacity-reached') setGoogleError(t('signup.errorCapacityReached'));
      else if (err instanceof CloudAuthError && err.code === 'signup-closed') setGoogleError(t('signup.errorSignupClosed'));
      else if (err instanceof CloudAuthError && err.code === 'invite-required') {
        toast.error(t('signup.errorInviteRequiredGoogle'));
        navigate('/signup');
      }
      else if (err instanceof CloudAuthError && err.code === 'network') setGoogleError(t('errors.networkError'));
      else setGoogleError(t('signup.errorGoogle'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <CyberBackdrop />
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-brand">
          <CyberMark size={40} glow />
          <div className="auth-wordmark">very happy</div>
        </div>
        <div className="auth-eyebrow eyebrow">{t('settings.connectAccount')}</div>

        <GoogleLoginButton
          disabled={busy}
          dividerLabel={t('signup.orPassword')}
          retryLabel={t('common.retry')}
          unavailableLabel={t('signup.errorGoogle')}
          onCredential={onGoogleCredential}
        />
        {googleError && <div className="auth-error" role="alert">{googleError}</div>}

        <Input
          label={t('common.name')}
          autoFocus
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

        <button type="button" className="auth-alt" onClick={() => navigate('/signup')}>
          {t('settingsAccount.createAccountTitle')}
        </button>
      </form>
    </div>
  );
}
