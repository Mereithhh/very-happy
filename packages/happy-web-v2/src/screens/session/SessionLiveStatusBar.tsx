/**
 * SessionLiveStatusBar — thin status strip above the composer. Precedence:
 * permission > running tool > thinking. Shows a live elapsed timer and a
 * pulsing dot while the agent works; a warning when approval is needed.
 */
import { ChevronDown, ShieldAlert } from 'lucide-react';
import { useSession, useSessionRunningTool } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { StatusDot } from '@/ui';
import { useElapsedSeconds } from './useElapsed';
import { formatElapsed } from './format';
import './statusbar.css';

export function SessionLiveStatusBar({ sessionId, onActivate }: { sessionId: string; onActivate: () => void }) {
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
            <button
                type="button"
                className="lsb lsb--permission"
                onClick={onActivate}
                aria-label={`${t('session.chat.needsPermission')}. ${t('session.chat.jumpToLatest')}`}
                title={t('session.chat.jumpToLatest')}
            >
                <span className="lsb-content" role="status" aria-live="polite">
                    <ShieldAlert size={14} />
                    <span>{t('session.chat.needsPermission')}</span>
                </span>
                <ChevronDown className="lsb-action" size={15} aria-hidden />
            </button>
        );
    }

    const label =
        kind === 'tool'
            ? t('session.chat.runningTool', {
                name: runningTool!.name,
                seconds: formatElapsed(elapsed),
            })
            : t('session.chat.thinking', { seconds: formatElapsed(elapsed) });
    const accessibleLabel = kind === 'tool'
        ? `${runningTool!.name}. ${t('session.chat.toolRunning')}. ${t('session.chat.jumpToLatest')}`
        : `${t('session.chat.thinkingLabel')}. ${t('session.chat.jumpToLatest')}`;

    return (
        <button
            type="button"
            className="lsb lsb--live"
            onClick={onActivate}
            aria-label={accessibleLabel}
            title={t('session.chat.jumpToLatest')}
        >
            <span className="lsb-content">
                <StatusDot status="thinking" size={8} pulse />
                <span className="lsb-label">{label}</span>
            </span>
            <ChevronDown className="lsb-action" size={15} aria-hidden />
        </button>
    );
}
