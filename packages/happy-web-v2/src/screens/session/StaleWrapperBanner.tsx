/**
 * StaleWrapperBanner (B-462) — strip under the chat header of a LIVE session
 * whose wrapper process still runs older CLI code than the machine has
 * installed. Says which version it is on, offers the one action that fixes it
 * (restart in place, conversation kept), and can be put away.
 *
 * Rules are pure in app/staleWrapperPolicy.ts; the restart is the existing
 * B-264 `restart-session` action. Token discipline as SessionArchivedBanner:
 * the bg ladder plus --warn for the critical case; never --accent.
 */
import { X, RotateCcw, PackageOpen } from 'lucide-react';
import { storage, useSession, useLocalSettingMutable } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui';
import { restartBrokenSession, useRestartState } from '@/app/sessionRestartAction';
import { isStaleWrapperNoticeVisible, staleWrapperHintKey, staleWrapperNotice } from '@/app/staleWrapperPolicy';
import './mirror.css';

export function StaleWrapperBanner({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const machine = storage((s) => {
        const id = session?.metadata?.machineId;
        return id ? s.machines[id] : undefined;
    });
    const [dismissedHints, setDismissedHints] = useLocalSettingMutable('dismissedHints');
    const restart = useRestartState(sessionId);
    const notice = staleWrapperNotice(session, machine);
    if (!notice) return null;
    const hintKey = staleWrapperHintKey(sessionId, notice);
    // A restart in flight keeps the strip up so its progress has somewhere to
    // show, even if the user had dismissed this notice earlier.
    const busy = restart?.phase === 'spawning' || restart?.phase === 'awaiting-online';
    const failed = restart?.phase === 'failed';
    if (!busy && !failed && !isStaleWrapperNoticeVisible(hintKey, dismissedHints)) return null;

    const text = busy
        ? t('session.chat.restarting')
        : failed
            ? (restart?.reason === 'daemon-too-old' ? t('session.chat.restartDaemonTooOld') : t('session.chat.restartFailed'))
            : notice.severity === 'critical'
                ? t('staleWrapper.criticalNotice', { sessionVersion: notice.sessionVersion })
                : t('staleWrapper.behindNotice', { sessionVersion: notice.sessionVersion, machineVersion: notice.machineVersion });

    return (
        <div className="mrb" data-testid="stale-wrapper-banner" data-severity={notice.severity}>
            <div className={`mrb-note${failed ? ' mrb-note--failed' : ''}`} role="status">
                <PackageOpen size={13} />
                <span className="mrb-note-text">{text}</span>
                <button
                    type="button"
                    className="mrb-term-btn mono"
                    onClick={() => { void restartBrokenSession(sessionId); }}
                    disabled={busy}
                    aria-busy={busy}
                >
                    {busy ? <Spinner size={13} /> : <RotateCcw size={13} />}
                    <span>{t(failed ? 'restore.retry' : 'session.chat.restart')}</span>
                </button>
                <button
                    type="button"
                    className="mrb-dismiss"
                    onClick={() => setDismissedHints({ ...(dismissedHints ?? {}), [hintKey]: Date.now() })}
                    aria-label={t('staleWrapper.dismiss')}
                    title={t('staleWrapper.dismiss')}
                >
                    <X size={13} />
                </button>
            </div>
        </div>
    );
}
