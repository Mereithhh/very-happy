import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRandomBytes } from 'expo-crypto';
import { encodeBase64 } from '@/encryption/base64';
import { authGetToken } from '@/auth/authGetToken';
import { setAccountCredentials, AccountAuthError } from '@/auth/passwordUnlock';
import { useAuth } from '@/auth/AuthContext';
import { Button, Input, CyberMark, useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { CyberBackdrop } from '@/screens/common/CyberBackdrop';
import './auth.css';

const MIN_USERNAME = 3;
const MIN_PASSWORD = 8;

export function SignupScreen() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // Field-level validation only surfaces after a field is touched (audit S2:
  // real-time inline validation that doesn't scream at an empty pristine form).
  const [touched, setTouched] = useState<{ u?: boolean; p?: boolean; c?: boolean }>({});

  const usernameError = useMemo(() => {
    if (!touched.u) return null;
    if (username.trim().length < MIN_USERNAME) {
      return t('signup.errorUsernameShort' as any, { count: MIN_USERNAME } as any) as string;
    }
    return null;
  }, [touched.u, username, t]);

  const passwordError = useMemo(() => {
    if (!touched.p) return null;
    if (password.length < MIN_PASSWORD) {
      return t('signup.errorPasswordShort' as any, { count: MIN_PASSWORD } as any) as string;
    }
    return null;
  }, [touched.p, password, t]);

  const confirmError = useMemo(() => {
    if (!touched.c || confirm.length === 0) return null;
    if (confirm !== password) return t('signup.errorMismatch' as any) as string;
    return null;
  }, [touched.c, confirm, password, t]);

  const canSubmit =
    username.trim().length >= MIN_USERNAME &&
    password.length >= MIN_PASSWORD &&
    confirm === password &&
    !busy;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched({ u: true, p: true, c: true });
    if (!canSubmit) return;
    setBusy(true);
    setServerError(null);
    try {
      // Generate a fresh 32-byte account secret and base64url-encode it. The
      // secret is what happy uses for encryption/sync; here we register it
      // server-side so any browser with username+password can become the account.
      const secret = getRandomBytes(32);
      const secretB64 = encodeBase64(secret, 'base64url');
      const inviteCode = invite.trim() || undefined;
      const token = await authGetToken(secret, inviteCode);
      await setAccountCredentials(username, password, secretB64, { token, secret: secretB64 });
      await login(token, secretB64);
      toast.success(t('signup.success' as any) as string);
      navigate('/', { replace: true });
    } catch (err: any) {
      if (err instanceof AccountAuthError) {
        if (err.code === 'username-taken') setServerError(t('signup.errorUsernameTaken' as any) as string);
        else if (err.code === 'rate-limited') setServerError(t('signup.errorRateLimited' as any) as string);
        else setServerError(t('signup.errorGeneric' as any) as string);
      } else {
        const status = err?.response?.status;
        const code = err?.response?.data?.error ?? err?.response?.data?.code;
        if (status === 403 && (code === 'invite-required' || /invite/i.test(String(code))))
          setServerError(t('signup.errorInviteRequired' as any) as string);
        else if (status === 403 && (code === 'signup-closed' || /closed/i.test(String(code))))
          setServerError(t('signup.errorSignupClosed' as any) as string);
        else if (status === 429 || status === 403)
          setServerError(t('signup.errorRateLimited' as any) as string);
        else setServerError(t('signup.errorGeneric' as any) as string);
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
        <div className="auth-eyebrow eyebrow">{t('signup.title' as any)}</div>

        <Input
          label={t('signup.username' as any) as string}
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          onBlur={() => setTouched((s) => ({ ...s, u: true }))}
          placeholder={t('signup.usernamePlaceholder' as any) as string}
          error={usernameError}
        />
        <Input
          label={t('signup.password' as any) as string}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched((s) => ({ ...s, p: true }))}
          placeholder={t('signup.passwordPlaceholder' as any) as string}
          error={passwordError}
        />
        <Input
          label={t('signup.confirm' as any) as string}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={() => setTouched((s) => ({ ...s, c: true }))}
          placeholder={t('signup.confirmPlaceholder' as any) as string}
          error={confirmError}
        />
        <Input
          label={t('signup.inviteCode' as any) as string}
          autoComplete="off"
          value={invite}
          onChange={(e) => setInvite(e.target.value)}
          placeholder={t('signup.inviteCodePlaceholder' as any) as string}
          error={serverError}
        />

        <Button type="submit" variant="primary" fullWidth loading={busy} disabled={!canSubmit}>
          {t('signup.submit' as any)}
        </Button>

        <button type="button" className="auth-alt" onClick={() => navigate('/login')}>
          {t('signup.haveAccount' as any)}
        </button>
      </form>
    </div>
  );
}
