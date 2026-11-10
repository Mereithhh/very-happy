import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { getPendingUpdate, subscribePendingUpdate, type PendingUpdate } from '@/app/pendingUpdate';
import { applyUpdate, checkForUpdateAfterReconnect } from '@/app/staleBundleReload';
import { apiSocket } from '@/sync/apiSocket';
import './updatePrompt.css';

/**
 * B-319: offer the update rather than performing it. Non-modal on purpose —
 * this must not stand between someone and the thing they were doing, which is
 * the whole complaint being fixed. Ignoring it is fine: the update applies
 * itself as soon as the tab goes to the background.
 *
 * B-914: it stays until it is acted on (no timeout, no dismiss) and says that
 * the refresh is what brings the release notes. Mounted only in the signed-in
 * roots, which is also where the control socket lives — so this is where a
 * reconnect turns into an immediate version check.
 */
export function UpdatePrompt() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingUpdate | null>(getPendingUpdate);
  const [applying, setApplying] = useState(false);

  useEffect(() => subscribePendingUpdate(setPending), []);
  useEffect(() => {
    // Both: a blue/green handover / restart reconnects (onReconnected); a
    // short blip the server replayed (onRecovered) cannot be a new server,
    // but checking costs one small fetch and keeps the rule simple.
    const offReconnected = apiSocket.onReconnected(() => { checkForUpdateAfterReconnect(); });
    const offRecovered = apiSocket.onRecovered(checkForUpdateAfterReconnect);
    return () => { offReconnected(); offRecovered(); };
  }, []);

  if (!pending) return null;
  return (
    <div className="vh-update-prompt" role="status">
      <span className="vh-update-prompt-text">{t('changelog.updateReady')}</span>
      <button
        type="button"
        className="vh-update-prompt-btn"
        disabled={applying}
        onClick={() => {
          setApplying(true);
          // B-328: the reload should replace this page within a moment. If it
          // has not, something upstream is wedged — give the button back rather
          // than leaving a dead control on screen, which is exactly what the
          // frozen-page report looked like.
          // B-356 raised the ceiling: applyUpdate now waits (bounded) for the
          // new service worker to take control before reloading, so the button
          // must outlast that whole handover or it flips back mid-update.
          setTimeout(() => setApplying(false), 9000);
          void applyUpdate(pending.entry);
        }}
      >
        <RefreshCw size={13} aria-hidden />
        {applying ? t('changelog.updateApplying') : t('changelog.updateApply')}
      </button>
    </div>
  );
}
