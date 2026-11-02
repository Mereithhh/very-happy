import { describe, expect, it } from 'vitest';
import { createReconnectGate, RECONNECT_NOT_READY_MAX_TICKS } from './reconnectGate';

describe('B-869 reconnect gate', () => {
    it('connects whenever the predicate says ready', () => {
        const gate = createReconnectGate();
        expect(gate.decide(true)).toBe('connect');
        expect(gate.decide(true)).toBe('connect');
    });

    it('forces an attempt after N consecutive not-ready ticks, then counts again', () => {
        const gate = createReconnectGate(3);
        expect([gate.decide(false), gate.decide(false), gate.decide(false)]).toEqual(['wait', 'wait', 'force']);
        expect(gate.notReadyTicks).toBe(0);
        expect([gate.decide(false), gate.decide(false), gate.decide(false)]).toEqual(['wait', 'wait', 'force']);
    });

    it('a ready tick resets the count', () => {
        const gate = createReconnectGate(3);
        gate.decide(false);
        gate.decide(false);
        expect(gate.decide(true)).toBe('connect');
        expect(gate.decide(false)).toBe('wait');
        expect(gate.decide(false)).toBe('wait');
        expect(gate.decide(false)).toBe('force');
    });

    it('a predicate stuck at not-ready never wedges: an attempt at least every N ticks', () => {
        const gate = createReconnectGate();
        // mac-office 11-02: 3835 "not ready" ticks in a row.
        const decisions = Array.from({ length: 3835 }, () => gate.decide(false));
        const forced = decisions.filter((d) => d === 'force').length;
        expect(forced).toBe(Math.floor(3835 / RECONNECT_NOT_READY_MAX_TICKS));
        expect(decisions.indexOf('force')).toBe(RECONNECT_NOT_READY_MAX_TICKS - 1);
    });
});
