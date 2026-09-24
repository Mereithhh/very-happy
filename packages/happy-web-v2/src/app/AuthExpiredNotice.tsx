import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { getAuthLatch, subscribeAuthLatch, type AuthLatchInfo } from '@/auth/authLatch';
import { persistAuthReturnTarget } from '@/app/authReturnTarget';
import { markProgrammaticReload } from '@/app/programmaticReload';
import { useTranslation } from '@/i18n/useTranslation';
import { Button } from '@/ui';
import './authExpiredNotice.css';

/**
 * B-490: the server rejected this browser's token. Background sync is already
 * stopped (auth/authLatch.ts); say so and offer the existing reauth path
 * (remember where we were → logout → login screen → back here). Blocking on
 * purpose: nothing on screen can be trusted or saved until the user signs in.
 * "Reload" covers a transient server-side auth error.
 */
export function AuthExpiredNotice() {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const location = useLocation();
  const [latch, setLatch] = useState<AuthLatchInfo | null>(getAuthLatch);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLatch(getAuthLatch());
    return subscribeAuthLatch(setLatch);
  }, []);

  if (!latch) return null;
  return (
    <div className="vh-auth-expired" role="alertdialog" aria-modal="true" aria-labelledby="vh-auth-expired-title">
      <div className="vh-auth-expired-card">
        <h2 id="vh-auth-expired-title" className="vh-auth-expired-title">{t('authExpired.title')}</h2>
        <p className="vh-auth-expired-body">{t('authExpired.body')}</p>
        <div className="vh-auth-expired-actions">
          <Button
            variant="primary"
            fullWidth
            loading={busy}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              persistAuthReturnTarget(location);
              void logout();
            }}
          >
            {t('authExpired.signIn')}
          </Button>
          <Button
            variant="ghost"
            fullWidth
            disabled={busy}
            onClick={() => {
              markProgrammaticReload();
              window.location.reload();
            }}
          >
            {t('authExpired.reload')}
          </Button>
        </div>
      </div>
    </div>
  );
}
