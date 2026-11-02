import { describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { isProcessAlive, terminateProcess, terminateProcessTree, TREE_VERIFY_ATTEMPTS, type ProcessSignal, type ProcessTerminationRuntime } from './processTermination';

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

describe('isProcessAlive (B-864b)', () => {
    const fail = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
    it('EPERM is a live process this user may not signal; only ESRCH is gone', () => {
        expect(isProcessAlive(42, () => undefined)).toBe(true);
        expect(isProcessAlive(42, fail('EPERM'))).toBe(true);
        expect(isProcessAlive(42, fail('ESRCH'))).toBe(false);
        expect(isProcessAlive(0, () => undefined)).toBe(false);
        expect(isProcessAlive(-1, () => undefined)).toBe(false);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('pid 1 (another user) reads as alive', () => {
        expect(isProcessAlive(1)).toBe(true);
    });
});

describe('terminateProcessTree verification (B-864b)', () => {
    const child = { pid: 43, ppid: 42, start: 's' };
    const late = { pid: 44, ppid: 42, start: 't' };

    it('re-snapshots right before the SIGKILL so a child started in the grace window is reaped too', () => {
        const f = fakeRuntime(true);
        const reaped: number[][] = [];
        let calls = 0;
        const settled = vi.fn();
        terminateProcessTree(42, settled, {
            runtime: f.runtime,
            snapshot: () => (calls++ === 0 ? [child] : [child, late]),
            reap: (entries) => { reaped.push(entries.map((e) => e.pid)); return []; },
            readLive: () => [],
        });
        f.scheduled.shift()!();       // grace → beforeKill snapshot + SIGKILL
        expect(f.signal).toHaveBeenCalledWith(42, 'SIGKILL');
        f.scheduled.shift()!();       // settle
        expect(reaped).toEqual([[43, 44]]);
        expect(settled).toHaveBeenCalledWith(true);
    });

    it('keeps re-killing a survivor and reports not-stopped when it never goes', () => {
        const f = fakeRuntime(true);
        const settled = vi.fn();
        const leftovers = vi.fn();
        const reap = vi.fn(() => [43]);
        terminateProcessTree(42, settled, { runtime: f.runtime, snapshot: () => [child], reap, readLive: () => [child], onLeftovers: leftovers });
        while (f.scheduled.length > 0) f.scheduled.shift()!();
        expect(reap).toHaveBeenCalledTimes(TREE_VERIFY_ATTEMPTS);
        expect(leftovers).toHaveBeenCalledWith([43]);
        expect(settled).toHaveBeenCalledWith(false);
    });

    it('a survivor that dies on a re-kill settles as stopped', () => {
        const f = fakeRuntime(true);
        const settled = vi.fn();
        let live = [child];
        let kills = 0;
        terminateProcessTree(42, settled, { runtime: f.runtime, snapshot: () => [child], reap: () => { if (++kills === 3) live = []; return []; }, readLive: () => live });
        while (f.scheduled.length > 0) f.scheduled.shift()!();
        expect(settled).toHaveBeenCalledWith(true);
    });
});

// Real processes: a wrapper that ignores SIGTERM (needs the SIGKILL) with a
// child that would keep "running the turn" after the wrapper is gone.
describe.skipIf(process.platform === 'win32')('terminateProcessTree on a real tree (B-864b)', () => {
    // Running = listed and not a zombie (an exited child waiting for init to reap it executes nothing).
    const alive = (pid: number) => {
        const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
        return stat !== '' && !stat.startsWith('Z');
    };
    const childrenOf = (pid: number) => spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout
        .split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === pid).map(([p]) => p);

    it('a wrapper that ignores SIGTERM is SIGKILLed and its grandchildren do not survive it', async () => {
        const script = `
            process.on('SIGTERM', () => {});
            const { spawn } = require('node:child_process');
            const agent = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:child_process').spawn('sleep', ['300'], { stdio: 'ignore' }); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
            setInterval(() => {}, 1000);
        `;
        const wrapper = spawn(process.execPath, ['-e', script], { stdio: 'ignore', detached: true });
        const wrapperPid = wrapper.pid!;
        let agentPid = 0;
        let toolPid = 0;
        for (let i = 0; i < 50 && toolPid === 0; i++) {
            await new Promise((r) => setTimeout(r, 100));
            agentPid = childrenOf(wrapperPid)[0] ?? 0;
            toolPid = agentPid ? childrenOf(agentPid)[0] ?? 0 : 0;
        }
        expect(agentPid).toBeGreaterThan(0);
        expect(toolPid).toBeGreaterThan(0);
        try {
            const stopped = await new Promise<boolean>((resolve) => {
                expect(terminateProcessTree(wrapperPid, resolve, { graceMs: 300 })).toBe(true);
            });
            expect(stopped).toBe(true);
            expect(wrapper.signalCode ?? 'SIGKILL').toBe('SIGKILL');
            expect(alive(agentPid)).toBe(false);
            expect(alive(toolPid)).toBe(false);
        } finally {
            for (const pid of [toolPid, agentPid, wrapperPid]) { try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
        }
    }, 15_000);
});

describe('every wrapper stop goes through the tree stop (B-864b)', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

    it.each(['daemon/run.ts', 'utils/sessionLock.ts', 'daemon/doctor.ts'])('%s never stops a wrapper with the single-process terminateProcess', (rel) => {
        const source = read(rel);
        expect(source).not.toMatch(/\bterminateProcess\(/);
        expect(source).toMatch(/\bterminateProcessTree\(/);
    });

    it('wrapper liveness checks treat EPERM as alive', () => {
        expect(read('utils/sessionLock.ts')).toContain('isAlive: (pid) => isProcessAlive(pid)');
        expect(read('daemon/run.ts')).toContain('const isPidAlive = (pid: number): boolean => isProcessAlive(pid);');
        expect(read('daemon/run.ts')).not.toMatch(/process\.kill\(pid, 0\)/);
    });
});
