/**
 * B-869 — the "ready to reconnect" predicate (`shouldReconnect()`: network
 * interface up, lid open or an external display) is a hint, never a veto.
 *
 * A MacBook that runs closed without an external display (clamshell sleep
 * disabled, the mac-office setup) answers "lid closed" forever. After a sleep
 * the control socket dropped with `ping timeout`, the 3 s interval logged
 * "Still not ready to reconnect" 3835 times over 5h40m and never sent a
 * CONNECT, while the relay socket (socket.io's own reconnection, no predicate)
 * came straight back — so the machine looked offline and missed CLI updates
 * until the daemon was restarted (2026-11-02).
 *
 * The interval firing at all proves the process is awake, so a predicate that
 * keeps saying "not ready" is more likely wrong than right: after
 * RECONNECT_NOT_READY_MAX_TICKS consecutive "not ready" ticks the gate forces
 * one attempt, then starts counting again. A real sleep costs nothing (timers
 * do not run), a wrong predicate costs one CONNECT every ~30 s.
 */

export const RECONNECT_NOT_READY_MAX_TICKS = 10;

export type ReconnectDecision = 'connect' | 'wait' | 'force';

export interface ReconnectGate {
    decide(ready: boolean): ReconnectDecision;
    /** Test/diagnostic view. */
    readonly notReadyTicks: number;
}

export function createReconnectGate(maxNotReadyTicks = RECONNECT_NOT_READY_MAX_TICKS): ReconnectGate {
    let notReady = 0;
    return {
        decide(ready) {
            if (ready) {
                notReady = 0;
                return 'connect';
            }
            notReady += 1;
            if (notReady < maxNotReadyTicks) return 'wait';
            notReady = 0;
            return 'force';
        },
        get notReadyTicks() {
            return notReady;
        },
    };
}
