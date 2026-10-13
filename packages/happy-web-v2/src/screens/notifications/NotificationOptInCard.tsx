/**
 * B-570 — non-blocking invitation to turn on notifications, with a preview of
 * what an alert looks like (idea from Orca NotificationOnboardingPreview, MIT).
 *
 * Shown only while the decision is open (permission 'default', not dismissed;
 * see notificationOnboarding.shouldOfferNotificationOptIn), yields to the PWA
 * install card, and is mounted inside AppLayout, i.e. only when logged in.
 *
 * iOS: requestPermission must run inside the user's tap — the click handler's
 * FIRST await is requestNotificationPermission(), whose first await is
 * Notification.requestPermission().
 */
import { Bell, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useTranslation } from '@/i18n/useTranslation';
import { usePwaInstallPromptVisible } from '@/app/pwaInstallVisibility';
import { getNotificationPermission, requestNotificationPermission } from '@/sync/webNotifications';
import { enableWebPush, isWebPushSupported } from '@/sync/webPush';
import {
  NOTIF_OPT_IN_DISMISSED_STORAGE,
  NOTIF_OPT_IN_REVEAL_MS,
  shouldOfferNotificationOptIn,
} from './notificationOnboarding';
import './notificationOptInCard.css';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(NOTIF_OPT_IN_DISMISSED_STORAGE) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(NOTIF_OPT_IN_DISMISSED_STORAGE, '1');
  } catch {
    // Storage unavailable (strict private mode): hidden for this page only.
  }
}

/** Show a local "this is what it looks like" notification; best-effort. */
async function showEnabledPreview(title: string, body: string): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'vh-test',
      data: { url: '/settings/notifications', kind: 'test', createdAt: Date.now() },
    });
  } catch {
    /* preview only */
  }
}

export function NotificationOptInCard() {
  const { t } = useTranslation();
  const { credentials } = useAuth();
  const location = useLocation();
  const installVisible = usePwaInstallPromptVisible();
  const [revealed, setRevealed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setRevealed(true), NOTIF_OPT_IN_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const offer = revealed && !hidden && shouldOfferNotificationOptIn({
    supported: isWebPushSupported(),
    permission: getNotificationPermission(),
    dismissed: readDismissed(),
    installPromptVisible: installVisible,
    onNotificationSettings: location.pathname.startsWith('/settings/notifications'),
  });
  if (!offer) return null;

  const dismiss = () => {
    writeDismissed();
    setHidden(true);
  };

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // MUST be the first await (iOS user-gesture requirement).
      const result = await requestNotificationPermission();
      if (result === 'granted') {
        if (credentials) await enableWebPush(credentials);
        void showEnabledPreview(t('notifications.optInEnabledTitle'), t('notifications.optInEnabledBody'));
      }
      // granted or denied: the decision is made, the gate never reopens.
      setHidden(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="notif-optin" role="region" aria-labelledby="notif-optin-title" aria-describedby="notif-optin-body">
      <button className="notif-optin-close" type="button" onClick={dismiss} aria-label={t('notifications.optInClose')}>
        <X size={16} />
      </button>
      <div className="notif-optin-head">
        <Bell size={16} aria-hidden />
        <h2 id="notif-optin-title">{t('notifications.optInTitle')}</h2>
      </div>
      <p id="notif-optin-body">{t('notifications.optInBody')}</p>
      {/* Decorative: the copy above is the accessible explanation. Titles are
          the real CLI push titles (sent in English), bodies are session names. */}
      <div className="notif-optin-preview" aria-hidden>
        <div className="notif-optin-preview-label">{t('notifications.optInPreviewLabel')}</div>
        <div className="notif-optin-sample">
          <img src="/icon-192.png" alt="" width={20} height={20} />
          <div className="notif-optin-sample-text">
            <div className="notif-optin-sample-title">Permission request</div>
            <div className="notif-optin-sample-body">{t('notifications.optInSampleDecision')}</div>
          </div>
        </div>
        <div className="notif-optin-sample">
          <img src="/icon-192.png" alt="" width={20} height={20} />
          <div className="notif-optin-sample-text">
            <div className="notif-optin-sample-title">It&apos;s ready!</div>
            <div className="notif-optin-sample-body">{t('notifications.optInSampleDone')}</div>
          </div>
        </div>
      </div>
      <div className="notif-optin-actions">
        <button className="notif-optin-primary" type="button" onClick={() => void enable()} disabled={busy}>
          {busy ? t('notifications.optInEnabling') : t('notifications.optInEnable')}
        </button>
        <button className="notif-optin-later" type="button" onClick={dismiss}>
          {t('notifications.optInLater')}
        </button>
      </div>
    </aside>
  );
}
