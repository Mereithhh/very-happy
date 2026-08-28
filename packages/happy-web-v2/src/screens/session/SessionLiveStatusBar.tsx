/**
 * SessionLiveStatusBar — compact live activity indicator in the transcript
 * area. Permission requests have their own actionable PermissionCard.
 */
import { useSession, useSessionRunningTool } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { StatusDot } from '@/ui';
import { useElapsedSeconds } from './useElapsed';
import { formatElapsed } from './format';
import './statusbar.css';

export function SessionLiveStatusBar({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const runningTool = useSessionRunningTool(sessionId);

    const isThinking = session?.thinking === true;

    const kind: 'tool' | 'thinking' | null = runningTool
            ? 'tool'
            : isThinking
                ? 'thinking'
                : null;

    const anchor =
        kind === 'tool' ? runningTool!.startedAt : kind === 'thinking' ? session?.thinkingStartedAt ?? null : null;
    const elapsed = useElapsedSeconds(anchor);

    if (!kind) return null;

    const label =
        kind === 'tool'
            ? t('session.chat.runningTool', {
                name: runningTool!.name,
                seconds: formatElapsed(elapsed),
            })
            : t('session.chat.thinking', { seconds: formatElapsed(elapsed) });
    return (
        <div className="lsb" role="status" aria-live="polite">
            <span className="lsb-content">
                <StatusDot status="thinking" size={8} pulse />
                <span className="lsb-label">{label}</span>
            </span>
        </div>
    );
}
