/** Live usage is per API message; never borrow the previous persisted turn. */
import { formatTokens } from './format';

export type LiveStatusInput = {
    inputTokens?: number;
    outputTokens?: number;
    cacheTokens?: number;
    thinkingTokens?: number;
};
export type LiveTokenMetric = { kind: 'input' | 'output' | 'cache' | 'thinking'; value: string };

export function liveTokenMetrics(input: LiveStatusInput): LiveTokenMetric[] {
    const metrics: LiveTokenMetric[] = [];
    for (const [kind, count] of [
        ['input', input.inputTokens], ['output', input.outputTokens],
        ['cache', input.cacheTokens], ['thinking', input.thinkingTokens],
    ] as const) {
        if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) {
            metrics.push({ kind, value: `${kind === 'thinking' ? '≈ ' : ''}${formatTokens(count)}` });
        }
    }
    return metrics;
}
