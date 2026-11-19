/**
 * B-943: what a terminal someone shared with me shows while its machine is not
 * reachable. Before this, an offline owner machine left the page black: the
 * attach waited out the server's reconnect grace in silence, the error line was
 * unreadable on the dark pane, a drop while watching was never signalled, and
 * nothing re-attached when the machine came back. Pure — the screen wires it.
 */
export type SharedPaneNotice = 'connecting' | 'offline' | null;

/** Offline wins: a pane that once painted keeps its old screen under a compact notice. */
export function sharedPaneNotice(state: { connecting: boolean; offline: boolean }): SharedPaneNotice {
    if (state.offline) return 'offline';
    if (state.connecting) return 'connecting';
    return null;
}

/** Only an unreachable machine is retried by itself; every other failure needs the person. */
export function isMachineUnreachable(code: string): boolean {
    return code === 'machine_offline';
}

/**
 * Gap before the next attach attempt while the machine is away. Each attempt
 * itself waits up to the server's reconnect grace (~15 s) and returns the moment
 * the daemon is back, so short gaps are cheap; capped so an hours-long outage
 * costs one call every ~45 s per open pane.
 */
const RETRY_GAPS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;
export function offlineRetryDelayMs(attempt: number): number {
    const i = Number.isFinite(attempt) ? Math.max(0, Math.min(Math.floor(attempt), RETRY_GAPS_MS.length - 1)) : 0;
    return RETRY_GAPS_MS[i];
}

