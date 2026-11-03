/**
 * B-876b — one answer to "is this daemon still the machine's daemon?".
 *
 * B-864 made the heartbeat exit once `daemon.state.json` names another pid, but
 * the heartbeat was the only path that asked. A superseded daemon that woke up
 * reconnected about a second later, and the reconnect (B-876) fetched the CLI
 * policy, started an install and wrote its own pid back into the state file —
 * after which the heartbeat no longer saw "a different daemon" and the old
 * process lived on (QA48).
 *
 * Every path that fetches, installs or writes the state file asks `owns()`. The
 * answer latches: once superseded, always superseded, and `onSuperseded` (the
 * B-864 self-exit) runs exactly once. A missing or unreadable state file is not
 * a takeover — it reads as owned, as the heartbeat always treated it.
 */
export function createDaemonOwnership(deps: {
    pid: number;
    /** The pid recorded in daemon.state.json; null when there is no readable file. */
    statePid: () => number | null;
    onSuperseded: (ownerPid: number) => void;
}) {
    let superseded = false;
    return {
        owns(): boolean {
            if (superseded) return false;
            const ownerPid = deps.statePid();
            if (ownerPid === null || ownerPid === deps.pid) return true;
            superseded = true;
            deps.onSuperseded(ownerPid);
            return false;
        },
    };
}
