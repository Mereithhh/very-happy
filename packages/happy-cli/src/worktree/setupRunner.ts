/**
 * B-585 setup script execution: the APPROVED bytes, written into the daemon's
 * run directory, run in the new worktree with a sanitized environment, in their
 * own process group, with a timeout; stdout/stderr go straight to a log file.
 *
 * Windows runner text follows Orca's `buildWindowsRunnerScript`
 * (src/main/setup-runner-script-text.ts, MIT): `call` each line and stop on the
 * first non-zero errorlevel; delayed expansion off so `!` survives.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, fstatSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupRunner } from './config';

export const SETUP_KILL_GRACE_MS = 10_000;
/** Output beyond this stops the run (a runaway loop must not fill the disk). */
export const SETUP_LOG_MAX_BYTES = 20 * 1024 * 1024;
const LOG_CHECK_MS = 500;

/** One CRLF batch file: `call <line>` + errorlevel check per non-empty line. */
export function buildWindowsRunnerScript(script: string): string {
    const header = '@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n';
    let out = header;
    for (const raw of script.split('\n')) {
        const line = raw.replace(/\r$/, '').trim();
        if (!line) { out += '\r\n'; continue; }
        out += `call ${line}\r\nif errorlevel 1 exit /b %errorlevel%\r\n`;
    }
    return out;
}

/**
 * The daemon's environment minus very-happy internals (`HAPPY_*` / `VH_*`:
 * server URLs, team scope files, reconnect keys). Nothing is added except two
 * plain path variables.
 */
export function sanitizeSetupEnv(base: NodeJS.ProcessEnv, paths: { worktree: string; root: string }): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
        if (value === undefined) continue;
        if (/^(HAPPY|VH)_/i.test(key)) continue;
        env[key] = value;
    }
    env.VERY_HAPPY_WORKTREE_PATH = paths.worktree;
    env.VERY_HAPPY_ROOT_PATH = paths.root;
    return env;
}

export interface RunnerLaunch { command: string; args: string[]; scriptPath: string }

/** Write the runner file for `runner` into `runDir`; return how to start it. */
export function prepareRunner(runDir: string, runner: SetupRunner, script: string): RunnerLaunch {
    if (runner === 'cmd') {
        const scriptPath = join(runDir, 'setup.cmd');
        writeFileSync(scriptPath, buildWindowsRunnerScript(script), { mode: 0o600 });
        return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', scriptPath], scriptPath };
    }
    const scriptPath = join(runDir, runner === 'shebang' ? 'setup' : 'setup.sh');
    writeFileSync(scriptPath, script, { mode: 0o700 });
    if (runner === 'shebang') {
        chmodSync(scriptPath, 0o700);
        return { command: scriptPath, args: [], scriptPath };
    }
    return { command: '/bin/sh', args: ['-e', scriptPath], scriptPath };
}

export interface SetupRunOutcome {
    state: 'succeeded' | 'failed' | 'timed-out' | 'interrupted';
    exitCode: number | null;
    message?: string;
    /** The output cap was hit and the run was killed. */
    truncated?: boolean;
}

export interface SetupRunHandle {
    pid: number | undefined;
    /** Resolves once the process has exited (or failed to start). */
    done: Promise<SetupRunOutcome>;
    /** Kill the whole tree; the outcome becomes `interrupted` unless already settled. */
    stop(): void;
}

/** Kill the whole tree: POSIX process group; Windows `taskkill /T /F`. */
export function killSetupTree(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
        if (platform === 'win32') {
            spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
        } else {
            process.kill(-child.pid, signal);
        }
    } catch {
        try { child.kill(signal); } catch { /* gone */ }
    }
}

export function startSetupRun(opts: {
    launch: RunnerLaunch;
    cwd: string;
    env: Record<string, string>;
    logPath: string;
    timeoutMs: number;
    maxLogBytes?: number;
    spawnImpl?: typeof spawn;
}): SetupRunHandle {
    const maxLogBytes = opts.maxLogBytes ?? SETUP_LOG_MAX_BYTES;
    const logFd = openSync(opts.logPath, 'a', 0o600);
    let child: ChildProcess;
    let interrupted = false;
    let timedOut = false;
    let truncated = false;
    let settle: (outcome: SetupRunOutcome) => void = () => undefined;
    const done = new Promise<SetupRunOutcome>((resolve) => { settle = resolve; });
    let settled = false;
    const finish = (outcome: SetupRunOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(sizeWatch);
        try { closeSync(logFd); } catch { /* already closed */ }
        settle(outcome);
    };
    const terminate = () => {
        killSetupTree(child, 'SIGTERM');
        const hard = setTimeout(() => killSetupTree(child, 'SIGKILL'), SETUP_KILL_GRACE_MS);
        hard.unref();
        child.once('exit', () => clearTimeout(hard));
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, opts.timeoutMs);
    timer.unref();
    const sizeWatch = setInterval(() => {
        if (truncated) return;
        let size = 0;
        try { size = fstatSync(logFd).size; } catch { return; }
        if (size > maxLogBytes) { truncated = true; terminate(); }
    }, LOG_CHECK_MS);
    sizeWatch.unref();
    try {
        child = (opts.spawnImpl ?? spawn)(opts.launch.command, opts.launch.args, {
            cwd: opts.cwd,
            env: opts.env,
            shell: false,
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['ignore', logFd, logFd],
        });
    } catch (error) {
        finish({ state: 'failed', exitCode: null, message: error instanceof Error ? error.message : String(error) });
        return { pid: undefined, done, stop: () => undefined };
    }
    child.on('error', (error) => finish({ state: 'failed', exitCode: null, message: error.message }));
    child.on('exit', (code, signal) => {
        // Orphaned grandchildren in the group die with the leader (the leader
        // has exited, so killSetupTree's liveness guard would skip it).
        if (process.platform !== 'win32' && child.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already empty */ }
        }
        if (truncated) finish({ state: 'failed', exitCode: code, truncated: true, message: `Output exceeded ${Math.round(maxLogBytes / 1024 / 1024)} MB; stopped` });
        else if (timedOut) finish({ state: 'timed-out', exitCode: code, message: `Timed out after ${Math.round(opts.timeoutMs / 60000)} min` });
        else if (interrupted) finish({ state: 'interrupted', exitCode: code, message: 'Stopped' });
        else if (code === 0) finish({ state: 'succeeded', exitCode: 0 });
        else finish({ state: 'failed', exitCode: code, ...(signal ? { message: `Killed by ${signal}` } : {}) });
    });
    return {
        pid: child.pid,
        done,
        stop: () => { if (settled) return; interrupted = true; terminate(); },
    };
}
