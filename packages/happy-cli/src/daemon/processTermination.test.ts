import { describe, expect, it, vi } from 'vitest';
import { terminateProcess, type ProcessSignal, type ProcessTerminationRuntime } from './processTermination';

function fakeRuntime(alive = true) {
    let current = alive;
    const signal = vi.fn((_pid: number, sig: ProcessSignal) => {
        if (sig === 'SIGKILL') current = false;
    });
    const scheduled: Array<() => void> = [];
    const runtime: ProcessTerminationRuntime = {
        signal,
        isAlive: () => current,
        schedule: (cb) => scheduled.push(cb),
    };
    return { runtime, signal, scheduled };
}

describe('terminateProcess', () => {
    it('treats an already-dead process as idempotent success', () => {
        const f = fakeRuntime(false);
        const settled = vi.fn();
        expect(terminateProcess(42, settled, f.runtime)).toBe(true);
        expect(f.signal).not.toHaveBeenCalled();
        expect(settled).toHaveBeenCalledWith(true);
    });

    it('escalates a surviving process from SIGTERM to SIGKILL and verifies exit', () => {
        const f = fakeRuntime(true);
        const settled = vi.fn();
        expect(terminateProcess(42, settled, f.runtime)).toBe(true);
        expect(f.signal).toHaveBeenCalledWith(42, 'SIGTERM');
        f.scheduled.shift()!();
        expect(f.signal).toHaveBeenCalledWith(42, 'SIGKILL');
        f.scheduled.shift()!();
        expect(settled).toHaveBeenCalledWith(true);
    });
});
