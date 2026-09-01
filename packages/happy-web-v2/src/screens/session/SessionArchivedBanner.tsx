/**
 * SessionArchivedBanner (B-265) — strip under the chat header of an ARCHIVED
 * session. Says so, offers the one action (restore in place), and narrates
 * the restore: spawning on the machine → waiting for it to come online →
 * done (the banner unmounts when the session is active again) or a reason.
 * Token discipline as MirrorBanner: bg ladder + --warn; no --accent (an
 * archived session is not live).
 */
import { useEffect, useState } from 'react';
import { Archive, RotateCcw } from 'lucide-react';
import { useSession } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui';
import { restoreSession, useRestoreState, RESTORE_SLOW_SPAWN_MS, type RestoreReason } from '@/app/sessionRestore';
import './mirror.css';

type TKey = Parameters<ReturnType<typeof useTranslation>['t']>[0];
export function restoreReasonKey(reason: RestoreReason | undefined): TKey {
    return `restore.reason.${reason ?? 'unknown'}` as TKey;
}

export function SessionArchivedBanner({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const state = useRestoreState(sessionId);
    const busy = state?.phase === 'spawning' || state?.phase === 'awaiting-online';
    // "machine not responding" hint after RESTORE_SLOW_SPAWN_MS in `spawning`.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (state?.phase !== 'spawning') return;
        const iv = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(iv);
    }, [state?.phase]);
    if (!session) return null;

    let text: string;
    if (state?.phase === 'spawning') {
        text = now - state.startedAt >= RESTORE_SLOW_SPAWN_MS ? t('restore.restoringSlow') : t('restore.restoring');
    } else if (state?.phase === 'awaiting-online') {
        text = t('restore.awaitingOnline');
    } else if (state?.phase === 'failed') {
        text = `${t('restore.failed')}: ${t(restoreReasonKey(state.reason))}${state.reason === 'unknown' && state.message ? ` (${state.message})` : ''}`;
    } else {
        text = t('restore.archivedNotice');
    }

    return (
        <div className="mrb" data-testid="session-archived-banner">
            <div className={`mrb-note${state?.phase === 'failed' ? ' mrb-note--failed' : ''}`} role="status">
                <Archive size={13} />
                <span className="mrb-note-text">{text}</span>
                <button
                    type="button"
                    className="mrb-term-btn mono"
                    onClick={() => void restoreSession(sessionId)}
                    disabled={busy}
                    aria-busy={busy}
                >
                    {busy ? <Spinner size={13} /> : <RotateCcw size={13} />}
                    <span>{t(state?.phase === 'failed' ? 'restore.retry' : 'restore.restore')}</span>
                </button>
            </div>
        </div>
    );
}
