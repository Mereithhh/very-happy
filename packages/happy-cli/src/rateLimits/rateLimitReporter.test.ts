import { describe, expect, it, vi } from 'vitest';
import { createRateLimitReporter } from './rateLimitReporter';
import { RATE_LIMIT_OBSERVED_REFRESH_MS } from './rateLimitWindows';

const T0 = 1_791_800_000_000;
const frame = (utilization: number) => ({
    status: 'allowed',
    unifiedWindows: { five_hour: { utilization, resetsAt: 1791826800 } },
});

describe('createRateLimitReporter (B-555)', () => {
    it('forwards a change, drops an identical repeat, re-sends after the refresh interval', () => {
        let now = T0;
        const send = vi.fn();
        const reporter = createRateLimitReporter(send, () => now);
        reporter.observeClaude(frame(0.1));
        reporter.observeClaude(frame(0.1));
        expect(send).toHaveBeenCalledTimes(1);
        reporter.observeClaude(frame(0.2));
        expect(send).toHaveBeenCalledTimes(2);
        now += RATE_LIMIT_OBSERVED_REFRESH_MS;
        reporter.observeClaude(frame(0.2));
        expect(send).toHaveBeenCalledTimes(3);
        expect(send.mock.calls[0][0]).toMatchObject({ provider: 'claude', windows: [{ kind: 'five_hour', usedPercent: 10 }] });
    });

    it('dedupes per provider and ignores unusable frames', () => {
        const send = vi.fn();
        const reporter = createRateLimitReporter(send, () => T0);
        reporter.observeClaude({ status: 'allowed' });
        reporter.observeCodex({ limitId: 'codex', primary: null, secondary: null });
        expect(send).not.toHaveBeenCalled();
        reporter.observeClaude(frame(0.5));
        reporter.observeCodex({ primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1791826800 } });
        expect(send.mock.calls.map((c) => c[0].provider)).toEqual(['claude', 'codex']);
    });

    it('never throws when the sender does', () => {
        const reporter = createRateLimitReporter(() => { throw new Error('boom'); }, () => T0);
        expect(() => reporter.observeClaude(frame(0.3))).not.toThrow();
    });
});
