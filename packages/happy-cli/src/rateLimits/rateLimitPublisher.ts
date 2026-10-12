/**
 * B-555 daemon side: collect wrapper reports and write `daemonState.rateLimits`
 * at most once per {@link RATE_LIMIT_MIN_WRITE_INTERVAL_MS}, only when
 * {@link planRateLimitWrite} says the value changed. Every daemonState write
 * re-ships the whole state (terminal list included) and counts against the
 * B-307 state quota, so several busy sessions must not turn into a write each.
 */
import { planRateLimitWrite, type RateLimitReport } from './rateLimitWindows';

export const RATE_LIMIT_MIN_WRITE_INTERVAL_MS = 60_000;
const MAX_PENDING_REPORTS = 16;

type TimerHandle = ReturnType<typeof setTimeout>;

export type RateLimitPublisherDeps = {
    /** The currently stored `daemonState.rateLimits` (any shape). */
    getCurrent: () => unknown;
    /** Perform the write (merging `reports` into the freshest state); false = not written, retry later. */
    write: (reports: RateLimitReport[]) => Promise<boolean>;
    now?: () => number;
    minIntervalMs?: number;
    setTimer?: (fn: () => void, ms: number) => TimerHandle;
    clearTimer?: (handle: TimerHandle) => void;
};

export class RateLimitPublisher {
    private pending: RateLimitReport[] = [];
    private timer: TimerHandle | null = null;
    private writing = false;
    private lastWriteAt = 0;
    private stopped = false;
    private readonly now: () => number;
    private readonly minIntervalMs: number;
    private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
    private readonly clearTimer: (handle: TimerHandle) => void;

    constructor(private readonly deps: RateLimitPublisherDeps) {
        this.now = deps.now ?? Date.now;
        this.minIntervalMs = deps.minIntervalMs ?? RATE_LIMIT_MIN_WRITE_INTERVAL_MS;
        this.setTimer = deps.setTimer ?? ((fn, ms) => {
            const handle = setTimeout(fn, ms);
            (handle as { unref?: () => void }).unref?.();
            return handle;
        });
        this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
    }

    report(report: RateLimitReport): void {
        if (this.stopped) return;
        this.pending.push(report);
        if (this.pending.length > MAX_PENDING_REPORTS) {
            this.pending.splice(0, this.pending.length - MAX_PENDING_REPORTS);
        }
        this.schedule();
    }

    stop(): void {
        this.stopped = true;
        this.pending = [];
        if (this.timer) this.clearTimer(this.timer);
        this.timer = null;
    }

    private schedule(): void {
        if (this.timer || this.writing || this.stopped || this.pending.length === 0) return;
        const wait = this.lastWriteAt === 0 ? 0 : Math.max(0, this.lastWriteAt + this.minIntervalMs - this.now());
        this.timer = this.setTimer(() => {
            this.timer = null;
            void this.flush();
        }, wait);
    }

    /** Exposed for tests; normally driven by the timer. */
    async flush(): Promise<void> {
        if (this.writing || this.stopped) return;
        const reports = this.pending;
        this.pending = [];
        if (!planRateLimitWrite(this.deps.getCurrent(), reports, this.now())) return;
        this.writing = true;
        this.lastWriteAt = this.now();
        let written = false;
        try {
            written = await this.deps.write(reports);
        } catch {
            written = false;
        } finally {
            this.writing = false;
        }
        if (!written && !this.stopped) {
            // Keep the unwritten observations (newer ones first win on merge anyway).
            this.pending = [...reports, ...this.pending].slice(-MAX_PENDING_REPORTS);
        }
        this.schedule();
    }
}
