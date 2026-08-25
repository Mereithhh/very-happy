import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
import {
  E2eeAccountAuthError,
  commitE2eePasswordSignup,
  requestE2eeSignupChallenge,
} from '@/auth/e2eeAccountApi';
import {
  disposePreparedE2eeSignup,
  prepareE2eePasswordSignup,
  type PreparedE2eePasswordSignup,
} from '@/auth/e2eeAccountSetup';

const MIN_USERNAME = 3;
const MIN_PASSWORD = 8;

export function SignupScreen() {
  const { login, loginE2ee } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { t } = useTranslation();

  useEffect(() => { document.title = 'Create account — Very Happy'; }, []);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [authConfig, setAuthConfig] = useState<PublicAuthConfig | null>(null);
  const [preparedE2ee, setPreparedE2ee] = useState<PreparedE2eePasswordSignup | null>(null);
  const preparedRef = useRef<PreparedE2eePasswordSignup | null>(null);
  const [recoveryConfirmation, setRecoveryConfirmation] = useState('');
  const [recoveryCopied, setRecoveryCopied] = useState(false);
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

  useEffect(() => () => {
    if (preparedRef.current) disposePreparedE2eeSignup(preparedRef.current);
  }, []);

  function holdPrepared(prepared: PreparedE2eePasswordSignup | null) {
    preparedRef.current = prepared;
    setPreparedE2ee(prepared);
  }

  function authErrorText(error: unknown): string {
    if (!(error instanceof E2eeAccountAuthError)) return t('signup.errorGeneric');
    if (error.code === 'username-taken') return t('signup.errorUsernameTaken');
    if (error.code === 'rate-limited') return t('signup.errorRateLimited');
    if (error.code === 'capacity-reached') return t('signup.errorCapacityReached');
    if (error.code === 'invite-required') return t('signup.errorInviteRequired');
    if (error.code === 'signup-closed') return t('signup.errorSignupClosed');
    if (error.code === 'same-origin-required') {
      return 'E2EE setup requires the Web app and relay API on the same origin. See Self-hosting.';
    }
    return t('signup.errorGeneric');
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched({ u: true, p: true, c: true });
    if (!canSubmit) return;
    setBusy(true);
    setServerError(null);
    setGoogleError(null);
    try {
      if (authConfig?.e2ee?.enabled) {
        const { origin, challenge } = await requestE2eeSignupChallenge();
        const prepared = await prepareE2eePasswordSignup({ origin, challenge, username });
        holdPrepared(prepared);
        setRecoveryConfirmation('');
        return;
      }
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
      if (err instanceof E2eeAccountAuthError) {
        setServerError(authErrorText(err));
      } else if (err instanceof AccountAuthError) {
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

  async function finishE2eeSignup(e: FormEvent) {
    e.preventDefault();
    if (!preparedE2ee || recoveryConfirmation.trim() !== preparedE2ee.recoveryCode || busy) return;
    setBusy(true);
    setServerError(null);
    try {
      // commitE2eePasswordSignup owns and wipes the prepared secret buffers.
      preparedRef.current = null;
      const credentials = await commitE2eePasswordSignup({
        prepared: preparedE2ee,
        password,
        inviteCode: invite.trim() || undefined,
      });
      holdPrepared(null);
      const unlocked = await loginE2ee(credentials);
      if (!unlocked) throw new Error('New E2EE device did not unlock');
      toast.success(t('signup.success'));
      navigate(authReturnTarget(location.state), { replace: true });
    } catch (error) {
      holdPrepared(null);
      setServerError(authErrorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyRecoveryCode() {
    if (!preparedE2ee) return;
    try {
      await navigator.clipboard.writeText(preparedE2ee.recoveryCode);
      setRecoveryCopied(true);
    } catch {
      setServerError('Copy failed. Select the recovery code and save it manually.');
    }
  }

  function downloadRecoveryCode() {
    if (!preparedE2ee) return;
    const blob = new Blob([
      `Very Happy recovery code\n\n${preparedE2ee.recoveryCode}\n\n`,
      'Keep this file private. Very Happy and the relay cannot recover this code.\n',
    ], { type: 'text/plain;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = 'very-happy-recovery-code.txt';
    anchor.click();
    URL.revokeObjectURL(href);
  }

  function cancelPreparedSignup() {
    if (preparedE2ee) disposePreparedE2eeSignup(preparedE2ee);
    holdPrepared(null);
    setRecoveryConfirmation('');
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

  if (preparedE2ee) return (
    <div className="auth-page">
      <CyberBackdrop />
      <form className="auth-card auth-card--recovery" onSubmit={finishE2eeSignup}>
        <div className="auth-brand"><CyberMark size={40} glow /><div className="auth-wordmark">very happy</div></div>
        <div className="auth-eyebrow eyebrow">SAVE YOUR RECOVERY CODE</div>
        <h1 className="auth-recovery-title">Your password cannot decrypt this account.</h1>
        <p className="auth-recovery-copy">
          This one-time code is the only way to approve a new browser. The relay never receives it and cannot reset it.
        </p>
        <output className="auth-recovery-code" aria-label="Recovery code">
          {preparedE2ee.recoveryCode}
        </output>
        <div className="auth-recovery-actions">
          <Button type="button" variant="secondary" onClick={copyRecoveryCode}>
            {recoveryCopied ? 'Copied' : 'Copy code'}
          </Button>
          <Button type="button" variant="ghost" onClick={downloadRecoveryCode}>Download .txt</Button>
        </div>
        <Input
          label="Paste the recovery code to confirm"
          autoComplete="off"
          spellCheck={false}
          value={recoveryConfirmation}
          onChange={(event) => setRecoveryConfirmation(event.target.value.trim().toUpperCase())}
          placeholder="VH1-…"
        />
        {serverError && <div className="auth-error" role="alert">{serverError}</div>}
        <Button
          type="submit"
          variant="primary"
          fullWidth
          loading={busy}
          disabled={recoveryConfirmation !== preparedE2ee.recoveryCode || busy}
        >
          Create encrypted account
        </Button>
        <button type="button" className="auth-alt" disabled={busy} onClick={cancelPreparedSignup}>
          Start over
        </button>
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
        <div className="auth-eyebrow eyebrow">{t('signup.title')}</div>

        {authConfig?.signup.atCapacity ? (
          <div className="auth-policy" role="status">{t('signup.errorCapacityReached')}</div>
        ) : authConfig?.signup.mode === 'closed' ? (
          <div className="auth-policy" role="status">{t('signup.errorSignupClosed')}</div>
        ) : authConfig?.signup.mode === 'invite' ? (
          <div className="auth-policy" role="status">{t('signup.errorInviteRequired')}</div>
        ) : null}

        {(authConfig?.signup.mode === 'invite' || authConfig === null) && <Input
            label={t('signup.inviteCode')}
            autoComplete="off"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            placeholder={t('signup.inviteCodePlaceholder')}
          />}

        {authConfig && !authConfig.e2ee?.enabled ? <GoogleLoginButton
            disabled={busy}
            dividerLabel={t('signup.orPassword')}
            retryLabel={t('common.retry')}
            unavailableLabel={t('signup.errorGoogle')}
            onCredential={onGoogleCredential}
          /> : authConfig?.e2ee?.enabled ? (
            <div className="auth-policy" role="status">
              Google registration is temporarily unavailable while encrypted-device approval is completed. Use password signup.
            </div>
          ) : null}
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
