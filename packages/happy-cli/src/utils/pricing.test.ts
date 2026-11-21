import { describe, expect, it } from 'vitest';
import { calculateCost, PRICING, resolvePricingKey } from './pricing';

describe('pricing.resolvePricingKey', () => {
    it('maps exact Claude 5 family ids and their 1M variants', () => {
        expect(resolvePricingKey('claude-fable-5-2')).toBe('claude-fable-5-2');
        expect(resolvePricingKey('claude-fable-5-2[1m]')).toBe('claude-fable-5-2');
        expect(resolvePricingKey('claude-fable-5-1')).toBe('claude-fable-5-1');
        expect(resolvePricingKey('claude-fable-5-1[1m]')).toBe('claude-fable-5-1');
        expect(resolvePricingKey('claude-opus-5[1m]')).toBe('claude-opus-5');
        expect(resolvePricingKey('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
        expect(resolvePricingKey('claude-sonnet-5')).toBe('claude-sonnet-5');
        expect(resolvePricingKey('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
        expect(resolvePricingKey('claude-sonnet-5-5[1m]')).toBe('claude-sonnet-5-5');
        expect(resolvePricingKey('claude-haiku-5-5')).toBe('claude-haiku-5-5');
        expect(resolvePricingKey('claude-haiku-4-5')).toBe('claude-haiku-4-5');
    });

    it('maps Claude Code aliases to the model they currently resolve to', () => {
        expect(resolvePricingKey('fable')).toBe('claude-fable-5-2');
        expect(resolvePricingKey('fable[1m]')).toBe('claude-fable-5-2');
        expect(resolvePricingKey('opus')).toBe('claude-opus-5-5');
        // B-949: Claude Code 2.1.330 — sonnet → Sonnet 5.5, haiku → Haiku 5.5.
        expect(resolvePricingKey('sonnet')).toBe('claude-sonnet-5-5');
        expect(resolvePricingKey('sonnet[1m]')).toBe('claude-sonnet-5-5');
        expect(resolvePricingKey('haiku')).toBe('claude-haiku-5-5');
        expect(resolvePricingKey('opusplan')).toBe('claude-opus-5-5');
    });

    it('handles dated snapshots, dotted versions and provider prefixes', () => {
        expect(resolvePricingKey('claude-opus-4-5-20251101')).toBe('claude-opus-4-5');
        expect(resolvePricingKey('claude-4.5-sonnet')).toBe('claude-sonnet-4-5');
        expect(resolvePricingKey('us.anthropic.claude-opus-4-8-v1:0')).toBe('claude-opus-4-8');
        expect(resolvePricingKey('claude-3-5-haiku-20241022')).toBe('claude-3-5-haiku-20241022');
        expect(resolvePricingKey('claude-3-7-sonnet-20250219')).toBe('claude-3-7-sonnet-20250219');
    });

    it('prices the Mythos counterparts like Fable, not like Opus', () => {
        expect(resolvePricingKey('claude-mythos-5-1')).toBe('claude-mythos-5-1');
        expect(resolvePricingKey('claude-mythos-5')).toBe('claude-mythos-5');
        expect(resolvePricingKey('mythos')).toBe('claude-mythos-5-2');
        expect(resolvePricingKey('claude-mythos-5-2')).toBe('claude-mythos-5-2');
        expect(PRICING['claude-mythos-5-1']).toEqual(PRICING['claude-fable-5-1']);
        expect(PRICING['claude-mythos-5-2']).toEqual(PRICING['claude-fable-5-2']);
        expect(PRICING['claude-mythos-5'].input).toBe(10.0);
    });

    it('never falls back to a Claude 3 rate for an unknown modern id', () => {
        expect(resolvePricingKey('claude-fable-6')).toBe('claude-fable-5-2');
        expect(resolvePricingKey('claude-fable-3')).toBe('claude-fable-5-2');
        expect(resolvePricingKey('claude-mythos-6')).toBe('claude-mythos-5-2');
        expect(resolvePricingKey('claude-opus-6')).toBe('claude-opus-5-5');
        expect(resolvePricingKey(undefined)).toBe('claude-opus-5-5');
        expect(resolvePricingKey('something-else')).toBe('claude-opus-5-5');
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

    it('prices Fable 5.2 at its own published rates ($8 / $40 / $0.20 cache read), not 5.1\'s', () => {
        const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 } as any;
        const cost = calculateCost(usage, 'claude-fable-5-2[1m]');
        expect(cost.input).toBeCloseTo(8 + 10 + 0.2, 6);
        expect(cost.output).toBeCloseTo(40, 6);
    });

    it('prices the four current models at their published rates (B-949)', () => {
        const million = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as any;
        // $/MTok input + output
        expect(calculateCost(million, 'claude-fable-5-2').total).toBeCloseTo(8 + 40, 6);
        expect(calculateCost(million, 'claude-opus-5-5').total).toBeCloseTo(4 + 20, 6);
        expect(calculateCost(million, 'claude-sonnet-5-5').total).toBeCloseTo(2 + 10, 6);
        expect(PRICING['claude-fable-5-2'].cache_read).toBe(0.20);
        expect(PRICING['claude-opus-5-5'].cache_read).toBe(0.20);
        expect(PRICING['claude-sonnet-5-5']).toMatchObject({ cache_write: 2.5, cache_read: 0.10 });
        // Sonnet 5.5 cache reads are half of Sonnet 5's.
        expect(PRICING['claude-sonnet-5-5'].cache_read).toBeLessThan(PRICING['claude-sonnet-5'].cache_read);
    });

    it('prices Haiku 5.5 by prompt size: $0.10 / $0.50 up to 100K tokens, $0.50 / $2.50 beyond', () => {
        const short = calculateCost({ input_tokens: 60_000, output_tokens: 10_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 40_000 } as any, 'claude-haiku-5-5');
        expect(short.input).toBeCloseTo(0.06 * 0.10 + 0.04 * 0.01, 9);
        expect(short.output).toBeCloseTo(0.01 * 0.50, 9);
        // One token over the threshold moves the whole request to the long tier.
        const long = calculateCost({ input_tokens: 60_001, output_tokens: 10_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 40_000 } as any, 'haiku');
        expect(long.input).toBeCloseTo(0.060001 * 0.50 + 0.04 * 0.05, 9);
        expect(long.output).toBeCloseTo(0.01 * 2.50, 9);
        // Cache writes count toward the prompt size too.
        const viaCache = calculateCost({ input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 0 } as any, 'claude-haiku-5-5');
        expect(viaCache.input).toBeCloseTo((1 * 0.50 + 100_000 * 0.625) / 1_000_000, 9);
    });

    it('keeps a flat rate for models without a long-context tier', () => {
        const big = calculateCost({ input_tokens: 900_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as any, 'claude-sonnet-5-5[1m]');
        expect(big.input).toBeCloseTo(0.9 * 2, 6);
    });
});
