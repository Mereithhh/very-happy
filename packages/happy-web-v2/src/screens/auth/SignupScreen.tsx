import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { getRandomBytes } from 'expo-crypto';
import { encodeBase64 } from '@/encryption/base64';
import { signupWithPassword, AccountAuthError } from '@/auth/passwordUnlock';
import { CloudAuthError, loadPublicAuthConfig, loginWithGoogle, type PublicAuthConfig } from '@/auth/cloudAuth';
import { useAuth } from '@/auth/AuthContext';
import { Button, Input, CyberMark, useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { CyberBackdrop } from '@/screens/common/CyberBackdrop';
import { GoogleLoginButton } from './GoogleLoginButton';
import './auth.css';
import { authReturnTarget } from '@/app/authReturnTarget';

const MIN_USERNAME = 3;
const MIN_PASSWORD = 8;

export function SignupScreen() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { t } = useTranslation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [authConfig, setAuthConfig] = useState<PublicAuthConfig | null>(null);
  // Field-level validation only surfaces after a field is touched (audit S2:
  // real-time inline validation that doesn't scream at an empty pristine form).
  const [touched, setTouched] = useState<{ u?: boolean; p?: boolean; c?: boolean }>({});

  const usernameError = useMemo(() => {
    if (!touched.u) return null;
    if (username.trim().length < MIN_USERNAME) {
      return t('signup.errorUsernameShort', { count: MIN_USERNAME });
    }
    return null;
  }, [touched.u, username, t]);

  const passwordError = useMemo(() => {
    if (!touched.p) return null;
    if (password.length < MIN_PASSWORD) {
      return t('signup.errorPasswordShort', { count: MIN_PASSWORD });
    }
    return null;
  }, [touched.p, password, t]);

  const confirmError = useMemo(() => {
    if (!touched.c || confirm.length === 0) return null;
    if (confirm !== password) return t('signup.errorMismatch');
    return null;
  }, [touched.c, confirm, password, t]);

  const registrationBlocked = authConfig?.signup.atCapacity || authConfig?.signup.mode === 'closed';
  const canSubmit =
    username.trim().length >= MIN_USERNAME &&
    password.length >= MIN_PASSWORD &&
    confirm === password &&
    !registrationBlocked &&
    !busy;

  useEffect(() => {
    let cancelled = false;
    void loadPublicAuthConfig().then((config) => { if (!cancelled) setAuthConfig(config); });
    return () => { cancelled = true; };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched({ u: true, p: true, c: true });
    if (!canSubmit) return;
    setBusy(true);
    setServerError(null);
    setGoogleError(null);
    try {
      // Generate a fresh 32-byte account secret and base64url-encode it. The
      // secret is what happy uses for encryption/sync; here we register it
      // server-side so any browser with username+password can become the account.
      const secret = getRandomBytes(32);
      const secretB64 = encodeBase64(secret, 'base64url');
      const inviteCode = invite.trim() || undefined;
      const cloudCredentials = await signupWithPassword(username, password, secretB64, inviteCode);
      await login(cloudCredentials.token, cloudCredentials.secret);
      toast.success(t('signup.success'));
      navigate(authReturnTarget(location.state), { replace: true });
    } catch (err: any) {
      if (err instanceof AccountAuthError) {
        if (err.code === 'username-taken') setServerError(t('signup.errorUsernameTaken'));
        else if (err.code === 'rate-limited') setServerError(t('signup.errorRateLimited'));
        else setServerError(t('signup.errorGeneric'));
      } else {
        const status = err?.response?.status;
        const code = err?.response?.data?.error ?? err?.response?.data?.code;
        if (code === 'capacity-reached')
          setServerError(t('signup.errorCapacityReached'));
        else if (status === 403 && (code === 'invite-required' || /invite/i.test(String(code))))
          setServerError(t('signup.errorInviteRequired'));
        else if (status === 403 && (code === 'signup-closed' || /closed/i.test(String(code))))
          setServerError(t('signup.errorSignupClosed'));
        else if (status === 429 || status === 403)
          setServerError(t('signup.errorRateLimited'));
        else setServerError(t('signup.errorGeneric'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function onGoogleCredential(credential: string, nonce: string) {
    setBusy(true);
    setGoogleError(null);
    try {
      const creds = await loginWithGoogle(credential, nonce, invite.trim() || undefined);
      await login(creds.token, creds.secret);
      navigate(authReturnTarget(location.state), { replace: true });
    } catch (err) {
      if (err instanceof CloudAuthError) {
        if (err.code === 'capacity-reached') setGoogleError(t('signup.errorCapacityReached'));
        else if (err.code === 'invite-required') setGoogleError(t('signup.errorInviteRequiredGoogle'));
        else if (err.code === 'signup-closed') setGoogleError(t('signup.errorSignupClosed'));
        else if (err.code === 'rate-limited') setGoogleError(t('signup.errorRateLimited'));
        else setGoogleError(t('signup.errorGoogle'));
      } else {
        setGoogleError(t('signup.errorGoogle'));
      }
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
        <div className="auth-eyebrow eyebrow">{t('signup.title')}</div>

        {authConfig?.signup.atCapacity ? (
          <div className="auth-policy" role="status">This server is at account capacity. Existing users can sign in; new users can try later or self-host.</div>
        ) : authConfig?.signup.mode === 'closed' ? (
          <div className="auth-policy" role="status">Registration is currently closed. Existing accounts can still sign in.</div>
        ) : authConfig?.signup.mode === 'invite' ? (
          <div className="auth-policy" role="status">This server requires an invite code for new accounts.</div>
        ) : null}

        {(authConfig?.signup.mode === 'invite' || authConfig === null) && <Input
            label={t('signup.inviteCode')}
            autoComplete="off"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            placeholder={t('signup.inviteCodePlaceholder')}
          />}

        <GoogleLoginButton
          disabled={busy}
          dividerLabel={t('signup.orPassword')}
          retryLabel={t('common.retry')}
          unavailableLabel={t('signup.errorGoogle')}
          onCredential={onGoogleCredential}
        />
        {googleError && <div className="auth-error" role="alert">{googleError}</div>}

        <Input
          label={t('signup.username')}
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          onBlur={() => setTouched((s) => ({ ...s, u: true }))}
          placeholder={t('signup.usernamePlaceholder')}
          error={usernameError}
        />
        <Input
          label={t('signup.password')}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched((s) => ({ ...s, p: true }))}
          placeholder={t('signup.passwordPlaceholder')}
          error={passwordError}
        />
        <Input
          label={t('signup.confirm')}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={() => setTouched((s) => ({ ...s, c: true }))}
          placeholder={t('signup.confirmPlaceholder')}
          error={confirmError}
        />
        {serverError && <div className="auth-error" role="alert">{serverError}</div>}
        <Button type="submit" variant="primary" fullWidth loading={busy} disabled={!canSubmit}>
          {t('signup.submit')}
        </Button>

        <button type="button" className="auth-alt" onClick={() => navigate('/login', { state: location.state })}>
          {t('signup.haveAccount')}
        </button>
        <div className="auth-help">Registration unavailable? <Link to="/docs/accounts-and-quotas">Review account policies</Link></div>
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
