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
 * - after a failed fetch (network not back yet) another try after `retryMs` —
 *   except that a socket connect runs at once: it proves the network is back,
 *   and a wake-time fetch that failed a few seconds earlier must not hold it;
 * - a refresh the controller skipped because another operation was running is
 *   retried after `retryMs` too.
 * What to do with the policy (waiting_idle, install, …) stays entirely with the
 * update controller, exactly as for the hourly check.
 */

export const POLICY_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
export const POLICY_REFRESH_RETRY_MS = 30_000;
/** A heartbeat gap this much longer than the interval means the process was suspended (sleep / DarkWake). */
export const WAKE_GAP_SLACK_MS = 2 * 60_000;

/** `ok` = a policy was read; `unavailable` = the fetch failed; `busy` = another update operation ran, nothing was read. */
export type PolicyRefreshResult = 'ok' | 'unavailable' | 'busy';

export type PolicyRefreshReason = 'startup' | 'connect' | 'wake' | 'stale' | 'scheduled';

export interface PolicyRefreshTriggerDependencies {
    refresh: () => Promise<PolicyRefreshResult>;
    now?: () => number;
    minIntervalMs?: number;
    retryMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    log?: (message: string) => void;
}

export type PolicyRefreshDecision = 'run' | 'deferred' | 'in-flight' | 'stopped';

export function createPolicyRefreshTrigger(deps: PolicyRefreshTriggerDependencies) {
    const now = deps.now ?? Date.now;
    const minIntervalMs = deps.minIntervalMs ?? POLICY_REFRESH_MIN_INTERVAL_MS;
    const retryMs = deps.retryMs ?? POLICY_REFRESH_RETRY_MS;
    const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let lastSuccessAt: number | null = null;
    let lastAttemptAt: number | null = null;
    let inFlight = false;
    let timer: unknown = null;
    let stopped = false;

    function earliestRun(reason: PolicyRefreshReason): number {
        let at = 0;
        if (lastSuccessAt !== null) at = Math.max(at, lastSuccessAt + minIntervalMs);
        if (lastAttemptAt !== null && reason !== 'connect') at = Math.max(at, lastAttemptAt + retryMs);
        return at;
    }

    function defer(ms: number) {
        if (timer !== null) return;
        timer = setTimer(() => { timer = null; request('scheduled'); }, Math.max(0, ms));
    }

    function run(reason: PolicyRefreshReason) {
        inFlight = true;
        lastAttemptAt = now();
        deps.log?.(`CLI update policy refresh (${reason})`);
        void deps.refresh().catch((): PolicyRefreshResult => 'unavailable').then((result) => {
            inFlight = false;
            if (result === 'ok') lastSuccessAt = now();
            else if (result === 'busy') lastAttemptAt = now();
            if (stopped || result === 'ok') return;
            defer(retryMs);
        });
    }

    function request(reason: PolicyRefreshReason): PolicyRefreshDecision {
        if (stopped) return 'stopped';
        if (inFlight) return 'in-flight';
        const wait = earliestRun(reason) - now();
        if (wait > 0) { defer(wait); return 'deferred'; }
        if (timer !== null) { clearTimer(timer); timer = null; }
        run(reason);
        return 'run';
    }

    return {
        request,
        /** Any other refresh (startup, hourly, announcement) that read a policy restarts the window. */
        noteRefreshed(result: PolicyRefreshResult) {
            if (result === 'ok') lastSuccessAt = now();
        },
        stop() {
            stopped = true;
            if (timer !== null) clearTimer(timer);
            timer = null;
        },
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
