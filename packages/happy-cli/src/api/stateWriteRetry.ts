/**
 * B-307 — how to wait when the server refuses a state write for RATE.
 *
 * The shared `utils/time.ts` backoff is `while (true)` with `maxDelay` of one
 * second and no give-up. Against a transient failure that is fine. Against an
 * account-wide rate bucket it is an amplifier: the retries arrive faster than
 * the window drains, and because every session on the account shares that
 * bucket, one stuck writer starves the others — including session CREATION,
 * which is how a single write conflict became an hour in which no terminal
 * could get its structured-view mirror (B-305).
 *
 * The server has always named the reason in the ack (`error: '<resource>_rate_
 * quota_exceeded'`); nobody read it. Now we do, and wait on a scale that
 * matches the bucket's one-minute window instead of the sub-second scale that
 * suits a dropped packet.
 *
 * Still unbounded on purpose: giving up would silently drop the newest agent
 * state, and a dropped permission request is worse than a slow one. Slow, not
 * absent, is the correct failure here.
 */

/** Every account-resource rate refusal the server can send. */
export function isRateQuotaCode(code: unknown): code is string {
    return typeof code === 'string' && code.endsWith('_rate_quota_exceeded');
}

/** First wait — already longer than the whole old backoff ladder. */
export const RATE_RETRY_MIN_DELAY_MS = 2_000;
/** Ceiling: the bucket's window is 60s, so waiting longer buys nothing. */
export const RATE_RETRY_MAX_DELAY_MS = 60_000;

/**
 * Exponential with full jitter. Jitter matters more than the curve here: when
 * a bucket refuses, it refuses every writer on the account at once, and a
 * fixed delay would march them all back in lockstep to be refused together.
 *
 * @param attempt 1 for the first refusal.
 * @param random  injected for tests; must be in [0, 1).
 */
export function rateRetryDelayMs(attempt: number, random: number = Math.random()): number {
    const exponent = Math.max(0, Math.min(attempt, 32) - 1);
    const ceiling = Math.min(RATE_RETRY_MIN_DELAY_MS * 2 ** exponent, RATE_RETRY_MAX_DELAY_MS);
    // Full jitter, but never below the minimum: the point is to leave the
    // window alone for a while, and a 3ms "wait" would not.
    return Math.round(RATE_RETRY_MIN_DELAY_MS + random * (ceiling - RATE_RETRY_MIN_DELAY_MS));
}

/**
 * Wait out one rate refusal. Returns the delay it slept, so callers can assert
 * on it. `sleep`/`log` are injected so the policy stays testable without timers.
 */
export async function pauseForRateQuota(opts: {
    /** What was being written, for the log line ('metadata', 'daemon state', …). */
    label: string;
    /** The server's `*_rate_quota_exceeded` code. */
    code: string;
    /** Consecutive refusals for this write, starting at 1. */
    attempt: number;
    sleep: (ms: number) => Promise<unknown>;
    log?: (message: string) => void;
}): Promise<number> {
    const ms = rateRetryDelayMs(opts.attempt);
    opts.log?.(`[RATE] ${opts.label} write refused (${opts.code}), attempt ${opts.attempt} — waiting ${ms}ms`);
    await opts.sleep(ms);
    return ms;
}
