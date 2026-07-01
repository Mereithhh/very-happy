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
    lastTouch: number;
}

// A web-terminal pty is just a `tmux attach` client; the tmux SESSION holds the
// real state, so a pty is disposable (reopening reattaches). Bound live ptys so
// orphaned ones — web views that vanished without sending `terminal-close`
// (tab closed, nav, socket drop) — can't accumulate and exhaust the system PTY
// pool (kern.tty.ptmx_max ~511 → node-pty `posix_spawnp failed` → black screen).
const MAX_LIVE_PTYS = 24;              // hard cap; LRU-evict oldest-touched beyond this
const PTY_IDLE_MS = 20 * 60 * 1000;    // reap ptys with no input/resize for 20 min
const REAP_INTERVAL_MS = 5 * 60 * 1000;

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
    // Ensure a UTF-8 locale so tmux + the shell treat CJK/emoji as wide chars.
    // The daemon is often launched without LANG (launchd/GUI context) → tmux
    // falls back to the C locale → multibyte input renders at width 1 and
    // overlaps ("中文" overwrites itself). Only inject when no UTF-8 locale is
    // already present, so we never clobber a user's own zh_CN.UTF-8 etc.
    const isUtf8 = (v?: string) => !!v && /utf-?8/i.test(v);
    if (!isUtf8(env.LC_ALL) && !isUtf8(env.LANG) && !isUtf8(env.LC_CTYPE)) {
        env.LANG = 'en_US.UTF-8';
        env.LC_CTYPE = 'en_US.UTF-8';
    }
    return env;
}

export class WebTerminalManager {
    private terminals = new Map<string, TerminalEntry>();
    private emit: EmitFn;
    private reaper: ReturnType<typeof setInterval>;

    constructor(emit: EmitFn) {
        this.emit = emit;
        // Periodically reap idle/orphaned ptys (detach only — tmux session lives).
        this.reaper = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS);
        this.reaper.unref?.();
    }

    /** Detach ptys with no client activity for PTY_IDLE_MS (orphaned web views).
     *  The tmux `vh-<id>` session survives, so reopening reattaches instantly. */
    private reapIdle() {
        const now = Date.now();
        for (const [id, entry] of [...this.terminals]) {
            if (now - entry.lastTouch > PTY_IDLE_MS) {
                logger.debug(`[WEB TERMINAL] reaping idle pty ${id} (idle ${Math.round((now - entry.lastTouch) / 60000)}m)`);
                this.close(id);
            }
        }
    }

    /** Enforce the live-pty cap by detaching the least-recently-touched ones
     *  (their tmux sessions survive). Guards against orphan accumulation even
     *  when few new terminals are opened to trigger natural eviction. */
    private enforceCap() {
        while (this.terminals.size >= MAX_LIVE_PTYS) {
            let oldestId: string | null = null;
            let oldest = Infinity;
            for (const [id, e] of this.terminals) {
                if (e.lastTouch < oldest) { oldest = e.lastTouch; oldestId = id; }
            }
            if (!oldestId) break;
            logger.debug(`[WEB TERMINAL] pty cap reached (${this.terminals.size}); evicting LRU ${oldestId}`);
            this.close(oldestId);
        }
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
            // tmux options applied on (re)attach, idempotent.
            //  Session-scoped (`-t`, touch only THIS vh- session):
            //   - mouse on: wheel-scrolls scrollback + click panes/windows —
            //     the point of a browser terminal.
            //   - history-limit: deep scrollback for panes in the session.
            //  Server-scoped (`-g`, no session-scoped equivalent exists):
            //   - set-clipboard on + terminal-features …:clipboard: make tmux
            //     emit an OSC 52 escape when copying (mouse drag-select), so the
            //     web xterm can mirror the selection into the browser clipboard.
            //     Without this, copying inside tmux only fills tmux's own buffer,
            //     which the browser can't read. Benign + desirable globally.
            const setOpts = [
                `tmux set-option -t ${tmuxSession} mouse on`,
                `tmux set-option -t ${tmuxSession} history-limit 100000`,
                `tmux set-option -g set-clipboard on`,
                `tmux set-option -ga terminal-features ',xterm-256color:clipboard'`,
            ].join(' >/dev/null 2>&1; ') + ' >/dev/null 2>&1; ';
            args = ['-c',
                `tmux new-session -A -d -s ${tmuxSession} -x ${cols} -y ${rows} >/dev/null 2>&1; `
                + setOpts
                + `exec tmux attach-session -d -t ${tmuxSession}`];
        } else {
            file = defaultShell();
            args = [];
        }

        // Bound live ptys before spawning a new one (the reopen path above
        // already freed this id, so this only trims OTHER stale/orphaned ptys).
        this.enforceCap();

        const proc = pty.spawn(file, args, {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env,
        });

        const entry: TerminalEntry = { pty: proc, tmuxSession, lastTouch: Date.now() };
        this.terminals.set(id, entry);

        // Guard against a stale client: on a rapid re-open (reattach), the
        // previous pty's tmux client can linger and survive SIGHUP for a beat.
        // While it lives it keeps receiving tmux's render and would emit a
        // SECOND copy of every byte → the web writes input twice (`ls` → `llls`).
        // Only the pty that is *currently* the entry for this id may emit; a
        // replaced pty goes silent even if it hasn't fully died yet. Same guard
        // on exit so a dying old pty can't delete the new entry or fire a
        // spurious terminal-exit.
        proc.onData((data) => {
            if (this.terminals.get(id) !== entry) return;
            this.emit('terminal-output', { terminalId: id, data: Buffer.from(data, 'utf8').toString('base64') });
        });
        proc.onExit(({ exitCode }) => {
            if (this.terminals.get(id) !== entry) return;
            this.terminals.delete(id);
            this.emit('terminal-exit', { terminalId: id, exitCode });
        });

        logger.debug(`[WEB TERMINAL] opened ${id} (${file} ${args.join(' ')}) ${cols}x${rows} cwd=${cwd}`);
        return { terminalId: id, tmuxSession };
    }

    write(terminalId: string, dataBase64: string) {
        const entry = this.terminals.get(terminalId);
        if (!entry) return;
        entry.lastTouch = Date.now();
        entry.pty.write(Buffer.from(dataBase64, 'base64').toString('utf8'));
    }

    resize(terminalId: string, cols: number, rows: number) {
        const entry = this.terminals.get(terminalId);
        if (!entry) return;
        entry.lastTouch = Date.now();
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

    /**
     * List the live `vh-*` tmux sessions on this machine. The machine is the
     * source of truth for the cross-device terminal list — any logged-in
     * device queries this (over the RPC relay) instead of a per-device cache,
     * so terminals are visible and reattachable from anywhere. [] if no tmux.
     */
    listSessions(): Array<{ id: string; title?: string; cwd?: string; createdAt?: number }> {
        if (!isTmuxAvailable()) return [];
        try {
            const r = spawnSync('tmux',
                ['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{pane_current_path}'],
                { encoding: 'utf8' });
            if (r.status !== 0 || !r.stdout) return [];
            const out: Array<{ id: string; title?: string; cwd?: string; createdAt?: number }> = [];
            for (const line of r.stdout.split('\n')) {
                if (!line) continue;
                const [name, created, cwd] = line.split('\t');
                if (!name || !name.startsWith('vh-')) continue;
                const id = name.slice(3);
                let title: string | undefined;
                try {
                    const t = spawnSync('tmux', ['show-options', '-t', name, '-v', '@vh_title'], { encoding: 'utf8' });
                    if (t.status === 0 && t.stdout && t.stdout.trim()) title = t.stdout.trim();
                } catch { /* no title set */ }
                out.push({
                    id,
                    title,
                    cwd: cwd || undefined,
                    createdAt: created ? Number(created) * 1000 : undefined,
                });
            }
            return out;
        } catch {
            return [];
        }
    }

    /** Persist a human title on the tmux session (`@vh_title`) so every device
     *  sees the same name. `ifAbsent` (used by auto-titling from the first
     *  command) skips when a title already exists, so it never clobbers a
     *  manual rename on reattach. No-op without tmux or for an invalid id. */
    setTitle(terminalId: string, title: string, ifAbsent = false) {
        if (!isTmuxAvailable()) return;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(terminalId)) return;
        const name = `vh-${terminalId}`;
        try {
            if (ifAbsent) {
                const cur = spawnSync('tmux', ['show-options', '-t', name, '-v', '@vh_title'], { encoding: 'utf8' });
                if (cur.status === 0 && cur.stdout && cur.stdout.trim()) return; // already titled
            }
            spawnSync('tmux', ['set-option', '-t', name, '@vh_title', title], { stdio: 'ignore' });
        } catch { /* session gone */ }
    }
}
