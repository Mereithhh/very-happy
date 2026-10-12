/**
 * B-548 automation precheck: a cheap command the daemon runs after claiming a
 * run and before its action. Exit 0 runs the action; anything else records the
 * run as `skipped` with a reason code and the output tail. Runs in its own
 * process group (POSIX) so a timeout kills the whole tree: SIGTERM, then
 * SIGKILL after `PRECHECK_KILL_GRACE_MS`.
 *
 * `command` is argv (no shell); `shell` is one command line for the platform
 * shell (`/bin/sh -c` / `cmd.exe /d /s /c`). Output is kept as tails of
 * `AUTOMATION_PRECHECK_OUTPUT_MAX_CHARS`: stdout alone (prompt context) and
 * stdout+stderr merged (the skip summary).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { AUTOMATION_PRECHECK_DEFAULT_TIMEOUT_MS, AUTOMATION_PRECHECK_MAX_TIMEOUT_MS, AUTOMATION_PRECHECK_OUTPUT_MAX_CHARS, AUTOMATION_SUMMARY_MAX_CHARS, type AutomationAction, type AutomationPrecheck, type AutomationSkipReason } from '@slopus/happy-wire';
import { killScriptTree, TailBuffer } from './script';

export const PRECHECK_KILL_GRACE_MS = 2_000;
/** After `exit`, wait at most this long for the pipes to close (a grandchild may hold them). */
export const PRECHECK_DRAIN_MS = 1_000;

export interface PrecheckRunOptions {
    /** argv, or a single shell command line (exactly one). */
    command?: string[];
    shell?: string;
    cwd: string;
    timeoutMs: number;
    env?: Record<string, string>;
    baseEnv?: NodeJS.ProcessEnv;
    onStart?: (child: ChildProcess) => void;
}

export interface PrecheckResult {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    /** stdout tail (prompt context). */
    stdout: string;
    /** stdout + stderr tail (skip summary). */
    output: string;
    /** Launch failure (ENOENT, bad cwd, …). */
    error?: string;
    durationMs: number;
}

export function precheckTimeoutMs(precheck: Pick<AutomationPrecheck, 'timeoutMs'>): number {
    const value = precheck.timeoutMs;
    if (typeof value !== 'number' || !Number.isFinite(value)) return AUTOMATION_PRECHECK_DEFAULT_TIMEOUT_MS;
    return Math.min(AUTOMATION_PRECHECK_MAX_TIMEOUT_MS, Math.max(1000, Math.floor(value)));
}

/** Where the precheck runs unless it names its own cwd: the action's directory, else the daemon's home. */
export function defaultPrecheckCwd(action: AutomationAction): string | undefined {
    if (action.kind === 'spawn') return action.directory;
    if (action.kind === 'script') return action.cwd;
    return undefined;
}

export function runPrecheck(options: PrecheckRunOptions): Promise<PrecheckResult> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
        const stdout = new TailBuffer(AUTOMATION_PRECHECK_OUTPUT_MAX_CHARS);
        const merged = new TailBuffer(AUTOMATION_PRECHECK_OUTPUT_MAX_CHARS);
        let timedOut = false;
        let settled = false;
        let child: ChildProcess;
        const timers: NodeJS.Timeout[] = [];
        const finish = (result: Omit<PrecheckResult, 'durationMs' | 'stdout' | 'output' | 'timedOut'>) => {
            if (settled) return;
            settled = true;
            for (const t of timers) clearTimeout(t);
            resolve({ ...result, timedOut, stdout: stdout.value(), output: merged.value(), durationMs: Date.now() - startedAt });
        };
        const spawnOptions = {
            cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            env: { ...(options.baseEnv ?? process.env), ...(options.env ?? {}) },
        };
        try {
            if (options.shell !== undefined) child = spawn(options.shell, { ...spawnOptions, shell: true });
            else if (options.command && options.command.length > 0) child = spawn(options.command[0], options.command.slice(1), { ...spawnOptions, shell: false });
            else { finish({ exitCode: null, signal: null, error: 'precheck has no command' }); return; }
        } catch (error) {
            finish({ exitCode: null, signal: null, error: error instanceof Error ? error.message : String(error) });
            return;
        }
        const timer = setTimeout(() => {
            timedOut = true;
            killScriptTree(child, 'SIGTERM');
            const killer = setTimeout(() => killScriptTree(child, 'SIGKILL'), PRECHECK_KILL_GRACE_MS);
            killer.unref();
        }, options.timeoutMs);
        timer.unref();
        timers.push(timer);
        options.onStart?.(child);
        child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout.push(chunk); merged.push(chunk); });
        child.stderr?.setEncoding('utf8').on('data', (chunk: string) => merged.push(chunk));
        child.on('error', (error) => finish({ exitCode: null, signal: null, error: error.message }));
        child.on('close', (code, signal) => finish({ exitCode: code, signal }));
        child.on('exit', (code, signal) => {
            const drain = setTimeout(() => { killScriptTree(child, 'SIGKILL'); finish({ exitCode: code, signal }); }, PRECHECK_DRAIN_MS);
            drain.unref();
            timers.push(drain);
        });
    });
}

export type PrecheckVerdict =
    | { pass: true; stdout: string }
    | { pass: false; reason: AutomationSkipReason; attention: boolean; summary: string; exitCode: number | null };

/**
 * Exit 0 (no timeout, no launch error) passes. A non-zero exit is the normal
 * "nothing to do" and is not flagged; a timeout or a launch error is a broken
 * precheck and asks for attention (the server folds repeats, so once per streak).
 */
export function evaluatePrecheck(result: PrecheckResult, timeoutMs: number): PrecheckVerdict {
    if (!result.timedOut && !result.error && result.exitCode === 0) return { pass: true, stdout: result.stdout };
    const tail = result.output.trim();
    const withTail = (line: string) => (tail ? `${line}\n${tail}` : line).slice(0, AUTOMATION_SUMMARY_MAX_CHARS);
    if (result.timedOut) return { pass: false, reason: 'precheck_timeout', attention: true, summary: withTail(`Precheck timed out after ${Math.round(timeoutMs / 1000)}s; the action was not run.`), exitCode: null };
    if (result.error) return { pass: false, reason: 'precheck_error', attention: true, summary: withTail(`Precheck could not run: ${result.error}`), exitCode: null };
    return { pass: false, reason: 'precheck_failed', attention: false, summary: withTail(`Precheck exited ${result.exitCode ?? `on signal ${result.signal}`}; nothing to do.`), exitCode: result.exitCode };
}

/** `includeOutput`: the precheck's stdout rides along as context at the end of the prompt. */
export function appendPrecheckOutput(prompt: string, stdout: string): string {
    const text = stdout.trim();
    return text ? `${prompt}\n\n[precheck output]\n${text}` : prompt;
}
