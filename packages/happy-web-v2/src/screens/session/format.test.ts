import { describe, expect, it } from 'vitest';
import { formatCost, hasDisplayableCost } from './format';

describe('hasDisplayableCost', () => {
    // B-299: a failed turn bills nothing, and `$0.0000` next to the error read as
    // if a zero cost were a result worth reporting.
    it('drops a cost that would print as $0.0000', () => {
        expect(hasDisplayableCost(0)).toBe(false);
        expect(hasDisplayableCost(0.00001)).toBe(false);
        expect(hasDisplayableCost(0.000049)).toBe(false);
    });

    it('keeps the smallest cost that still prints a non-zero digit', () => {
        expect(hasDisplayableCost(0.00005)).toBe(true);
        expect(formatCost(0.00005)).toBe('$0.0001');
        expect(hasDisplayableCost(1.23)).toBe(true);
    });

    it('treats absent and non-finite values as nothing to show', () => {
        expect(hasDisplayableCost(undefined)).toBe(false);
        expect(hasDisplayableCost(null)).toBe(false);
        expect(hasDisplayableCost(Number.NaN)).toBe(false);
        expect(hasDisplayableCost(Number.POSITIVE_INFINITY)).toBe(false);
    });
});
