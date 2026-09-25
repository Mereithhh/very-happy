/**
 * Script action runner (B-496): argv child process, no shell, in its own
 * process group so a timeout or cancellation kills the whole tree (a `sh -c`
 * wrapper's children included). Merged stdout/stderr tail (4KB) becomes the
 * run summary; exit 0 → done, anything else → failed. Timeout: SIGTERM to
 * the group, then SIGKILL 10s later. The result settles on `exit` plus a short
 * drain window for the pipes — a grandchild holding stdout open must not keep
 * the run alive forever.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { AUTOMATION_SUMMARY_MAX_CHARS } from '@slopus/happy-wire';

export const SCRIPT_KILL_GRACE_MS = 10_000;
/** After `exit`, wait at most this long for the pipes to close. */
export const SCRIPT_DRAIN_MS = 2_000;

export interface ScriptRunOptions {
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    /** Base environment (defaults to the daemon's). */
    baseEnv?: NodeJS.ProcessEnv;
    onStart?: (child: ChildProcess) => void;
}

export interface ScriptRunResult {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    /** Merged stdout+stderr, last AUTOMATION_SUMMARY_MAX_CHARS characters. */
    output: string;
    /** Launch failure (ENOENT, EACCES, …). */
    error?: string;
}

/** Keep only the tail of a growing text without unbounded memory. */
export class TailBuffer {
    private text = '';
    constructor(private readonly maxChars: number) {}
    push(chunk: string): void {
        this.text += chunk;
        if (this.text.length > this.maxChars * 2) this.text = this.text.slice(this.text.length - this.maxChars);
    }
    value(): string { return this.text.length > this.maxChars ? this.text.slice(this.text.length - this.maxChars) : this.text; }
}

/** Signal the child's whole process group (POSIX); the child alone on Windows. */
export function killScriptTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
    } catch {
        try { child.kill(signal); } catch { /* already gone */ }
    }
}

/** SIGTERM the tree now and SIGKILL it after the grace period (used by cancellation and daemon shutdown). */
export function terminateScriptTree(child: ChildProcess): void {
    killScriptTree(child, 'SIGTERM');
    const killer = setTimeout(() => killScriptTree(child, 'SIGKILL'), SCRIPT_KILL_GRACE_MS);
    killer.unref();
    child.once('exit', () => clearTimeout(killer));
}

export function runScript(options: ScriptRunOptions): Promise<ScriptRunResult> {
    return new Promise((resolve) => {
        const tail = new TailBuffer(AUTOMATION_SUMMARY_MAX_CHARS);
        let timedOut = false;
        let settled = false;
        let child: ChildProcess;
        const timers: NodeJS.Timeout[] = [];
        const finish = (result: ScriptRunResult) => { if (settled) return; settled = true; for (const t of timers) clearTimeout(t); resolve(result); };
        const timer = setTimeout(() => { timedOut = true; terminateScriptTree(child); }, options.timeoutMs);
        timer.unref();
        timers.push(timer);
        try {
            child = spawn(options.command[0], options.command.slice(1), {
                cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
                detached: process.platform !== 'win32',
                env: { ...(options.baseEnv ?? process.env), ...(options.env ?? {}) },
            });
        } catch (error) {
            finish({ exitCode: null, signal: null, timedOut: false, output: '', error: error instanceof Error ? error.message : String(error) });
            return;
        }
        options.onStart?.(child);
        child.stdout?.setEncoding('utf8').on('data', (chunk: string) => tail.push(chunk));
        child.stderr?.setEncoding('utf8').on('data', (chunk: string) => tail.push(chunk));
        child.on('error', (error) => finish({ exitCode: null, signal: null, timedOut, output: tail.value(), error: error.message }));
        // `close` waits for every pipe holder; a detached grandchild can keep them
        // open, so settle on `exit` after a bounded drain.
        child.on('close', (code, signal) => finish({ exitCode: code, signal, timedOut, output: tail.value() }));
        child.on('exit', (code, signal) => {
            const drain = setTimeout(() => {
                killScriptTree(child, 'SIGKILL');
                finish({ exitCode: code, signal, timedOut, output: tail.value() });
            }, SCRIPT_DRAIN_MS);
            drain.unref();
            timers.push(drain);
        });
    });
}
