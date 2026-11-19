/**
 * B-942 OversizeSkippedBanner — strip under the chat header when the server
 * skipped records from this session's process for being over its per-message
 * limit (`session.oversizeSkipped`, a running total). The server cannot write a
 * visible message into an end-to-end encrypted transcript, so this strip is how
 * the reader learns that something is missing. Hiding it is remembered per
 * count: a new skip shows it again.
 */
import { useState } from 'react';
import { FileWarning, X } from 'lucide-react';
import { useSession } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import './mirror.css';

const HIDDEN_KEY = (sessionId: string) => `vh.oversizeSkipped.hidden.${sessionId}`;

function readHidden(sessionId: string): number {
    try { return Number(localStorage.getItem(HIDDEN_KEY(sessionId))) || 0; } catch { return 0; }
}

export function OversizeSkippedBanner({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const count = useSession(sessionId)?.oversizeSkipped ?? 0;
    const [hidden, setHidden] = useState(() => readHidden(sessionId));
    if (count <= 0 || hidden >= count) return null;
    const hide = () => {
        setHidden(count);
        try { localStorage.setItem(HIDDEN_KEY(sessionId), String(count)); } catch { /* per-device convenience only */ }
    };
    return (
        <div className="mrb" data-testid="oversize-skipped-banner" data-kind="oversize-skipped">
            <div className="mrb-note" role="status">
                <FileWarning size={13} />
                <span className="mrb-note-text">{t('session.chat.oversizeSkipped', { count })}</span>
                <button type="button" className="mrb-dismiss" onClick={hide} aria-label={t('session.chat.oversizeSkippedDismiss')} title={t('session.chat.oversizeSkippedDismiss')}>
                    <X size={13} />
                </button>
            </div>
        </div>
    );
}
