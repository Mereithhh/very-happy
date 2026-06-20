/**
 * Web terminal manager (daemon side).
 *
 * Bridges a browser xterm.js terminal to a real PTY on this machine. Each web
 * terminal tab gets its own tmux session `vh-<id>` spawned inside a node-pty,
 * so the user can also `tmux attach -t vh-<id>` locally and share the session.
 * If tmux isn't installed we fall back to the login shell directly (no local
 * attach, but the terminal still works).
 *
 * Transport: raw bytes are relayed base64 over the (TLS) socket through the
 * server, consistent with the server-trusted model. open/resize/close are
 * driven from apiMachine; output is pushed via the injected emit callback.
 */
import * as pty from 'node-pty';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { logger } from '@/ui/logger';

export interface OpenTerminalOptions {
    /** Client-owned id → tmux session `vh-<id>`. Reusing it reattaches to the
     *  same live session (state survives). Omitted → a fresh random id. */
    terminalId?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
}

type EmitFn = (event: string, payload: any) => void;

interface TerminalEntry {
    pty: pty.IPty;
    tmuxSession?: string;
}

let tmuxAvailableCache: boolean | null = null;
function isTmuxAvailable(): boolean {
    if (tmuxAvailableCache !== null) return tmuxAvailableCache;
    try {
        const r = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
        tmuxAvailableCache = r.status === 0;
    } catch {
        tmuxAvailableCache = false;
    }
    return tmuxAvailableCache;
}

function defaultShell(): string {
    if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
    return process.env.SHELL || '/bin/bash';
}

/** Ensure ~/.local/bin is on PATH so `claude` and friends are findable. */
function ptyEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') env[k] = v;
    }
    const local = `${os.homedir()}/.local/bin`;
    if (!(env.PATH || '').split(':').includes(local)) {
        env.PATH = `${local}:${env.PATH || ''}`;
    }
    env.TERM = 'xterm-256color';
    return env;
}

export class WebTerminalManager {
    private terminals = new Map<string, TerminalEntry>();
    private emit: EmitFn;

    constructor(emit: EmitFn) {
        this.emit = emit;
    }

    /** Update the emitter when the socket reconnects. */
    setEmit(emit: EmitFn) {
        this.emit = emit;
    }

    open(opts: OpenTerminalOptions): { terminalId: string; tmuxSession?: string } {
        const cols = Math.max(2, Math.floor(opts.cols ?? 80));
        const rows = Math.max(2, Math.floor(opts.rows ?? 24));
        const cwd = opts.cwd && opts.cwd.length > 0 ? opts.cwd : os.homedir();
        const id = opts.terminalId && /^[a-zA-Z0-9_-]{1,64}$/.test(opts.terminalId)
            ? opts.terminalId
            : randomBytes(5).toString('hex');
        // Reopening an id: drop the previous pty client (the tmux session lives
        // on) before attaching a fresh one.
        if (this.terminals.has(id)) {
            try { this.terminals.get(id)!.pty.kill(); } catch { /* gone */ }
            this.terminals.delete(id);
        }
        // Bulletproof single-client: explicitly detach ANY clients still
        // attached to this tmux session (a killed pty's client can linger and
        // survive SIGHUP). Multiple clients clamp the session size and garble
        // redraws / double-echo. Safe no-op if the session doesn't exist yet.
        if (isTmuxAvailable()) {
            try { spawnSync('tmux', ['detach-client', '-s', `vh-${id}`], { stdio: 'ignore' }); } catch { /* none */ }
        }
        const env = ptyEnv();

        let file: string;
        let args: string[];
        let tmuxSession: string | undefined;

        if (isTmuxAvailable()) {
            tmuxSession = `vh-${id}`;
            // Create-or-noop the session detached, then attach with `-d` so any
            // OTHER client (a stale web view, or a local attach) is detached —
            // a single client means the session size follows THIS xterm and we
            // avoid the multi-client size-clamp that garbles redraws. id is
            // validated to [A-Za-z0-9_-], cols/rows are ints → safe to inline.
            file = '/bin/sh';
            args = ['-c',
                `tmux new-session -A -d -s ${tmuxSession} -x ${cols} -y ${rows} >/dev/null 2>&1; `
                + `exec tmux attach-session -d -t ${tmuxSession}`];
        } else {
            file = defaultShell();
            args = [];
        }

        const proc = pty.spawn(file, args, {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env,
        });

        this.terminals.set(id, { pty: proc, tmuxSession });

        proc.onData((data) => {
            this.emit('terminal-output', { terminalId: id, data: Buffer.from(data, 'utf8').toString('base64') });
        });
        proc.onExit(({ exitCode }) => {
            this.terminals.delete(id);
            this.emit('terminal-exit', { terminalId: id, exitCode });
        });

        logger.debug(`[WEB TERMINAL] opened ${id} (${file} ${args.join(' ')}) ${cols}x${rows} cwd=${cwd}`);
        return { terminalId: id, tmuxSession };
    }

    write(terminalId: string, dataBase64: string) {
        const entry = this.terminals.get(terminalId);
        if (!entry) return;
        entry.pty.write(Buffer.from(dataBase64, 'base64').toString('utf8'));
    }

    resize(terminalId: string, cols: number, rows: number) {
        const entry = this.terminals.get(terminalId);
        if (!entry) return;
        try {
            entry.pty.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)));
        } catch (e) {
            logger.debug(`[WEB TERMINAL] resize ${terminalId} failed: ${e}`);
        }
    }

    /** Close the web view's PTY. With tmux this only detaches the client — the
     *  `vh-<id>` session keeps running so a local `tmux attach` survives. */
    close(terminalId: string) {
        const entry = this.terminals.get(terminalId);
        if (!entry) return;
        this.terminals.delete(terminalId);
        try {
            entry.pty.kill();
        } catch {
            // already gone
        }
        logger.debug(`[WEB TERMINAL] closed ${terminalId}`);
    }

    /** Permanently destroy the terminal: close the pty AND kill the tmux
     *  session (so a local `tmux attach` won't find it either). Used when the
     *  user deletes the terminal from the sidebar. */
    killSession(terminalId: string) {
        this.close(terminalId);
        try {
            spawnSync('tmux', ['kill-session', '-t', `vh-${terminalId}`], { stdio: 'ignore' });
        } catch {
            // tmux gone / session already dead
        }
        logger.debug(`[WEB TERMINAL] killed session vh-${terminalId}`);
    }

    closeAll() {
        for (const id of [...this.terminals.keys()]) this.close(id);
    }
}
