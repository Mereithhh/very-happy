import { describe, expect, it } from 'vitest';
import { decideAfterProbe, decideProbe, LIVENESS_PROBE_MS } from './socketLiveness';

describe('decideProbe', () => {
    it('skips when the emit already closed the socket (manager is reconnecting)', () => {
        expect(decideProbe({ connectedAfterEmit: false, handoverInFlight: false })).toBe('skip');
    });
    it('skips during release handover', () => {
        expect(decideProbe({ connectedAfterEmit: true, handoverInFlight: true })).toBe('skip');
    });
    it('probes a socket that still claims to be connected', () => {
        expect(decideProbe({ connectedAfterEmit: true, handoverInFlight: false })).toBe('probe');
        expect(decideProbe({ connectedAfterEmit: true, handoverInFlight: false, attemptFromEarlierEpoch: true })).toBe('probe');
    });
    // B-803b: a handshake begun while hidden waits out socket.io's 20s connect timeout on a dead path.
    it('reconnects now when still connecting on an attempt begun before this foreground', () => {
        expect(decideProbe({ connectedAfterEmit: false, handoverInFlight: false, attemptFromEarlierEpoch: true })).toBe('reconnect');
    });
    it('leaves an attempt of this foreground (e.g. the one the emit just triggered) and handover alone', () => {
        expect(decideProbe({ connectedAfterEmit: false, handoverInFlight: false, attemptFromEarlierEpoch: false })).toBe('skip');
        expect(decideProbe({ connectedAfterEmit: false, handoverInFlight: true, attemptFromEarlierEpoch: true })).toBe('skip');
    });
});

describe('decideAfterProbe', () => {
    it('ack → alive', () => {
        expect(decideAfterProbe({ acked: true, sameSocket: true, connected: true, handoverInFlight: false })).toBe('alive');
    });
    it('no ack but the socket already dropped (queued close rejected the ack) → none, never reconnect', () => {
        expect(decideAfterProbe({ acked: false, sameSocket: true, connected: false, handoverInFlight: false })).toBe('none');
    });
    it('no ack on a socket that was replaced (handover) → none', () => {
        expect(decideAfterProbe({ acked: false, sameSocket: false, connected: true, handoverInFlight: false })).toBe('none');
        expect(decideAfterProbe({ acked: false, sameSocket: true, connected: true, handoverInFlight: true })).toBe('none');
    });
    it('no ack on the same, still-connected socket → reconnect', () => {
        expect(decideAfterProbe({ acked: false, sameSocket: true, connected: true, handoverInFlight: false })).toBe('reconnect');
    });
    it('probe window covers cellular radio wake-up', () => {
        expect(LIVENESS_PROBE_MS).toBeGreaterThanOrEqual(5_000);
    });
});
