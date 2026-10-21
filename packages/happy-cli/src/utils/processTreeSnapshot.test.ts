import { describe, expect, it, vi } from 'vitest';
import { descendantsOf, killSurvivors, parseProcessTable, snapshotTree, survivorsOf, terminateSurvivors, type ProcessEntry } from './processTreeSnapshot';

const T = 'Wed Oct 21 03:00:00 2026';
const e = (pid: number, ppid: number, start = T): ProcessEntry => ({ pid, ppid, start });

describe('process tree snapshot (B-634 ①)', () => {
    it('parses ps -A -o pid=,ppid=,lstart= with spaces inside the start time', () => {
        expect(parseProcessTable(`    1     0 Wed Oct 21 01:00:00 2026\n  200     1 ${T}\n\n`)).toEqual([
            { pid: 1, ppid: 0, start: 'Wed Oct 21 01:00:00 2026' },
            { pid: 200, ppid: 1, start: T },
        ]);
    });

    it('collects every descendant, grandchildren included, and nothing else', () => {
        const table = [e(1, 0), e(10, 1), e(20, 10), e(30, 20), e(31, 20), e(40, 1), e(50, 40)];
        expect(descendantsOf(10, table).map((p) => p.pid)).toEqual([20, 30, 31]);
        expect(snapshotTree(10, { includeRoot: true, read: () => table }).map((p) => p.pid)).toEqual([10, 20, 30, 31]);
        expect(snapshotTree(10, { read: () => null })).toEqual([]);
    });

    it('a survivor must be the same process: a reused pid with another start time is left alone', () => {
        const snapshot = [e(20, 10), e(30, 20), e(31, 20)];
        const later = [e(20, 1), e(30, 1, 'Wed Oct 21 03:05:00 2026')];
        expect(survivorsOf(snapshot, later).map((p) => p.pid)).toEqual([20]);
        const kill = vi.fn();
        expect(killSurvivors(snapshot, { read: () => later, kill })).toEqual([20]);
        expect(kill).toHaveBeenCalledWith(20, 'SIGKILL');
        expect(kill).toHaveBeenCalledTimes(1);
    });

    it('terminateSurvivors: SIGTERM, wait, SIGKILL only who is still there', async () => {
        const snapshot = [e(20, 10), e(30, 20)];
        let table = [...snapshot];
        const kill = vi.fn((pid: number, signal: string) => {
            // 20 obeys SIGTERM, 30 ignores it
            if (signal === 'SIGTERM' && pid === 20) table = table.filter((p) => p.pid !== 20);
            if (signal === 'SIGKILL') table = table.filter((p) => p.pid !== pid);
        });
        await terminateSurvivors(snapshot, { read: () => table, kill, graceMs: 300, sleep: async () => {} });
        expect(kill.mock.calls).toEqual([[20, 'SIGTERM'], [30, 'SIGTERM'], [30, 'SIGKILL']]);
    });

    it('reads the real table on this machine and finds its own child', async () => {
        if (process.platform === 'win32') return;
        const { spawn } = await import('node:child_process');
        const child = spawn('sleep', ['30'], { stdio: 'ignore' });
        try {
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(snapshotTree(process.pid).some((p) => p.pid === child.pid)).toBe(true);
        } finally {
            child.kill('SIGKILL');
        }
    });
});
