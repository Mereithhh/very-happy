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
