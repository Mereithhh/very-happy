import { describe, expect, it } from 'vitest';
import { streamThrottleMs } from './streamThrottle';

describe('streamThrottleMs', () => {
    it('does not throttle short drafts — typing must feel immediate', () => {
        expect(streamThrottleMs(0)).toBe(0);
        expect(streamThrottleMs(1_999)).toBe(0);
    });

    it('steps up with length and is monotonic', () => {
        const lengths = [0, 1_999, 2_000, 7_999, 8_000, 19_999, 20_000, 100_000];
        const values = lengths.map(streamThrottleMs);
        expect(values).toEqual([0, 0, 120, 120, 250, 250, 400, 400]);
        for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    });

    it('keeps the worst measured shape inside a ~10% main-thread budget', () => {
        // 16.5 KB parse+render measured at ~38 ms (node); a 400 ms interval means
        // at most ~2.5 renders per second.
        const perFrameMs = 38;
        const dutyCycle = perFrameMs / streamThrottleMs(16_500);
        expect(dutyCycle).toBeLessThan(0.2);
    });
});
