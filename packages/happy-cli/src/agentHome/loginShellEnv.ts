/**
 * Ask the daemon user's login shell what it exports (B-478).
 *
 * The daemon's `process.env` is a snapshot of whichever shell ran
 * `daemon start` (or of the service manager, which has almost nothing), so a
 * variable the user added to `.zshrc` / `.bashrc` afterwards never reaches it.
 * `claude --resume` typed in a terminal DOES see it. Running the login shell
 * once with a tiny `printf` and parsing marker lines gives the daemon the same
 * view, without guessing which rc file the user edits.
 *
 * `-l -i` on purpose: exports usually live in the interactive rc file. The
 * shell may print banners or prompts around our lines, hence the marker.
 * Anything odd (no shell, Windows, timeout, non-zero exit without a marker)
 * yields `null` and the caller falls back to the daemon env.
 */
import { spawn } from 'node:child_process';

export const LOGIN_SHELL_ENV_MARKER = '__VH_ENV__';
export const LOGIN_SHELL_PROBE_TIMEOUT_MS = 3_000;

/** POSIX `printf` re-applies the format for every extra pair of arguments, so
 *  one call prints one marker line per variable. Works in sh, bash, zsh and fish. */
export function loginShellProbeScript(names: readonly string[]): string {
    const pairs = names.map(name => `${name} "$${name}"`).join(' ');
    return `printf '${LOGIN_SHELL_ENV_MARKER}%s=%s\\n' ${pairs}`;
}

/** Pull `NAME=value` out of marker lines; everything else the shell printed is
 *  ignored. Only the requested names are returned, unset ones as `undefined`. */
export function parseLoginShellEnv(output: string, names: readonly string[]): Record<string, string | undefined> {
    const wanted = new Set(names);
    const env: Record<string, string | undefined> = {};
    for (const rawLine of output.split(/\r?\n/)) {
        const at = rawLine.indexOf(LOGIN_SHELL_ENV_MARKER);
        if (at < 0) continue;
        const line = rawLine.slice(at + LOGIN_SHELL_ENV_MARKER.length);
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const name = line.slice(0, eq);
        if (!wanted.has(name)) continue;
        const value = line.slice(eq + 1).trim();
        env[name] = value ? value : undefined;
    }
    return env;
}

export interface ProbeLoginShellOptions {
    shell?: string | undefined;
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}

/**
 * Resolves to the exported values, or `null` when the shell could not be
 * asked. Never rejects.
 */
export function probeLoginShellEnv(
    names: readonly string[],
    options: ProbeLoginShellOptions = {},
): Promise<Record<string, string | undefined> | null> {
    const platform = options.platform ?? process.platform;
    if (platform === 'win32') return Promise.resolve(null);
    const shell = (options.shell ?? process.env.SHELL ?? '').trim() || '/bin/sh';
    const timeoutMs = options.timeoutMs ?? LOGIN_SHELL_PROBE_TIMEOUT_MS;

    return new Promise((resolve) => {
        let stdout = '';
        let settled = false;
        const finish = (value: Record<string, string | undefined> | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(shell, ['-l', '-i', '-c', loginShellProbeScript(names)], {
                stdio: ['ignore', 'pipe', 'ignore'],
                env: options.env ?? process.env,
                windowsHide: true,
            });
        } catch {
            resolve(null);
            return;
        }
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
            finish(null);
        }, timeoutMs);
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.on('error', () => finish(null));
        child.on('close', () => {
            // A non-zero exit is fine as long as our marker lines came through
            // (rc files often end with a failing command).
            finish(stdout.includes(LOGIN_SHELL_ENV_MARKER) ? parseLoginShellEnv(stdout, names) : null);
        });
    });
}
