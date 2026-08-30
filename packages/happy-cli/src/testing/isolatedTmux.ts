/**
 * Test-only: a private tmux server that can never be the user's.
 *
 * Incident 2026-08-31 (00:42, 01:35 — every vh-* web terminal on mac-office
 * killed twice): the tmux suites relied on TMUX_TMPDIR, which a tmux client
 * ignores whenever an inherited `$TMUX` names another socket (tests run from
 * a web terminal). Their `kill-server` then hit the daemon's real server.
 *
 * This helper makes isolation explicit and env-independent:
 *  - every call goes through `tmux -S <tmpdir>/sock` (never TMUX_TMPDIR);
 *  - the client env has TMUX / TMUX_PANE / TMUX_TMPDIR removed;
 *  - production code under test is pointed at the same socket through
 *    VH_TMUX_SOCKET (see src/terminal/tmuxSocket.ts);
 *  - `killServer()` is the ONLY kill-server, and it is socket-bound.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { VH_TMUX_SOCKET_ENV } from '@/terminal/tmuxSocket';

export interface IsolatedTmux {
    dir: string;
    socket: string;
    /** Scrubbed env for clients: no TMUX / TMUX_PANE / TMUX_TMPDIR, VH_TMUX_SOCKET set. */
    env: Record<string, string>;
    /** `tmux -S <socket> ...args` with the scrubbed env. */
    spawn(args: readonly string[], opts?: SpawnSyncOptions): SpawnSyncReturns<string>;
    /** Convenience: utf8 stdout/stderr result. */
    run(...args: string[]): SpawnSyncReturns<string>;
    hasSession(name: string): boolean;
    sessionNames(): string[];
    /** Kill the private server only (explicit -S). */
    killServer(): void;
    /** killServer + remove tmpdir + restore process.env. */
    dispose(): void;
}

function scrubbedEnv(socket: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.TMUX_TMPDIR;
    env[VH_TMUX_SOCKET_ENV] = socket;
    return env;
}

export const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

/**
 * Create the private socket and point process.env at it (so the
 * WebTerminalManager under test uses the same server). Call `dispose()` in
 * afterAll.
 */
export function createIsolatedTmux(prefix: string): IsolatedTmux {
    const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
    const socket = join(dir, 'sock');
    const saved = {
        TMUX: process.env.TMUX,
        TMUX_PANE: process.env.TMUX_PANE,
        TMUX_TMPDIR: process.env.TMUX_TMPDIR,
        socket: process.env[VH_TMUX_SOCKET_ENV],
    };
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    delete process.env.TMUX_TMPDIR;
    process.env[VH_TMUX_SOCKET_ENV] = socket;
    const env = scrubbedEnv(socket);

    const spawn = (args: readonly string[], opts: SpawnSyncOptions = {}) =>
        spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', ...opts, env: { ...env, ...(opts.env ?? {}) } }) as SpawnSyncReturns<string>;
    const run = (...args: string[]) => spawn(args);
    const restore = (key: 'TMUX' | 'TMUX_PANE' | 'TMUX_TMPDIR', value: string | undefined) => {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    };
    return {
        dir,
        socket,
        env,
        spawn,
        run,
        hasSession: (name) => spawn(['has-session', '-t', `=${name}:`], { stdio: 'ignore' }).status === 0,
        sessionNames: () => (run('list-sessions', '-F', '#{session_name}').stdout ?? '').split('\n').filter(Boolean),
        killServer: () => { spawn(['kill-server'], { stdio: 'ignore' }); },
        dispose: () => {
            spawn(['kill-server'], { stdio: 'ignore' });
            rmSync(dir, { recursive: true, force: true });
            restore('TMUX', saved.TMUX);
            restore('TMUX_PANE', saved.TMUX_PANE);
            restore('TMUX_TMPDIR', saved.TMUX_TMPDIR);
            if (saved.socket === undefined) delete process.env[VH_TMUX_SOCKET_ENV];
            else process.env[VH_TMUX_SOCKET_ENV] = saved.socket;
        },
    };
}
