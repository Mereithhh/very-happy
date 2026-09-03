import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { getPendingUpdate, subscribePendingUpdate, type PendingUpdate } from '@/app/pendingUpdate';
import { applyUpdate } from '@/app/staleBundleReload';
import './updatePrompt.css';

/**
 * B-319: offer the update rather than performing it. Non-modal on purpose —
 * this must not stand between someone and the thing they were doing, which is
 * the whole complaint being fixed. Ignoring it is fine: the update applies
 * itself as soon as the tab goes to the background.
 */
export function UpdatePrompt() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingUpdate | null>(getPendingUpdate);
  const [applying, setApplying] = useState(false);

  useEffect(() => subscribePendingUpdate(setPending), []);

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
          setTimeout(() => setApplying(false), 6000);
          void applyUpdate(pending.entry);
        }}
      >
        <RefreshCw size={13} aria-hidden />
        {applying ? t('changelog.updateApplying') : t('changelog.updateApply')}
      </button>
    </div>
  );
}
