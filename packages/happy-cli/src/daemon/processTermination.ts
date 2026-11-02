import { spawnSync } from 'node:child_process';

import { killSurvivors, readLiveProcessTable, snapshotTree, survivorsOf, type ProcessEntry, type ProcessTableReader } from '@/utils/processTreeSnapshot';

export type ProcessSignal = 'SIGTERM' | 'SIGKILL';

export interface ProcessTerminationRuntime {
    signal(pid: number, signal: ProcessSignal): void;
    isAlive(pid: number): boolean;
    schedule(callback: () => void, delayMs: number): void;
}

/**
 * B-864b: `kill(pid, 0)` failing with EPERM means the process EXISTS but this
 * user may not signal it. Calling that "dead" let a lock holder or daemon owned
 * by another uid (sudo, a second account on the box) be overwritten while it
 * kept running. Only ESRCH (or a non-positive pid) is "not alive".
 */
export function isProcessAlive(pid: number, kill: (pid: number, signal: 0) => void = (p, s) => { process.kill(p, s); }): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
}

const runtime: ProcessTerminationRuntime = {
    signal: (pid, signal) => process.kill(pid, signal),
    isAlive: (pid) => isProcessAlive(pid),
    schedule: (callback, delayMs) => { setTimeout(callback, delayMs); },
};

export type TerminateHooks = {
    /** Runs right before the SIGKILL escalation, while the process is still alive. */
    beforeKill?: () => void;
};

/** Request a graceful stop, then guarantee an eventual hard-kill attempt.
 * "Already gone" is idempotent success; other signal errors are failures. */
export function terminateProcess(
    pid: number,
    onSettled: (stopped: boolean) => void,
    impl: ProcessTerminationRuntime = runtime,
    graceMs = 2_000,
    hooks: TerminateHooks = {},
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
            try { hooks.beforeKill?.(); } catch { /* best effort */ }
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

/** How long the tree stop keeps re-checking (and re-SIGKILLing) snapshot members after the wrapper settled. */
export const TREE_VERIFY_ATTEMPTS = 20;
const TREE_VERIFY_INTERVAL_MS = 100;

export type TerminateTreeDeps = {
    terminate?: typeof terminateProcess;
    snapshot?: (pid: number) => ProcessEntry[];
    reap?: (snapshot: ProcessEntry[]) => number[];
    /** Live (non-zombie) process table for the "did the tree really stop" check; null = cannot tell. */
    readLive?: ProcessTableReader;
    runtime?: ProcessTerminationRuntime;
    graceMs?: number;
    platform?: NodeJS.Platform;
    onLeftovers?: (pids: number[]) => void;
};

/** Windows: TerminateProcess on the root orphans everything under it; taskkill /T ends the tree. */
const windowsTreeRuntime = (base: ProcessTerminationRuntime): ProcessTerminationRuntime => ({
    ...base,
    signal: (pid, signal) => {
        const result = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
        if (result.status !== 0 && base.isAlive(pid)) base.signal(pid, signal);
    },
});

/**
 * B-634 ① / B-864b: stop a session wrapper AND everything under it (Claude
 * Code, codex app-server, MCP servers, tool commands). A wrapper that exits on
 * its SIGTERM reaps its own tree first (runClaude cleanup); one that has to be
 * SIGKILLed cannot, and its agent re-parents to init and keeps running the turn
 * unowned — the "ghost executor" beside the replacement wrapper.
 *
 * The descendants are snapshotted while the wrapper is alive (once it dies
 * they re-parent and cannot be found by parentage): once up front and again
 * right before the SIGKILL, so a child started during the grace window is in
 * it too. After the wrapper settled every snapshot member that is still the
 * same process (pid + start time) is SIGKILLed, and the stop only reports
 * `stopped` once none of them is left running (zombies excluded) — re-killing
 * for up to ~2 s.
 */
export function terminateProcessTree(
    pid: number,
    onSettled: (stopped: boolean) => void,
    deps: TerminateTreeDeps = {},
): boolean {
    const snapshot = deps.snapshot ?? ((root: number) => snapshotTree(root));
    const reap = deps.reap ?? ((entries: ProcessEntry[]) => killSurvivors(entries));
    const readLive = deps.readLive ?? readLiveProcessTable;
    const base = deps.runtime ?? runtime;
    const impl = (deps.platform ?? process.platform) === 'win32' ? windowsTreeRuntime(base) : base;
    const members = new Map<string, ProcessEntry>();
    const remember = () => {
        try {
            for (const entry of snapshot(pid)) members.set(`${entry.pid}@${entry.start}`, entry);
        } catch { /* best effort */ }
    };
    remember();
    return (deps.terminate ?? terminateProcess)(pid, (stopped) => {
        const tree = [...members.values()];
        let attempt = 0;
        const verify = () => {
            try { reap(tree); } catch { /* best effort */ }
            if (tree.length === 0) {
                onSettled(stopped);
                return;
            }
            let table: ProcessEntry[] | null = null;
            try { table = readLive(); } catch { table = null; }
            const left = table ? survivorsOf(tree, table).filter((entry) => entry.pid !== process.pid) : [];
            if (left.length === 0) {
                onSettled(stopped);
                return;
            }
            attempt += 1;
            if (attempt >= TREE_VERIFY_ATTEMPTS) {
                deps.onLeftovers?.(left.map((entry) => entry.pid));
                onSettled(false);
                return;
            }
            impl.schedule(verify, TREE_VERIFY_INTERVAL_MS);
        };
        verify();
    }, impl, deps.graceMs ?? 2_000, { beforeKill: remember });
}
