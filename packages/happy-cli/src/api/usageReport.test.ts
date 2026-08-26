import { describe, expect, it } from 'vitest';
import { normalizeAgentUsage, usageAgentKey } from './usageReport';

describe('normalizeAgentUsage', () => {
    it('normalizes the Codex app-server cumulative shape without double-counting cache', () => {
        expect(normalizeAgentUsage({
            total: {
                totalTokens: 140, inputTokens: 100, cachedInputTokens: 60,
                cacheWriteInputTokens: 4, outputTokens: 40, reasoningOutputTokens: 10,
            },
            last: { totalTokens: 5 },
            modelContextWindow: 200_000,
        })).toEqual({ total: 140, input: 100, output: 40, cache_creation: 4, cache_read: 60, reasoning: 10 });
    });

    it('normalizes ACP snake_case usage and derives a total', () => {
        expect(normalizeAgentUsage({ type: 'token-count', input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 8 }))
            .toEqual({ total: 15, input: 12, output: 3, cache_read: 8 });
    });

    it('normalizes the official ACP PromptResponse usage shape', () => {
        expect(normalizeAgentUsage({
            totalTokens: 30,
            inputTokens: 20,
            outputTokens: 5,
            cachedReadTokens: 3,
            cachedWriteTokens: 1,
            thoughtTokens: 1,
        })).toEqual({ total: 30, input: 20, output: 5, cache_creation: 1, cache_read: 3, reasoning: 1 });
    });

    it('normalizes an OpenClaw sessions.list snapshot', () => {
        expect(normalizeAgentUsage({ inputTokens: 90, outputTokens: 10, totalTokens: 100 }))
            .toEqual({ total: 100, input: 90, output: 10 });
    });

    it('rejects unknown, negative and non-finite usage', () => {
        expect(normalizeAgentUsage({ prompt: 12 })).toBeNull();
        expect(normalizeAgentUsage({ total_tokens: -1 })).toBeNull();
        expect(normalizeAgentUsage({ total_tokens: Number.POSITIVE_INFINITY })).toBeNull();
    });
});

it('creates a key-safe agent slug', () => {
    expect(usageAgentKey('My ACP / Agent')).toBe('my-acp-agent');
    expect(usageAgentKey('***')).toBe('unknown');
});
