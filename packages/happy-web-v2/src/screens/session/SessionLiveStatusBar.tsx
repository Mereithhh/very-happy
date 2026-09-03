/**
 * SessionLiveStatusBar — the live activity indicator at the tail of the
 * transcript. Permission requests have their own actionable PermissionCard.
 *
 * B-310: this used to be a pulsing dot plus "Thinking 12s" — the only thing
 * the web could say during a turn, because the only signal it received was a
 * 2s boolean heartbeat. With the live stream channel (B-309) the CLI now
 * reports quantified progress, so the bar reads like the terminal's:
 *
 *     ✳ Cerebrating…  14s · ↑ 1.2k tokens
 *
 * Every piece degrades independently. A session driven by a CLI without the
 * streaming relay reports no tokens, and the bar falls back to exactly the
 * old elapsed-only line rather than claiming zero.
 */
import { memo, useEffect, useState } from 'react';
import { useSession, useSessionRunningTool } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { StatusDot } from '@/ui';
import { isAgentWorkLive } from '@/sync/agentLiveness';
import { useLiveStreamProgress } from '@/sync/liveStreamStore';
import { useElapsedSeconds } from './useElapsed';
import { formatElapsed } from './format';
import { liveStatusDetail, sparkFrameAt, SPARK_FRAMES, SPARK_FRAME_MS, vibingVerbAt } from './liveStatus';
import './statusbar.css';

function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The cycling glyph. Its own component so the 120ms tick re-renders eight
 * characters and nothing else — the surrounding bar re-renders once a second
 * at most.
 */
const SparkGlyph = memo(function SparkGlyph() {
    const reduced = prefersReducedMotion();
    const [frame, setFrame] = useState(() => (reduced ? SPARK_FRAMES[2] : sparkFrameAt(0)));
    useEffect(() => {
        if (reduced) return;
        const started = Date.now();
        const id = setInterval(() => setFrame(sparkFrameAt(Date.now() - started)), SPARK_FRAME_MS);
        return () => clearInterval(id);
    }, [reduced]);
    return <span className="lsb-spark" aria-hidden>{frame}</span>;
});

export const SessionLiveStatusBar = memo(function SessionLiveStatusBar({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const reducedMotion = prefersReducedMotion();
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

    const detail = liveStatusDetail(
        {
            thinkingTokens: progress.thinkingTokens,
            outputTokens: progress.outputTokens,
        },
        formatElapsed(elapsed),
    ).join(' · ');

    // Compaction is worth naming: it is the one phase where a long silence is
    // expected rather than a symptom.
    const verb = progress.status === 'compacting'
        ? t('session.chat.liveCompacting')
        // The verb steps once per window off the same elapsed clock, so it
        // never changes on an unrelated re-render. Rotation is motion: a
        // reduced-motion user gets one stable word (spec B-310).
        : reducedMotion
            ? t('session.chat.thinkingLabel')
            : vibingVerbAt(sessionId, elapsed * 1000);

    const label =
        kind === 'tool'
            ? t('session.chat.liveRunningTool', { name: runningTool!.name, detail })
            : t('session.chat.liveWorking', { verb, detail });

    return (
        <div className="lsb" role="status" aria-live="polite">
            <span className="lsb-content">
                {kind === 'thinking'
                    ? <SparkGlyph />
                    : <StatusDot status="thinking" size={8} pulse />}
                <span className="lsb-label">{label}</span>
            </span>
        </div>
    );
});
