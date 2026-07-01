/**
 * SessionLiveStatusBar — thin status strip above the composer. Precedence:
 * permission > running tool > thinking. Shows a live elapsed timer and a
 * pulsing dot while the agent works; a warning when approval is needed.
 */
import { ShieldAlert } from 'lucide-react';
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

    const hasPermission =
        !!session?.agentState?.requests && Object.keys(session.agentState.requests).length > 0;
    const isThinking = session?.thinking === true;

    const kind: 'permission' | 'tool' | 'thinking' | null = hasPermission
        ? 'permission'
        : runningTool
            ? 'tool'
            : isThinking
                ? 'thinking'
                : null;

    const anchor =
        kind === 'tool' ? runningTool!.startedAt : kind === 'thinking' ? session?.thinkingStartedAt ?? null : null;
    const elapsed = useElapsedSeconds(anchor);

    if (!kind) return null;

    if (kind === 'permission') {
        return (
            <div className="lsb lsb--permission" role="status">
                <ShieldAlert size={14} />
                <span>{t('session.chat.needsPermission' as any)}</span>
            </div>
        );
    }

    const label =
        kind === 'tool'
            ? t('session.chat.runningTool' as any, {
                name: runningTool!.name,
                seconds: formatElapsed(elapsed),
            })
            : t('session.chat.thinking' as any, { seconds: formatElapsed(elapsed) });

    return (
        <div className="lsb lsb--live" role="status" aria-live="polite">
            <StatusDot status="thinking" size={8} pulse />
            <span className="lsb-label">{label}</span>
        </div>
    );
}
