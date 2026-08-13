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
 *
 * ── List push (Stage 2: daemon-driven terminal list) ─────────────────────────
 * The manager also runs ONE internal list-tracking loop (startListTracking):
 * every tick it rebuilds the cross-device list (tmux membership + @vh_title
 * follow + agent classification + activity) and fires the callback only when
 * the list SIGNATURE changed (terminalListSignature — activityAt quantized so
 * raw output alone can't turn it into a metronome). Event kicks (open / kill /
 * exit / rename / live OSC title via headless onTitleChange) refresh within
 * LIST_KICK_DEBOUNCE_MS instead of waiting for the tick. apiMachine writes each
 * changed list into daemonState.webTerminals, which the server persists and
 * broadcasts — clients consume the push instead of polling `list-terminals`
 * (the RPC remains for old clients; both return the same item shape).
 *
 * ── Realtime activity (Stage 3: ephemeral `terminal-activity`) ───────────────
 * The list push above is the DURABLE lane and is deliberately coarse: one push
 * costs a full daemonState encrypt + CAS + DB write + broadcast, so activity
 * only participates in its signature at 60s granularity — which meant a
 * terminal that was merely PRINTING could take up to a minute to float to the
 * top of the sidebar. Stage 3 adds a second, ephemeral lane for exactly that
 * one number: `terminal-activity` frames carrying `[{ id, activityAt }]`,
 * relayed by the server to the account's web clients and stored nowhere. Fed
 * by the live pty stream (leading-edge throttled to ~1s) and by the tracking
 * tick (which is the only observer of COLD sessions' tmux activity). Emitted
 * only when a value actually moved, so an idle machine sends nothing at all.
 * The 60s bucket stays exactly as it is — the two lanes have different jobs.
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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { TerminalNotifyTracker, type TerminalNotification } from './terminalNotify';

// ── Kill tombstones ──────────────────────────────────────────────────────────
// A deleted terminal's id is remembered here so that a STALE CLIENT (an old
// bundle in a forgotten tab/PWA speaking the legacy create-or-attach dialect)
// can never resurrect it: terminal ids are randomly generated at creation, so
// a "create" request for a previously-killed id can only come from a stale
// client replaying history — refuse it. (Field incident 2026-08-13: a phone
// PWA resurrected a deleted terminal twice; the web-side stale-bundle reload
// only helps clients new enough to carry it.)
export const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Prune expired entries (pure; exported for tests). */
export function pruneTombstones(
    map: Record<string, number>,
    now: number,
    ttlMs: number = TOMBSTONE_TTL_MS,
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(map)) {
        if (typeof at === 'number' && now - at < ttlMs) out[id] = at;
    }
    return out;
}

function tombstoneFile(): string {
    return join(configuration.happyHomeDir, 'terminal-tombstones.json');
}

function loadTombstones(): Record<string, number> {
    try {
        const raw = JSON.parse(readFileSync(tombstoneFile(), 'utf8'));
        return pruneTombstones(raw && typeof raw === 'object' ? raw : {}, Date.now());
    } catch {
        return {};
    }
}

function saveTombstones(map: Record<string, number>): void {
    try {
        mkdirSync(configuration.happyHomeDir, { recursive: true });
        writeFileSync(tombstoneFile(), JSON.stringify(pruneTombstones(map, Date.now())));
    } catch (e) {
        logger.debug(`[WEB TERMINAL] tombstone save failed: ${e}`);
    }
}

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
    /** One-shot command to run ONLY when this open genuinely CREATES the
     *  terminal (a fresh tmux session / fresh shell) — never on re-attach or
     *  re-subscribe. Injected as literal keys (`send-keys -l`) + a separate
     *  Enter, so tmux never parses the command's content. Empty/absent → run
     *  nothing (old clients simply don't send the field). */
    startupCommand?: string;
    /** Catch-up from a viewer that already holds a subscription (visibility /
     *  reconnect refresh) — do NOT count it as a new subscriber. Old clients
     *  never send it (legacy = every open counts, conservative). Implies
     *  `attachOnly`. */
    resub?: boolean;
    /** Attach to an EXISTING terminal only — never create the tmux session.
     *  Sent by every new-web open except the fresh-create navigation, so a
     *  deleted terminal can't be resurrected by a lingering screen's catch-up
     *  or a refresh on its URL (`open` throws 'terminal-gone' instead). Old
     *  clients never send it (legacy = create-or-attach). */
    attachOnly?: boolean;
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
 *  gap exceeds this we fall back to a full snapshot instead. 2MB lets a longer /
 *  higher-throughput blip still replay the delta (cheap) instead of resending a
 *  full snapshot, at a bounded per-session cost. */
const RING_MAX_BYTES = 2 * 1024 * 1024;

/** Scrollback lines included in a snapshot serialize(). Bounds snapshot size so
 *  a huge accumulated history can't blow up the transport / the client's main
 *  thread on restore. 300 aligns with VS Code's restore depth — the headless
 *  buffer keeps far more (HEADLESS_SCROLLBACK); we just don't ship it all on a
 *  cold restore. */
const SNAPSHOT_SCROLLBACK = 300;

/** Headless scrollback retained in the daemon's authoritative buffer. Larger than
 *  the snapshot cap so recent history survives, but still bounded per session. */
const HEADLESS_SCROLLBACK = 5000;

/** Per-probe tmux subprocess timeout — a wedged tmux must never stall the
 *  sidebar's periodic `list-terminals` poll. */
const TMUX_PROBE_TIMEOUT_MS = 1500;

/**
 * ── List tracking (daemon-side push) ─────────────────────────────────────────
 * Cadence of the ONE internal list refresh: tmux membership + titles + agent
 * classification, computed once per tick regardless of how many clients are
 * connected (the old model re-probed per client per 10s poll). 10s keeps the
 * needs_input notification latency of the old poll while making the cost
 * client-count-independent; event kicks (title change, open/kill/exit,
 * rename) refresh sooner.
 */
const LIST_TRACK_INTERVAL_MS = 10_000;

/** Debounce for event kicks so a burst (e.g. several OSC title updates in one
 *  claude turn) coalesces into one refresh+push. */
const LIST_KICK_DEBOUNCE_MS = 250;

/**
 * activityAt granularity inside the list SIGNATURE. Continuous pty output
 * would otherwise change the snapshot every tick and turn the "push only on
 * change" contract into a 10s metronome of daemonState writes. Quantized to
 * 60s buckets: a busy terminal pushes at most once a minute for activity
 * alone; any real change (title/agent/membership) still pushes immediately —
 * and carries the EXACT activityAt (only the signature is quantized).
 *
 * ⚠️ This bucket protects the PERSISTED lane and must stay coarse — one
 * daemonState write is a full-state encrypt + CAS(expectedVersion) RPC + a
 * server DB write + a broadcast; making it 1s would turn every busy machine
 * into a metronome hammering the database. Sub-second freshness is NOT its
 * job: that belongs to the ephemeral `terminal-activity` channel below, which
 * costs one tiny un-persisted socket frame. Division of labour:
 *   • daemonState.webTerminals = the durable snapshot (membership, titles,
 *     cwd, agentState, coarse activity) — survives offline machines, reload,
 *     and cold clients;
 *   • terminal-activity = "this id moved, now" — fire-and-forget, never
 *     stored, only ever used to float a row in the sidebar.
 */
export const ACTIVITY_SIGNATURE_BUCKET_MS = 60_000;

/**
 * ── Realtime activity channel (ephemeral) ────────────────────────────────────
 * Throttle for the `terminal-activity` event. LEADING edge: the first pty
 * chunk after an idle gap emits immediately (that's the "I just talked to it"
 * case the whole channel exists for), then at most one frame per window while
 * output keeps flowing. No output ⇒ no timer, no frame — an idle machine
 * costs exactly zero.
 */
export const ACTIVITY_EVENT_THROTTLE_MS = 1_000;

/** One realtime activity increment. Deliberately the smallest possible shape:
 *  an id already visible in the terminal relay envelope, plus a clock
 *  reading. No title, no cwd, no bytes — nothing the durable (encrypted)
 *  daemonState lane is responsible for. */
export interface TerminalActivityUpdate {
    id: string;
    activityAt: number;
}

/**
 * Which ids moved FORWARD since the last emission. Only strictly-newer values
 * are reported (activity is monotonic per terminal — a tmux poll returning an
 * older `#{session_activity}` than the live pty's `lastOutputAt` must never
 * un-float a row), and an unchanged map yields an empty array so the caller
 * can skip the frame entirely. Pure; unit-tested.
 */
export function diffTerminalActivity(
    lastEmitted: Record<string, number>,
    current: Record<string, number>,
): TerminalActivityUpdate[] {
    const out: TerminalActivityUpdate[] = [];
    for (const [id, at] of Object.entries(current)) {
        if (!Number.isFinite(at) || at <= 0) continue;
        if (at > (lastEmitted[id] ?? 0)) out.push({ id, activityAt: at });
    }
    return out;
}

/** Timeout for the synchronous `tmux new-session -d` in open(). More generous
 *  than the probe timeout: the very first session may also have to boot the
 *  tmux server. On timeout we just fall back to the pty script's `-A` create
 *  (terminal still works; startup injection is skipped). */
const TMUX_CREATE_TIMEOUT_MS = 5000;

/** Max accepted startup-command length; anything longer is dropped (it's a
 *  one-liner setting, not a script hose). */
const STARTUP_COMMAND_MAX_LEN = 2000;

/**
 * Validate/normalize a client-supplied startup command. Returns undefined for
 * anything that must NOT be injected: non-strings (old/foreign clients),
 * blank strings (the "disabled" setting value), or absurd lengths. Embedded
 * newlines are collapsed to spaces — the setting is a single command line, and
 * a literal \n key would otherwise execute each fragment separately.
 * Pure function (unit-tested without tmux).
 */
export function normalizeStartupCommand(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const cmd = raw.replace(/[\r\n]+/g, ' ').trim();
    if (cmd.length === 0 || cmd.length > STARTUP_COMMAND_MAX_LEN) return undefined;
    return cmd;
}

/**
 * The exact tmux argv vectors (no shell involved anywhere) that inject a
 * startup command into a just-created session:
 *  1. `send-keys -l -- <cmd>`: `-l` sends the argument LITERALLY — tmux does
 *     not interpret key names, `;` command separators, or format expansion —
 *     and `--` guards a command starting with `-`. The whole command is one
 *     argv element, so the shell's own quoting/escaping is out of the picture
 *     too (we spawn tmux directly, not via `sh -c`).
 *  2. a separate `send-keys Enter` (key name, NOT literal) to run it.
 * Target is `=<session>:` — `=` forces an exact session-name match (a bare
 * name is a prefix match: `vh-abc` could hit `vh-abc1`) and the trailing `:`
 * selects the session's current pane. NOTE the colon is required: tmux (3.6)
 * rejects a bare `=name` when the command expects a pane target
 * ("can't find pane") — verified empirically.
 * Pure function (unit-tested without tmux).
 */
export function startupInjectionArgs(tmuxSession: string, command: string): string[][] {
    return [
        ['send-keys', '-t', `=${tmuxSession}:`, '-l', '--', command],
        ['send-keys', '-t', `=${tmuxSession}:`, 'Enter'],
    ];
}

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

/** One terminal in the cross-device list — the shape `list-terminals` returns
 *  AND the shape pushed through daemonState.webTerminals (identical on
 *  purpose: poll and push describe the same thing). */
export interface TerminalListItem {
    id: string;
    title?: string;
    cwd?: string;
    createdAt?: number;
    activityAt?: number;
    agentState?: AgentState;
}

/**
 * Canonical change signature of a terminal list. Two lists with the same
 * signature must not trigger a push. Order-insensitive (sorted by id);
 * `activityAt` participates only at ACTIVITY_SIGNATURE_BUCKET_MS granularity
 * (see that constant). Pure; unit-tested.
 */
export function terminalListSignature(items: TerminalListItem[]): string {
    const canon = [...items]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((t) => [
            t.id,
            t.title ?? '',
            t.cwd ?? '',
            t.createdAt ?? 0,
            Math.floor((t.activityAt ?? 0) / ACTIVITY_SIGNATURE_BUCKET_MS),
            t.agentState ?? '',
        ]);
    return JSON.stringify(canon);
}

const SHELL_COMMANDS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh']);

/**
 * ── Auto-title: follow the pane's OSC title ──────────────────────────────────
 * Claude Code's TUI continuously sets the terminal window title (OSC 0/2) to a
 * short summary of the current task — tmux stores it as `#{pane_title}`
 * (verified on tmux 3.6b: "✳ 与ted沟通GPU成本口径", "◐ webhook-integration-setup";
 * `allow-rename` only affects the WINDOW name, not pane_title). That is exactly
 * the title a user wants in the sidebar, so listSessions() follows it into
 * `@vh_title` (the cross-device title truth) on every poll — unless the user
 * manually renamed the terminal (`@vh_title_manual`, see setTitle).
 *
 * A plain shell doesn't set a useful OSC title — the tmux DEFAULT pane_title is
 * the machine's hostname — so deriveAutoTitle() filters that (and bare process
 * names) out; shell terminals keep their web-side first-command fallback title.
 */

/** Max auto-title length in code points (matches the web's own 60-char cap). */
const TITLE_MAX_CHARS = 60;

/** pane_title values that carry no information: the tmux default (hostname,
 *  handled separately), bare shell/process names, and tmux itself. */
const JUNK_TITLES = new Set(['tmux', 'claude', 'node', ...SHELL_COMMANDS]);

/**
 * Turn a raw `#{pane_title}` into a sidebar-worthy auto title, or undefined
 * when it says nothing. Strips the leading status glyph(s) Claude Code puts in
 * its OSC title ("✳ <task>" / "◐ <task>" — the spinner set varies by version,
 * so strip ANY leading non-letter/digit run), collapses whitespace, drops the
 * tmux default title (hostname, full or short form) and bare process names,
 * and truncates to TITLE_MAX_CHARS code points. Pure; unit-tested.
 */
export function deriveAutoTitle(paneTitle: unknown, hostname: string): string | undefined {
    if (typeof paneTitle !== 'string') return undefined;
    const t = paneTitle.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
    if (!t) return undefined;
    const lower = t.toLowerCase();
    const host = (hostname || '').toLowerCase();
    const shortHost = host.split('.')[0];
    if (host && (lower === host || lower === shortHost)) return undefined;
    if (JUNK_TITLES.has(lower)) return undefined;
    const chars = Array.from(t);
    return chars.length > TITLE_MAX_CHARS ? chars.slice(0, TITLE_MAX_CHARS).join('') : t;
}

/** Field separator for the list-sessions format below. Titles and paths are
 *  free text that may contain tabs; US (0x1f) can't be typed into a terminal
 *  title in practice. pane_title is deliberately the LAST field so even a
 *  pathological embedded 0x1f only garbles the title, never the fields. */
export const LIST_FIELD_SEP = '\x1f';

const LIST_SESSIONS_FORMAT = [
    '#{session_name}',
    '#{session_created}',
    '#{session_activity}',
    '#{pane_current_path}',
    '#{@vh_title}',
    '#{@vh_title_manual}',
    '#{pane_title}',
].join(LIST_FIELD_SEP);

export interface SessionListLine {
    name: string;
    created?: number;   // epoch ms
    activity?: number;  // epoch ms
    cwd?: string;
    /** Current `@vh_title` (trimmed), if any. */
    vhTitle?: string;
    /** `@vh_title_manual` is set → the user renamed it; never auto-follow. */
    manual: boolean;
    /** Raw `#{pane_title}` of the session's active pane. */
    paneTitle?: string;
}

/** Parse one `list-sessions -F LIST_SESSIONS_FORMAT` line. Pure; unit-tested. */
export function parseSessionListLine(line: string): SessionListLine | undefined {
    if (!line) return undefined;
    const parts = line.split(LIST_FIELD_SEP);
    if (parts.length < 7) return undefined;
    const [name, created, activity, cwd, vhTitle, manual] = parts;
    if (!name) return undefined;
    return {
        name,
        created: created ? Number(created) * 1000 : undefined,
        activity: activity ? Number(activity) * 1000 : undefined,
        cwd: cwd || undefined,
        vhTitle: vhTitle.trim() || undefined,
        manual: manual.trim().length > 0,
        paneTitle: parts.slice(6).join(LIST_FIELD_SEP) || undefined,
    };
}

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
    const looksLikeClaude = looksLikeClaudeCommand(cmd);
    const hasIdleFooter =
        text.includes('? for shortcuts')
        || text.includes('bypass permissions on')
        || text.includes('⏵⏵');
    if (looksLikeClaude || hasIdleFooter) return 'idle';

    if (isShell) return 'shell';
    return undefined;
}

/**
 * Does a `#{pane_current_command}` (or node-pty foreground name) look like the
 * Claude Code process? Real-world quirk: Claude Code's pane_current_command
 * shows up as its bare VERSION string (argv0 is versioned, e.g. "2.1.228"),
 * not "claude"/"node" — so a version-like command counts too. "node" is
 * included for the bundled CLI. Pure; unit-tested.
 */
export function looksLikeClaudeCommand(currentCommand: string): boolean {
    const cmd = (currentCommand || '').trim().replace(/^-/, '').toLowerCase();
    return cmd === 'claude' || cmd === 'node' || /^\d+\.\d+(\.\d+)?$/.test(cmd);
}

/**
 * Decide how to scroll a tmux pane for a client wheel gesture, mirroring the
 * semantics tmux itself applies to mouse wheels:
 *  - pane already in copy-mode → keep scrolling copy-mode;
 *  - inner app is fullscreen AND asked for mouse reporting (`alternate_on` +
 *    `mouse_any_flag`, e.g. the Claude Code TUI ≥2.1.226) → synthesize SGR
 *    wheel events straight into the pane. Arrow keys are WRONG for these
 *    apps: in Claude's input box Up/Down walk history / move the cursor —
 *    the wheel is the only "scroll" input they understand. (The web client
 *    filters mouse-tracking from its own xterm, so the app never gets wheel
 *    events any other way.) Verified on claude 2.1.228: wheel events scroll
 *    the transcript regardless of coordinates (input-box row included).
 *  - inner app is fullscreen WITHOUT mouse reporting but looks like Claude
 *    Code (older TUI versions / CLAUDE_CODE_DISABLE_MOUSE) → PageUp/PageDown,
 *    its documented fullscreen scroll keys (half a screen per press — count
 *    is converted lines→pages). Arrow keys are the trap here: they open the
 *    input box's history browser ("History n/n"), the exact "wheel edits my
 *    prompt history" complaint. Verified on 2.1.228 with mouse disabled.
 *  - inner app is fullscreen without mouse reporting (vim/less default) →
 *    forward arrow keys so the APP scrolls (content isn't in pane history);
 *  - otherwise scrolling UP enters copy-mode (with -e: auto-exits when
 *    scrolled back to the bottom); scrolling DOWN at the bottom is a no-op.
 *    This is also the path a classic-renderer Claude Code takes (alt off →
 *    its transcript lives in tmux history; see CLAUDE_CLASSIC_RENDERER_ENV).
 * Pure so the decision table is unit-testable without tmux.
 * `lines > 0` = scroll up (into history), `lines < 0` = scroll down.
 */
export function planScrollAction(
    paneInMode: boolean,
    alternateOn: boolean,
    paneWantsMouse: boolean,
    lines: number,
    claudeLike = false,
    paneRows = 24,
):
    | { kind: 'copy-scroll'; dir: 'up' | 'down'; count: number }
    | { kind: 'mouse-wheel'; dir: 'up' | 'down'; count: number }
    | { kind: 'page-keys'; key: 'PPage' | 'NPage'; count: number }
    | { kind: 'keys'; key: 'Up' | 'Down'; count: number }
    | { kind: 'none' } {
    // Bound a single step so a burst can't wedge tmux with a huge -N.
    const count = Math.min(Math.abs(Math.trunc(lines)), 200);
    if (count === 0) return { kind: 'none' };
    const up = lines > 0;
    if (paneInMode) return { kind: 'copy-scroll', dir: up ? 'up' : 'down', count };
    if (alternateOn && paneWantsMouse) return { kind: 'mouse-wheel', dir: up ? 'up' : 'down', count };
    if (alternateOn && claudeLike) {
        // PageUp/PageDown scroll half the viewport per press → convert lines
        // to pages, always at least one so a small flick still moves.
        const halfPage = Math.max(1, Math.floor(paneRows / 2));
        const pages = Math.max(1, Math.round(count / halfPage));
        return { kind: 'page-keys', key: up ? 'PPage' : 'NPage', count: pages };
    }
    if (alternateOn) return { kind: 'keys', key: up ? 'Up' : 'Down', count };
    if (up) return { kind: 'copy-scroll', dir: 'up', count };
    return { kind: 'none' }; // down at the live bottom — nowhere to go
}

/**
 * Hex byte arguments for `tmux send-keys -H`: `count` SGR mouse-wheel events
 * (WheelUp = `CSI < 64;x;y M`, WheelDown = 65) aimed at the pane's center
 * cell (SGR coordinates are 1-based). One flat byte list → ONE send-keys
 * invocation delivers the whole burst. `-H` bypasses tmux key-name parsing,
 * so the pane receives the raw escape bytes exactly as a terminal would send
 * them. Pure; unit-tested.
 */
export function sgrWheelHexBytes(dir: 'up' | 'down', count: number, paneWidth: number, paneHeight: number): string[] {
    const x = Math.max(1, Math.floor(paneWidth / 2));
    const y = Math.max(1, Math.floor(paneHeight / 2));
    const seq = `\x1b[<${dir === 'up' ? 64 : 65};${x};${y}M`;
    const bytes: string[] = [];
    for (let i = 0; i < count; i++) {
        for (const ch of seq) bytes.push(ch.charCodeAt(0).toString(16).padStart(2, '0'));
    }
    return bytes;
}

/**
 * ── Classic-renderer Claude Code in web terminals ────────────────────────────
 * Claude Code's fullscreen TUI (default since ~2.1.2xx) draws on the pane's
 * ALTERNATE screen: the transcript lives only inside the app, tmux history
 * never accumulates, and "scroll back to read earlier output" exists solely
 * as app-internal scrolling (synthetic SGR wheel / PageUp) — fragile across
 * claude versions (pre-mouse fullscreen builds turn wheel→arrow-keys into
 * input-history walking). Claude Code ships an official escape hatch:
 * CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 selects the classic renderer
 * (https://code.claude.com/docs/en/fullscreen.md). Verified on 2.1.228 under
 * tmux 3.6b: alternate_on stays 0, the transcript flows CLEANLY into tmux
 * history (no repeated frames), pane_title/OSC auto-titles still work, and
 * the existing copy-mode wheel path (frozen view while reading, auto-exit at
 * bottom, browser-native selection) reviews the whole transcript.
 *
 * So every NEWLY CREATED web-terminal session gets this env var injected via
 * `new-session -e` (tmux ≥3.2; create-only — ignored on `-A` attach, verified).
 * It only sets the default: a user can still opt back into fullscreen with
 * `/tui fullscreen` inside claude, which lands on the SGR wheel path above.
 * NOTE the tmux window option `alternate-screen off` is NOT a substitute: the
 * fullscreen renderer then repaints in place and NOTHING ever enters history
 * (verified — history_size stays 0), which would break scrolling entirely.
 */
export const CLAUDE_CLASSIC_RENDERER_ENV = 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1';

/** Does this `tmux -V` output support `new-session -e VAR=value` (tmux ≥3.2)?
 *  Dev builds report "tmux next-X.Y" / "tmux master". Pure; unit-tested. */
export function tmuxSupportsNewSessionEnv(versionOutput: string): boolean {
    if (/master/i.test(versionOutput)) return true;
    const m = /(\d+)\.(\d+)/.exec(versionOutput);
    if (!m) return false;
    const maj = Number(m[1]);
    const min = Number(m[2]);
    return maj > 3 || (maj === 3 && min >= 2);
}

let tmuxAvailableCache: boolean | null = null;
function isTmuxAvailable(): boolean {
    if (tmuxAvailableCache !== null) return tmuxAvailableCache;
    try {
        const r = spawnSync('tmux', ['-V'], { stdio: 'ignore', env: ptyEnv() });
        tmuxAvailableCache = r.status === 0;
    } catch {
        tmuxAvailableCache = false;
    }
    return tmuxAvailableCache;
}

let tmuxEnvFlagCache: boolean | null = null;
/** Runtime probe for the `-e` support above; a pre-3.2 tmux would reject the
 *  whole new-session on an unknown flag, so it must be gated, not assumed. */
function tmuxSupportsEnvFlag(): boolean {
    if (tmuxEnvFlagCache !== null) return tmuxEnvFlagCache;
    try {
        const r = spawnSync('tmux', ['-V'], { encoding: 'utf8', env: ptyEnv() });
        tmuxEnvFlagCache = r.status === 0 && tmuxSupportsNewSessionEnv(r.stdout || '');
    } catch {
        tmuxEnvFlagCache = false;
    }
    return tmuxEnvFlagCache;
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
    /** Last pty OUTPUT timestamp — the daemon-side activity truth for a live
     *  session (the pty stream passes through us anyway). tmux
     *  `#{session_activity}` remains the fallback for cold sessions. */
    lastOutputAt?: number;
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

    /** Fires when the inner app's OSC title reaches the authoritative screen
     *  (requires tmux `set-titles on` for the session — see the open() options
     *  — so tmux re-emits the pane title to its attach client). Zero-cost
     *  event: no subprocess, the bytes were flowing through us anyway. */
    onTitleChange(cb: (title: string) => void): void {
        this.headless.onTitleChange(cb);
    }

    /** Record one pty output chunk: bump seq, feed the authoritative screen,
     *  push to the ring. Returns the assigned seq so the caller can emit it. */
    ingest(dataUtf8: string, dataBase64: string): number {
        this.lastOutputAt = Date.now();
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

    /** Inputs for classifyPane, read straight from the authoritative in-process
     *  state — no tmux subprocess. `tail` is the plain text of the last `maxLines`
     *  buffer lines (≈ `tmux capture-pane -p -S -N`); `command` is node-pty's
     *  best-effort foreground process name (≈ `#{pane_current_command}`). */
    agentProbeInput(maxLines = 40): { command: string; tail: string } {
        const buf = this.headless.buffer.active;
        const total = buf.length;
        const start = Math.max(0, total - maxLines);
        const lines: string[] = [];
        for (let y = start; y < total; y++) {
            const l = buf.getLine(y);
            lines.push(l ? l.translateToString(true) : '');
        }
        let command = '';
        try { command = this.pty.process || ''; } catch { /* platform quirk — text signals carry it */ }
        return { command, tail: lines.join('\n') };
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
            // Match the OutputChunk.data contract: base64 of raw bytes. serialize()
            // returns a raw ANSI *string*; live/replay chunks are base64 (see the
            // pty 'data' handler) and the client uniformly does decrypt→b64decode.
            // Sending the snapshot un-base64'd made the client atob() an ANSI string
            // → InvalidCharacterError → blank terminal on cold load / hard refresh.
            data: Buffer.from(this.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK }), 'utf8').toString('base64'),
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
    /** killed terminal ids → killedAt; blocks stale-client resurrection. */
    private tombstones: Record<string, number> = loadTombstones();
    private emit: EmitFn;
    private reaper: ReturnType<typeof setInterval>;

    // ── List tracking (daemon-side push) ────────────────────────────────────
    // ONE internal refresh loop owns the cross-device terminal list: tmux
    // membership + title follow + agent classification, computed once per
    // LIST_TRACK_INTERVAL_MS tick — never multiplied by client count. Event
    // kicks (open/kill/exit/rename/OSC title) refresh sooner via a short
    // debounce. The callback fires ONLY when the list signature changes.
    private listChangedCb: ((terminals: TerminalListItem[]) => void) | null = null;
    private listTrackTimer: ReturnType<typeof setInterval> | null = null;
    private listKickTimer: ReturnType<typeof setTimeout> | null = null;
    private lastListSignature: string | null = null;

    // ── Realtime activity channel ───────────────────────────────────────────
    // Sits BESIDE the list push, not inside it: `terminal-activity` frames are
    // ephemeral (server relays, nobody stores them), so they can be a hundred
    // times cheaper and a hundred times fresher than a daemonState write. Two
    // feeders, one emitter:
    //   • pty output  → noteActivity() on every chunk, throttled (leading edge)
    //   • tmux poll   → the list track tick, which also covers COLD sessions
    //                   whose pty we already detached.
    // `lastActivityEmitted` is the de-dup table: a value that didn't move
    // produces no frame at all.
    private lastActivityEmitted: Record<string, number> = {};
    private activityFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private lastActivityFlushAt = 0;

    // ── Agent-transition notifications ──────────────────────────────────────
    // Every tick's agentState observations also feed a transition tracker
    // (terminalNotify.ts): working→idle / working|idle→needs_input transitions
    // — debounced, cooled down, eligibility-gated — surface through `onNotify`
    // so the daemon can push a webhook notification for bare-tmux claude runs
    // (the web-terminal counterpart of the session path's push-event). No
    // callback ⇒ tracking is skipped entirely.
    private readonly onNotify: ((n: TerminalNotification) => void) | null;
    private notifyTracker = new TerminalNotifyTracker();

    constructor(emit: EmitFn, onNotify?: (n: TerminalNotification) => void) {
        this.emit = emit;
        this.onNotify = onNotify ?? null;
        // Periodically detach orphaned+idle ptys (detach only — tmux session lives).
        this.reaper = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS);
        this.reaper.unref?.();
    }

    /**
     * Start (or re-target) list tracking. `cb` receives the full list whenever
     * the tracked signature changes. Idempotent: calling again just swaps the
     * callback (used on socket reconnect). The caller typically pairs this
     * with primeListSignature() after shipping an initial snapshot itself.
     */
    startListTracking(cb: (terminals: TerminalListItem[]) => void, intervalMs = LIST_TRACK_INTERVAL_MS): void {
        this.listChangedCb = cb;
        // The daemon re-calls this on every socket connect, so this doubles as
        // "forget what we told the PREVIOUS connection". Frames emitted while
        // the socket was down went nowhere, and their ids would otherwise stay
        // marked as already-reported and never be re-sent; clearing makes the
        // first tick after a reconnect re-seed the clients' overlay.
        this.lastActivityEmitted = {};
        if (!this.listTrackTimer) {
            this.listTrackTimer = setInterval(() => this.listTrackTick(), intervalMs);
            this.listTrackTimer.unref?.();
        }
    }

    /** Stop tracking (tests / shutdown). */
    stopListTracking(): void {
        this.listChangedCb = null;
        if (this.listTrackTimer) { clearInterval(this.listTrackTimer); this.listTrackTimer = null; }
        if (this.listKickTimer) { clearTimeout(this.listKickTimer); this.listKickTimer = null; }
        if (this.activityFlushTimer) { clearTimeout(this.activityFlushTimer); this.activityFlushTimer = null; }
    }

    /**
     * One pty chunk arrived → make sure a realtime activity frame goes out
     * soon. Leading edge (emit NOW when the last frame is older than the
     * throttle window) so the very first byte after an idle gap floats the row
     * immediately; otherwise coalesce into the already-pending flush.
     *
     * Gated on list tracking, which the daemon starts on socket connect — no
     * socket, no frames. Called on EVERY output chunk, so it stays down to a
     * clock read and two comparisons (the base64 + headless write on the same
     * path already cost orders of magnitude more).
     */
    private noteActivity(): void {
        if (!this.listChangedCb) return;
        if (this.activityFlushTimer) return; // a flush is already queued
        const wait = ACTIVITY_EVENT_THROTTLE_MS - (Date.now() - this.lastActivityFlushAt);
        if (wait <= 0) { this.flushLiveActivity(); return; }
        this.activityFlushTimer = setTimeout(() => {
            this.activityFlushTimer = null;
            this.flushLiveActivity();
        }, wait);
        this.activityFlushTimer.unref?.();
    }

    /** Emit the live ptys' output timestamps (in-memory only — no tmux, no
     *  subprocess, so this is safe to run every throttle window). */
    private flushLiveActivity(): void {
        this.lastActivityFlushAt = Date.now();
        const current: Record<string, number> = {};
        for (const [id, s] of this.terminals) {
            if (s.lastOutputAt) current[id] = s.lastOutputAt;
        }
        this.emitActivity(current);
    }

    /** Diff against what we already told the clients and emit only the moves.
     *  Never throws (a broken socket must not take down the pty stream). */
    private emitActivity(current: Record<string, number>): void {
        const updates = diffTerminalActivity(this.lastActivityEmitted, current);
        if (updates.length === 0) return; // nothing moved ⇒ zero traffic
        for (const u of updates) this.lastActivityEmitted[u.id] = u.activityAt;
        try {
            this.emit('terminal-activity', { terminals: updates });
        } catch (e) {
            logger.debug(`[WEB TERMINAL] activity emit failed: ${e}`);
        }
    }

    /** Seed the change signature from a list the caller already delivered by
     *  other means (the connect-time daemonState write carries the initial
     *  snapshot), so the first tick doesn't re-push an identical list. */
    primeListSignature(list: TerminalListItem[]): void {
        this.lastListSignature = terminalListSignature(list);
    }

    /**
     * The current cross-device list: tmux truth (membership, cwd, titles,
     * cold-session activity, agent states — see listSessions) overlaid with
     * what only the live pty stream knows (fresher activityAt).
     */
    buildTerminalList(): TerminalListItem[] {
        const list = this.listSessions();
        for (const item of list) {
            const live = this.terminals.get(item.id);
            if (live?.lastOutputAt) {
                item.activityAt = Math.max(item.activityAt ?? 0, live.lastOutputAt);
            }
        }
        return list;
    }

    /** Event kick: schedule a near-immediate refresh (debounced so bursts —
     *  e.g. several OSC title updates in one claude turn — coalesce). No-op
     *  without a tracking callback. */
    private kickListRefresh(): void {
        if (!this.listChangedCb || this.listKickTimer) return;
        this.listKickTimer = setTimeout(() => {
            this.listKickTimer = null;
            this.listTrackTick();
        }, LIST_KICK_DEBOUNCE_MS);
        this.listKickTimer.unref?.();
    }

    /** One tracking tick: rebuild the list, feed the notification tracker,
     *  compare signatures, fire on change. The tracker is fed BEFORE the
     *  signature short-circuit: stability confirmation needs the repeat
     *  observations of an UNCHANGED list too. */
    private listTrackTick(): void {
        const cb = this.listChangedCb;
        if (!cb) return;
        try {
            const list = this.buildTerminalList();
            this.trackNotifications(list);
            // Realtime lane, BEFORE the signature short-circuit: this tick is
            // the only place a COLD session's tmux `#{session_activity}` is
            // observed (its pty was detached by the reaper, so noteActivity()
            // never fires for it). Without this, a background terminal that
            // starts printing again would stay frozen in the sidebar until the
            // 60s activity bucket happens to flip.
            this.pruneActivityTable(list);
            this.emitActivity(Object.fromEntries(
                list.filter((t) => t.activityAt).map((t) => [t.id, t.activityAt!]),
            ));
            const sig = terminalListSignature(list);
            if (sig === this.lastListSignature) return;
            this.lastListSignature = sig;
            cb(list);
        } catch (e) {
            logger.debug(`[WEB TERMINAL] list track tick failed: ${e}`);
        }
    }

    /** Drop de-dup entries for terminals that no longer exist, so a long-lived
     *  daemon can't accumulate one number per terminal ever created. */
    private pruneActivityTable(list: TerminalListItem[]): void {
        const alive = new Set(list.map((t) => t.id));
        for (const id of this.terminals.keys()) alive.add(id);
        for (const id of Object.keys(this.lastActivityEmitted)) {
            if (!alive.has(id)) delete this.lastActivityEmitted[id];
        }
    }

    /** Feed this tick's agentState observations into the transition tracker
     *  and surface any resulting notification events. Disappeared terminals
     *  are pruned so per-terminal state can't leak. Never throws. */
    private trackNotifications(list: TerminalListItem[]): void {
        if (!this.onNotify) return;
        const now = Date.now();
        this.notifyTracker.prune(list.map((t) => t.id));
        for (const item of list) {
            const event = this.notifyTracker.observe(item.id, item.agentState, now);
            if (!event) continue;
            try {
                this.onNotify({ terminalId: item.id, title: item.title || 'Terminal', event });
            } catch (e) {
                logger.debug(`[WEB TERMINAL] notify callback failed: ${e}`);
            }
        }
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
            //
            // `resub` marks a catch-up from a viewer that ALREADY holds a
            // subscription (visibility/reconnect refresh): it must not inflate
            // the count — each catchUp used to +1 while terminal-close only
            // ever -1'd once, permanently pinning the pty past the idle reaper
            // (subs=2→3→4 observed in the field). Old webs never send the flag
            // and keep the (conservative) legacy behavior.
            if (!opts.resub || existing.subscribers === 0) existing.subscribers += 1;
            existing.lastTouch = Date.now();
            this.applyResize(existing, cols, rows);
            const state = existing.subscribeState(opts.fromSeq);
            logger.debug(`[WEB TERMINAL] re-subscribed ${id} (subs=${existing.subscribers}, mode=${state.mode}, seq=${state.seq})`);
            return { terminalId: id, tmuxSession: existing.tmuxSession, ...state };
        }

        // Attach-only opens (viewer catch-ups via `resub`, and every new-web
        // open except the fresh-create one) must NEVER create a session: with
        // create-or-attach semantics, a terminal deleted from the sidebar was
        // resurrected by its own still-mounted screen (kill → catch-up open →
        // `new-session -A` recreated `vh-<id>` → the list push re-adopted it
        // everywhere — the "terminal won't delete" bug), or by refreshing its
        // URL. No live pty and no tmux session ⇒ the terminal is gone; fail
        // honestly and let the client drop the row. ('terminal-gone' is the
        // contract string the web matches on — see machineOpenTerminal.)
        if (opts.attachOnly || opts.resub) {
            const alive = isTmuxAvailable() && spawnSync(
                'tmux', ['has-session', '-t', `=vh-${id}:`],
                { stdio: 'ignore', timeout: TMUX_PROBE_TIMEOUT_MS, env: ptyEnv() },
            ).status === 0;
            if (!alive) throw new Error('terminal-gone');
        } else if (this.tombstones[id]) {
            // A CREATE request for a previously-killed id = a stale client
            // replaying legacy create-or-attach (fresh creates use random
            // ids). If the tmux session somehow exists (resurrected before
            // this guard shipped) attach honestly; otherwise refuse — the
            // terminal stays deleted no matter how old the client is.
            const alive = isTmuxAvailable() && spawnSync(
                'tmux', ['has-session', '-t', `=vh-${id}:`],
                { stdio: 'ignore', timeout: TMUX_PROBE_TIMEOUT_MS, env: ptyEnv() },
            ).status === 0;
            if (!alive) {
                logger.debug(`[WEB TERMINAL] refused stale-client resurrection of tombstoned ${id}`);
                throw new Error('terminal-gone');
            }
        }

        const env = ptyEnv();
        let file: string;
        let args: string[];
        let tmuxSession: string | undefined;

        if (isTmuxAvailable()) {
            tmuxSession = `vh-${id}`;
            // ── NEW vs ATTACH ─────────────────────────────────────────────────
            // Create the session HERE, synchronously: `new-session -d` exits
            // non-zero ("duplicate session") when the session already exists, so
            // its exit status is an ATOMIC "did WE just create it" signal — no
            // separate has-session probe whose answer could go stale between
            // probe and create (two devices opening the same id concurrently
            // can't both observe "new"). Only a genuinely-created session gets
            // the startup command; every re-attach (daemon restart, reaped pty,
            // another device) sees "duplicate" and injects nothing.
            let createdNew = false;
            // Classic-renderer default for claude launched inside this session
            // (see CLAUDE_CLASSIC_RENDERER_ENV). `-e` is create-only: it sets
            // the initial pane's environment on creation and is ignored when
            // `-A` attaches to an existing session. Gated on tmux ≥3.2 — an
            // older tmux rejects the unknown flag and would fail the create.
            const envFlags = tmuxSupportsEnvFlag() ? ['-e', CLAUDE_CLASSIC_RENDERER_ENV] : [];
            // Attach-only opens skip BOTH creation paths (this pre-create and
            // the pty script's `new-session -A` below): the has-session gate
            // above said the session exists, and racing a concurrent kill must
            // fail the attach, not quietly recreate the session.
            const attachOnly = !!(opts.attachOnly || opts.resub);
            if (!attachOnly) {
                try {
                    // env: THIS call may boot the tmux server, which pins its
                    // environment for the life of the server — without ptyEnv() a
                    // daemon launched from launchd/GUI would hand every session a
                    // PATH missing ~/.local/bin and a C locale (CJK width breakage).
                    // The pty's attach script (below) gets the same env via
                    // pty.spawn, so both creation paths agree. Later tmux calls
                    // pass it too — harmless once the server runs (env doesn't
                    // re-stick), correct when one of them is the first to boot it.
                    const created = spawnSync('tmux',
                        ['new-session', '-d', ...envFlags, '-s', tmuxSession, '-x', String(cols), '-y', String(rows), '-c', cwd],
                        { stdio: 'ignore', timeout: TMUX_CREATE_TIMEOUT_MS, env });
                    createdNew = created.status === 0;
                } catch {
                    // tmux hiccup — the pty script's `new-session -A` below still
                    // covers creation; we just lose startup injection this once.
                }
            }
            // Session-scoped options (mouse off / history-limit — see the
            // setOpts comment below for rationale) plus the idempotent
            // server-scoped clipboard ones. Applied on EVERY open — create AND
            // reattach: the copies kept in the pty script only ever run when
            // `-A` itself creates the session; with the session pre-existing
            // the script's exec attach blocks first, so a reattach through the
            // script alone never (re)applies them (observed in the wild: a
            // session with `mouse` unset after the pre-create landed). All
            // idempotent, so re-running on every open is free; if the session
            // doesn't exist yet because the pre-create failed, these fail
            // best-effort and the script fallback still covers it.
            // (`=name:` = exact-match target, see startupInjectionArgs.)
            const optArgs = [
                ['set-option', '-t', `=${tmuxSession}:`, 'mouse', 'off'],
                ['set-option', '-t', `=${tmuxSession}:`, 'history-limit', '2000'],
                // Native-terminal feel: hide tmux's green status bar. The web
                // header already shows the session title, so the bar is pure
                // tmux noise there. Session-scoped ⇒ a LOCAL `tmux attach -t
                // vh-*` for debugging also loses the bar — accepted trade-off
                // (`tmux set -t <sess> status on` brings it back if needed).
                // tmux reflows the pane to reclaim the row by itself; the
                // copy-mode position indicator ([0/1234], top-right) lives in
                // the pane, not the bar, so scrollback review keeps its signal.
                ['set-option', '-t', `=${tmuxSession}:`, 'status', 'off'],
                // Re-emit the pane's title to the attach client (OSC 0), with
                // the raw pane_title as the string. This is what makes the
                // headless Terminal's onTitleChange fire for LIVE sessions —
                // a zero-subprocess title event feeding the list tracker —
                // instead of waiting for the next tmux poll. Session-scoped;
                // the web xterm also sees the OSC, which is inert there.
                ['set-option', '-t', `=${tmuxSession}:`, 'set-titles', 'on'],
                ['set-option', '-t', `=${tmuxSession}:`, 'set-titles-string', '#{pane_title}'],
                ['set-option', '-g', 'set-clipboard', 'on'],
                ['set-option', '-ga', 'terminal-features', ',xterm-256color:clipboard'],
            ];
            for (const a of optArgs) {
                try { spawnSync('tmux', a, { stdio: 'ignore', timeout: TMUX_PROBE_TIMEOUT_MS, env }); } catch { /* best-effort */ }
            }
            if (createdNew) {
                // Startup command — ONLY into the session we just created. tmux
                // buffers pane input, so it's fine that the pane's shell may not
                // have finished starting; it runs the command once it reads.
                const startup = normalizeStartupCommand(opts.startupCommand);
                if (startup) {
                    try {
                        for (const a of startupInjectionArgs(tmuxSession, startup)) {
                            spawnSync('tmux', a, { stdio: 'ignore', timeout: TMUX_PROBE_TIMEOUT_MS, env });
                        }
                        logger.debug(`[WEB TERMINAL] injected startup command into new session ${tmuxSession}`);
                    } catch { /* injection is best-effort, never blocks the open */ }
                }
            }
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
            //   - history-limit: deep scrollback for panes in the session. Kept
            //     modest (2000): the daemon's headless buffer (HEADLESS_SCROLLBACK)
            //     is now the authoritative scrollback the web renders from, so a
            //     100k-line tmux history was mostly dead redundant memory. 2000
            //     still gives copy-mode a useful recent window — and with the
            //     classic-renderer claude default (CLAUDE_CLASSIC_RENDERER_ENV)
            //     this history is where the transcript lands, i.e. the wheel's
            //     copy-mode review depth. NOTE it only affects panes created
            //     AFTER it's set; the initial pane keeps the server default,
            //     which is also 2000 — the option pins that against user configs.
            //   - status OFF: native-terminal feel — the web renders these
            //     sessions as plain terminals, so tmux's green status bar is
            //     noise (the web header owns the title). tmux reclaims the row
            //     and reflows on its own. See the optArgs copy above for the
            //     local-attach trade-off.
            //  Server-scoped (`-g`, no session-scoped equivalent exists):
            //   - set-clipboard on + terminal-features …:clipboard: make tmux
            //     emit an OSC 52 escape when copying (keyboard copy-mode yank), so
            //     the web xterm (with @xterm/addon-clipboard) mirrors it into the
            //     browser clipboard. Benign + desirable globally.
            const setOpts = [
                `tmux set-option -t ${tmuxSession} mouse off`,
                `tmux set-option -t ${tmuxSession} history-limit 2000`,
                `tmux set-option -t ${tmuxSession} status off`,
                `tmux set-option -t ${tmuxSession} set-titles on`,
                `tmux set-option -t ${tmuxSession} set-titles-string '#{pane_title}'`,
                `tmux set-option -g set-clipboard on`,
                `tmux set-option -ga terminal-features ',xterm-256color:clipboard'`,
            ].join(' >/dev/null 2>&1; ') + ' >/dev/null 2>&1; ';
            // The script's `-A` create fallback carries the same `-e` env flag
            // (see envFlags above): only effective if THIS line is what creates
            // the session (pre-create failed); ignored on the attach path. The
            // value contains no shell metacharacters — safe to inline.
            const envFlagsSh = envFlags.length > 0 ? ` -e ${CLAUDE_CLASSIC_RENDERER_ENV}` : '';
            // Attach-only: no `new-session -A` fallback either — if the session
            // died between the has-session gate and here (concurrent kill), the
            // bare attach fails and the pty exits, instead of resurrecting it.
            const createFallback = attachOnly
                ? ''
                : `tmux new-session -A -d${envFlagsSh} -s ${tmuxSession} -x ${cols} -y ${rows} >/dev/null 2>&1; `;
            args = ['-c',
                createFallback
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

        // No-tmux fallback: there IS no attach path — reaching this point (no
        // live map entry, no tmux) always means a brand-new shell, so injecting
        // the startup command as pty input is safe (the kernel pty buffers it
        // until the shell starts reading). '\r' = the Enter keypress.
        if (!tmuxSession) {
            const startup = normalizeStartupCommand(opts.startupCommand);
            if (startup) {
                try { proc.write(startup + '\r'); } catch { /* best-effort */ }
            }
        }

        const session = new TerminalSession(id, proc, tmuxSession, cols, rows);
        session.subscribers = 1;
        this.terminals.set(id, session);

        // Live title events: the inner app's OSC title (re-emitted by tmux —
        // `set-titles` above) reaches the headless screen with zero subprocess
        // cost. The kick's refresh does the actual pane_title→@vh_title follow
        // through the ONE existing listSessions path, so there's no second
        // title-writing code path to keep consistent.
        session.onTitleChange(() => this.kickListRefresh());

        // Every pty chunk: ingest into the authoritative screen + ring (assigning
        // a seq), then relay to subscribers tagged with that seq. The guard
        // ensures a stale pty replaced by a re-attach can't emit for this id.
        proc.onData((data) => {
            if (this.terminals.get(id) !== session) return;
            const b64 = Buffer.from(data, 'utf8').toString('base64');
            const seq = session.ingest(data, b64);
            this.emit('terminal-output', { terminalId: id, data: b64, seq });
            // Realtime sidebar ordering: `ingest` just stamped lastOutputAt —
            // tell the clients about it (throttled; see noteActivity).
            this.noteActivity();
        });
        proc.onExit(({ exitCode }) => {
            if (this.terminals.get(id) !== session) return;
            this.terminals.delete(id);
            session.dispose();
            this.emit('terminal-exit', { terminalId: id, exitCode });
            // The tmux session usually died with its client (shell exit) —
            // refresh the tracked list so the terminal vanishes everywhere.
            this.kickListRefresh();
        });

        logger.debug(`[WEB TERMINAL] opened ${id} (${file} ${args.join(' ')}) ${cols}x${rows} cwd=${cwd}`);
        // Membership may have changed (a genuinely new tmux session) — let the
        // tracker see it now instead of at the next tick.
        this.kickListRefresh();
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
            spawnSync('tmux', ['kill-session', '-t', `vh-${terminalId}`], { stdio: 'ignore', env: ptyEnv() });
        } catch {
            // tmux gone / session already dead
        }
        // Tombstone the id so stale clients can't legacy-create it back.
        this.tombstones[terminalId] = Date.now();
        saveTombstones(this.tombstones);
        // Drop its notification state — a killed terminal must never fire.
        this.notifyTracker.remove(terminalId);
        logger.debug(`[WEB TERMINAL] killed session vh-${terminalId}`);
        // Deletion propagates by ABSENCE from the pushed list — refresh now so
        // every device converges without tombstone bookkeeping.
        this.kickListRefresh();
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
     *
     * Auto-title piggybacks here: the SAME list-sessions call carries each
     * session's `#{pane_title}` plus the current `@vh_title` and the manual
     * flag (user options expand in -F formats — one subprocess total, replacing
     * the old per-session `show-options` spawn). When the pane title is
     * meaningful (see deriveAutoTitle) and the terminal wasn't manually
     * renamed, it is written through to `@vh_title`, so the sidebar title
     * FOLLOWS Claude Code's live task summary at poll cadence. Works for cold
     * sessions too (reaped pty / daemon restart) — it's pure tmux state.
     */
    listSessions(): TerminalListItem[] {
        if (!isTmuxAvailable()) return [];
        try {
            const env = ptyEnv();
            const r = spawnSync('tmux',
                ['list-sessions', '-F', LIST_SESSIONS_FORMAT],
                { encoding: 'utf8', env });
            if (r.status !== 0 || !r.stdout) return [];
            const hostname = os.hostname();
            const out: TerminalListItem[] = [];
            for (const line of r.stdout.split('\n')) {
                const s = parseSessionListLine(line);
                if (!s || !s.name.startsWith('vh-')) continue;
                const id = s.name.slice(3);
                let title = s.vhTitle;
                const auto = deriveAutoTitle(s.paneTitle, hostname);
                if (auto && !s.manual && auto !== title) {
                    // Follow the pane title into the cross-device truth. Overwrites
                    // any previous AUTO title on purpose (the summary tracks the
                    // task); a manual rename (flag) is never touched. Best-effort:
                    // on failure we just report the stored title this round.
                    try {
                        const w = spawnSync('tmux', ['set-option', '-t', `=${s.name}:`, '@vh_title', auto],
                            { stdio: 'ignore', timeout: TMUX_PROBE_TIMEOUT_MS, env });
                        if (w.status === 0) title = auto;
                    } catch { /* keep the stored title */ }
                }
                out.push({
                    id,
                    title,
                    cwd: s.cwd,
                    createdAt: s.created,
                    // tmux last-activity (epoch s) → ms; optional so old daemons
                    // simply omit it and web clients fall back to createdAt.
                    activityAt: s.activity,
                    agentState: this.probeAgentState(s.name),
                });
            }
            return out;
        } catch {
            return [];
        }
    }

    /** Best-effort agent-state probe for one session.
     *  Fast path (zero subprocess): if the daemon holds a live TerminalSession
     *  for this id, classify from its authoritative headless screen + pty
     *  foreground name. The sidebar polls this for every session on each refresh;
     *  the old path spawned 2 tmux procs EACH (2×N per refresh) — now a terminal
     *  you've opened this daemon lifetime costs nothing. Cold tmux-only sessions
     *  (pty reaped / never attached) fall back to the tmux probe. */
    private probeAgentState(sessionName: string): AgentState | undefined {
        const id = sessionName.startsWith('vh-') ? sessionName.slice(3) : sessionName;
        const live = this.terminals.get(id);
        if (live) {
            try {
                const { command, tail } = live.agentProbeInput();
                return classifyPane(command, tail);
            } catch { /* fall through to the tmux probe */ }
        }
        return this.probeAgentStateViaTmux(sessionName);
    }

    /** Fallback probe for sessions with no live headless: 2 short tmux calls
     *  (foreground command + pane tail) fed into classifyPane. Any failure or
     *  timeout → undefined (the field is omitted), never an error. */
    private probeAgentStateViaTmux(sessionName: string): AgentState | undefined {
        try {
            const cmd = spawnSync('tmux',
                ['display-message', '-p', '-t', sessionName, '#{pane_current_command}'],
                { encoding: 'utf8', timeout: TMUX_PROBE_TIMEOUT_MS, env: ptyEnv() });
            if (cmd.status !== 0 || typeof cmd.stdout !== 'string') return undefined;
            const cap = spawnSync('tmux',
                ['capture-pane', '-p', '-t', sessionName, '-S', '-40'],
                { encoding: 'utf8', timeout: TMUX_PROBE_TIMEOUT_MS, env: ptyEnv() });
            if (cap.status !== 0 || typeof cap.stdout !== 'string') return undefined;
            return classifyPane(cmd.stdout.trim(), cap.stdout);
        } catch {
            return undefined;
        }
    }

    /**
     * Scroll a terminal's tmux history for a client wheel gesture. Needed
     * because the attach-client pty holds the OUTER terminal in the alternate
     * screen, so the web xterm has no scrollback of its own — history lives in
     * tmux (history-limit) and is reached via copy-mode. `lines > 0` scrolls up.
     * See planScrollAction for the decision table. Best-effort: any tmux
     * failure is swallowed (a scroll is never worth an error to the client).
     */
    scroll(terminalId: string, lines: number) {
        if (!isTmuxAvailable()) return;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(terminalId)) return;
        if (!Number.isFinite(lines)) return;
        const name = `vh-${terminalId}`;
        const session = this.terminals.get(terminalId);
        if (session) session.lastTouch = Date.now();
        try {
            const probe = spawnSync('tmux',
                ['display-message', '-p', '-t', name, '#{pane_in_mode}\t#{alternate_on}\t#{mouse_any_flag}\t#{pane_width}\t#{pane_height}\t#{pane_current_command}'],
                { encoding: 'utf8', timeout: TMUX_PROBE_TIMEOUT_MS, env: ptyEnv() });
            if (probe.status !== 0 || typeof probe.stdout !== 'string') return;
            const [inMode, altOn, wantsMouse, paneW, paneH, paneCmd] = probe.stdout.trim().split('\t');
            const action = planScrollAction(
                inMode === '1', altOn === '1', wantsMouse === '1', lines,
                looksLikeClaudeCommand(paneCmd || ''), Number(paneH) || 24);
            if (action.kind === 'none') return;
            if (action.kind === 'mouse-wheel') {
                // The pane's app asked for mouse reporting (Claude Code TUI):
                // hand it real SGR wheel events at the pane center — arrow keys
                // would edit its input box instead of scrolling. `-H` writes
                // the raw bytes; one call carries the whole burst.
                const hex = sgrWheelHexBytes(action.dir, action.count, Number(paneW) || 80, Number(paneH) || 24);
                spawnSync('tmux', ['send-keys', '-t', name, '-H', ...hex],
                    { stdio: 'ignore', timeout: TMUX_PROBE_TIMEOUT_MS, env: ptyEnv() });
                return;
            }
            if (action.kind === 'page-keys') {
                // Fullscreen Claude Code without mouse reporting: PageUp/PageDown
                // are its documented scroll keys; arrows would open the input
                // box's prompt-history browser instead of scrolling.
                spawnSync('tmux', ['send-keys', '-t', name, '-N', String(action.count), action.key],
                    { stdio: 'ignore', timeout: TMUX_PROBE_TIMEOUT_MS, env: ptyEnv() });
                return;
            }
            if (action.kind === 'keys') {
                spawnSync('tmux', ['send-keys', '-t', name, '-N', String(action.count), action.key],
                    { stdio: 'ignore', timeout: TMUX_PROBE_TIMEOUT_MS, env: ptyEnv() });
                return;
            }
            // copy-scroll: enter copy-mode idempotently (-e → auto-exit at the
            // bottom, so wheel-down naturally returns to the live view).
            spawnSync('tmux', ['copy-mode', '-e', '-t', name],
                { stdio: 'ignore', timeout: TMUX_PROBE_TIMEOUT_MS, env: ptyEnv() });
            spawnSync('tmux',
                ['send-keys', '-X', '-t', name, '-N', String(action.count),
                    action.dir === 'up' ? 'scroll-up' : 'scroll-down'],
                { stdio: 'ignore', timeout: TMUX_PROBE_TIMEOUT_MS, env: ptyEnv() });
        } catch {
            // tmux gone / session dead — nothing to scroll
        }
    }

    /** Persist a human title on the tmux session (`@vh_title`) so every device
     *  sees the same name.
     *
     *  `ifAbsent` (the web's first-command fallback auto-title) skips when a
     *  title already exists, so it never clobbers an existing name on reattach.
     *  It does NOT mark the title manual — a fallback title stays overridable
     *  by the pane-title auto-follow (listSessions), e.g. when claude starts
     *  later in that shell.
     *
     *  A direct set (`ifAbsent=false`) is a USER RENAME — sidebar rename or the
     *  web's pendingTitle re-push of one — and additionally stamps
     *  `@vh_title_manual`, which permanently stops the auto-follow for this
     *  terminal (a title the user chose must not drift with the task summary).
     *  The flag lives in tmux, not daemon memory, so it survives daemon
     *  restarts and is visible to the listSessions format read.
     *
     *  Returns whether the machine actually holds a title now: the web's
     *  `pendingTitle` mechanism treats the RPC's success as the machine's ack
     *  and clears the pending flag — an unconditional success (session gone,
     *  tmux missing, set-option failure) would clear it on a rename that never
     *  landed. `ifAbsent` finding an existing title counts as success (there IS
     *  a title; nothing to retry). */
    setTitle(terminalId: string, title: string, ifAbsent = false): boolean {
        if (!isTmuxAvailable()) return false;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(terminalId)) return false;
        const name = `vh-${terminalId}`;
        try {
            if (ifAbsent) {
                const cur = spawnSync('tmux', ['show-options', '-t', name, '-v', '@vh_title'], { encoding: 'utf8', env: ptyEnv() });
                if (cur.status === 0 && cur.stdout && cur.stdout.trim()) return true; // already titled
            }
            const r = spawnSync('tmux', ['set-option', '-t', name, '@vh_title', title], { stdio: 'ignore', env: ptyEnv() });
            if (r.status !== 0) return false;
            if (!ifAbsent) {
                try { spawnSync('tmux', ['set-option', '-t', name, '@vh_title_manual', '1'], { stdio: 'ignore', env: ptyEnv() }); } catch { /* best-effort */ }
            }
            // A rename must reach other devices immediately, not at tick cadence.
            this.kickListRefresh();
            return true;
        } catch {
            return false; // session gone
        }
    }
}
