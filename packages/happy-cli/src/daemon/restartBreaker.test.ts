import { describe, expect, it } from 'vitest';
import { decideRestart, recordRestartAttempt, DEFAULT_MAX_RESTARTS } from './restartBreaker';

describe('restart circuit breaker', () => {
    it('allows the first restart and reports attempt number', () => {
        const d = decideRestart(0);
        expect(d).toEqual({ allowed: true, attempt: 1 });
    });

    it('allows up to but not beyond the max', () => {
        expect(decideRestart(DEFAULT_MAX_RESTARTS - 1).allowed).toBe(true);
        const blocked = decideRestart(DEFAULT_MAX_RESTARTS);
        expect(blocked.allowed).toBe(false);
        if (!blocked.allowed) expect(blocked.reason).toContain('restart-limit');
    });

    it('honors a custom max', () => {
        expect(decideRestart(1, 1).allowed).toBe(false);
        expect(decideRestart(0, 1).allowed).toBe(true);
    });

    it('records an attempt as a monotonic increment', () => {
        expect(recordRestartAttempt(0)).toBe(1);
        expect(recordRestartAttempt(2)).toBe(3);
    });

    it('a rejected pre-flight does not burn a slot (record is caller-driven)', () => {
        // decideRestart is pure and never mutates; the daemon only calls
        // recordRestartAttempt once it actually spawns. Simulate: 3 pre-flight
        // checks that never spawn leave the count at 0.
        let count = 0;
        for (let i = 0; i < 3; i++) {
            const d = decideRestart(count);
            expect(d.allowed).toBe(true); // still allowed — nothing was recorded
        }
        expect(count).toBe(0);
    });
});
