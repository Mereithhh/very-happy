/**
 * Session operations for remote procedure calls
 * Provides strictly typed functions for all session-related RPC operations
 */

import { apiSocket } from './apiSocket';
import { sync } from './sync';
import { storage } from './storage';
import type { MachineMetadata, Metadata } from './storageTypes';
import { commitSessionResume } from './sessionResumeFlow';

// Strict type definitions for all operations

// Permission operation types
interface SessionPermissionRequest {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    updatedInput?: Record<string, unknown>;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

// Mode change operation types
interface SessionModeChangeRequest {
    to: 'remote' | 'local';
}

// Bash operation types
interface SessionBashRequest {
    command: string;
    cwd?: string;
    timeout?: number;
}

interface SessionBashResponse {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}

// Read file operation types
interface SessionReadFileRequest {
    path: string;
}

interface SessionReadFileResponse {
    success: boolean;
    content?: string; // base64 encoded
    error?: string;
}

// Write file operation types
interface SessionWriteFileRequest {
    path: string;
    content: string; // base64 encoded
    expectedHash?: string | null;
}

interface SessionWriteFileResponse {
    success: boolean;
    hash?: string;
    error?: string;
}

// List directory operation types
interface SessionListDirectoryRequest {
    path: string;
}

interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number;
}

interface SessionListDirectoryResponse {
    success: boolean;
    entries?: DirectoryEntry[];
    error?: string;
}

// Directory tree operation types
interface SessionGetDirectoryTreeRequest {
    path: string;
    maxDepth: number;
}

interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modified?: number;
    children?: TreeNode[];
}

interface SessionGetDirectoryTreeResponse {
    success: boolean;
    tree?: TreeNode;
    error?: string;
}

// Ripgrep operation types
interface SessionRipgrepRequest {
    args: string[];
    cwd?: string;
}

interface SessionRipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

// Kill session operation types

interface SessionKillResponse {
    success: boolean;
    message: string;
}

// Response types for spawn session
export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

// Options for spawning a session
export interface SpawnSessionOptions {
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    agent?: 'codex' | 'claude' | 'gemini' | 'openclaw';
    /**
     * If set, the daemon spawns the agent with `--resume <id>` so the new
     * Happy session attaches to a pre-existing on-disk Claude conversation
     * file. Used by the session fork / duplicate flow.
     */
    resumeClaudeSessionId?: string;
    /**
     * If set, the daemon spawns Codex with `--resume <id>` so the new Happy
     * session attaches to an app-server thread created by fork / duplicate.
     */
    resumeCodexThreadId?: string;
    /** Happy session id this fork was branched from (lineage). */
    parentSessionId?: string;
    /** Happy message id used as the rewind point (only set for "duplicate"). */
    forkedFromMessageId?: string;
    /**
     * Session variant tag forwarded to the daemon (e.g. 'assistant' for the
     * meta-agent voice session). New daemons use it to pick their own cwd and
     * dedupe the singleton; old daemons ignore the unknown field (bidirectional
     * compatibility is a design requirement).
     */
    variant?: string;
    /**
     * Skip the daemon-side variant-singleton dedupe: stop any existing process
     * for this variant and spawn a brand-new one ("new conversation"). Old
     * daemons ignore the unknown field and may return the existing session.
     */
    forceNew?: boolean;
    /**
     * Permission mode the daemon forwards to the spawned CLI as
     * `--permission-mode <v>` (daemon-side allowlist; invalid values ignored).
     * Used by the assistant "skip permission approvals" setting: off → send
     * 'default' so tool use requires approval. Absent → daemon default
     * (the fork's yolo). Old daemons ignore the unknown field.
     */
    permissionMode?: string;
}

// Options for forking a Claude session on a machine
export interface ClaudeForkSessionOptions {
    machineId: string;
    /** Working directory of the source session — used to derive the Claude project dir. */
    directory: string;
    /** Source Claude session UUID (Session.metadata.claudeSessionId on the parent). */
    claudeSessionId: string;
}

export type ClaudeForkSessionResult =
    | { type: 'success'; newClaudeSessionId: string }
    | { type: 'error'; errorMessage: string };

export interface ClaudeRewindPoint {
    uuid: string;
    text: string;
    timestamp: number;
}

export type ClaudeListRewindPointsResult =
    | { type: 'success'; points: ClaudeRewindPoint[] }
    | { type: 'error'; errorMessage: string };

export interface CodexForkThreadOptions {
    machineId: string;
    /** Working directory of the source session, passed to Codex thread/fork. */
    directory: string;
    /** Source Codex app-server thread id (Session.metadata.codexThreadId). */
    codexThreadId: string;
}

export type CodexForkThreadResult =
    | { type: 'success'; newCodexThreadId: string }
    | { type: 'error'; errorMessage: string };

export interface CodexRewindPoint {
    itemId: string;
    text: string;
    timestamp: number;
}

export type CodexListRewindPointsResult =
    | { type: 'success'; points: CodexRewindPoint[] }
    | { type: 'error'; errorMessage: string };

export interface ResumeSessionOptions {
    machineId: string;
    sessionId: string;
}

// Exported session operation functions

/**
 * Spawn a new remote session on a specific machine
 */
export async function machineSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {

    const { machineId, directory, approvedNewDirectoryCreation = false, token, agent, resumeClaudeSessionId, resumeCodexThreadId, parentSessionId, forkedFromMessageId, variant, forceNew, permissionMode } = options;

    try {
        const result = await apiSocket.machineRPC<SpawnSessionResult, {
            type: 'spawn-in-directory'
            directory: string
            approvedNewDirectoryCreation?: boolean,
            token?: string,
            agent?: 'codex' | 'claude' | 'gemini' | 'openclaw',
            resumeClaudeSessionId?: string,
            resumeCodexThreadId?: string,
            parentSessionId?: string,
            forkedFromMessageId?: string,
            variant?: string,
            forceNew?: boolean,
            permissionMode?: string,
        }>(
            machineId,
            'spawn-happy-session',
            { type: 'spawn-in-directory', directory, approvedNewDirectoryCreation, token, agent, resumeClaudeSessionId, resumeCodexThreadId, parentSessionId, forkedFromMessageId, variant, forceNew, permissionMode }
        );
        return result;
    } catch (error) {
        // Handle RPC errors
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to spawn session'
        };
    }
}

/**
 * Open a web terminal (tmux-in-pty) on one of the user's machines. Account
 * scoping is enforced server-side. Returns the terminalId used for the
 * subsequent terminal-input/output/resize/close byte stream.
 */
/**
 * Wait (bounded) for a machine's encryption to be initialized. On a cold load
 * or a direct navigation to the terminal URL, `fetchMachines` (which decrypts
 * the per-machine data key and calls `initializeMachines`) may not have run yet,
 * so a machine RPC would throw "Machine encryption not found". Polling until the
 * key is ready turns that race into a brief wait instead of a hard failure.
 */
export async function ensureMachineEncryption(machineId: string, timeoutMs = 12000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (sync.encryption.getMachineEncryption(machineId)) return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return !!sync.encryption.getMachineEncryption(machineId);
}

/**
 * Encrypt/decrypt the terminal byte stream with the per-machine key. This makes
 * bytes opaque to passive storage/forwarding, but does not exclude the trusted
 * relay operator, who can recover account material or impersonate Web access.
 * `data` is a base64 string of raw bytes; the ciphertext is itself base64.
 */
export async function encryptTerminalData(machineId: string, dataB64: string): Promise<string | null> {
    const me = sync.encryption.getMachineEncryption(machineId);
    if (!me) return null;
    return me.encryptRaw(dataB64);
}
export async function decryptTerminalData(machineId: string, cipher: string): Promise<string | null> {
    const me = sync.encryption.getMachineEncryption(machineId);
    if (!me) return null;
    const out = await me.decryptRaw(cipher);
    return typeof out === 'string' ? out : null;
}

/** How the daemon brought a (re)subscribing client up to date:
 *  - `snapshot`: full authoritative screen — client does reset() + write(data).
 *  - `replay`:   only the chunks after the client's `fromSeq` — apply in seq
 *                order, dedup by seq, no reset.
 *  `data`/`chunks[].data` are base64 raw bytes, encrypted iff `encStream`. */
export type OpenTerminalOk = {
    success: true;
    terminalId: string;
    tmuxSession?: string;
    encStream?: boolean;
    seq: number;
    /** B-121 terminal channel v2. Absent = an old daemon that only speaks the
     *  full-screen tmux mirror ('attach'); the client keeps every v1 behavior
     *  (wheel hijack → terminal-scroll RPC, synthetic touch wheel, blank belt).
     *  'lines' = the daemon streams the pane's CONTENT (tmux control mode), so
     *  xterm owns a real local scrollback. LATCHED PER MOUNT: a daemon that
     *  changes generation mid-session (vh-update) must trigger a remount, never
     *  a hot switch (spec §D3 M-R2-4). */
    streamMode?: 'lines' | 'attach';
    /** lines-mode snapshot only: names the FULL capture the daemon is holding
     *  for `terminal-history` paging. Absent on a lines-mode REPLAY. */
    snapshotId?: string;
    /** lines-mode snapshot only: how many pages that full capture splits into. */
    totalPages?: number;
    /** lines-mode snapshot only: the pane was on the alternate screen when the
     *  capture ran → `data` is just its visible area and needs a synthesized
     *  `\x1b[?1049h` in front (spec §D1 R3 M-R3-3). */
    alternateOn?: boolean;
    /** B-124: the pane's authoritative geometry at capture time. A lines client
     *  wraps lines itself, so it must render at the width the application in the
     *  pane believes it has — otherwise a TUI's "erase N rows" repaint leaves a
     *  duplicate status line. Live changes arrive in-band (OSC 6121). */
    paneCols?: number;
    paneRows?: number;
} & (
    | { mode: 'snapshot'; data: string }
    | { mode: 'replay'; chunks: Array<{ seq: number; data: string }> }
);

export async function machineOpenTerminal(
    machineId: string,
    options: {
        terminalId?: string; cols?: number; rows?: number; cwd?: string; fromSeq?: number; encStream?: boolean;
        /** Auto-run ONLY if the daemon genuinely CREATES the tmux session for
         *  this open — a reattach never re-runs it (the daemon decides; the
         *  client can't know whether `vh-<id>` already exists on the machine).
         *  Old daemons ignore the extra field → nothing runs. */
        startupCommand?: string;
        /** This open is a catch-up from a viewer that already subscribed —
         *  the daemon must not count it as a new subscriber (old daemons
         *  ignore it = legacy conservative counting). Also implies
         *  `attachOnly` on daemons that understand it. */
        resub?: boolean;
        /** Attach to an EXISTING terminal only — never create the tmux
         *  session. Sent by every open except the one that intentionally
         *  creates the terminal (the fresh-create navigation), so a deleted
         *  terminal can't be resurrected by a lingering screen or a stale
         *  URL. Old daemons (< 0.2.29) ignore it = legacy create-or-attach. */
        attachOnly?: boolean;
        /** B-121 capability declaration: "I can consume the CONTENT stream".
         *  Old daemons ignore the field and answer with the v1 shape (no
         *  `streamMode`), which is exactly the attach fallback the client keeps
         *  around — so this is safe to send unconditionally (铁律 4). */
        streamMode?: 'lines';
    },
): Promise<OpenTerminalOk | { success: false; error: string; gone?: boolean }> {
    try {
        // Avoid the cold-load race: don't fire the RPC before the machine's
        // encryption key has synced, or it fails with "Machine encryption not found".
        await ensureMachineEncryption(machineId);
        const result = await apiSocket.machineRPC<
            {
                type: 'success'; terminalId: string; tmuxSession?: string; encStream?: boolean; seq: number;
                streamMode?: 'lines' | 'attach'; snapshotId?: string; totalPages?: number; alternateOn?: boolean; paneCols?: number; paneRows?: number;
            } & (
                | { mode: 'snapshot'; data: string }
                | { mode: 'replay'; chunks: Array<{ seq: number; data: string }> }
            ),
            { terminalId?: string; cols?: number; rows?: number; cwd?: string; fromSeq?: number; encStream?: boolean; startupCommand?: string; resub?: boolean; attachOnly?: boolean; streamMode?: 'lines' }
        >(machineId, 'open-terminal', options);
        // A daemon-side handler error comes back as `{ error }` WITH a
        // relay-level ok (RpcHandlerManager encrypts the error object as a
        // normal response), so machineRPC doesn't throw — detect it here.
        // 'terminal-gone' is the attach-only daemon's (>= 0.2.29) explicit
        // "this terminal no longer exists" — callers stop retrying and drop
        // the row instead of rendering a broken screen.
        const failed = result as unknown as { error?: string };
        if (typeof failed?.error === 'string') {
            return { success: false, error: failed.error, gone: failed.error === 'terminal-gone' };
        }
        // encStream is echoed back only by daemons that support stream encryption
        // (old daemons ignore the flag → falsy → we fall back to plaintext).
        const base = {
            success: true as const,
            terminalId: result.terminalId,
            tmuxSession: result.tmuxSession,
            encStream: result.encStream === true,
            seq: result.seq,
            // Passed through verbatim, INCLUDING absent: "no streamMode" is the
            // load-bearing signal for the attach fallback, so it must never be
            // defaulted to a value here.
            streamMode: result.streamMode,
            snapshotId: result.snapshotId,
            totalPages: result.totalPages,
            alternateOn: result.alternateOn,
            paneCols: result.paneCols,
            paneRows: result.paneRows,
        };
        return result.mode === 'replay'
            ? { ...base, mode: 'replay', chunks: result.chunks }
            : { ...base, mode: 'snapshot', data: result.data };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to open terminal' };
    }
}

/**
 * Upload a file to the machine via the machine-level RPC (used by the web
 * terminal's drag-and-drop). Lands under ~/.happy/uploads/terminal/ and returns
 * the absolute path so it can be pasted into the terminal. Reuses the same
 * `uploadFile` handler that sessions use (registered at machine level too).
 */
export async function machineUploadFile(
    machineId: string,
    name: string,
    content: string,
): Promise<MachineUploadFileResponse> {
    try {
        return await apiSocket.machineRPC<
            MachineUploadFileResponse,
            { name: string; content: string; subdir?: string }
        >(machineId, 'uploadFile', { name, content, subdir: 'terminal' });
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export type MachineUploadFileChunkRequest =
    | { action: 'start'; uploadId: string; name: string; totalSize: number; subdir?: string }
    | { action: 'append'; uploadId: string; offset: number; content: string }
    | { action: 'finish'; uploadId: string }
    | { action: 'abort'; uploadId: string };

export type MachineUploadFileResponse = {
    success: boolean;
    path?: string;
    pathQuoteStyle?: 'posix' | 'powershell' | 'cmd';
    size?: number;
    error?: string;
};

/**
 * Chunked counterpart to machineUploadFile. Each request stays below the
 * relay's encrypted 256 KiB RPC envelope; the daemon verifies ordering and
 * declared size, then atomically exposes the completed file.
 */
export async function machineUploadFileChunk(
    machineId: string,
    request: MachineUploadFileChunkRequest,
): Promise<MachineUploadFileResponse> {
    try {
        return await apiSocket.machineRPC<MachineUploadFileResponse, MachineUploadFileChunkRequest>(
            machineId,
            'uploadFileChunk',
            request,
        );
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Scroll a tmux-backed terminal's history on the machine. `lines > 0` scrolls
 * UP (into history), `lines < 0` scrolls down. The daemon enters tmux
 * copy-mode (-e: auto-exits at the bottom) and scrolls, or forwards arrow keys
 * when the pane's inner app is fullscreen (vim/less) — mirroring tmux's own
 * wheel semantics. Needed because tmux holds the outer terminal in the
 * alternate screen, where xterm.js has no scrollback of its own.
 * Returns false when the daemon doesn't support the RPC (old CLI) so the
 * caller can fall back to xterm's default wheel behavior.
 */
/**
 * B-107: paste one message into the terminal hosting an ACTIVE mirrored
 * claude (the structured view's input bar). The daemon pastes via tmux
 * bracketed paste + Enter; it HARD-refuses when the mirror binding is not
 * active (claude gone → the bytes would execute in a bare shell). Returns a
 * typed failure so the UI can distinguish "claude exited" from "old CLI".
 */
export async function machineMirrorTerminalSend(
    machineId: string,
    terminalId: string,
    text: string,
): Promise<{ success: true } | { success: false; reason: 'not-active' | 'unsupported' | 'error'; error: string }> {
    try {
        const r = await apiSocket.machineRPC<
            { type?: string; error?: string },
            { terminalId: string; text: string; submit: boolean }
        >(machineId, 'mirror-terminal-send', { terminalId, text, submit: true });
        // Daemon-side handler errors ride back as `{ error }` in a normal
        // response (RpcHandlerManager envelope) — machineRPC doesn't throw.
        if (typeof r?.error === 'string') {
            return {
                success: false,
                reason: r.error === 'mirror-not-active' ? 'not-active' : 'error',
                error: r.error,
            };
        }
        if (r?.type === 'success') return { success: true };
        return { success: false, reason: 'error', error: 'unexpected response' };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'send failed';
        // An old CLI has no handler registered → the relay reports an unknown
        // method; surface it as "upgrade the CLI" instead of a generic error.
        const unsupported = /unknown|not.*(found|registered)|no handler/i.test(message);
        return { success: false, reason: unsupported ? 'unsupported' : 'error', error: message };
    }
}

/**
 * B-121 (spec §D1b「粘贴专路」): paste text into a lines-mode terminal through
 * the daemon instead of `term.paste()`.
 *
 * Why the local paste stops working in v2: the daemon no longer has a pty — it
 * writes to the pane with `send-keys`, and a multi-line literal sent that way
 * EXECUTES line by line. Bracketed paste can't save it either: xterm brackets
 * only what it believes the app enabled, and tmux 3.6b exposes no
 * bracketed-paste format for the daemon to re-derive it. The daemon instead
 * does `load-buffer` + `paste-buffer -p -d` on the SAME control-mode command
 * FIFO the keystrokes use — which also keeps "paste then Enter" in order (two
 * executors would let the Enter land first and run an empty line).
 *
 * Wire contract: `text` carries LF (`\n`) line separators and no trailing
 * newline for insert-style pastes; tmux's `paste-buffer` translates LF→CR and
 * `-p` wraps it in the bracketed-paste markers when the pane asked for them.
 * Attach-mode (v1 daemon) terminals keep using `term.paste()`.
 */
export async function machineTerminalPaste(
    machineId: string,
    terminalId: string,
    text: string,
): Promise<boolean> {
    try {
        const r = await apiSocket.machineRPC<
            { type?: string; error?: string },
            { terminalId: string; text: string }
        >(machineId, 'terminal-paste', { terminalId, text });
        // Daemon handler errors ride back inside a normal response envelope.
        if (typeof r?.error === 'string') return false;
        return r?.type === 'success';
    } catch {
        return false;
    }
}

/** One page of a held full capture, or the reason it can't be served. */
export type TerminalHistoryPage =
    | { ok: true; page: number; totalPages: number; data: string }
    /** The daemon dropped or replaced the capture named by `snapshotId`
     *  (new capture / TTL / terminal reaped) — the client gives up on this
     *  assembly and retries the whole open once. */
    | { ok: false; expired: true }
    | { ok: false; expired: false; error: string };

/**
 * B-121 (spec §D1「历史分页 RPC」): fetch one page of the full capture the
 * daemon is holding under `snapshotId` (established by the lines-mode open
 * response). `data` is base64, ≤256KB per page so the encrypted RPC envelope
 * (~342KB) stays well under the server's 1e6 socket.io frame limit — going over
 * disconnects the daemon socket, which would drop EVERY terminal on that
 * machine at once.
 *
 * History pages are completely decoupled from the live stream: they never enter
 * the ring, never touch seq, and are written raw during the atomic rebuild.
 */
export async function machineTerminalHistory(
    machineId: string,
    terminalId: string,
    snapshotId: string,
    page: number,
): Promise<TerminalHistoryPage> {
    try {
        const r = await apiSocket.machineRPC<
            { page?: number; totalPages?: number; data?: string; error?: string },
            { terminalId: string; snapshotId: string; page: number }
        >(machineId, 'terminal-history', { terminalId, snapshotId, page });
        if (typeof r?.error === 'string') {
            return r.error === 'snapshot-expired'
                ? { ok: false, expired: true }
                : { ok: false, expired: false, error: r.error };
        }
        if (typeof r?.data !== 'string') {
            return { ok: false, expired: false, error: 'malformed history page' };
        }
        return {
            ok: true,
            page: typeof r.page === 'number' ? r.page : page,
            totalPages: typeof r.totalPages === 'number' ? r.totalPages : 0,
            data: r.data,
        };
    } catch (error) {
        return {
            ok: false,
            expired: false,
            error: error instanceof Error ? error.message : 'history page failed',
        };
    }
}

export async function machineScrollTerminal(
    machineId: string,
    terminalId: string,
    lines: number,
): Promise<boolean> {
    try {
        const r = await apiSocket.machineRPC<
            { type: string },
            { terminalId: string; lines: number }
        >(machineId, 'terminal-scroll', { terminalId, lines });
        return r?.type === 'success';
    } catch {
        return false;
    }
}

/** Permanently destroy a terminal's tmux session on the machine. Returns
 *  whether the machine acked (false = offline/timeout/error; never throws) —
 *  a failed kill must surface to the user instead of pretending the terminal
 *  is gone (the machine would push it right back). */
export async function machineKillTerminal(machineId: string, terminalId: string): Promise<boolean> {
    try {
        const r = await apiSocket.machineRPC<{ type: 'success' }, { terminalId: string }>(
            machineId, 'kill-terminal', { terminalId },
        );
        return (r as unknown as { type?: string })?.type === 'success';
    } catch {
        return false;
    }
}

/** Claude Code status inside a terminal, reported by newer daemons.
 *  Old daemons omit the field entirely — treat `undefined` as "unknown" and
 *  keep the default terminal rendering (no agent dot, no alerts). */
export type TerminalAgentState = 'working' | 'needs_input' | 'idle' | 'shell';

export interface MachineTerminal {
    id: string;
    title?: string;
    cwd?: string;
    createdAt?: number;
    /** tmux session_activity (ms) — newer daemons only; fall back to createdAt. */
    activityAt?: number;
    agentState?: TerminalAgentState;
    /** B-105: id of this terminal's shadow mirror session (a hand-launched
     *  `claude` is being tailed into it). Absent when there is no mirror. */
    mirrorSessionId?: string;
    /** B-150: the daemon auto-restored this terminal after a restart (ms epoch).
     *  Directory and conversation carried over; the processes are new. The
     *  daemon clears it once the terminal is opened, so it is a "while you were
     *  away" hint, not a permanent property. */
    restoredAt?: number;
}

/** Persist a terminal's title on the machine so every device sees it.
 *  `ifAbsent` (auto-title from first command) won't overwrite a manual rename.
 *  The confirming daemon push carries the title back to every device.
 *  Returns whether the RPC went through (false = offline/timeout; never throws). */
export async function machineSetTerminalTitle(machineId: string, terminalId: string, title: string, ifAbsent = false): Promise<boolean> {
    try {
        await apiSocket.machineRPC<{ type: 'success' }, { terminalId: string; title: string; ifAbsent: boolean }>(
            machineId, 'set-terminal-title', { terminalId, title, ifAbsent },
        );
        return true;
    } catch {
        return false; // best-effort
    }
}

/**
 * Copy the source session's Claude JSONL on the daemon machine and return
 * the new Claude session UUID. Caller then spawns a fresh Happy session
 * with `resumeClaudeSessionId` set to that UUID to attach a new Happy
 * session row to the copied conversation.
 */
export async function claudeForkSession(options: ClaudeForkSessionOptions): Promise<ClaudeForkSessionResult> {
    const { machineId, directory, claudeSessionId } = options;
    try {
        const result = await apiSocket.machineRPC<ClaudeForkSessionResult, {
            directory: string;
            claudeSessionId: string;
        }>(
            machineId,
            'claude-fork-session',
            { directory, claudeSessionId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to fork session',
        };
    }
}

/**
 * Read the on-disk Claude JSONL on the daemon machine and return user-text
 * messages with their underlying claudeUuid + timestamp. Disk is the
 * source of truth for the rewind picker — server-side envelopes miss
 * claudeUuid for any user message that travelled via the legacy
 * `sentFrom: 'web'` path.
 */
export async function claudeListRewindPoints(
    options: ClaudeForkSessionOptions,
): Promise<ClaudeListRewindPointsResult> {
    const { machineId, directory, claudeSessionId } = options;
    try {
        const result = await apiSocket.machineRPC<ClaudeListRewindPointsResult, {
            directory: string;
            claudeSessionId: string;
        }>(
            machineId,
            'claude-list-rewind-points',
            { directory, claudeSessionId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to list rewind points',
        };
    }
}

/**
 * Same as claudeForkSession, but truncates the copied JSONL right after the
 * line with `cutAfterUuid` (keeping the chosen message as the last entry,
 * dropping every line after — including the agent's response). Use this
 * for "rewind to message N and try again" flows. Daemon hard-fails if the
 * UUID isn't present in the source — never silently produces a
 * non-truncated copy.
 */
export async function claudeDuplicateSession(
    options: ClaudeForkSessionOptions & { cutAfterUuid: string },
): Promise<ClaudeForkSessionResult> {
    const { machineId, directory, claudeSessionId, cutAfterUuid } = options;
    try {
        const result = await apiSocket.machineRPC<ClaudeForkSessionResult, {
            directory: string;
            claudeSessionId: string;
            cutAfterUuid: string;
        }>(
            machineId,
            'claude-duplicate-session',
            { directory, claudeSessionId, cutAfterUuid },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to duplicate session',
        };
    }
}

export async function codexForkThread(options: CodexForkThreadOptions): Promise<CodexForkThreadResult> {
    const { machineId, directory, codexThreadId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexForkThreadResult, {
            directory: string;
            codexThreadId: string;
        }>(
            machineId,
            'codex-fork-thread',
            { directory, codexThreadId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to fork Codex thread',
        };
    }
}

export async function codexDuplicateThread(
    options: CodexForkThreadOptions & { cutAfterItemId: string },
): Promise<CodexForkThreadResult> {
    const { machineId, directory, codexThreadId, cutAfterItemId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexForkThreadResult, {
            directory: string;
            codexThreadId: string;
            cutAfterItemId: string;
        }>(
            machineId,
            'codex-duplicate-thread',
            { directory, codexThreadId, cutAfterItemId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to duplicate Codex thread',
        };
    }
}

export async function codexListRewindPoints(
    options: CodexForkThreadOptions,
): Promise<CodexListRewindPointsResult> {
    const { machineId, directory, codexThreadId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexListRewindPointsResult, {
            directory: string;
            codexThreadId: string;
        }>(
            machineId,
            'codex-list-rewind-points',
            { directory, codexThreadId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to list Codex rewind points',
        };
    }
}

export async function machineResumeSession(options: ResumeSessionOptions & { model?: string; permissionMode?: string }): Promise<SpawnSessionResult> {
    const { machineId, sessionId, model, permissionMode } = options;

    return commitSessionResume(
        () => sessionUnarchive(sessionId),
        () => apiSocket.machineRPC<SpawnSessionResult, { sessionId: string; model?: string; permissionMode?: string }>(
            machineId,
            'resume-happy-session',
            { sessionId, model, permissionMode },
        ),
        () => sessionArchive(sessionId),
    );
}

/**
 * Permanently remove a machine from the server. Sessions spawned by the
 * machine are preserved; only the Machine row and its AccessKeys are deleted.
 */
export async function machineDelete(machineId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/machines/${machineId}`, {
            method: 'DELETE'
        });
        if (response.ok) {
            return { success: true };
        }
        const error = await response.text();
        return { success: false, message: error || 'Failed to delete machine' };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Stop the daemon on a specific machine
 */
export async function machineStopDaemon(machineId: string): Promise<{ message: string }> {
    const result = await apiSocket.machineRPC<{ message: string }, {}>(
        machineId,
        'stop-daemon',
        {}
    );
    return result;
}

/**
 * Execute a bash command on a specific machine
 */
export async function machineBash(
    machineId: string,
    command: string,
    cwd: string
): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
}> {
    try {
        const result = await apiSocket.machineRPC<{
            success: boolean;
            stdout: string;
            stderr: string;
            exitCode: number;
        }, {
            command: string;
            cwd: string;
        }>(
            machineId,
            'bash',
            { command, cwd }
        );
        return result;
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1
        };
    }
}

/**
 * Update machine metadata with optimistic concurrency control and automatic retry
 */
export async function machineUpdateMetadata(
    machineId: string,
    metadata: MachineMetadata,
    expectedVersion: number,
    maxRetries: number = 3
): Promise<{ version: number; metadata: string }> {
    let currentVersion = expectedVersion;
    let currentMetadata = { ...metadata };
    let retryCount = 0;

    const machineEncryption = sync.encryption.getMachineEncryption(machineId);
    if (!machineEncryption) {
        throw new Error(`Machine encryption not found for ${machineId}`);
    }

    while (retryCount < maxRetries) {
        const encryptedMetadata = await machineEncryption.encryptRaw(currentMetadata);

        const result = await apiSocket.emitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
            message?: string;
        }>('machine-update-metadata', {
            machineId,
            metadata: encryptedMetadata,
            expectedVersion: currentVersion
        });

        if (result.result === 'success') {
            return {
                version: result.version!,
                metadata: result.metadata!
            };
        } else if (result.result === 'version-mismatch') {
            // Get the latest version and metadata from the response
            currentVersion = result.version!;
            const latestMetadata = await machineEncryption.decryptRaw(result.metadata!) as MachineMetadata;

            // Merge our changes with the latest metadata
            // Preserve the displayName we're trying to set, but use latest values for other fields
            currentMetadata = {
                ...latestMetadata,
                displayName: metadata.displayName // Keep our intended displayName change
            };

            retryCount++;

            // If we've exhausted retries, throw error
            if (retryCount >= maxRetries) {
                throw new Error(`Failed to update after ${maxRetries} retries due to version conflicts`);
            }

            // Otherwise, loop will retry with updated version and merged metadata
        } else {
            throw new Error(result.message || 'Failed to update machine metadata');
        }
    }

    throw new Error('Unexpected error in machineUpdateMetadata');
}

/**
 * Set a session's title by writing `metadata.summary` directly via the
 * session `update-metadata` socket op (the same server op the CLI uses).
 *
 * This is the manual-rename write path: it bypasses the Happy `change_title`
 * MCP tool entirely (no agent round-trip). The server validates `accountId`
 * ownership and broadcasts an `update-session` to all interested clients,
 * so the CLI and other devices pick up the new title automatically.
 *
 * Pass an empty/whitespace title to clear the summary back to "no title".
 * Optimistic concurrency with bounded retry on version-mismatch.
 */
export async function sessionUpdateTitle(
    sessionId: string,
    title: string,
    maxRetries: number = 3
): Promise<void> {
    await sessionUpdateTitleTags(sessionId, { title }, maxRetries);
}

/**
 * Write title (`metadata.summary`) and/or tags (`metadata.tags`) in ONE
 * `update-metadata` round-trip — the rename modal edits both together, and a
 * single write avoids a pointless second version bump + conflict window.
 *
 * `title === undefined` / `tags === undefined` leave that field untouched;
 * an empty title clears the summary, an empty tags array deletes the field
 * (optional-only in MetadataSchema — never store a ghost `[]`).
 *
 * Same optimistic-concurrency/rebase semantics as the original
 * sessionUpdateTitle (see the version-mismatch comments below).
 */
export async function sessionUpdateTitleTags(
    sessionId: string,
    changes: { title?: string; tags?: string[] },
    maxRetries: number = 3
): Promise<void> {
    const applyChanges = (base: Metadata): Metadata => {
        const next: Metadata = { ...base };
        if (changes.title !== undefined) {
            const trimmed = changes.title.trim();
            if (trimmed.length === 0) {
                delete next.summary;
            } else {
                next.summary = { text: trimmed, updatedAt: Date.now() };
            }
        }
        if (changes.tags !== undefined) {
            if (changes.tags.length === 0) {
                delete next.tags;
            } else {
                next.tags = changes.tags;
            }
        }
        return next;
    };
    await sessionApplyMetadata(sessionId, applyChanges, maxRetries);
}

/**
 * Stamp the user's "mark done" moment on a session (`metadata.completedAt`).
 * The board's Done column derives its session records from this field; it
 * rides the normal metadata sync so every device sees the record for free.
 */
export async function sessionMarkCompleted(sessionId: string, maxRetries: number = 3): Promise<void> {
    const at = Date.now();
    await sessionApplyMetadata(sessionId, (base) => ({ ...base, completedAt: at }), maxRetries);
}

/**
 * Generic metadata write with the optimistic-concurrency/rebase loop
 * extracted from the original sessionUpdateTitle: on a version-mismatch the
 * server's authoritative {version, metadata} become the new base and `apply`
 * is replayed on top, so a concurrent CLI metadata write can never drop this
 * edit (and vice versa).
 */
export async function sessionApplyMetadata(
    sessionId: string,
    apply: (base: Metadata) => Metadata,
    maxRetries: number = 3
): Promise<void> {
    const sessionEncryption = sync.encryption.getSessionEncryption(sessionId);
    if (!sessionEncryption) {
        throw new Error(`Session encryption not found for ${sessionId}`);
    }

    // Seed base metadata/version from local storage, then keep them in lock-step
    // with what the SERVER reports on a version-mismatch. We must NOT re-derive
    // the base from `sync.refreshSessions()` on each retry: refreshSessions()
    // coalesces onto an already-in-flight `/v1/sessions` fetch (very common on an
    // active session that is constantly invalidating sessionsSync as the CLI
    // streams updates), so it can hand back a version that predates the conflict
    // — the retry then re-sends the same stale expectedVersion, mismatches again,
    // and after maxRetries the rename is thrown away (and the callers swallow it,
    // so an active-session rename silently never persists → no device ever sees
    // the new title). The version-mismatch ack already carries the authoritative
    // current {version, metadata}; apply the summary on top of THAT and retry,
    // exactly like the CLI's own updateMetadata does.
    const initial = storage.getState().sessions[sessionId];
    if (!initial) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    if (!initial.metadata) {
        throw new Error(`Session metadata not loaded for ${sessionId}`);
    }
    let baseMetadata: Metadata = initial.metadata;
    let expectedVersion = initial.metadataVersion;

    let retryCount = 0;
    while (retryCount <= maxRetries) {
        const nextMetadata = apply(baseMetadata);

        const encryptedMetadata = await sessionEncryption.encryptMetadata(nextMetadata);
        const result = await apiSocket.emitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
        }>('update-metadata', {
            sid: sessionId,
            metadata: encryptedMetadata,
            expectedVersion
        });

        if (result.result === 'success') {
            // The server broadcasts an `update-session` which the sync reducer
            // applies to storage; no manual local write needed.
            return;
        } else if (result.result === 'version-mismatch') {
            // The server rejected our expectedVersion and returned the current
            // authoritative version + metadata. Rebase onto it (preserving any
            // fields another writer — e.g. the CLI — just changed) and retry with
            // the summary re-applied on top, so a concurrent CLI metadata write
            // can no longer drop the rename.
            if (typeof result.version === 'number') {
                expectedVersion = result.version;
            }
            if (result.metadata) {
                const latest = await sessionEncryption.decryptMetadata(result.version ?? expectedVersion, result.metadata);
                if (latest) {
                    baseMetadata = latest;
                }
            }
            retryCount++;
            continue;
        } else {
            throw new Error('Failed to update session metadata');
        }
    }

    throw new Error(`Failed to update session metadata after ${maxRetries} retries due to version conflicts`);
}

/**
 * Abort the current session operation
 */
export async function sessionAbort(sessionId: string): Promise<void> {
    await apiSocket.sessionRPC(sessionId, 'abort', {
        reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
    });
}

/**
 * Allow a permission request
 */
export async function sessionAllow(sessionId: string, id: string, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', allowedTools?: string[], decision?: 'approved' | 'approved_for_session', updatedInput?: Record<string, unknown>): Promise<void> {
    const request: SessionPermissionRequest = { id, approved: true, mode, allowTools: allowedTools, decision, updatedInput };
    await apiSocket.sessionRPC(sessionId, 'permission', request);
}

/**
 * Deny a permission request
 */
export async function sessionDeny(sessionId: string, id: string, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', allowedTools?: string[], decision?: 'denied' | 'abort'): Promise<void> {
    const request: SessionPermissionRequest = { id, approved: false, mode, allowTools: allowedTools, decision };
    await apiSocket.sessionRPC(sessionId, 'permission', request);
}

/**
 * Request mode change for a session
 */
export async function sessionSwitch(sessionId: string, to: 'remote' | 'local'): Promise<boolean> {
    const request: SessionModeChangeRequest = { to };
    const response = await apiSocket.sessionRPC<boolean, SessionModeChangeRequest>(
        sessionId,
        'switch',
        request,
    );
    return response;
}

/**
 * Execute a bash command in the session
 */
export async function sessionBash(sessionId: string, request: SessionBashRequest): Promise<SessionBashResponse> {
    try {
        const response = await apiSocket.sessionRPC<SessionBashResponse, SessionBashRequest>(
            sessionId,
            'bash',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Read a file from the session
 */
export async function sessionReadFile(sessionId: string, path: string): Promise<SessionReadFileResponse> {
    try {
        const request: SessionReadFileRequest = { path };
        const response = await apiSocket.sessionRPC<SessionReadFileResponse, SessionReadFileRequest>(
            sessionId,
            'readFile',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Write a file to the session
 */
export async function sessionWriteFile(
    sessionId: string,
    path: string,
    content: string,
    expectedHash?: string | null
): Promise<SessionWriteFileResponse> {
    try {
        const request: SessionWriteFileRequest = { path, content, expectedHash };
        const response = await apiSocket.sessionRPC<SessionWriteFileResponse, SessionWriteFileRequest>(
            sessionId,
            'writeFile',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Upload a user file to the machine, staged under ~/.happy/uploads/<sessionId>/
 * (outside the session cwd). Returns the absolute path so it can be referenced
 * in chat for the agent to read with its own tools. Works on both execution
 * paths (local + remote), unlike inline multimodal which is remote-only.
 */
export async function sessionUploadFile(
    sessionId: string,
    name: string,
    content: string,
): Promise<{ success: boolean; path?: string; size?: number; error?: string }> {
    try {
        return await apiSocket.sessionRPC<
            { success: boolean; path?: string; size?: number; error?: string },
            { name: string; content: string; subdir?: string }
        >(sessionId, 'uploadFile', { name, content, subdir: sessionId });
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * List directory contents in the session
 */
export async function sessionListDirectory(sessionId: string, path: string): Promise<SessionListDirectoryResponse> {
    try {
        const request: SessionListDirectoryRequest = { path };
        const response = await apiSocket.sessionRPC<SessionListDirectoryResponse, SessionListDirectoryRequest>(
            sessionId,
            'listDirectory',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Get directory tree from the session
 */
export async function sessionGetDirectoryTree(
    sessionId: string,
    path: string,
    maxDepth: number
): Promise<SessionGetDirectoryTreeResponse> {
    try {
        const request: SessionGetDirectoryTreeRequest = { path, maxDepth };
        const response = await apiSocket.sessionRPC<SessionGetDirectoryTreeResponse, SessionGetDirectoryTreeRequest>(
            sessionId,
            'getDirectoryTree',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Run ripgrep in the session
 */
export async function sessionRipgrep(
    sessionId: string,
    args: string[],
    cwd?: string
): Promise<SessionRipgrepResponse> {
    try {
        const request: SessionRipgrepRequest = { args, cwd };
        const response = await apiSocket.sessionRPC<SessionRipgrepResponse, SessionRipgrepRequest>(
            sessionId,
            'ripgrep',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Kill the session process immediately
 */
export async function sessionKill(sessionId: string): Promise<SessionKillResponse> {
    try {
        const response = await apiSocket.sessionRPC<SessionKillResponse, {}>(
            sessionId,
            'killSession',
            {}
        );
        return response;
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Archive a session by deactivating it on the server.
 * Use this when the CLI process is already dead and sessionKill can't reach it.
 */
export async function sessionArchive(sessionId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/sessions/${sessionId}/archive`, {
            method: 'POST'
        });
        if (!response.ok) {
            return { success: false, message: `Server error: ${response.status}` };
        }
        return { success: true };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/** Prepare an intentional resume. A 404 means an older server that has no
 * durable archive tombstone yet, so continuing preserves backward compat. */
export async function sessionUnarchive(sessionId: string): Promise<{ success: boolean; supported: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/sessions/${sessionId}/unarchive`, { method: 'POST' });
        if (response.status === 404) return { success: true, supported: false };
        if (!response.ok) return { success: false, supported: true, message: `Server error: ${response.status}` };
        return { success: true, supported: true };
    } catch (error) {
        return { success: false, supported: true, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Permanently delete a session from the server
 * This will remove the session and all its associated data (messages, usage reports, access keys)
 * The session should be inactive/archived before deletion
 *
 * NOTE (B-083 archive-only): the web UI no longer exposes any delete entry —
 * archiving is the only way a chat session ends. This op is kept as the call
 * surface for a future data-retention sweep (B-025) and because its 404-idempotent
 * purge+tombstone semantics are battle-tested. Do not wire it back into UI.
 */
export async function sessionDelete(sessionId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/sessions/${sessionId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            await response.json();
            // Purge local state right away instead of relying on the
            // delete-session socket echo — the socket may be down, and the
            // purge also tombstones the id so a raced session update or an
            // in-flight sessions fetch can't pop the session back into the
            // sidebar ("deleted session reappears" bug).
            sync.onSessionDeleted(sessionId);
            return { success: true };
        } else if (response.status === 404) {
            // Session is already gone server-side (e.g. a previous delete
            // succeeded but a raced update resurrected the local copy).
            // Treat as success and purge the local ghost so the user isn't
            // stuck with an undeletable session.
            sync.onSessionDeleted(sessionId);
            return { success: true };
        } else {
            const error = await response.text();
            return {
                success: false,
                message: error || 'Failed to delete session'
            };
        }
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

type ClaudeForkSource = {
    kind?: 'claude';
    sessionId: string;
    machineId: string;
    directory: string;
    claudeSessionId: string;
};

type CodexForkSource = {
    kind: 'codex';
    sessionId: string;
    machineId: string;
    directory: string;
    codexThreadId: string;
};

// Forking source description used by forkAndSpawn.
export type ForkSource = ClaudeForkSource | CodexForkSource;

type ForkOptions = {
    cutAfterUuid?: string;
    cutAfterItemId?: string;
    forkedFromMessageId?: string;
};

/**
 * Two-step orchestrator for the session fork / duplicate flow:
 *   1. Ask the daemon to copy (and optionally truncate) the source Claude
 *      JSONL — returns a fresh Claude session UUID.
 *   2. Spawn a new Happy session on the same machine with
 *      `resumeClaudeSessionId` set to that UUID so `claude --resume` picks
 *      up the copied conversation.
 *
 * Lineage (parentSessionId, forkedFromMessageId) rides through the spawn
 * RPC into env vars, then into the new Happy session's metadata at start
 * — so the parent link survives without any server-side schema change.
 */
export async function forkAndSpawn(
    source: ForkSource,
    opts: ForkOptions = {},
): Promise<SpawnSessionResult> {
    if (source.kind === 'codex') {
        const forkResult = opts.cutAfterItemId
            ? await codexDuplicateThread({
                machineId: source.machineId,
                directory: source.directory,
                codexThreadId: source.codexThreadId,
                cutAfterItemId: opts.cutAfterItemId,
            })
            : await codexForkThread({
                machineId: source.machineId,
                directory: source.directory,
                codexThreadId: source.codexThreadId,
            });

        if (forkResult.type !== 'success') {
            return { type: 'error', errorMessage: forkResult.errorMessage };
        }

        const spawnResult = await machineSpawnNewSession({
            machineId: source.machineId,
            directory: source.directory,
            agent: 'codex',
            approvedNewDirectoryCreation: false,
            resumeCodexThreadId: forkResult.newCodexThreadId,
            parentSessionId: source.sessionId,
            forkedFromMessageId: opts.forkedFromMessageId,
        });

        if (spawnResult.type === 'success') {
            try {
                await sync.refreshSessions();
            } catch {
                // Refresh is best-effort; broadcast sync will still hydrate.
            }
        }

        return spawnResult;
    }

    const forkResult = opts.cutAfterUuid
        ? await claudeDuplicateSession({
            machineId: source.machineId,
            directory: source.directory,
            claudeSessionId: source.claudeSessionId,
            cutAfterUuid: opts.cutAfterUuid,
        })
        : await claudeForkSession({
            machineId: source.machineId,
            directory: source.directory,
            claudeSessionId: source.claudeSessionId,
        });

    if (forkResult.type !== 'success') {
        return { type: 'error', errorMessage: forkResult.errorMessage };
    }

    const spawnResult = await machineSpawnNewSession({
        machineId: source.machineId,
        directory: source.directory,
        agent: 'claude',
        approvedNewDirectoryCreation: false,
        resumeClaudeSessionId: forkResult.newClaudeSessionId,
        parentSessionId: source.sessionId,
        forkedFromMessageId: opts.forkedFromMessageId,
    });

    // Pull the newly-created session row into local sync state before we
    // hand control back to the caller — otherwise router.replace into the
    // new session id races the broadcast and the app screams
    // "Session X not found" until the next sync tick lands.
    if (spawnResult.type === 'success') {
        try {
            await sync.refreshSessions();
        } catch {
            // Refresh is best-effort; the broadcast will still hydrate the
            // session shortly even if this fetch flaked.
        }
    }

    return spawnResult;
}

// Export types for external use
export type {
    SessionBashRequest,
    SessionBashResponse,
    SessionReadFileResponse,
    SessionWriteFileResponse,
    SessionListDirectoryResponse,
    DirectoryEntry,
    SessionGetDirectoryTreeResponse,
    TreeNode,
    SessionRipgrepResponse,
    SessionKillResponse
};
