/** Shared formatting helpers for the chat screen. */

export const MAX_CONTEXT_SIZE = 190_000;

export function formatElapsed(totalSeconds: number): string {
    if (totalSeconds < 0) totalSeconds = 0;
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function formatDurationMs(ms: number): string {
    return formatElapsed(Math.round(ms / 1000));
}

/** 1.2M / 12.3k / 412 */
export function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return `${n}`;
}

export function formatCost(usd: number): string {
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

/** Percentage of the context window used, clamped 0..100. */
export function contextPercentUsed(contextSize: number): number {
    return Math.max(0, Math.min(100, Math.round((contextSize / MAX_CONTEXT_SIZE) * 100)));
}
