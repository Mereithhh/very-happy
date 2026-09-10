import { isTerminalToolName } from '@/utils/toolDisplay';
import { memo } from 'react';
import { ArrowUp, ArrowDown, Brain, Zap } from 'lucide-react';
import { useSession, useSessionRunningTool } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { isAgentWorkLive } from '@/sync/agentLiveness';
import { useLiveStreamProgress } from '@/sync/liveStreamStore';
import { useElapsedSeconds } from './useElapsed';
import { formatElapsed } from './format';
import { liveTokenMetrics, type LiveTokenMetric } from './liveStatus';
import './statusbar.css';
import { useHeartbeatFresh } from '@/sync/heartbeatLease';

/** CSS-only activity: orbit + breathing core; never a completion percentage. */
export function LiveActivityMark() {
    return <span className="lsb-mark" aria-hidden="true">
        <svg className="lsb-orbit" viewBox="0 0 28 28" fill="none">
            <circle className="lsb-track" cx="14" cy="14" r="11" />
            <circle className="lsb-sweep" cx="14" cy="14" r="11" />
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
        : phase === 'tool' ? t('session.chat.liveExecutingTool', { tool: isTerminalToolName(runningTool!.name) ? 'Bash' : runningTool!.name })
        : phase === 'requesting' ? t('session.chat.liveRequesting')
        : t('session.chat.liveProcessing');
    return <LiveStatusRow phase={phase} label={label} elapsed={elapsed} metrics={metrics} />;
});

/** Passive progress, never a disclosure. Shared by the real chat and visual fixtures. */
export function LiveStatusRow({ phase, label, elapsed, metrics }: {
    phase: 'tool' | 'thinking' | 'working' | 'requesting' | 'compacting';
    label: string;
    elapsed: number;
    metrics: LiveTokenMetric[];
}) {
    const { t } = useTranslation();
    const names = {
        input: t('session.chat.liveInputTokens'),
        output: t('session.chat.liveOutputTokens'),
        cache: t('session.chat.liveCacheTokens'),
        thinking: t('session.chat.liveThinkingTokens'),
    };
    const icons = { input: ArrowUp, output: ArrowDown, cache: Zap, thinking: Brain };
    // Show reported input/output directly; estimates remain separate and are
    // never added to exact usage. Older runners may only report thinking/cache.
    const usage = metrics.filter(metric => metric.kind === 'input' || metric.kind === 'output');
    const visibleMetrics = usage.length > 0 ? usage : metrics;
    const usageDescription = metrics.map(metric => `${names[metric.kind]}: ${metric.value}`).join(' · ');

    return <div className="lsb" data-phase={phase}>
        <div className="lsb-content">
            <LiveActivityMark />
            <span className="lsb-label" role="status" aria-live="polite" title={label}>{label}</span>
            <span className="lsb-separator" aria-hidden="true">·</span>
            <span className="lsb-elapsed">{formatElapsed(elapsed)}</span>
            {visibleMetrics.length > 0 && <>
                <span className="lsb-separator" aria-hidden="true">·</span>
                <span className="lsb-metrics" title={usageDescription} aria-label={usageDescription}>
                    {visibleMetrics.map(({ kind, value }) => {
                        const Icon = icons[kind];
                        return <span className="lsb-metric" key={kind} aria-label={`${names[kind]}: ${value}`}>
                            <Icon size={12} aria-hidden="true" />
                            <span>{value}</span>
                        </span>;
                    })}
                </span>
            </>}
        </div>
    </div>;
}
