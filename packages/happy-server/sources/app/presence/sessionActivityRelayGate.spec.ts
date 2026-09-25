import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_ACTIVITY_RELAY_LIMITS, SessionActivityRelayGate } from './sessionActivityRelayGate';

/** Web `sync/heartbeatLease.ts` HEARTBEAT_LEASE_TTL_MS (separate package). */
const WEB_HEARTBEAT_LEASE_TTL_MS = 25_000;

/** Simulate a wrapper beating every 2 s and return the relayed timestamps. */
function run(gate: SessionActivityRelayGate, sid: string, from: number, to: number, thinking: (t: number) => boolean): number[] {
    const out: number[] = [];
    for (let t = from; t <= to; t += 2_000) {
        if (gate.shouldRelay(sid, thinking(t), t)) out.push(t);
    }
    return out;
}

describe('SessionActivityRelayGate (B-484)', () => {
    it('relays the first beat of a session immediately', () => {
        const gate = new SessionActivityRelayGate();
        expect(gate.shouldRelay('s1', false, 1_000)).toBe(true);
        expect(gate.shouldRelay('s2', true, 1_000)).toBe(true);
    });

    it('coalesces idle beats to one per idle interval', () => {
        const gate = new SessionActivityRelayGate();
        const relayed = run(gate, 's', 0, 120_000, () => false);
        // 2 s beats over 120 s = 61 beats; 30 s spacing → 0, 30, 60, 90, 120
        expect(relayed).toEqual([0, 30_000, 60_000, 90_000, 120_000]);
    });

    it('keeps busy beats well inside the web heartbeat lease', () => {
        const gate = new SessionActivityRelayGate();
        const relayed = run(gate, 's', 0, 60_000, () => true);
        const gaps = relayed.slice(1).map((t, i) => t - relayed[i]);
        expect(Math.max(...gaps)).toBe(DEFAULT_SESSION_ACTIVITY_RELAY_LIMITS.busyIntervalMs);
        // Web lease is 25 s and a blue-green handover can add a 10 s gap on top
        // of the relay spacing; the sum must stay under the lease.
        expect(DEFAULT_SESSION_ACTIVITY_RELAY_LIMITS.busyIntervalMs + 10_000).toBeLessThan(WEB_HEARTBEAT_LEASE_TTL_MS);
    });

    it('relays a thinking flip immediately in both directions', () => {
        const gate = new SessionActivityRelayGate();
        expect(gate.shouldRelay('s', false, 0)).toBe(true);
        expect(gate.shouldRelay('s', false, 2_000)).toBe(false);
        expect(gate.shouldRelay('s', true, 4_000)).toBe(true);
        expect(gate.shouldRelay('s', true, 6_000)).toBe(false);
        expect(gate.shouldRelay('s', false, 7_000)).toBe(true);
    });

    it('treats the beat after an inactive broadcast as an edge', () => {
        const gate = new SessionActivityRelayGate();
        expect(gate.shouldRelay('s', false, 0)).toBe(true);
        gate.forget('s');
        expect(gate.shouldRelay('s', false, 2_000)).toBe(true);
    });

    it('drops sessions that stopped beating', () => {
        const gate = new SessionActivityRelayGate({ busyIntervalMs: 4_000, idleIntervalMs: 30_000 });
        gate.shouldRelay('gone', false, 0);
        gate.shouldRelay('live', false, 0);
        run(gate, 'live', 2_000, 130_000, () => false);
        expect(gate.size).toBe(1);
    });
});
