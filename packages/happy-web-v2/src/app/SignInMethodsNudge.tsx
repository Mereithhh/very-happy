import { useEffect, useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { loadAccountLoginMethods, loadPublicAuthConfig, type AccountLoginMethods } from '@/auth/cloudAuth';
import { useLocalSettingMutable } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { SIGN_IN_METHODS_NUDGE_HINT, shouldShowSignInMethodsNudge } from './signInMethodsNudgePolicy';
import './signInMethodsNudge.css';
import './floatingCards.css';
import { OVERLAY_PRIORITY, useOverlayHeldAbove } from './overlayQueue';

/**
 * B-668: a non-blocking card for accounts that can sign in with email codes
 * only. It points at Settings → Account (password / Google) so switching
 * devices stops spending the address's daily code budget. Placement follows
 * the other floating onboarding cards (floatingCards.css).
 */
export function SignInMethodsNudge() {
  const { credentials } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const inSettings = pathname.startsWith('/settings');
  const [dismissedHints, setDismissedHints] = useLocalSettingMutable('dismissedHints');
  const [methods, setMethods] = useState<AccountLoginMethods | null>(null);
  const [offers, setOffers] = useState({ password: false, google: false });
  // B-831: like the install / notification cards — stand down (not dismissed)
  // while a dialog above notice level holds the overlay turn.
  const deferred = useOverlayHeldAbove(OVERLAY_PRIORITY.notice);

  // Re-read on leaving Settings, so a password or Google link made there
  // removes the card without a reload.
  useEffect(() => {
    if (!credentials || inSettings) return;
    let cancelled = false;
    void Promise.all([loadAccountLoginMethods(credentials), loadPublicAuthConfig()]).then(([loaded, config]) => {
      if (cancelled) return;
      setMethods(loaded);
      setOffers({ password: config?.passwordLoginEnabled !== false, google: !!config?.googleClientId });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [credentials, inSettings]);

  const visible = shouldShowSignInMethodsNudge({
    methods,
    passwordLoginEnabled: offers.password,
    googleLoginEnabled: offers.google,
    dismissedAt: dismissedHints[SIGN_IN_METHODS_NUDGE_HINT],
    pathname,
  });
  if (!visible || deferred) return null;

  const dismiss = () => setDismissedHints({ ...dismissedHints, [SIGN_IN_METHODS_NUDGE_HINT]: Date.now() });

  return (
    <aside className="signin-nudge" role="region" aria-labelledby="signin-nudge-title" aria-describedby="signin-nudge-body">
      <button className="signin-nudge__close" type="button" onClick={dismiss} aria-label={t('signInNudge.later')}>
        <X size={16} />
      </button>
      <div className="signin-nudge__head">
        <KeyRound size={16} aria-hidden />
        <h2 id="signin-nudge-title">{t('signInNudge.title')}</h2>
      </div>
      <p id="signin-nudge-body">{t('signInNudge.body')}</p>
      <div className="signin-nudge__actions">
        <button className="signin-nudge__primary" type="button" onClick={() => navigate('/settings/account')}>{t('signInNudge.setUp')}</button>
        <button className="signin-nudge__later" type="button" onClick={dismiss}>{t('signInNudge.later')}</button>
      </div>
    </aside>
  );
}
