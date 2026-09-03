import { afterEach, describe, expect, it } from 'vitest';
import {
    HEARTBEAT_LEASE_TTL_MS,
    isHeartbeatFresh,
    leaseVerdict,
    recordHeartbeat,
    resetHeartbeatLeaseForTest,
    setHeartbeatSocketStatusReader,
} from './heartbeatLease';

afterEach(() => resetHeartbeatLeaseForTest());

describe('leaseVerdict (B-322)', () => {
    it('expires a heartbeat that stopped arriving', () => {
        expect(leaseVerdict({ lastBeatAt: 0, now: HEARTBEAT_LEASE_TTL_MS - 1, suspended: false }).fresh).toBe(true);
        expect(leaseVerdict({ lastBeatAt: 0, now: HEARTBEAT_LEASE_TTL_MS, suspended: false }).fresh).toBe(false);
    });

    it('never expires while suspended, and restarts the clock on resume', () => {
        // A frozen background tab receives nothing because it is not listening,
        // not because the wrapper stopped — and a frozen tab never even gets the
        // `disconnect` event, so socketStatus alone would still say 'connected'.
        const verdict = leaseVerdict({ lastBeatAt: 0, now: 10 * HEARTBEAT_LEASE_TTL_MS, suspended: true });
        expect(verdict.fresh).toBe(true);
        // Pushing the start forward is what buys a full TTL of grace after
        // resume without a second grace constant or a second visibility listener.
        expect(verdict.nextLastBeatAt).toBe(10 * HEARTBEAT_LEASE_TTL_MS);
    });

    it('never having observed a heartbeat is not a vote against liveness', () => {
        // Cold start already renders idle because the REST snapshot writes
        // thinking:false; the lease only has to expire an ALREADY-true flag.
        expect(leaseVerdict({ lastBeatAt: undefined, now: 1_000_000, suspended: false }).fresh).toBe(true);
    });
});

describe('recordHeartbeat / isHeartbeatFresh (B-322)', () => {
    it('an idle session arms no expiry timer at all', () => {
        // thinking=false sessions cannot go stale in a way anyone can see, so
        // they must not each hold a timer — that is the whole reason this is a
        // per-session one-shot instead of a global ticker.
        recordHeartbeat('s1', false, 0);
        expect(isHeartbeatFresh('s1', HEARTBEAT_LEASE_TTL_MS + 1)).toBe(false);
    });

    it('a live session stays fresh inside the TTL and goes stale past it', () => {
        recordHeartbeat('s2', true, 0);
        expect(isHeartbeatFresh('s2', HEARTBEAT_LEASE_TTL_MS - 1)).toBe(true);
        recordHeartbeat('s2', true, HEARTBEAT_LEASE_TTL_MS - 1);
        expect(isHeartbeatFresh('s2', 2 * HEARTBEAT_LEASE_TTL_MS - 3)).toBe(true);
        expect(isHeartbeatFresh('s2', 5 * HEARTBEAT_LEASE_TTL_MS)).toBe(false);
    });

    it('a disconnected socket suspends the lease instead of declaring death', () => {
        recordHeartbeat('s3', true, 0);
        setHeartbeatSocketStatusReader(() => 'disconnected');
        expect(isHeartbeatFresh('s3', 10 * HEARTBEAT_LEASE_TTL_MS)).toBe(true);
        // …and reconnecting gets a full TTL, not an instant expiry.
        setHeartbeatSocketStatusReader(() => 'connected');
        expect(isHeartbeatFresh('s3', 10 * HEARTBEAT_LEASE_TTL_MS + 1)).toBe(true);
        expect(isHeartbeatFresh('s3', 11 * HEARTBEAT_LEASE_TTL_MS + 1)).toBe(false);
    });
});
