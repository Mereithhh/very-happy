import { useEffect, useState, type FormEvent } from 'react';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { CloudAuthError, loginWithEmail, requestEmailLoginCode } from '@/auth/cloudAuth';
import { Button, Input } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { emailOtpTiming, shouldResetEmailChallenge } from './emailOtpPresentation';

interface EmailOtpFormProps {
  busy?: boolean;
  inviteCode?: string;
  onBusyChange?: (busy: boolean) => void;
  onCredentials: (credentials: AuthCredentials) => Promise<void>;
}

function emailErrorMessage(error: unknown, t: ReturnType<typeof useTranslation>['t']): string {
  if (!(error instanceof CloudAuthError)) return t('emailAuth.network');
  if (error.code === 'invalid-email-code') return t('emailAuth.invalidCode');
  if (error.code === 'email-delivery-unavailable') return t('emailAuth.deliveryUnavailable');
  if (error.code === 'email-not-configured') return t('emailAuth.notConfigured');
  if (error.code === 'rate-limited') return t('signup.errorRateLimited');
  if (error.code === 'capacity-reached') return t('signup.errorCapacityReached');
  if (error.code === 'signup-closed') return t('signup.errorSignupClosed');
  if (error.code === 'invite-required') return t('signup.errorInviteRequired');
  return t('emailAuth.network');
}

export function EmailOtpForm({ busy = false, inviteCode, onBusyChange, onCredentials }: EmailOtpFormProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedEmail = email.trim().toLowerCase();
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
  const isBusy = busy || localBusy;
  const { remainingSeconds, resendSeconds } = emailOtpTiming(now, sentAt, expiresAt);

  useEffect(() => {
    if (!challengeId) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [challengeId]);

  async function withBusy(action: () => Promise<void>) {
    setLocalBusy(true);
    onBusyChange?.(true);
    setError(null);
    try { await action(); }
    catch (err) {
      setError(emailErrorMessage(err, t));
      if (err instanceof CloudAuthError && shouldResetEmailChallenge(err.code)) {
        setChallengeId(null);
        setExpiresAt(null);
      }
    }
    finally { setLocalBusy(false); onBusyChange?.(false); }
  }

  async function sendCode() {
    if (!emailValid) { setError(t('emailAuth.invalidEmail')); return; }
    await withBusy(async () => {
      const challenge = await requestEmailLoginCode(normalizedEmail);
      setChallengeId(challenge.challengeId);
      setExpiresAt(Date.parse(challenge.expiresAt));
      setSentAt(Date.now());
      setNow(Date.now());
      setCode('');
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!challengeId) { await sendCode(); return; }
    if (remainingSeconds === 0) { setError(t('emailAuth.expired')); return; }
    if (!/^\d{6}$/.test(code)) { setError(t('emailAuth.invalidCode')); return; }
    await withBusy(async () => {
      const credentials = await loginWithEmail(normalizedEmail, challengeId, code, inviteCode);
      await onCredentials(credentials);
    });
  }

  return <form className="auth-email" onSubmit={submit}>
    <div className="auth-method-heading">
      <strong>{t('emailAuth.title')}</strong>
      <span>{t('emailAuth.subtitle')}</span>
    </div>
    {!challengeId ? <Input
      label={t('emailAuth.email')}
      type="email"
      autoFocus
      autoComplete="email"
      inputMode="email"
      value={email}
      onChange={(event) => setEmail(event.target.value)}
      placeholder={t('emailAuth.emailPlaceholder')}
      error={error}
    /> : <>
      <div className="auth-email-sent" role="status">
        <span>{t('emailAuth.sent', { email: normalizedEmail })}</span>
        <span>{remainingSeconds > 0 ? t('emailAuth.expiresIn', { seconds: remainingSeconds }) : t('emailAuth.expired')}</span>
      </div>
      <Input
        label={t('emailAuth.code')}
        autoFocus
        autoComplete="one-time-code"
        inputMode="numeric"
        maxLength={6}
        value={code}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder={t('emailAuth.codePlaceholder')}
        error={error}
      />
    </>}
    <Button type="submit" variant="primary" fullWidth loading={isBusy} disabled={isBusy || (!challengeId ? !emailValid : code.length !== 6 || remainingSeconds === 0)}>
      {challengeId ? t('emailAuth.verify') : t('emailAuth.sendCode')}
    </Button>
    {challengeId && <div className="auth-email-actions">
      <button type="button" disabled={isBusy || resendSeconds > 0} onClick={() => void sendCode()}>{resendSeconds > 0 ? t('emailAuth.resendIn', { seconds: resendSeconds }) : t('emailAuth.resend')}</button>
      <button type="button" disabled={isBusy} onClick={() => { setChallengeId(null); setExpiresAt(null); setCode(''); setError(null); }}>{t('emailAuth.changeEmail')}</button>
    </div>}
  </form>;
}
