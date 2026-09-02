import { describe, expect, it } from 'vitest';
import { calculateCost, PRICING, resolvePricingKey } from './pricing';

describe('pricing.resolvePricingKey', () => {
    it('maps exact Claude 5 family ids and their 1M variants', () => {
        expect(resolvePricingKey('claude-fable-5-1')).toBe('claude-fable-5-1');
        expect(resolvePricingKey('claude-fable-5-1[1m]')).toBe('claude-fable-5-1');
        expect(resolvePricingKey('claude-opus-5[1m]')).toBe('claude-opus-5');
        expect(resolvePricingKey('claude-sonnet-5')).toBe('claude-sonnet-5');
        expect(resolvePricingKey('claude-haiku-4-5')).toBe('claude-haiku-4-5');
    });

    it('maps Claude Code aliases to the model they currently resolve to', () => {
        expect(resolvePricingKey('fable')).toBe('claude-fable-5-1');
        expect(resolvePricingKey('fable[1m]')).toBe('claude-fable-5-1');
        expect(resolvePricingKey('opus')).toBe('claude-opus-5');
        expect(resolvePricingKey('sonnet')).toBe('claude-sonnet-5');
        expect(resolvePricingKey('haiku')).toBe('claude-haiku-4-5');
        expect(resolvePricingKey('opusplan')).toBe('claude-opus-5');
    });

    it('handles dated snapshots, dotted versions and provider prefixes', () => {
        expect(resolvePricingKey('claude-opus-4-5-20251101')).toBe('claude-opus-4-5');
        expect(resolvePricingKey('claude-4.5-sonnet')).toBe('claude-sonnet-4-5');
        expect(resolvePricingKey('us.anthropic.claude-opus-4-8-v1:0')).toBe('claude-opus-4-8');
        expect(resolvePricingKey('claude-3-5-haiku-20241022')).toBe('claude-3-5-haiku-20241022');
        expect(resolvePricingKey('claude-3-7-sonnet-20250219')).toBe('claude-3-7-sonnet-20250219');
    });

    it('never falls back to a Claude 3 rate for an unknown modern id', () => {
        expect(resolvePricingKey('claude-fable-6')).toBe('claude-fable-5-1');
        expect(resolvePricingKey('claude-opus-6')).toBe('claude-opus-5');
        expect(resolvePricingKey(undefined)).toBe('claude-opus-5');
        expect(resolvePricingKey('something-else')).toBe('claude-opus-5');
    });
});

describe('pricing.calculateCost', () => {
    it('prices Fable 5.1 tokens at the published rates', () => {
        const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000 } as any;
        const cost = calculateCost(usage, 'claude-fable-5-1');
        expect(cost.input).toBeCloseTo(PRICING['claude-fable-5-1'].input + PRICING['claude-fable-5-1'].cache_read, 6);
        expect(cost.output).toBeCloseTo(5.0, 6);
        expect(cost.total).toBeCloseTo(cost.input + cost.output, 6);
    });
});
