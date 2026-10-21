import { describe, expect, it, vi } from 'vitest';
import { terminateProcess, terminateProcessTree, type ProcessSignal, type ProcessTerminationRuntime } from './processTermination';

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

describe('terminateProcessTree (B-634 ①)', () => {
    it('snapshots the tree before signalling and reaps it once the wrapper settled', () => {
        const order: string[] = [];
        let settle!: (stopped: boolean) => void;
        const onSettled = vi.fn(() => order.push('settled'));
        const requested = terminateProcessTree(42, onSettled, {
            snapshot: (pid) => { order.push(`snapshot:${pid}`); return [{ pid: 43, ppid: 42, start: 's' }]; },
            terminate: (pid, cb) => { order.push(`terminate:${pid}`); settle = cb; return true; },
            reap: (entries) => { order.push(`reap:${entries.map((e) => e.pid).join(',')}`); return []; },
        });
        expect(requested).toBe(true);
        expect(order).toEqual(['snapshot:42', 'terminate:42']);
        settle(true);
        expect(order).toEqual(['snapshot:42', 'terminate:42', 'reap:43', 'settled']);
        expect(onSettled).toHaveBeenCalledWith(true);
    });
});
