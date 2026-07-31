/**
 * Web terminal manager (daemon side).
 *
 * ── Architecture (Stage 1: daemon-authoritative screen) ──────────────────────
 * Each web terminal is a long-lived daemon session object that owns the screen
 * state, so client reconnect/redraw no longer relies on tmux redrawing on
 * re-attach. A session holds:
 *   1. a node-pty attached to a BACKGROUND tmux session `vh-<id>` (the pty is
 *      just tmux's single stable client; the tmux session holds the process);
 *   2. an `@xterm/headless` Terminal — every pty output chunk is `.write()` into
 *      it, so the daemon always has the authoritative screen + scrollback;
 *   3. a monotonic output `seq` (incremented per emitted chunk);
 *   4. a bounded ring buffer of recent `{ seq, data }` chunks, used to replay
 *      only the gap after a brief client disconnect instead of a full snapshot.
 *
 * On (re)subscribe (`open`), the daemon returns either a REPLAY (the client's
 * `fromSeq..now` is still covered by the ring → send just the missing chunks) or
 * a SNAPSHOT (serialize the headless screen, bounded scrollback). The pty is NOT
 * recreated on re-subscribe — the browser connecting/disconnecting is pure
 * subscribe/unsubscribe against the daemon buffer. This is what kills the old
 * single-client redraw jitter: the daemon keeps exactly one steady tmux client;
 * it no longer creates/destroys a tmux client on every browser open/close.
 *
 * Cross-browser survival: closing the web view only marks the session as having
 * no subscribers; the pty (and headless buffer) live on. An idle reaper detaches
 * the pty only when it has no subscribers AND has been idle past the timeout
 * (tmux stays alive → reopening reattaches instantly). MAX_LIVE_PTYS still
 * LRU-evicts to protect the system PTY pool.
 *
 * Transport: raw bytes are relayed base64 over the (TLS) socket through the
 * server, consistent with the server-trusted model. open/input/resize/close are
 * driven from apiMachine; live output is pushed via the injected emit callback.
 * If tmux isn't installed we fall back to the login shell directly (no local
 * attach / no background survival, but the terminal still works).
 */
import * as pty from 'node-pty';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
// Headless xterm: a DOM-free Terminal that accumulates the authoritative screen
// + scrollback from the pty stream. addon-serialize reads that buffer back out
// as a replayable escape sequence for snapshots (works headless — buffer only).
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { logger } from '@/ui/logger';

export interface OpenTerminalOptions {
    /** Client-owned id → tmux session `vh-<id>`. Reusing it re-subscribes to the
     *  same live session (state survives). Omitted → a fresh random id. */
    terminalId?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    /** Reconnect hint: the last output seq the client already applied. If the
     *  ring buffer still covers `fromSeq..now`, we replay just the gap instead
     *  of a full snapshot. */
    fromSeq?: number;
}

/** Result of (re)subscribing to a terminal.
 *  - `snapshot`: full screen restore — client does `reset()` + `write(data)`.
 *  - `replay`:   only the chunks after `fromSeq` — client applies each in seq
 *                order (dedup by seq), no reset. */
export type OpenTerminalResult = {
    terminalId: string;
    tmuxSession?: string;
    /** Current output seq at the moment of subscribe; the client's new baseline. */
    seq: number;
} & (
    | { mode: 'snapshot'; data: string }
    | { mode: 'replay'; chunks: Array<{ seq: number; data: string }> }
);

type EmitFn = (event: string, payload: any) => void;

interface OutputChunk {
    seq: number;
    /** base64 of the raw pty bytes, ready to relay as-is. */
    data: string;
}

// A web-terminal pty is just tmux's single stable client; the tmux SESSION holds
// the real process, so a pty is disposable (reopening reattaches). We bound live
// ptys so orphaned ones — sessions no browser is watching — can't accumulate and
// exhaust the system PTY pool (kern.tty.ptmx_max ~511 → node-pty
// `posix_spawnp failed` → black screen).
const MAX_LIVE_PTYS = 24;              // hard cap; LRU-evict oldest-touched beyond this
const PTY_IDLE_MS = 20 * 60 * 1000;    // detach ptys with no subscriber + idle 20 min
const REAP_INTERVAL_MS = 5 * 60 * 1000;

/** Ring-buffer cap per terminal. Bounds memory for reconnect replay; once the
 *  gap exceeds this we fall back to a full snapshot instead. 512KB comfortably
 *  covers a short network blip's worth of output without unbounded growth. */
const RING_MAX_BYTES = 512 * 1024;

/** Scrollback lines included in a snapshot serialize(). Bounds snapshot size so
 *  a huge accumulated history can't blow up the transport / the client's main
 *  thread on restore. The headless buffer keeps more; we just don't ship it all. */
const SNAPSHOT_SCROLLBACK = 1000;

/** Headless scrollback retained in the daemon's authoritative buffer. Larger than
 *  the snapshot cap so recent history survives, but still bounded per session. */
const HEADLESS_SCROLLBACK = 5000;

/** Per-probe tmux subprocess timeout — a wedged tmux must never stall the
 *  sidebar's periodic `list-terminals` poll. */
const TMUX_PROBE_TIMEOUT_MS = 1500;

/**
 * Coarse state of the agent (Claude Code) inside a web terminal, surfaced in
 * the sidebar. Optional everywhere: probing is best-effort and the field is
 * simply omitted when detection fails or times out.
 *  - working:     Claude Code is actively running a turn.
 *  - needs_input: a permission / choice / plan-approval dialog is waiting.
 *  - idle:        Claude Code is up but sitting at its input box.
 *  - shell:       plain shell, no agent TUI detected.
 */
export type AgentState = 'working' | 'needs_input' | 'idle' | 'shell';

const SHELL_COMMANDS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh']);

/**
 * Classify a tmux pane into an AgentState from its current foreground command
 * (`#{pane_current_command}`) and the tail of its visible text (capture-pane).
 * Pure function so the heuristics are unit-testable without tmux.
 *
 * Priority: needs_input > working > idle > shell. Dialog markers only count
 * inside the last 15 non-blank-trimmed lines so a "Do you want" merely quoted
 * in scrolled-by output doesn't misfire. Returns undefined when nothing is
 * recognizable (e.g. vim/htop in the pane) — callers omit the field then.
 */
export function classifyPane(currentCommand: string, tail: string): AgentState | undefined {
    const cmd = (currentCommand || '').trim().replace(/^-/, '').toLowerCase();
    const isShell = SHELL_COMMANDS.has(cmd);
    const lines = tail.replace(/\r/g, '').split('\n').map((l) => l.trimEnd());
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const text = lines.join('\n');
    const last15 = lines.slice(-15).join('\n');

    // Interactive dialog (permission prompt / choice list / plan approval).
    // Checked first: a waiting dialog also shows other footer text around it.
    const hasDialog =
        last15.includes('Do you want')
        || last15.includes('Would you like to proceed')
        // Numbered choice list: a line starting (after box-drawing/space) with
        // "❯ 1." or "> 1." — Claude Code renders options inside │…│ borders.
        || /^[\s│]*[❯>]\s*1\.\s/m.test(last15)
        || /\(y\/n\)/i.test(last15);
    if (hasDialog) return 'needs_input';

    // Claude Code's in-progress footer while a turn is running.
    if (text.includes('esc to interrupt')) return 'working';

    // Claude Code idle at its input box: the process itself (claude, or node
    // for the bundled CLI) is foreground, or its input-box footer is visible.
    // Real-world quirk: Claude Code's pane_current_command shows up as its bare
    // VERSION string (argv0 is versioned, e.g. "2.1.201"), not "claude"/"node" —
    // so treat a version-like command as the claude process too.
    const looksLikeClaude = cmd === 'claude' || cmd === 'node' || /^\d+\.\d+(\.\d+)?$/.test(cmd);
    const hasIdleFooter =
        text.includes('? for shortcuts')
        || text.includes('bypass permissions on')
        || text.includes('⏵⏵');
    if (looksLikeClaude || hasIdleFooter) return 'idle';

    if (isShell) return 'shell';
    return undefined;
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

/**
 * One long-lived daemon-side terminal session. Owns the pty, the authoritative
 * headless screen, the output seq counter and the reconnect ring buffer.
 */
class TerminalSession {
    readonly id: string;
    readonly tmuxSession?: string;
    pty: pty.IPty;
    private readonly headless: HeadlessTerminal;
    private readonly serializer: SerializeAddon;
    /** Last emitted output seq. Starts at 0; first chunk is seq 1. */
    seq = 0;
    /** Bounded recent-output ring (oldest first) for gap replay on reconnect. */
    private ring: OutputChunk[] = [];
    private ringBytes = 0;
    /** How many web views are currently watching this terminal. 0 = orphaned
     *  (eligible for pty reap once idle), but the tmux session still survives. */
    subscribers = 0;
    lastTouch = Date.now();
    cols: number;
    rows: number;

    constructor(id: string, ptyProc: pty.IPty, tmuxSession: string | undefined, cols: number, rows: number) {
        this.id = id;
        this.pty = ptyProc;
        this.tmuxSession = tmuxSession;
        this.cols = cols;
        this.rows = rows;
        this.headless = new HeadlessTerminal({
            cols,
            rows,
            scrollback: HEADLESS_SCROLLBACK,
            allowProposedApi: true,
        });
        this.serializer = new SerializeAddon();
        this.headless.loadAddon(this.serializer);
    }

    /** Record one pty output chunk: bump seq, feed the authoritative screen,
     *  push to the ring. Returns the assigned seq so the caller can emit it. */
    ingest(dataUtf8: string, dataBase64: string): number {
        this.headless.write(dataUtf8);
        this.seq += 1;
        const chunk: OutputChunk = { seq: this.seq, data: dataBase64 };
        this.ring.push(chunk);
        this.ringBytes += dataBase64.length;
        // Trim from the oldest end until back under the byte cap. A single chunk
        // larger than the cap is still kept alone (it'd just never fit).
        while (this.ring.length > 1 && this.ringBytes > RING_MAX_BYTES) {
            const dropped = this.ring.shift()!;
            this.ringBytes -= dropped.data.length;
        }
        return this.seq;
    }

    /** Keep the authoritative screen's dimensions in lockstep with the pty so a
     *  later snapshot serialize() reflects the real geometry. */
    resizeHeadless(cols: number, rows: number) {
        this.cols = cols;
        this.rows = rows;
        try { this.headless.resize(cols, rows); } catch { /* invalid dims — ignore */ }
    }

    /**
     * Decide how to bring a (re)subscribing client up to date.
     *  - `fromSeq` still covered by the ring → REPLAY just the newer chunks.
     *  - otherwise (fresh open, or the gap scrolled out of the ring) → SNAPSHOT
     *    the current screen (bounded scrollback).
     * The returned `seq` is always the current seq — the client's new baseline.
     */
    subscribeState(fromSeq?: number): { seq: number } & (
        | { mode: 'snapshot'; data: string }
        | { mode: 'replay'; chunks: OutputChunk[] }
    ) {
        // Ring covers fromSeq iff the oldest retained chunk is <= fromSeq+1, i.e.
        // there is no hole between what the client has and what the ring holds.
        const oldest = this.ring.length > 0 ? this.ring[0].seq : this.seq + 1;
        if (fromSeq !== undefined && fromSeq <= this.seq && fromSeq + 1 >= oldest) {
            const chunks = this.ring.filter((c) => c.seq > fromSeq);
            return { mode: 'replay', seq: this.seq, chunks };
        }
        return {
            mode: 'snapshot',
            seq: this.seq,
            data: this.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK }),
        };
    }

    dispose() {
        try { this.pty.kill(); } catch { /* already gone */ }
        try { this.headless.dispose(); } catch { /* already disposed */ }
        this.ring = [];
        this.ringBytes = 0;
    }
}

export class WebTerminalManager {
    private terminals = new Map<string, TerminalSession>();
    private emit: EmitFn;
    private reaper: ReturnType<typeof setInterval>;

    constructor(emit: EmitFn) {
        this.emit = emit;
        // Periodically detach orphaned+idle ptys (detach only — tmux session lives).
        this.reaper = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS);
        this.reaper.unref?.();
    }

    /** Detach ptys that have NO subscribers and have been idle past the timeout.
     *  WHY the subscriber gate: a watched terminal must stay live even when
     *  quiet (the user is reading, not typing); only genuinely orphaned sessions
     *  are reaped. The tmux `vh-<id>` session survives, so reopening reattaches
     *  instantly with a fresh snapshot. */
    private reapIdle() {
        const now = Date.now();
        for (const [id, session] of [...this.terminals]) {
            if (session.subscribers === 0 && now - session.lastTouch > PTY_IDLE_MS) {
                logger.debug(`[WEB TERMINAL] reaping orphaned idle pty ${id} (idle ${Math.round((now - session.lastTouch) / 60000)}m)`);
                this.detach(id);
            }
        }
    }

    /** Enforce the live-pty cap by detaching the least-recently-touched sessions
     *  that currently have no subscribers (their tmux sessions survive). Never
     *  evicts a session someone is actively watching. */
    private enforceCap() {
        while (this.terminals.size >= MAX_LIVE_PTYS) {
            // Prefer the least-recently-touched UNWATCHED session. But the cap is a
            // HARD safety limit against exhausting the system PTY pool
            // (kern.tty.ptmx_max ~511 → spawn failures → black screens), so if
            // every live pty claims a watcher — e.g. a crashed tab that never sent
            // terminal-close, inflating its subscriber count — we must still make
            // progress: fall back to force-evicting the global LRU. Its tmux
            // session survives; a genuine watcher just gets a reconnect snapshot.
            let unwatchedVictim: string | null = null; let unwatchedOldest = Infinity;
            let anyVictim: string | null = null; let anyOldest = Infinity;
            for (const [id, s] of this.terminals) {
                if (s.lastTouch < anyOldest) { anyOldest = s.lastTouch; anyVictim = id; }
                if (s.subscribers === 0 && s.lastTouch < unwatchedOldest) { unwatchedOldest = s.lastTouch; unwatchedVictim = id; }
            }
            const victimId = unwatchedVictim ?? anyVictim;
            if (!victimId) break; // no sessions at all
            if (!unwatchedVictim) logger.debug(`[WEB TERMINAL] pty cap reached with all sessions claiming watchers; force-evicting LRU ${victimId}`);
            else logger.debug(`[WEB TERMINAL] pty cap reached (${this.terminals.size}); evicting LRU ${victimId}`);
            this.detach(victimId);
        }
    }

    /** All web views become unreachable the instant the daemon's own socket to
     *  the server drops, so no terminal can still be watched. Reset every
     *  subscriber count to 0 — a view that never got to send terminal-close
     *  (socket blip, tab crash) would otherwise leave its count inflated and
     *  wedge the pty permanently un-reapable. Views re-subscribe (++ from 0) on
     *  reconnect. Called from the socket 'disconnect' handler. */
    resetSubscribers() {
        for (const s of this.terminals.values()) s.subscribers = 0;
    }

    /** Update the emitter when the socket reconnects. */
    setEmit(emit: EmitFn) {
        this.emit = emit;
    }

    /**
     * Subscribe to a terminal, creating the pty+headless session if it doesn't
     * exist yet. Reopening an existing id does NOT recreate the pty — it just
     * re-subscribes and returns a snapshot or a seq-based replay of the gap.
     */
    open(opts: OpenTerminalOptions): OpenTerminalResult {
        const cols = Math.max(2, Math.floor(opts.cols ?? 80));
        const rows = Math.max(2, Math.floor(opts.rows ?? 24));
        const cwd = opts.cwd && opts.cwd.length > 0 ? opts.cwd : os.homedir();
        const id = opts.terminalId && /^[a-zA-Z0-9_-]{1,64}$/.test(opts.terminalId)
            ? opts.terminalId
            : randomBytes(5).toString('hex');

        const existing = this.terminals.get(id);
        if (existing) {
            // Re-subscribe to the live session. The pty stays; we only bump the
            // subscriber count and resize to the (possibly new) client geometry.
            existing.subscribers += 1;
            existing.lastTouch = Date.now();
            this.applyResize(existing, cols, rows);
            const state = existing.subscribeState(opts.fromSeq);
            logger.debug(`[WEB TERMINAL] re-subscribed ${id} (subs=${existing.subscribers}, mode=${state.mode}, seq=${state.seq})`);
            return { terminalId: id, tmuxSession: existing.tmuxSession, ...state };
        }

        const env = ptyEnv();
        let file: string;
        let args: string[];
        let tmuxSession: string | undefined;

        if (isTmuxAvailable()) {
            tmuxSession = `vh-${id}`;
            // Create-or-noop the tmux session detached in the background, then
            // this pty becomes its single stable client. We keep the one-time
            // `attach -d` so that if the user ALSO ran a local `tmux attach`, the
            // local client is bumped and the session size follows THIS pty (two
            // clients clamp the session to the smaller size and garble redraws).
            // Unlike the old model we no longer pre-`detach-client` on every open
            // and we no longer recreate the pty on re-subscribe: the daemon keeps
            // exactly one steady client for the session's whole life, so there is
            // no client churn to jitter against. id is validated to [A-Za-z0-9_-],
            // cols/rows are ints → safe to inline.
            file = '/bin/sh';
            // tmux options applied on (re)attach, idempotent.
            //  Session-scoped (`-t`, touch only THIS vh- session):
            //   - mouse OFF: with mouse on, tmux swallows drag as its own mouse
            //     events so the browser never gets a selection → copy broke (esp.
            //     on Mac). Off ⇒ plain drag makes a normal browser selection
            //     (copy-on-select handles the rest). Wheel scrolls xterm's own
            //     scrollback; the deep tmux history is still reachable via
            //     keyboard copy-mode (prefix + [).
            //   - history-limit: deep scrollback for panes in the session.
            //  Server-scoped (`-g`, no session-scoped equivalent exists):
            //   - set-clipboard on + terminal-features …:clipboard: make tmux
            //     emit an OSC 52 escape when copying (keyboard copy-mode yank), so
            //     the web xterm (with @xterm/addon-clipboard) mirrors it into the
            //     browser clipboard. Benign + desirable globally.
            const setOpts = [
                `tmux set-option -t ${tmuxSession} mouse off`,
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

        // Bound live ptys before spawning a new one.
        this.enforceCap();

        const proc = pty.spawn(file, args, {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env,
        });

        const session = new TerminalSession(id, proc, tmuxSession, cols, rows);
        session.subscribers = 1;
        this.terminals.set(id, session);

        // Every pty chunk: ingest into the authoritative screen + ring (assigning
        // a seq), then relay to subscribers tagged with that seq. The guard
        // ensures a stale pty replaced by a re-attach can't emit for this id.
        proc.onData((data) => {
            if (this.terminals.get(id) !== session) return;
            const b64 = Buffer.from(data, 'utf8').toString('base64');
            const seq = session.ingest(data, b64);
            this.emit('terminal-output', { terminalId: id, data: b64, seq });
        });
        proc.onExit(({ exitCode }) => {
            if (this.terminals.get(id) !== session) return;
            this.terminals.delete(id);
            session.dispose();
            this.emit('terminal-exit', { terminalId: id, exitCode });
        });

        logger.debug(`[WEB TERMINAL] opened ${id} (${file} ${args.join(' ')}) ${cols}x${rows} cwd=${cwd}`);
        // A brand-new session has an empty screen — always a (trivial) snapshot.
        const state = session.subscribeState(undefined);
        return { terminalId: id, tmuxSession, ...state };
    }

    write(terminalId: string, dataBase64: string) {
        const session = this.terminals.get(terminalId);
        if (!session) return;
        session.lastTouch = Date.now();
        session.pty.write(Buffer.from(dataBase64, 'base64').toString('utf8'));
    }

    resize(terminalId: string, cols: number, rows: number) {
        const session = this.terminals.get(terminalId);
        if (!session) return;
        session.lastTouch = Date.now();
        this.applyResize(session, cols, rows);
    }

    /** Resize the pty AND the authoritative headless screen together, so a later
     *  snapshot matches the real geometry. Multiple tabs subscribed to one
     *  terminal all drive the same pty — we simply take the LAST resize (tmux is
     *  single-size anyway); there's no per-subscriber geometry to reconcile. */
    private applyResize(session: TerminalSession, cols: number, rows: number) {
        const c = Math.max(2, Math.floor(cols));
        const r = Math.max(2, Math.floor(rows));
        try {
            session.pty.resize(c, r);
        } catch (e) {
            logger.debug(`[WEB TERMINAL] resize ${session.id} failed: ${e}`);
        }
        session.resizeHeadless(c, r);
    }

    /**
     * A web view stopped watching this terminal (tab closed / navigated away /
     * socket dropped). This is an UNSUBSCRIBE, not a kill: the pty and the
     * authoritative headless buffer survive so any device can reattach and get a
     * snapshot. The idle reaper detaches the pty later only if it stays orphaned.
     */
    unsubscribe(terminalId: string) {
        const session = this.terminals.get(terminalId);
        if (!session) return;
        session.subscribers = Math.max(0, session.subscribers - 1);
        session.lastTouch = Date.now();
        logger.debug(`[WEB TERMINAL] unsubscribed ${terminalId} (subs=${session.subscribers})`);
    }

    /** Detach the pty (its single tmux client) without killing the tmux session.
     *  Used by the reaper / cap eviction. Reopening the id respawns a pty and
     *  reattaches to the surviving `vh-<id>` session. */
    private detach(terminalId: string) {
        const session = this.terminals.get(terminalId);
        if (!session) return;
        this.terminals.delete(terminalId);
        session.dispose();
        logger.debug(`[WEB TERMINAL] detached pty ${terminalId} (tmux session survives)`);
    }

    /** Permanently destroy the terminal: detach the pty AND kill the tmux
     *  session (so a local `tmux attach` won't find it either). Used when the
     *  user deletes the terminal from the sidebar. */
    killSession(terminalId: string) {
        this.detach(terminalId);
        try {
            spawnSync('tmux', ['kill-session', '-t', `vh-${terminalId}`], { stdio: 'ignore' });
        } catch {
            // tmux gone / session already dead
        }
        logger.debug(`[WEB TERMINAL] killed session vh-${terminalId}`);
    }

    /**
     * List the live `vh-*` tmux sessions on this machine. The machine is the
     * source of truth for the cross-device terminal list — any logged-in
     * device queries this (over the RPC relay) instead of a per-device cache,
     * so terminals are visible and reattachable from anywhere. [] if no tmux.
     *
     * Note: this queries tmux, not the daemon's live sessions map, so a terminal
     * whose pty was reaped (but whose tmux session survives) still shows up and
     * is reattachable — exactly the point of the daemon-authoritative model.
     *
     * `agentState` is a best-effort probe of what's running inside each
     * session (Claude Code working / waiting for input / idle, or plain
     * shell); it is omitted whenever the probe fails, times out, or nothing
     * is recognizable — never an error.
     */
    listSessions(): Array<{ id: string; title?: string; cwd?: string; createdAt?: number; agentState?: AgentState }> {
        if (!isTmuxAvailable()) return [];
        try {
            const r = spawnSync('tmux',
                ['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{pane_current_path}'],
                { encoding: 'utf8' });
            if (r.status !== 0 || !r.stdout) return [];
            const out: Array<{ id: string; title?: string; cwd?: string; createdAt?: number; agentState?: AgentState }> = [];
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
                    agentState: this.probeAgentState(name),
                });
            }
            return out;
        } catch {
            return [];
        }
    }

    /** Best-effort agent-state probe for one tmux session: 2 short tmux calls
     *  (foreground command + pane tail) fed into classifyPane. Any failure or
     *  timeout → undefined (the field is omitted), never an error. */
    private probeAgentState(sessionName: string): AgentState | undefined {
        try {
            const cmd = spawnSync('tmux',
                ['display-message', '-p', '-t', sessionName, '#{pane_current_command}'],
                { encoding: 'utf8', timeout: TMUX_PROBE_TIMEOUT_MS });
            if (cmd.status !== 0 || typeof cmd.stdout !== 'string') return undefined;
            const cap = spawnSync('tmux',
                ['capture-pane', '-p', '-t', sessionName, '-S', '-40'],
                { encoding: 'utf8', timeout: TMUX_PROBE_TIMEOUT_MS });
            if (cap.status !== 0 || typeof cap.stdout !== 'string') return undefined;
            return classifyPane(cmd.stdout.trim(), cap.stdout);
        } catch {
            return undefined;
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
