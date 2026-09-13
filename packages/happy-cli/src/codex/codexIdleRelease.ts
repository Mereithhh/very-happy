/**
 * Codex idle release (B-461).
 *
 * `codex app-server` keeps `~/.codex/*.sqlite` (plus their WAL files and a
 * thread-writer lock) open for as long as it runs, and a very-happy Codex session
 * used to keep one app-server alive for the whole life of the session — hours or
 * days of idling. Anything else that needs quiet access to that CODEX_HOME (the
 * Codex App, `cc-hub.py codex repair`, …) is then blocked by a process the user
 * never sees. 2026-09-11: a smoke session idle since the previous afternoon
 * blocked a thread repair on a colleague's Mac until the whole daemon was stopped.
 *
 * Policy: when a turn finishes and nothing is queued, arm a timer. If it fires
 * and the session is still idle, drop the app-server process but keep the thread
 * id. The next message respawns app-server and `thread/resume`s the same thread,
 * so the conversation is unaffected — the only cost is one spawn + initialize +
 * resume on the first message after a long pause.
 *
 * Everything here is a pure decision + a small timer wrapper so it can be tested
 * without a real Codex.
 */

/** Idle time before the app-server is released. */
export const DEFAULT_CODEX_IDLE_RELEASE_MS = 5 * 60 * 1000;

/** Env override: milliseconds; `0` disables the release entirely. */
export const CODEX_IDLE_RELEASE_ENV = 'HAPPY_CODEX_IDLE_RELEASE_MS';

/**
 * Resolve the idle delay from the env override. Non-numeric or negative values
 * fall back to the default; `0` means "never release" (returned as 0).
 */
export function resolveCodexIdleReleaseMs(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === '') return DEFAULT_CODEX_IDLE_RELEASE_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CODEX_IDLE_RELEASE_MS;
    return Math.floor(parsed);
}

export type CodexIdleState = {
    /** A message has been dequeued and its turn has not finished yet. */
    turnActive: boolean;
    /** Messages waiting in the queue. */
    queueSize: number;
    /** The main loop is shutting down; the final cleanup owns the process. */
    shouldExit: boolean;
    /** An abort is being processed; it may restart the app-server itself. */
    abortInProgress: boolean;
};

/** True only when nothing is running, queued, aborting or exiting. */
export function shouldReleaseIdleCodex(state: CodexIdleState): boolean {
    if (state.shouldExit) return false;
    if (state.turnActive) return false;
    if (state.abortInProgress) return false;
    if (state.queueSize > 0) return false;
    return true;
}

export type CodexIdleReleaseTimerOptions = {
    /** Idle delay; `0` disables arming altogether. */
    delayMs: number;
    /** Re-checked when the timer fires — the world may have changed since arming. */
    isIdle: () => boolean;
    /** Performs the release. Errors are reported through `onError`, never thrown. */
    release: () => Promise<unknown>;
    onError?: (error: unknown) => void;
};

/**
 * Arm/cancel wrapper around a single idle timer. `arm()` always restarts the
 * countdown; `cancel()` drops it. The timer is unref'd so it never keeps the
 * wrapper process alive on its own.
 */
export class CodexIdleReleaseTimer {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private releasing: Promise<void> | null = null;

    constructor(private readonly opts: CodexIdleReleaseTimerOptions) {}

    get enabled(): boolean {
        return this.opts.delayMs > 0;
    }

    get armed(): boolean {
        return this.timer !== null;
    }

    arm(): void {
        this.cancel();
        if (!this.enabled) return;
        const timer = setTimeout(() => {
            if (this.timer !== timer) return;
            this.timer = null;
            void this.fire();
        }, this.opts.delayMs);
        timer.unref?.();
        this.timer = timer;
    }

    cancel(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** Resolves once an in-flight release (if any) has finished. Test hook. */
    async settle(): Promise<void> {
        await this.releasing;
    }

    private async fire(): Promise<void> {
        if (!this.opts.isIdle()) return;
        const run = (async () => {
            try {
                await this.opts.release();
            } catch (error) {
                this.opts.onError?.(error);
            }
        })();
        this.releasing = run;
        try {
            await run;
        } finally {
            if (this.releasing === run) this.releasing = null;
        }
    }
}
