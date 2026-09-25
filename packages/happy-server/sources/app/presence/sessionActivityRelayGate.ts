/**
 * B-484: coalesce the per-session `activity` ephemeral that `session-alive`
 * fans out to the account's web clients.
 *
 * Every agent wrapper sends `session-alive` every 2 s whether or not it is
 * working (the keepAlive is a lease, see web `sync/heartbeatLease.ts`). The
 * server used to rebroadcast each one, and every broadcast is one XADD on the
 * socket.io Redis stream `vh:socket.io`. Measured on production 2026-09-25
 * (last 20k entries): `ephemeral:activity` was 78% of all stream entries
 * (~71/s of ~91/s) from ~150 live sessions, and only ~1.5% of those frames had
 * `thinking: true`. The other 98% told web clients "still idle, still online"
 * every two seconds.
 *
 * What the web actually needs from this lane:
 *  - edges: first sighting, `thinking` flipping, coming back after an
 *    inactive broadcast → must arrive immediately;
 *  - a fresh `thinking: true` heartbeat for the 25 s lease
 *    (`HEARTBEAT_LEASE_TTL_MS`) → a beat every `busyIntervalMs` keeps the worst
 *    gap at busy interval + 10 s handover < 25 s;
 *  - idle sessions: nothing time-critical. `presence` is the `active` flag, not
 *    a timeout, and going offline is a separate broadcast (session-end /
 *    archive / presence timeout), so an occasional idle refresh is enough.
 *
 * The DB side (`activityCache.queueSessionUpdate`) still sees every beat; only
 * the fan-out is coalesced. State is per server process: after a blue-green
 * switch the new slot has an empty table, so its first beat per session goes
 * out immediately.
 */

export interface SessionActivityRelayLimits {
    /** Minimum spacing between relayed `thinking: true` beats of one session. */
    busyIntervalMs: number;
    /** Minimum spacing between relayed idle beats of one session. */
    idleIntervalMs: number;
}

export const DEFAULT_SESSION_ACTIVITY_RELAY_LIMITS: SessionActivityRelayLimits = {
    busyIntervalMs: 4_000,
    idleIntervalMs: 30_000,
};

type Relayed = { at: number; thinking: boolean };

export class SessionActivityRelayGate {
    private readonly last = new Map<string, Relayed>();
    private lastSweepAt = 0;

    constructor(private readonly limits: SessionActivityRelayLimits = DEFAULT_SESSION_ACTIVITY_RELAY_LIMITS) {}

    /**
     * Decide whether this `session-alive` beat is rebroadcast. Records the
     * relay when it returns true.
     */
    shouldRelay(sessionId: string, thinking: boolean, now: number): boolean {
        this.sweep(now);
        const prev = this.last.get(sessionId);
        const interval = thinking ? this.limits.busyIntervalMs : this.limits.idleIntervalMs;
        if (prev && prev.thinking === thinking && now - prev.at < interval) {
            return false;
        }
        this.last.set(sessionId, { at: now, thinking });
        return true;
    }

    /**
     * An inactive `activity` was broadcast for this session (session-end,
     * archive, presence timeout): the next beat is an edge again.
     */
    forget(sessionId: string): void {
        this.last.delete(sessionId);
    }

    get size(): number {
        return this.last.size;
    }

    /** Drop sessions not relayed for a while so the table tracks live sessions only. */
    private sweep(now: number): void {
        const ttl = this.limits.idleIntervalMs * 2;
        if (now - this.lastSweepAt < ttl) return;
        this.lastSweepAt = now;
        for (const [id, r] of this.last) {
            if (now - r.at >= ttl) this.last.delete(id);
        }
    }
}

export const sessionActivityRelayGate = new SessionActivityRelayGate();
