/**
 * B-628 / B-629: stopping an agent child process together with what it started.
 *
 * Agent CLIs from npm are node launchers around a native binary or another node process
 * (codex's `bin/codex.js` forwards SIGINT/SIGTERM/SIGHUP to it — nothing can forward SIGKILL;
 * `gemini --experimental-acp` and `pi-acp` are node processes that spawn more); on Windows the
 * child is launched through cmd.exe, and TerminateProcess on that root leaves everything under
 * it running. So the graceful stop stays a SIGTERM to the launcher on POSIX and is only stdin
 * EOF on Windows (no graceful signal exists there), and the forced stop that follows reaches
 * the tree: `taskkill /T /F` on Windows, the launcher's direct children (`pkill -KILL -P`) then
 * the launcher on POSIX. This is the shape of Orca's `killCodexAppServerProcessTree`
 * (src/main/codex/codex-app-server-process-tree-kill.ts, MIT), rewritten; it stops at direct
 * children on purpose — the agent's own shell commands are its to reap.
 *
 * The pid is only ever used for the reap, and only while Node still holds the live child (no
 * `exitCode`/`signalCode` yet): a pid Node has seen exit may already be someone else's. The root
 * itself is always signalled through the ChildProcess handle, which is a no-op once it exited.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

/** What the tree kill needs of the helper process it spawns. */
export type SpawnedKiller = {
    on: (event: 'error' | 'exit', handler: (...args: any[]) => void) => unknown;
    unref: () => unknown;
};

export type ProcessTreeDeps = {
    platform?: NodeJS.Platform;
    /** `child_process.spawn`, injectable for tests. */
    spawn?: (command: string, args: string[], options: { stdio: 'ignore'; windowsHide: true }) => SpawnedKiller;
};

export type StoppableProcess = Pick<ChildProcess, 'pid' | 'kill'> & {
    stdin?: { end: () => void } | null;
    exitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
};

/** Graceful stop: close stdin, and on POSIX SIGTERM the launcher (which forwards it). */
export function stopProcessGracefully(proc: StoppableProcess, deps: ProcessTreeDeps = {}): void {
    const platform = deps.platform ?? process.platform;
    try { proc.stdin?.end(); } catch { /* ignore */ }
    // On Windows `kill` is TerminateProcess on the root alone, which orphans the native
    // server under it; the tree kill below is what ends it, after the stdin EOF had its chance.
    if (platform === 'win32') return;
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
}

/** Forced stop of whatever is still alive: the launcher's direct children, then the launcher. */
export function killProcessTree(proc: StoppableProcess, deps: ProcessTreeDeps = {}): void {
    // Node saw it exit: nothing of ours is left under that pid, which may already be reused.
    if (proc.exitCode != null || proc.signalCode != null) return;
    const killRoot = () => { try { proc.kill('SIGKILL'); } catch { /* gone meanwhile */ } };
    const pid = proc.pid;
    // A handle that does not track exit is not a live ChildProcess: never aim a pid at a guess.
    if (!pid || !('exitCode' in proc)) {
        killRoot();
        return;
    }
    const platform = deps.platform ?? process.platform;
    const spawn = deps.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
    if (platform === 'win32') {
        try {
            const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
            killer.on('error', killRoot);
            killer.on('exit', (code) => { if (code !== 0) killRoot(); });
            killer.unref();
        } catch {
            killRoot();
        }
        return;
    }
    try {
        const reaper = spawn('pkill', ['-KILL', '-P', String(pid)], { stdio: 'ignore', windowsHide: true });
        // No pkill on this box surfaces as an async 'error'; the root kill below is still the floor.
        reaper.on('error', () => undefined);
        reaper.unref();
    } catch { /* ignore */ }
    killRoot();
}

/** Last stderr lines as one line a person can read: ANSI stripped, whitespace folded. */
export function readableStderrTail(ring: string): string {
    return ring.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
}

/** Appends a stderr chunk to a bounded ring (the agent's last words when it dies). */
export function appendStderrRing(ring: string, chunk: string, maxChars: number): string {
    const text = chunk.trim();
    if (!text) return ring;
    return `${ring}\n${text}`.slice(-maxChars);
}
