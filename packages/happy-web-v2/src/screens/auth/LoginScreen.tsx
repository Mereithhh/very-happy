import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { loginWithPassword } from '@/auth/passwordUnlock';
import { useAuth } from '@/auth/AuthContext';
import { Button, Input, CyberMark, useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { CyberBackdrop } from '@/screens/common/CyberBackdrop';
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

  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
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

  return (
    <div className="auth-page">
      <CyberBackdrop />
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-brand">
          <CyberMark size={40} glow />
          <div className="auth-wordmark">very happy</div>
        </div>
        <div className="auth-eyebrow eyebrow">{t('settings.connectAccount')}</div>

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
