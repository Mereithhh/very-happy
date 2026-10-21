import { killSurvivors, snapshotTree, type ProcessEntry } from '@/utils/processTreeSnapshot';

export type ProcessSignal = 'SIGTERM' | 'SIGKILL';

export interface ProcessTerminationRuntime {
    signal(pid: number, signal: ProcessSignal): void;
    isAlive(pid: number): boolean;
    schedule(callback: () => void, delayMs: number): void;
}

const runtime: ProcessTerminationRuntime = {
    signal: (pid, signal) => process.kill(pid, signal),
    isAlive: (pid) => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    },
    schedule: (callback, delayMs) => { setTimeout(callback, delayMs); },
};

/** Request a graceful stop, then guarantee an eventual hard-kill attempt.
 * "Already gone" is idempotent success; other signal errors are failures. */
export function terminateProcess(
    pid: number,
    onSettled: (stopped: boolean) => void,
    impl: ProcessTerminationRuntime = runtime,
    graceMs = 2_000,
): boolean {
    if (!impl.isAlive(pid)) {
        onSettled(true);
        return true;
    }
    try {
        impl.signal(pid, 'SIGTERM');
    } catch {
        return false;
    }
    impl.schedule(() => {
        if (impl.isAlive(pid)) {
            try {
                impl.signal(pid, 'SIGKILL');
            } catch {
                onSettled(!impl.isAlive(pid));
                return;
            }
        }
        impl.schedule(() => onSettled(!impl.isAlive(pid)), 100);
    }, graceMs);
    return true;
}

/**
 * B-634 ①: {@link terminateProcess} for a session wrapper, plus what runs under
 * it. The descendants are snapshotted while the wrapper is alive (once it dies
 * they re-parent and cannot be found); after it settled, every snapshot member
 * that is still the same process is SIGKILLed. A wrapper that exits on its
 * SIGTERM reaps its own tree first (runClaude cleanup), so this only finds
 * something when it was SIGKILLed or wedged — then Claude Code, its MCP
 * servers and tool commands would otherwise keep running unowned.
 */
export function terminateProcessTree(
    pid: number,
    onSettled: (stopped: boolean) => void,
    deps: { terminate?: typeof terminateProcess; snapshot?: (pid: number) => ProcessEntry[]; reap?: (snapshot: ProcessEntry[]) => number[] } = {},
): boolean {
    const snapshot = (deps.snapshot ?? ((root) => snapshotTree(root)))(pid);
    const reap = deps.reap ?? ((entries) => killSurvivors(entries));
    return (deps.terminate ?? terminateProcess)(pid, (stopped) => {
        try { reap(snapshot); } catch { /* best effort */ }
        onSettled(stopped);
    });
}
