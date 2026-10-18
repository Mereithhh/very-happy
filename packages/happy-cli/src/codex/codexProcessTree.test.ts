import { describe, expect, it, vi } from 'vitest';
import { killCodexProcessTree, stopCodexProcess } from './codexProcessTree';

/** A live ChildProcess as Node presents it: pid known, exit not seen yet. */
function liveProc(pid = 4242) {
    return { pid, kill: vi.fn(), stdin: { end: vi.fn() }, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
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
        const proc = liveProc();
        stopCodexProcess(proc, { platform: 'darwin' });
        expect(proc.stdin.end).toHaveBeenCalled();
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('on Windows only closes stdin — TerminateProcess on the root would orphan the server', () => {
        const proc = liveProc();
        stopCodexProcess(proc, { platform: 'win32' });
        expect(proc.stdin.end).toHaveBeenCalled();
        expect(proc.kill).not.toHaveBeenCalled();
    });
});

describe('killCodexProcessTree (B-628)', () => {
    it('does nothing for a launcher Node has seen exit — its pid may be someone else\'s by now', () => {
        const { spawn } = fakeSpawn();
        for (const exited of [{ ...liveProc(), exitCode: 0 }, { ...liveProc(), signalCode: 'SIGTERM' as const }]) {
            killCodexProcessTree(exited, { platform: 'linux', spawn });
            expect(spawn).not.toHaveBeenCalled();
            expect(exited.kill).not.toHaveBeenCalled();
        }
    });

    it('reaps the launcher\'s direct children by pid, then the launcher through its handle, on POSIX', () => {
        const proc = liveProc();
        const { spawn, child } = fakeSpawn();
        killCodexProcessTree(proc, { platform: 'darwin', spawn });
        expect(spawn).toHaveBeenCalledWith('pkill', ['-KILL', '-P', '4242'], { stdio: 'ignore', windowsHide: true });
        expect(child.unref).toHaveBeenCalled();
        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('walks the tree with taskkill on Windows and falls back to the root handle when taskkill fails', () => {
        const proc = liveProc();
        const { spawn, handlers } = fakeSpawn();
        killCodexProcessTree(proc, { platform: 'win32', spawn });
        expect(spawn).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        expect(proc.kill).not.toHaveBeenCalled();
        handlers.exit?.(128);
        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('kills the root directly when taskkill cannot start', () => {
        const proc = liveProc();
        const spawn = vi.fn(() => { throw new Error('ENOENT'); });
        killCodexProcessTree(proc, { platform: 'win32', spawn });
        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('never aims a pid at a handle that does not track exit (a test double, no pid): root kill only', () => {
        const { spawn } = fakeSpawn();
        const untracked = { pid: 3011, kill: vi.fn(), stdin: { end: vi.fn() } };
        killCodexProcessTree(untracked, { platform: 'linux', spawn });
        const noPid = { ...liveProc(), pid: undefined };
        killCodexProcessTree(noPid, { platform: 'linux', spawn });
        expect(spawn).not.toHaveBeenCalled();
        expect(untracked.kill).toHaveBeenCalledWith('SIGKILL');
        expect(noPid.kill).toHaveBeenCalledWith('SIGKILL');
    });
});
