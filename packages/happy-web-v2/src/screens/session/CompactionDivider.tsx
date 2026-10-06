import { AlertTriangle } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui';
import type { CompactionSummary } from './compaction';
import { useElapsedSeconds } from './useElapsed';
import './compaction.css';

/**
 * B-540: a `/compact` turn as one boundary line across the transcript —
 * the shape Claude Code（「Conversation compacted」）, Codex and Cursor use.
 * Everything above it is still readable here, but the model only keeps the
 * summary; the tooltip says so.
 */
export function CompactionDivider({ state, startedAt, durationSeconds, error }: CompactionSummary) {
    const { t } = useTranslation();
    const elapsed = useElapsedSeconds(state === 'running' ? startedAt ?? null : null);
    const seconds = state === 'running' ? elapsed : durationSeconds;
    const label = state === 'running' ? t('session.chat.compactionRunning')
        : state === 'done' ? t('session.chat.compactionDone')
        : state === 'failed' ? (error ? t('session.chat.compactionFailedWith', { error }) : t('session.chat.compactionFailed'))
        : t('session.chat.compactionInterrupted');
    return (
        <div className={`msg-compaction msg-compaction--${state}`}
            title={state === 'done' ? t('session.chat.compactionHint') : undefined}>
            <span className="msg-compaction-label">
                {state === 'running' && <Spinner size={11} />}
                {state === 'failed' && <AlertTriangle size={13} aria-hidden />}
                <span className="msg-compaction-text">{label}</span>
                {seconds !== undefined && state !== 'failed' && (
                    <span className="msg-compaction-time">{t('session.chat.activityElapsed', { seconds })}</span>
                )}
            </span>
        </div>
    );
}
