/**
 * Script action runner (B-496): argv child process, no shell. Merged
 * stdout/stderr tail (4KB) becomes the run summary; exit 0 → done, anything
 * else → failed. Timeout: SIGTERM, then SIGKILL 10s later.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { AUTOMATION_SUMMARY_MAX_CHARS } from '@slopus/happy-wire';

export const SCRIPT_KILL_GRACE_MS = 10_000;

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

export function runScript(options: ScriptRunOptions): Promise<ScriptRunResult> {
    return new Promise((resolve) => {
        const tail = new TailBuffer(AUTOMATION_SUMMARY_MAX_CHARS);
        let timedOut = false;
        let settled = false;
        let child: ChildProcess;
        const finish = (result: ScriptRunResult) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killer); resolve(result); };
        let killer: NodeJS.Timeout | undefined;
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
            killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, SCRIPT_KILL_GRACE_MS);
            killer.unref();
        }, options.timeoutMs);
        timer.unref();
        try {
            child = spawn(options.command[0], options.command.slice(1), {
                cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
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
        child.on('close', (code, signal) => finish({ exitCode: code, signal, timedOut, output: tail.value() }));
    });
}
