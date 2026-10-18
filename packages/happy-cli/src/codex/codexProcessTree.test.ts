import { describe, expect, it, vi } from 'vitest';
import { killCodexProcessTree, stopCodexProcess } from './codexProcessTree';

function fakeProc(pid: number | undefined = 4242) {
    return { pid, kill: vi.fn(), stdin: { end: vi.fn() } };
}

function fakeSpawn() {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const child = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => { handlers[event] = handler; return child; }),
        unref: vi.fn(),
    };
    const spawn = vi.fn(() => child);
    return { spawn, child, handlers };
}

describe('stopCodexProcess (B-628)', () => {
    it('closes stdin and SIGTERMs the launcher on POSIX', () => {
        const proc = fakeProc();
        stopCodexProcess(proc, { platform: 'darwin' });
        expect(proc.stdin.end).toHaveBeenCalled();
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('on Windows only closes stdin — TerminateProcess on the root would orphan the server', () => {
        const proc = fakeProc();
        stopCodexProcess(proc, { platform: 'win32' });
        expect(proc.stdin.end).toHaveBeenCalled();
        expect(proc.kill).not.toHaveBeenCalled();
    });
});

describe('killCodexProcessTree (B-628)', () => {
    it('does nothing for a launcher that already exited', () => {
        const proc = fakeProc();
        const { spawn } = fakeSpawn();
        const kill = vi.fn(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); });
        killCodexProcessTree(proc, { platform: 'linux', spawn, kill });
        expect(spawn).not.toHaveBeenCalled();
        expect(kill).toHaveBeenCalledTimes(1);
        expect(kill).toHaveBeenCalledWith(4242, 0);
    });

    it('reaps the launcher\'s direct children, then the launcher, on POSIX', () => {
        const proc = fakeProc();
        const { spawn, child } = fakeSpawn();
        const kill = vi.fn();
        killCodexProcessTree(proc, { platform: 'darwin', spawn, kill });
        expect(spawn).toHaveBeenCalledWith('pkill', ['-KILL', '-P', '4242'], { stdio: 'ignore', windowsHide: true });
        expect(child.unref).toHaveBeenCalled();
        expect(kill.mock.calls).toEqual([[4242, 0], [4242, 'SIGKILL']]);
    });

    it('walks the tree with taskkill on Windows and falls back to the root when taskkill fails', () => {
        const proc = fakeProc();
        const { spawn, handlers } = fakeSpawn();
        const kill = vi.fn();
        killCodexProcessTree(proc, { platform: 'win32', spawn, kill });
        expect(spawn).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        expect(kill.mock.calls).toEqual([[4242, 0]]);
        handlers.exit?.(1);
        expect(kill.mock.calls).toEqual([[4242, 0], [4242, 'SIGKILL']]);
    });

    it('kills the root directly when taskkill cannot start', () => {
        const proc = fakeProc();
        const spawn = vi.fn(() => { throw new Error('ENOENT'); });
        const kill = vi.fn();
        killCodexProcessTree(proc, { platform: 'win32', spawn, kill });
        expect(kill.mock.calls).toEqual([[4242, 0], [4242, 'SIGKILL']]);
    });

    it('still signals a process without a pid', () => {
        const proc = { pid: undefined, kill: vi.fn(), stdin: { end: vi.fn() } };
        const kill = vi.fn();
        killCodexProcessTree(proc, { platform: 'linux', spawn: vi.fn(), kill });
        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
        expect(kill).not.toHaveBeenCalled();
    });
});
