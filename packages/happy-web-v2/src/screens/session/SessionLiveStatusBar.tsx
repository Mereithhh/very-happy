import { memo } from 'react';
import { ArrowUp, ArrowDown, Brain, Zap } from 'lucide-react';
import { useSession, useSessionRunningTool } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { isAgentWorkLive } from '@/sync/agentLiveness';
import { useLiveStreamProgress } from '@/sync/liveStreamStore';
import { useElapsedSeconds } from './useElapsed';
import { formatElapsed } from './format';
import { liveTokenMetrics } from './liveStatus';
import './statusbar.css';
import { useHeartbeatFresh } from '@/sync/heartbeatLease';

/** CSS-only activity: orbit + breathing core; never a completion percentage. */
export function LiveActivityMark() {
    return <span className="lsb-mark" aria-hidden="true">
        <svg className="lsb-orbit" viewBox="0 0 28 28" fill="none">
            <circle className="lsb-track" cx="14" cy="14" r="11" />
            <circle className="lsb-sweep" cx="14" cy="14" r="11" />
        </svg>
        <svg className="lsb-orbit lsb-orbit--inner" viewBox="0 0 28 28" fill="none">
            <circle className="lsb-sweep" cx="14" cy="14" r="7" />
        </svg>
        <span className="lsb-core" />
    </span>;
}

export const SessionLiveStatusBar = memo(function SessionLiveStatusBar({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const runningTool = useSessionRunningTool(sessionId);
    // Only the progress: its identity survives delta frames, so the bar
    // re-renders on real progress changes rather than ~12 times a second.
    const progress = useLiveStreamProgress(sessionId);

    // B-295: `runningTool` is last-known transcript state and never closes
    // itself after a wrapper restart, so it may not vote on its own — the
    // session's own keepAlive decides whether anything is live at all
    // (sync/agentLiveness.ts). Sub-agents don't reach this bar: their Task
    // tool_result already landed, so `runningTool` is null for them.
    // B-322: thinking 是租约不是闩锁（sync/heartbeatLease.ts）。
    const leaseFresh = useHeartbeatFresh(sessionId);
    const agentLive = isAgentWorkLive({
        presence: session?.presence,
        thinking: session?.thinking,
        runningSubagentsInTurn: 0,
        heartbeatFresh: leaseFresh,
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

    const metrics = liveTokenMetrics({
        inputTokens: progress.inputTokens,
        outputTokens: progress.outputTokens,
        cacheTokens: progress.cacheTokens,
        thinkingTokens: progress.thinkingTokens,
    });
    const phase = progress.status === 'compacting' ? 'compacting'
        : kind === 'tool' ? 'tool'
        : progress.status === 'requesting' ? 'requesting'
        : 'working';
    const label = phase === 'compacting' ? t('session.chat.liveCompacting')
        : phase === 'tool' ? runningTool!.name
        : phase === 'requesting' ? t('session.chat.liveRequesting')
        : t('session.chat.liveProcessing');
    const names = {
        input: t('session.chat.liveInputTokens'),
        output: t('session.chat.liveOutputTokens'),
        cache: t('session.chat.liveCacheTokens'),
        thinking: t('session.chat.liveThinkingTokens'),
    };
    const icons = { input: ArrowUp, output: ArrowDown, cache: Zap, thinking: Brain };

    const metricNode = ({ kind: metric, value }: (typeof metrics)[number]) => {
        const Icon = icons[metric];
        return <span className="lsb-metric" key={metric} title={names[metric]} aria-label={`${names[metric]}: ${value}`}>
            <Icon size={12} aria-hidden="true" />
            <span>{value}</span>
        </span>;
    };

    return (
        <details className="lsb" data-phase={phase}>
            <summary className="lsb-content">
                <LiveActivityMark />
                <span className="lsb-label" role="status" aria-live="polite" title={label}>{label}</span>
                <span className="lsb-elapsed">{formatElapsed(elapsed)}</span>
                <span className="lsb-counts">{metrics.filter(m => m.kind === 'input' || m.kind === 'output').map(metricNode)}</span>
            </summary>
            <div className="lsb-details">
                <strong>{label}</strong>
                <span className="lsb-elapsed">{formatElapsed(elapsed)}</span>
                {metrics.length > 0 && <div className="lsb-metrics">
                    {metrics.map(metric => <div className="lsb-detail-row" key={metric.kind}>
                        <span>{names[metric.kind]}</span>{metricNode(metric)}
                    </div>)}
                </div>}
            </div>
        </details>
    );
});
