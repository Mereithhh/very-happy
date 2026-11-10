/**
 * B-914 — a tab that stays open learns about a new version when the server
 * behind it changes, not on the next 15-minute tick.
 *
 * Field report (11-11): an open page sat on the old shell for a quarter of an
 * hour after a release, so "where is the update notice?" had no answer until
 * a manual refresh. A release always moves the control socket: blue/green
 * hands it over to the candidate slot (server-draining → onReconnected), and a
 * plain restart drops it and the manager reconnects. Either way the reconnect
 * is the earliest moment the page can know the server may be new.
 *
 * The page cannot ask the socket which shell the new server serves, so it
 * checks `/index.html` — several times, because during a blue/green switch the
 * drain notice (and so the handover) comes BEFORE the edge's default upstream
 * flips: the first fetch can still be answered by the outgoing slot. The burst
 * stops early once an update has been found.
 *
 * Pure (timers injected) so the schedule is testable without a DOM.
 */
export const RECONNECT_CHECK_DELAYS_MS: readonly number[] = [0, 8_000, 20_000];

export interface ReconnectCheckDeps {
    /** One forced check (bypasses the periodic check's minimum gap). */
    check: () => void | Promise<void>;
    /** An update has already been found — nothing left to look for. */
    found: () => boolean;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
    delays?: readonly number[];
}

/** Returns `trigger()`: call it on every socket (re)connect. A new trigger
 *  restarts the burst instead of stacking a second one on a flapping link. */
export function createReconnectUpdateCheck(deps: ReconnectCheckDeps): () => void {
    const delays = deps.delays ?? RECONNECT_CHECK_DELAYS_MS;
    let timers: unknown[] = [];
    return () => {
        for (const handle of timers) deps.clearTimer(handle);
        timers = delays.map((ms) => deps.setTimer(() => {
            if (deps.found()) return;
            void deps.check();
        }, ms));
    };
}
