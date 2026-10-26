import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { getAuthLatch, subscribeAuthLatch, type AuthLatchInfo } from '@/auth/authLatch';
import { authExpiredAction, unsentMessagesClipboardText, type UnsentMessage } from '@/auth/authExpiry';
import { persistAuthReturnTarget } from '@/app/authReturnTarget';
import { sync } from '@/sync/sync';
import { useTranslation } from '@/i18n/useTranslation';
import { Button, CopyButton } from '@/ui';
import './authExpiredNotice.css';

/**
 * B-490 / B-825: the server rejected this browser's token. Background sync is
 * already stopped (auth/authLatch.ts) and every unsent input marked failed.
 * The account secret and the local message cache must not outlive the token
 * (authExpiry.ts): with nothing waiting to be sent, sign out locally right
 * away (logout → login screen → back here after sign-in). Otherwise list the
 * unsent inputs first — the wipe deletes them — and sign out once the user
 * has copied what they need.
 */
export function AuthExpiredNotice() {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const location = useLocation();
  const [latch, setLatch] = useState<AuthLatchInfo | null>(getAuthLatch);
  const [unsent, setUnsent] = useState<UnsentMessage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const signingOut = useRef(false);

  useEffect(() => {
    setLatch(getAuthLatch());
    return subscribeAuthLatch(setLatch);
  }, []);

  const signOut = () => {
    if (signingOut.current) return;
    signingOut.current = true;
    setBusy(true);
    persistAuthReturnTarget(location);
    void logout();
  };

  useEffect(() => {
    if (!latch) return;
    let cancelled = false;
    void sync.unsentOutboxMessages().catch(() => [] as UnsentMessage[]).then((pending) => {
      if (cancelled) return;
      setUnsent(pending);
      if (authExpiredAction(pending) === 'sign-out-now') signOut();
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latch]);

  if (!latch) return null;
  const copyText = unsentMessagesClipboardText(unsent ?? []);
  return (
    <div className="vh-auth-expired" role="alertdialog" aria-modal="true" aria-labelledby="vh-auth-expired-title">
      <div className="vh-auth-expired-card">
        <h2 id="vh-auth-expired-title" className="vh-auth-expired-title">{t('authExpired.title')}</h2>
        {unsent && unsent.length > 0 ? (
          <>
            <p className="vh-auth-expired-body">{t('authExpired.unsentBody', { count: unsent.length })}</p>
            <ul className="vh-auth-expired-unsent" data-testid="auth-expired-unsent">
              {unsent.map((message) => (
                <li key={message.localId} className="vh-auth-expired-unsent-item">
                  {message.text?.trim() || <span className="vh-auth-expired-unsent-empty">{t('authExpired.unsentNoText')}</span>}
                </li>
              ))}
            </ul>
            {copyText && (
              <div className="vh-auth-expired-copy">
                <CopyButton text={copyText} showLabel label={t('authExpired.copyUnsent')} />
              </div>
            )}
          </>
        ) : (
          <p className="vh-auth-expired-body">{t('authExpired.body')}</p>
        )}
        <div className="vh-auth-expired-actions">
          <Button variant="primary" fullWidth loading={busy || !unsent} disabled={busy || !unsent} onClick={signOut}>
            {unsent && unsent.length > 0 ? t('authExpired.discardAndSignIn') : t('authExpired.signIn')}
          </Button>
        </div>
      </div>
    </div>
  );
}
