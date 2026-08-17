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

/*
 * 上下文百分比刻意**不在这里**：分母必须按真实生效的模型走，见
 * `./contextWindow.ts`（B-135——原来这里写死 190_000，对 1M 模型直接钉死在
 * 「剩余 0%」）。别再往这个文件加写死的窗口常量。
 */
