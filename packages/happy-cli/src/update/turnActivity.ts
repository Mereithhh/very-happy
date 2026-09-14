/**
 * B-466 — "is any agent turn in flight on this machine?"
 *
 * The auto-update gate used to be "no session wrapper and no live web
 * terminal". A machine whose owner keeps eight web terminals open is never
 * idle by that definition, so it never updates — five machines were still on
 * 0.2.129 twelve days after 0.2.134 shipped. What the gate is really
 * protecting is a turn in progress: a daemon handover does not kill wrappers
 * (they talk to the server themselves) and a web terminal lives in tmux, so
 * the only thing worth waiting for is an agent that is mid-answer.
 *
 * Wrappers already heartbeat `thinking` every couple of seconds
 * (`ApiSessionClient.keepAlive`). `TurnReporter` turns that into two
 * best-effort POSTs to the daemon — `turn_started` on the rising edge (and
 * again every LEASE_MS while it stays up, as a lease renewal) and
 * `turn_ended` on the falling edge. `TurnActivityTracker` is the daemon side:
 * a session counts as busy from its last `turn_started` until `turn_ended`,
 * the wrapper exiting, or BUSY_TTL_MS without a renewal — so a lost
 * `turn_ended` (daemon restarting at that moment) can never pin a machine on
 * an old version forever.
 *
 * Wrappers that predate this reporting never POST and therefore never count
 * as busy — the same as today's behaviour for terminals, and the price of not
 * requiring every wrapper to restart before the first automatic update.
 */

export type TurnEvent = 'turn_started' | 'turn_ended';

/** Renew the lease while thinking stays up. */
export const TURN_LEASE_MS = 60_000;
/** A busy mark without renewal expires after this (> 2 × lease). */
export const TURN_BUSY_TTL_MS = 150_000;

export class TurnActivityTracker {
    private readonly busy = new Map<string, number>();

    constructor(private readonly ttlMs: number = TURN_BUSY_TTL_MS) {}

    apply(sessionId: string, event: TurnEvent, now: number = Date.now()): void {
        if (event === 'turn_started') this.busy.set(sessionId, now);
        else this.busy.delete(sessionId);
    }

    /** The wrapper is gone: whatever it reported no longer holds. */
    forget(sessionId: string): void {
        this.busy.delete(sessionId);
    }

    /** Sessions whose last renewal is still inside the TTL. */
    activeSessions(now: number = Date.now()): string[] {
        const out: string[] = [];
        for (const [id, at] of this.busy) {
            if (now - at <= this.ttlMs) out.push(id);
            else this.busy.delete(id);
        }
        return out;
    }

    hasActiveTurn(now: number = Date.now()): boolean {
        return this.activeSessions(now).length > 0;
    }
}

/** Pure edge/lease logic for the wrapper side; `send` is the effect. */
export class TurnReporter {
    private thinking = false;
    private lastStartedAt = 0;

    constructor(
        private readonly send: (event: TurnEvent) => void,
        private readonly leaseMs: number = TURN_LEASE_MS,
    ) {}

    /** Called on every keepAlive tick; emits only on an edge or a due renewal. */
    observe(thinking: boolean, now: number = Date.now()): TurnEvent | null {
        if (thinking) {
            const due = !this.thinking || now - this.lastStartedAt >= this.leaseMs;
            this.thinking = true;
            if (!due) return null;
            this.lastStartedAt = now;
            this.send('turn_started');
            return 'turn_started';
        }
        if (!this.thinking) return null;
        this.thinking = false;
        this.lastStartedAt = 0;
        this.send('turn_ended');
        return 'turn_ended';
    }
}
