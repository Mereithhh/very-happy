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
