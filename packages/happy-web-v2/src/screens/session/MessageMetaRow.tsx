/**
 * MessageMetaRow — per-turn machine metadata: token usage, model, cost, duration.
 * Rendered as mono chips below the final agent-text message of a turn.
 */
import type { MessageUsage } from '@/sync/typesMessage';
import { formatCost, formatDurationMs, formatTokens } from './format';
import './meta.css';

export function MessageMetaRow({
    usage,
    model,
    costUsd,
    totalDurationMs,
}: {
    usage?: MessageUsage;
    model?: string | null;
    costUsd?: number;
    totalDurationMs?: number;
}) {
    const cache = (usage?.cacheCreation ?? 0) + (usage?.cacheRead ?? 0);
    const hasUsage = !!usage && (usage.inputTokens > 0 || usage.outputTokens > 0 || cache > 0);
    if (!hasUsage && !model && costUsd == null && totalDurationMs == null) {
        return null;
    }

    return (
        <div className="meta-row">
            {model && <span className="meta-chip">{model}</span>}
            {hasUsage && (
                <span className="meta-chip meta-chip--mono">
                    <span className="meta-arrow">↑</span>
                    {formatTokens(usage!.inputTokens)}
                    <span className="meta-arrow">↓</span>
                    {formatTokens(usage!.outputTokens)}
                    {cache > 0 && (
                        <>
                            <span className="meta-arrow">⚡</span>
                            {formatTokens(cache)}
                        </>
                    )}
                </span>
            )}
            {costUsd != null && <span className="meta-chip meta-chip--mono">{formatCost(costUsd)}</span>}
            {totalDurationMs != null && (
                <span className="meta-chip meta-chip--mono">{formatDurationMs(totalDurationMs)}</span>
            )}
        </div>
    );
}
