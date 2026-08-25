import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CloudAuthError, loginWithGoogle } from '@/auth/cloudAuth';
import { useAuth } from '@/auth/AuthContext';
import { Button, Input, CyberMark, useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { CyberBackdrop } from '@/screens/common/CyberBackdrop';
import { GoogleLoginButton } from './GoogleLoginButton';
import './auth.css';
import { authReturnTarget } from '@/app/authReturnTarget';
import { classifyPasswordLoginFailure } from './loginErrorPresentation';
import {
  E2eeAccountAuthError,
  activateE2eePasswordLogin,
  disposePendingE2eeLogin,
  startPasswordLoginV2,
} from '@/auth/e2eeAccountApi';
import type { PendingE2eeDeviceLogin } from '@/auth/e2eeAccountSetup';

export function LoginScreen() {
  const { login, loginE2ee } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { t } = useTranslation();

  useEffect(() => { document.title = 'Sign in — Very Happy'; }, []);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [pendingE2ee, setPendingE2ee] = useState<PendingE2eeDeviceLogin | null>(null);
  const pendingRef = useRef<PendingE2eeDeviceLogin | null>(null);
  const [recoveryCode, setRecoveryCode] = useState('');

  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;

  useEffect(() => () => {
    if (pendingRef.current) disposePendingE2eeLogin(pendingRef.current);
  }, []);

  function holdPending(pending: PendingE2eeDeviceLogin | null) {
    pendingRef.current = pending;
    setPendingE2ee(pending);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setGoogleError(null);
    try {
      const result = await startPasswordLoginV2(username, password);
      setPassword('');
      if (result.kind === 'trusted') {
        await login(result.credentials.token, result.credentials.secret);
        toast.success(t('common.success'));
        navigate(authReturnTarget(location.state), { replace: true });
      } else {
        holdPending(result.pending);
        setRecoveryCode('');
      }
    } catch (err) {
      const failure = err instanceof E2eeAccountAuthError
        ? (err.code === 'invalid-credentials' ? 'invalid-credentials'
          : err.code === 'rate-limited' ? 'rate-limited' : 'network')
        : classifyPasswordLoginFailure(err);
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

  async function onRecoverySubmit(e: FormEvent) {
    e.preventDefault();
    if (!pendingE2ee || !recoveryCode || busy) return;
    setBusy(true);
    setError(null);
    try {
      const credentials = await activateE2eePasswordLogin(pendingE2ee, recoveryCode);
      pendingRef.current = null;
      holdPending(null);
      const unlocked = await loginE2ee(credentials);
      if (!unlocked) throw new Error('Activated E2EE device did not unlock');
      toast.success(t('common.success'));
      navigate(authReturnTarget(location.state), { replace: true });
    } catch (err) {
      if (err instanceof E2eeAccountAuthError && err.code === 'recovery-invalid') {
        setError('That recovery code is invalid. Check every group and try again.');
      } else if (err instanceof E2eeAccountAuthError && err.code === 'rate-limited') {
        setError(t('signup.errorRateLimited'));
      } else {
        setError('Could not activate this encrypted browser. Sign in again and retry.');
      }
    } finally {
      setBusy(false);
    }
  }

  function cancelRecovery() {
    if (pendingE2ee) disposePendingE2eeLogin(pendingE2ee);
    holdPending(null);
    setRecoveryCode('');
    setError(null);
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

  if (pendingE2ee) return (
    <div className="auth-page">
      <CyberBackdrop />
      <form className="auth-card auth-card--recovery" onSubmit={onRecoverySubmit}>
        <div className="auth-brand"><CyberMark size={40} glow /><div className="auth-wordmark">very happy</div></div>
        <div className="auth-eyebrow eyebrow">APPROVE THIS BROWSER</div>
        <h1 className="auth-recovery-title">Unlock end-to-end encrypted work.</h1>
        <p className="auth-recovery-copy">
          Enter the recovery code you saved when the account was created. It is processed only in this browser and is never sent to the relay.
        </p>
        <Input
          label="Recovery code"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={recoveryCode}
          onChange={(event) => setRecoveryCode(event.target.value.trim().toUpperCase())}
          error={error}
          placeholder="VH1-…"
        />
        <Button type="submit" variant="primary" fullWidth loading={busy} disabled={!recoveryCode || busy}>
          Approve and open workspace
        </Button>
        <button type="button" className="auth-alt" disabled={busy} onClick={cancelRecovery}>
          Cancel and sign in again
        </button>
        <div className="auth-help"><Link to="/docs/security">Why a recovery code?</Link></div>
      </form>
    </div>
  );

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

        <button type="button" className="auth-alt" onClick={() => navigate('/signup', { state: location.state })}>
          {t('settingsAccount.createAccountTitle')}
        </button>
        <div className="auth-help">Can’t connect? <Link to="/docs/troubleshooting">Open troubleshooting</Link></div>
        <div className="auth-legal">
          <Link to="/">Home</Link>
          <span aria-hidden="true">·</span>
          <Link to="/docs">Docs</Link>
          <span aria-hidden="true">·</span>
          <Link to="/privacy">Privacy</Link>
          <span aria-hidden="true">·</span>
          <Link to="/terms">Terms</Link>
        </div>
      </form>
    </div>
  );
}
