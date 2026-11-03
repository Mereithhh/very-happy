/**
 * B-876 — re-read `/v1/version/cli` as soon as the daemon is back, instead of
 * on the next hourly check.
 *
 * Before this, three things lined up against a machine that slept through a
 * promote (Release38 mac-office, Release40 mac-main):
 * - the B-718 announcement goes out once over the socket; a sleeping machine
 *   never sees it and the relay does not replay it on reconnect;
 * - the hourly `setInterval` runs on the monotonic clock, which stops while the
 *   machine sleeps, so after waking it is still up to an hour away;
 * - the heartbeat's `tick()` only re-evaluates the policy it holds, and a policy
 *   older than 65 minutes just publishes `policy_stale` — nothing fetches.
 *
 * Triggers: the machine socket (re)connects, the heartbeat notices a wall-clock
 * jump (the process was suspended), or the held policy is stale. Each one asks
 * for a refresh; this module paces them:
 * - at most one refresh per `minIntervalMs` (5 min) after a successful one — a
 *   request inside the window is not dropped but runs once when it ends, so a
 *   promote made just after the last check is still picked up;
 * - after a failed fetch (network not back yet) another try after `retryMs`,
 *   doubling on every further failure up to `maxBackoffMs` (30 s → 1 m → 2 m …
 *   30 m) and back to normal after a success (B-876c). Only the first failure
 *   and each step up are logged as warnings; a capped retry logs at debug;
 * - a socket connect or a wake may skip the backoff, at most once per
 *   `minIntervalMs`: a connect proves the network is back, and a wake-time fetch
 *   that failed a few seconds earlier must not hold it;
 * - a fetch whose policy the server already reports as stale (its registry
 *   check keeps failing, `checkedAt` does not move) backs off the same way
 *   instead of re-fetching every window (B-876c);
 * - a refresh the controller skipped because another operation was running is
 *   retried after `retryMs` (or the current backoff, if longer);
 * - `blocked` (manual recovery required, B-817b) schedules nothing: the next
 *   connect, wake or hourly check asks again, and stale requests wait out the backoff;
 * - B-876b: a refresh that found another daemon owning the machine (B-864)
 *   stops the trigger for good — no retry, no deferred run.
 * What to do with the policy (waiting_idle, install, …) stays entirely with the
 * update controller, exactly as for the hourly check.
 */

export const POLICY_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
export const POLICY_REFRESH_RETRY_MS = 30_000;
/** Ceiling of the failure backoff (B-876c). */
export const POLICY_REFRESH_MAX_BACKOFF_MS = 30 * 60_000;
/** A heartbeat gap this much longer than the interval means the process was suspended (sleep / DarkWake). */
export const WAKE_GAP_SLACK_MS = 2 * 60_000;

/**
 * `ok` = a fresh policy was read; `stale` = a policy was read but the server already says it is past the limit
 * (B-876c); `unavailable` = the fetch failed; `busy` = another update operation ran, nothing was read;
 * `blocked` = manual recovery required, nothing was read (B-817b);
 * `superseded` = another daemon owns the machine now, nothing was read and nothing ever will be (B-876b).
 */
export type PolicyRefreshResult = 'ok' | 'stale' | 'unavailable' | 'busy' | 'blocked' | 'superseded';

export type PolicyRefreshReason = 'startup' | 'connect' | 'wake' | 'stale' | 'scheduled';

export interface PolicyRefreshTriggerDependencies {
    refresh: () => Promise<PolicyRefreshResult>;
    now?: () => number;
    minIntervalMs?: number;
    retryMs?: number;
    maxBackoffMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    log?: (message: string, level: 'warn' | 'debug') => void;
}

export type PolicyRefreshDecision = 'run' | 'deferred' | 'in-flight' | 'stopped';

export function createPolicyRefreshTrigger(deps: PolicyRefreshTriggerDependencies) {
    const now = deps.now ?? Date.now;
    const minIntervalMs = deps.minIntervalMs ?? POLICY_REFRESH_MIN_INTERVAL_MS;
    const retryMs = deps.retryMs ?? POLICY_REFRESH_RETRY_MS;
    const maxBackoffMs = deps.maxBackoffMs ?? POLICY_REFRESH_MAX_BACKOFF_MS;
    const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const log = (message: string, level: 'warn' | 'debug') => deps.log?.(message, level);
    let lastSuccessAt: number | null = null;
    let lastAttemptAt: number | null = null;
    let lastBypassAt: number | null = null;
    /** Consecutive refreshes that read no fresh policy (unavailable / stale / blocked); 0 after a success. */
    let failures = 0;
    let inFlight = false;
    let timer: unknown = null;
    let stopped = false;

    const backoff = (n: number) => n <= 0 ? retryMs : Math.min(retryMs * 2 ** (n - 1), maxBackoffMs);

    function earliestRun(reason: PolicyRefreshReason): { at: number; bypass: boolean } {
        const windowEnd = lastSuccessAt === null ? 0 : lastSuccessAt + minIntervalMs;
        const retryAt = lastAttemptAt === null ? 0 : lastAttemptAt + backoff(failures);
        if (retryAt <= Math.max(windowEnd, now())) return { at: windowEnd, bypass: false };
        const mayBypass = (reason === 'connect' || reason === 'wake')
            && (lastBypassAt === null || now() - lastBypassAt >= minIntervalMs);
        return mayBypass ? { at: windowEnd, bypass: true } : { at: retryAt, bypass: false };
    }

    function defer(ms: number) {
        if (timer !== null) return;
        timer = setTimer(() => { timer = null; request('scheduled'); }, Math.max(0, ms));
    }

    function run(reason: PolicyRefreshReason) {
        inFlight = true;
        lastAttemptAt = now();
        log(`CLI update policy refresh (${reason})`, failures === 0 ? 'warn' : 'debug');
        void deps.refresh().catch((): PolicyRefreshResult => 'unavailable').then((result) => {
            inFlight = false;
            if (result === 'superseded') { stop(); return; }
            if (result === 'ok') {
                if (failures > 0) log(`CLI update policy refresh recovered after ${failures} failed attempt(s)`, 'warn');
                lastSuccessAt = now();
                failures = 0;
                return;
            }
            if (result === 'busy') lastAttemptAt = now();
            else {
                if (result === 'stale') lastSuccessAt = now();
                failures += 1;
                const stepUp = failures === 1 || backoff(failures) > backoff(failures - 1);
                const next = result === 'blocked' ? 'waiting for the next connect / wake / hourly check' : `next try in ${Math.round(backoff(failures) / 1000)}s`;
                log(`CLI update policy refresh (${reason}) read no fresh policy (${result}, ${failures} in a row); ${next}`, stepUp ? 'warn' : 'debug');
            }
            if (stopped || result === 'blocked') return;
            defer(earliestRun('scheduled').at - now());
        });
    }

    function request(reason: PolicyRefreshReason): PolicyRefreshDecision {
        if (stopped) return 'stopped';
        if (inFlight) return 'in-flight';
        const { at, bypass } = earliestRun(reason);
        const wait = at - now();
        if (wait > 0) { defer(wait); return 'deferred'; }
        if (bypass) lastBypassAt = now();
        if (timer !== null) { clearTimer(timer); timer = null; }
        run(reason);
        return 'run';
    }

    function stop() {
        stopped = true;
        if (timer !== null) clearTimer(timer);
        timer = null;
    }

    return {
        request,
        /** Any other refresh (startup, hourly, announcement) that read a policy restarts the window (and a fresh one ends the backoff); one that found us superseded stops it. */
        noteRefreshed(result: PolicyRefreshResult) {
            if (result === 'ok' || result === 'stale') lastSuccessAt = now();
            if (result === 'ok') failures = 0;
            else if (result === 'superseded') stop();
        },
        stop,
    };
}

/**
 * Heartbeat-side wake detection. Timers run on the monotonic clock, which does
 * not advance while the machine sleeps, but `Date.now()` does: a heartbeat whose
 * wall-clock gap since the previous one is far longer than its interval ran
 * right after a suspend.
 */
export function createWakeDetector(intervalMs: number, now: () => number = Date.now, slackMs = WAKE_GAP_SLACK_MS) {
    let last: number | null = null;
    return {
        /** Call once per heartbeat; true when the process was just suspended. */
        beat(): boolean {
            const at = now();
            const woke = last !== null && at - last > intervalMs + slackMs;
            last = at;
            return woke;
        },
    };
}
