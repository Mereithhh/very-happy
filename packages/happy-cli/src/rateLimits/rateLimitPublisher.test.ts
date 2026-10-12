import { describe, expect, it, vi } from 'vitest';
import { RateLimitPublisher } from './rateLimitPublisher';
import { mergeRateLimitReports, RATE_LIMIT_OBSERVED_REFRESH_MS, type RateLimitReport } from './rateLimitWindows';

const T0 = 1_791_800_000_000;

function report(usedPercent: number, observedAt: number): RateLimitReport {
    return { provider: 'claude', observedAt, windows: [{ kind: 'five_hour', usedPercent, resetsAt: T0 + 5 * 3_600_000, observedAt }] };
}

function harness(opts?: { writeResult?: boolean }) {
    let now = T0;
    let stored: unknown;
    const timers: Array<{ fn: () => void; at: number }> = [];
    const write = vi.fn(async (reports: RateLimitReport[]) => {
        if (opts?.writeResult === false) return false;
        stored = mergeRateLimitReports(stored, reports, now);
        return true;
    });
    const publisher = new RateLimitPublisher({
        getCurrent: () => stored,
        write,
        now: () => now,
        minIntervalMs: 60_000,
        setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t as unknown as ReturnType<typeof setTimeout>; },
        clearTimer: (h) => { const i = timers.indexOf(h as unknown as { fn: () => void; at: number }); if (i >= 0) timers.splice(i, 1); },
    });
    const advance = async (ms: number) => {
        now += ms;
        for (;;) {
            const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            timers.splice(timers.indexOf(due), 1);
            due.fn();
            await new Promise((r) => setTimeout(r, 0));
        }
    };
    return { publisher, write, advance, get now() { return now; }, get stored() { return stored as any; }, timers };
}

describe('RateLimitPublisher (B-555)', () => {
    it('writes the first report immediately, then coalesces bursts into one trailing write per interval', async () => {
        const h = harness();
        h.publisher.report(report(10, h.now));
        await h.advance(0);
        expect(h.write).toHaveBeenCalledTimes(1);

        h.publisher.report(report(11, h.now + 1));
        h.publisher.report(report(12, h.now + 2));
        h.publisher.report(report(13, h.now + 3));
        await h.advance(30_000);
        expect(h.write).toHaveBeenCalledTimes(1);
        await h.advance(30_000);
        expect(h.write).toHaveBeenCalledTimes(2);
        expect(h.stored.providers.claude.windows[0].usedPercent).toBe(13);
    });

    it('skips the write when nothing visible changed', async () => {
        const h = harness();
        h.publisher.report(report(10, h.now));
        await h.advance(0);
        h.publisher.report(report(10.3, h.now + 5));
        await h.advance(120_000);
        expect(h.write).toHaveBeenCalledTimes(1);
        h.publisher.report(report(10, h.now + RATE_LIMIT_OBSERVED_REFRESH_MS));
        await h.advance(RATE_LIMIT_OBSERVED_REFRESH_MS);
        expect(h.write).toHaveBeenCalledTimes(2);
    });

    it('keeps reports when the write could not happen (socket down) and retries after the interval', async () => {
        const h = harness({ writeResult: false });
        h.publisher.report(report(10, h.now));
        await h.advance(0);
        expect(h.write).toHaveBeenCalledTimes(1);
        await h.advance(60_000);
        expect(h.write).toHaveBeenCalledTimes(2);
        expect(h.write.mock.calls[1][0][0].windows[0].usedPercent).toBe(10);
    });

    it('stop() cancels pending timers and ignores later reports', async () => {
        const h = harness();
        h.publisher.report(report(10, h.now));
        h.publisher.stop();
        await h.advance(120_000);
        h.publisher.report(report(20, h.now));
        await h.advance(120_000);
        expect(h.write).not.toHaveBeenCalled();
        expect(h.timers).toHaveLength(0);
    });
});
