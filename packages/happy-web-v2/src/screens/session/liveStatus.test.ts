import { describe, expect, it } from 'vitest';
import { liveTokenMetrics } from './liveStatus';

describe('liveTokenMetrics', () => {
    it('omits unknown, cleared and invalid counts instead of inventing usage', () => {
        expect(liveTokenMetrics({})).toEqual([]);
        expect(liveTokenMetrics({ inputTokens: 0, outputTokens: 0, thinkingTokens: 0 })).toEqual([]);
        expect(liveTokenMetrics({ inputTokens: -1, outputTokens: Infinity, cacheTokens: NaN, thinkingTokens: 1.2 })).toEqual([]);
    });
    it('keeps input, output, cache and estimated thinking distinct', () => {
        expect(liveTokenMetrics({ inputTokens: 1200, outputTokens: 40, cacheTokens: 72000, thinkingTokens: 500 })).toEqual([
            { kind: 'input', value: '1.2k' }, { kind: 'output', value: '40' },
            { kind: 'cache', value: '72.0k' }, { kind: 'thinking', value: '≈ 500' },
        ]);
    });
    it('does not label old CLI output or thinking as input', () => {
        expect(liveTokenMetrics({ outputTokens: 42 })).toEqual([{ kind: 'output', value: '42' }]);
        expect(liveTokenMetrics({ thinkingTokens: 1200 })).toEqual([{ kind: 'thinking', value: '≈ 1.2k' }]);
    });
});
