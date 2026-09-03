/** Shared formatting helpers for the chat screen. */

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

/**
 * B-299: the smallest cost `formatCost` can print without rounding to `$0.0000`.
 * Anything below it renders as a row of zeros that tells the reader nothing, so
 * the chip is omitted instead. The case that made this visible is a failed turn
 * — an authentication failure never bills — where `$0.0000` sat next to the
 * error as if it were a result worth reporting.
 */
export const MIN_DISPLAYED_COST_USD = 0.00005;

export function hasDisplayableCost(usd: number | null | undefined): usd is number {
    return typeof usd === 'number' && Number.isFinite(usd) && usd >= MIN_DISPLAYED_COST_USD;
}

/*
 * 上下文百分比刻意**不在这里**：分母必须按真实生效的模型走，见
 * `./contextWindow.ts`（B-135——原来这里写死 190_000，对 1M 模型直接钉死在
 * 「剩余 0%」）。别再往这个文件加写死的窗口常量。
 */
