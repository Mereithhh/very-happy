/**
 * SessionLiveStatusBar — compact live activity indicator in the transcript
 * area. Permission requests have their own actionable PermissionCard.
 */
import { useSession, useSessionRunningTool } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { StatusDot } from '@/ui';
import { isAgentWorkLive } from '@/sync/agentLiveness';
import { useElapsedSeconds } from './useElapsed';
import { formatElapsed } from './format';
import './statusbar.css';

export function SessionLiveStatusBar({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const runningTool = useSessionRunningTool(sessionId);

    // B-295: `runningTool` is last-known transcript state and never closes
    // itself after a wrapper restart, so it may not vote on its own — the
    // session's own keepAlive decides whether anything is live at all
    // (sync/agentLiveness.ts). Sub-agents don't reach this bar: their Task
    // tool_result already landed, so `runningTool` is null for them.
    const agentLive = isAgentWorkLive({
        presence: session?.presence,
        thinking: session?.thinking,
        runningSubagentsInTurn: 0,
    });

    const kind: 'tool' | 'thinking' | null = !agentLive
        ? null
        : runningTool
            ? 'tool'
            : 'thinking';

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
