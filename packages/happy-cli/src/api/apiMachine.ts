/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { summarizeSpawnSessionForLog } from '@/utils/spawnSessionLog';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody, type CliUpdateState } from './types';
import { withCurrentCliUpdateState } from '@/update/cliUpdate';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { registerFsHandlers } from '../modules/fs/fsRpc';
import { registerTodoHandlers } from '@/modules/todo/todoRpc';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { prepareClipboardText } from '@/clipboard/limits';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { WebTerminalManager, TerminalListItem } from '@/terminal/webTerminal';
import { sendToVhTerminal } from '@/assistant/terminals';
import { isValidTerminalId } from '@/assistant/ids';
import { parseMirrorSendParams } from '@/mirror/mirrorProtocol';
import { sendTerminalNotification, terminalNotifyLink, terminalNotifyMessage } from '@/terminal/terminalNotify';
import { detectCLIAvailability, CLIAvailability } from '@/utils/detectCLI';
import { detectResumeSupport, type ResumeSupport } from '@/resume/localHappyAgentAuth';
import { shouldReconnect } from '@/utils/lidState';
import { getProjectPath } from '@/claude/utils/path';
import {
    forkSession as claudeForkSession,
    forkAndTruncateSession as claudeForkAndTruncateSession,
    listClaudeRewindPoints,
    ForkTruncateUuidNotFoundError,
    ForkSourceMissingError,
} from '@/claude/utils/claudeSessionFork';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { discoverAndClaimRelay, type RelaySwitchTracker } from './relaySelection';
import { ReleaseDrainNoticeSchema, type RelayAssignment, type ReleaseDrainNotice } from '@slopus/happy-wire';
import {
    CodexForkRewindPointNotFoundError,
    forkCodexThread,
    listCodexRewindPoints,
} from '@/codex/codexThreadFork';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ServerToDaemonEvents {
    update: (data: Update) => void;
    'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void;
    'rpc-registered': (data: { method: string }) => void;
    'rpc-unregistered': (data: { method: string }) => void;
    'rpc-error': (data: { type: string, error: string }) => void;
    auth: (data: { success: boolean, user: string }) => void;
    error: (data: { message: string }) => void;
    // Web terminal: user → daemon (relayed by server, scoped to owning account)
    'terminal-input': (data: { terminalId: string, data: string, enc?: boolean }) => void;
    'terminal-resize': (data: { terminalId: string, cols: number, rows: number }) => void;
    'terminal-close': (data: { terminalId: string }) => void;
    'session-archive': (data: { sessionId: string }) => void;
    'server-draining': (data: ReleaseDrainNotice) => void;
}

interface DaemonToServerEvents {
    'release-handover-result': (data: { result: 'success' | 'failed'; durationMs: number }) => void;
    // Web terminal: daemon → user (relayed by server). `seq` is the monotonic
    // output sequence number the client tracks as `lastSeq` for gap-based
    // reconnect (see open-terminal `fromSeq`).
    'terminal-output': (data: { terminalId: string, data: string, seq: number, enc?: boolean }) => void;
    'terminal-exit': (data: { terminalId: string, exitCode: number }) => void;
    // Realtime sidebar ordering: "these terminals just moved". EPHEMERAL — the
    // server relays it to this account's web clients (same room and same
    // handler as the byte stream above) and stores nothing; the durable list
    // still travels through daemonState.webTerminals. Deliberately NOT
    // encrypted: it carries only terminal ids, which already ride in the clear
    // in this very relay's envelope (terminal-output/-input), plus a clock
    // reading — the same plaintext-metadata posture as every other transient
    // signal on this server (activity / machine-activity / usage). An old
    // server has no handler for the event and drops it; an old web client has
    // no listener for it. Both degrade to the pre-feature behaviour.
    'terminal-activity': (data: { terminals: Array<{ id: string, activityAt: number }> }) => void;
    // Clipboard push: daemon → server → all of the user's web clients.
    // `payload` is the clipboard text, encrypted with the per-machine key when
    // `enc` is true (same primitive as the terminal byte stream).
    'clipboard-push': (data: { payload: string, enc?: boolean, truncated?: boolean, totalBytes?: number }) => void;
    'machine-alive': (data: {
        machineId: string;
        time: number;
    }) => void;

    'machine-update-metadata': (data: {
        machineId: string;
        metadata: string; // Encrypted MachineMetadata
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        metadata: string
    } | {
        result: 'success',
        version: number,
        metadata: string
    }) => void) => void;

    'machine-update-state': (data: {
        machineId: string;
        daemonState: string; // Encrypted DaemonState
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        daemonState: string
    } | {
        result: 'success',
        version: number,
        daemonState: string
    }) => void) => void;

    'rpc-register': (data: { method: string }) => void;
    'rpc-unregister': (data: { method: string }) => void;
    'rpc-call': (data: { method: string, params: any }, callback: (response: {
        ok: boolean
        result?: any
        error?: string
    }) => void) => void;
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    resumeSession?: (sessionId: string, options?: { model?: string; permissionMode?: string }) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => boolean;
    listTrackedSessionIds?: () => string[];
    requestShutdown: () => void;
}

function requireNonEmptyString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

async function withCodexAppServerClient<T>(handler: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    const client = new CodexAppServerClient();
    await client.connect();
    try {
        return await handler(client);
    } finally {
        await client.disconnect();
    }
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
    private relaySocket: Socket | null = null;
    private relayAssignment: RelayAssignment | null = null;
    private relaySwitchTracker: RelaySwitchTracker = null;
    private relayRefreshInFlight: Promise<void> | null = null;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private lastKnownCLIAvailability: CLIAvailability | null = null;
    private lastKnownResumeSupport: ResumeSupport | null = null;
    private cliUpdateState: CliUpdateState | null = null;
    private cliUpdatePushChain: Promise<void> = Promise.resolve();
    private rpcHandlerManager: RpcHandlerManager;
    private resumeSessionHandler: ((sessionId: string, options?: { model?: string; permissionMode?: string }) => Promise<SpawnSessionResult>) | null = null;
    private stopSessionHandler: ((sessionId: string) => boolean) | null = null;
    private listTrackedSessionIds: (() => string[]) | null = null;
    private reconnectInterval: NodeJS.Timeout | null = null;
    private handoverInFlight: Promise<void> | null = null;
    // Terminals negotiated with `encStream` protect the live byte payload with
    // the per-machine key. This keeps it opaque to passive storage/forwarding
    // paths, but is not an operator trust boundary: the trusted relay can
    // recover account material or impersonate a Web client. (Declared before
    // webTerminal so the emit closure can read it.)
    private encTerminals = new Set<string>();
    private webTerminal = new WebTerminalManager((event, payload) => {
        let out: any = payload;
        // Encrypt the live byte stream for negotiated terminals. Daemon crypto
        // is synchronous, so output ordering is preserved. `seq` (and any other
        // non-data field) rides along unencrypted via the spread — only the
        // opaque byte payload is protected.
        if (event === 'terminal-output' && this.encTerminals.has(payload.terminalId)) {
            out = { ...payload, data: this.encTerminalData(payload.data), enc: true };
        }
        // Activity frames are advisory ordering hints — drop them on the floor
        // while the socket is down instead of letting socket.io queue them in
        // its UNBOUNDED sendBuffer for replay on reconnect. Nothing is lost:
        // the reconnect re-ships the durable list, and startListTracking clears
        // the de-dup table so the next tick re-seeds every client. (`volatile`
        // is socket.io's own primitive for exactly this; the `connected` check
        // covers the window before the socket object exists at all.)
        if (event === 'terminal-activity') {
            const sockets = [this.socket as any, this.relaySocket as any].filter((s) => s?.connected);
            for (const s of sockets) (s.volatile ?? s).emit(event, out);
            return;
        }
        if ((this.socket as any)?.connected || !this.relaySocket?.connected) (this.socket as any)?.emit(event, out);
        if (this.relaySocket?.connected) this.relaySocket.emit(event, out);
    }, (n) => {
        // Web-terminal agent transitions (turn finished / waiting for input)
        // → account webhook, via the server's /v1/webhook/notify. This is the
        // bare-tmux counterpart of the session path's push-event: the tracker
        // inside WebTerminalManager already applied stability/cooldown/
        // eligibility gating, so every callback here is meant to be sent.
        // Fire-and-forget; the closure reads token/machine at call time.
        sendTerminalNotification({
            baseUrl: configuration.serverUrl,
            token: this.token,
            title: n.title,
            message: terminalNotifyMessage(n.event),
            link: terminalNotifyLink(this.machine.id, n.terminalId),
            event: n.event,
        });
    });

    /**
     * Push text to the clipboard of every web client the user has open
     * (terminal-path claude → `very-happy mcp` → daemon /clipboard → here).
     * Encrypted with the per-machine key; the server relays without reading.
     */
    pushClipboard(text: string): { delivered: boolean; truncated: boolean; totalBytes: number; error?: string } {
        const prepared = prepareClipboardText(text);
        if (!this.socket?.connected) {
            return { delivered: false, truncated: prepared.truncated, totalBytes: prepared.totalBytes, error: 'daemon is not connected to the server' };
        }
        this.socket.emit('clipboard-push', {
            payload: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, prepared.text)),
            enc: true,
            truncated: prepared.truncated,
            totalBytes: prepared.totalBytes
        });
        return { delivered: true, truncated: prepared.truncated, totalBytes: prepared.totalBytes };
    }

    /** Encrypt one base64 terminal payload with the per-machine key (same scheme
     *  as the live output stream) → base64 ciphertext. Used for both live output
     *  and the open-terminal snapshot/replay payloads. */
    private encTerminalData(dataBase64: string): string {
        return encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, dataBase64));
    }

    constructor(
        private token: string,
        private machine: Machine
    ) {
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });

        registerCommonHandlers(this.rpcHandlerManager, process.cwd());
        // Machine-wide file browser (fs-list / fs-read) — lets the web browse
        // directories and read file contents on this machine (terminal cwd,
        // session path, anywhere). See modules/fs/fsRpc.ts for scope notes.
        registerFsHandlers(this.rpcHandlerManager);
        // B-007: external todo provider (todo-list / todo-complete / todo-create).
        // Disabled unless the machine's own settings name a provider command —
        // see modules/todo/todoRpc.ts for why that config is machine-local only.
        registerTodoHandlers(this.rpcHandlerManager);
        // B-150: route the auto-restore summary to the account notification.
        this.wireAutoRestoreReport();
    }

    /** Cache the latest relay policy locally and publish it now or on the next
     * socket connect. This makes startup/offline races harmless. */
    setCliUpdateState(state: CliUpdateState | null): void {
        this.cliUpdateState = state;
        if (!this.socket?.connected) return;
        this.cliUpdatePushChain = this.cliUpdatePushChain
            .then(() => this.updateDaemonState((current) => withCurrentCliUpdateState(current, this.cliUpdateState)))
            .catch((error) => logger.debug('[API MACHINE] Failed to publish CLI update policy:', error));
    }

    setRPCHandlers({
        spawnSession,
        resumeSession,
        stopSession,
        listTrackedSessionIds,
        requestShutdown
    }: MachineRpcHandlers) {
        this.resumeSessionHandler = resumeSession ?? null;
        this.stopSessionHandler = stopSession;
        this.listTrackedSessionIds = listTrackedSessionIds ?? null;

        // Register spawn session handler
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const { directory, sessionId, machineId, approvedNewDirectoryCreation, agent, environmentVariables, token, resumeClaudeSessionId, resumeCodexThreadId, parentSessionId, forkedFromMessageId, variant, forceNew, permissionMode } = params || {};
            logger.debug('[API MACHINE] Spawning session:', summarizeSpawnSessionForLog(params));

            // The assistant variant supplies its own directory (assistant home)
            // daemon-side; every other spawn requires one.
            if (!directory && variant !== 'assistant') {
                throw new Error('Directory is required');
            }

            const result = await spawnSession({ directory: directory || '', sessionId, machineId, approvedNewDirectoryCreation, agent, environmentVariables, token, resumeClaudeSessionId, resumeCodexThreadId, parentSessionId, forkedFromMessageId, variant: variant === 'assistant' ? 'assistant' : undefined, forceNew: forceNew === true, permissionMode: typeof permissionMode === 'string' ? permissionMode : undefined });

            switch (result.type) {
                case 'success':
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
                    return { type: 'success', sessionId: result.sessionId };

                case 'requestToApproveDirectoryCreation':
                    logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

                case 'error':
                    throw new Error(result.errorMessage);
            }
        });

        this.syncResumeSessionRpcRegistration();

        // Register web-terminal open handler. Account scoping is already
        // enforced by the server (RPC rooms are per-account), so only this
        // machine's owner can reach it.
        //
        // The daemon owns the screen: `open` (re)subscribes and returns either a
        // full `snapshot` of the authoritative headless screen, or a seq-based
        // `replay` of just the chunks the client missed (when it passes
        // `fromSeq` and the ring still covers the gap). `seq` is the client's new
        // output baseline. Under negotiated stream encryption we encrypt the
        // snapshot/replay payload the same way live output is encrypted, so the
        // relay never sees restored screen bytes.
        this.rpcHandlerManager.registerHandler('open-terminal', async (params: any) => {
            // `startupCommand` runs ONLY when this open genuinely creates the
            // tmux session (never on re-attach) — see WebTerminalManager.open.
            // Old clients simply don't send it → nothing runs.
            // `resub` (viewer catch-up: don't count a new subscriber) and
            // `attachOnly` (never create the session — a deleted terminal must
            // not be resurrected; open throws 'terminal-gone' instead, which
            // reaches the client as the RPC error) pass through the same way.
            // `streamMode:'lines'` (B-121) is the client's capability
            // declaration; a client that doesn't send it gets the v1 response
            // shape verbatim (its `applyOpenResult` throws on anything else and
            // the terminal would stay "connecting" forever).
            const { terminalId, cols, rows, cwd, fromSeq, encStream, startupCommand, resub, attachOnly, streamMode } = params || {};
            const result = await this.webTerminal.open({
                terminalId, cols, rows, cwd, fromSeq, startupCommand, resub, attachOnly,
                streamMode: streamMode === 'lines' ? 'lines' : undefined,
            });
            // Negotiated stream encryption: only enable for clients that ask
            // (so an old client still works in plaintext). Echo it back so the
            // client knows whether to encrypt its input / decrypt output.
            if (encStream) {
                this.encTerminals.add(result.terminalId);
                if (result.mode === 'snapshot') {
                    result.data = this.encTerminalData(result.data);
                } else {
                    result.chunks = result.chunks.map((c: { seq: number; data: string }) => ({ seq: c.seq, data: this.encTerminalData(c.data) }));
                }
            }
            return { type: 'success', ...result, encStream: !!encStream };
        });

        // B-121: one page of a terminal's deep history snapshot. Separate from
        // the live stream in every way — no seq, no ring, no headless — so a
        // slow history pull can never delay or reorder live output. The page
        // payload is encrypted exactly like the live stream for terminals that
        // negotiated encStream (the web decrypts it the same way).
        this.rpcHandlerManager.registerHandler('terminal-history', async (params: any) => {
            const { terminalId, snapshotId, page } = params || {};
            if (typeof terminalId !== 'string' || typeof snapshotId !== 'string' || typeof page !== 'number') {
                throw new Error('terminalId, snapshotId and page are required');
            }
            const result = this.webTerminal.getHistoryPage(terminalId, snapshotId, page);
            if ('expired' in result) {
                // Contract string: the web keeps its shallow screen and retries
                // the open once, rather than hanging on a half-built rebuild.
                throw new Error('snapshot-expired');
            }
            const data = this.encTerminals.has(terminalId) ? this.encTerminalData(result.data) : result.data;
            return { type: 'success', page: result.page, totalPages: result.totalPages, data };
        });

        // B-121: paste text into a terminal through tmux's paste buffer. The
        // web can no longer do this locally in lines mode: `term.paste()` wraps
        // in bracketed-paste markers only if the BROWSER's xterm has 2004 on,
        // which says nothing about the real pane — tmux's `paste-buffer -p`
        // asks the pane. Multi-line text executing line by line was the bug.
        this.rpcHandlerManager.registerHandler('terminal-paste', async (params: any) => {
            const { terminalId, text } = params || {};
            if (typeof terminalId !== 'string' || typeof text !== 'string') {
                throw new Error('terminalId and text are required');
            }
            await this.webTerminal.paste(terminalId, text);
            return { type: 'success' };
        });

        // B-107: paste one line of user input into the terminal that hosts an
        // ACTIVE mirrored claude (the structured view's input bar). Bracketed
        // paste via tmux buffers (B-013 precedent — opaque bytes, never
        // synthesized keystrokes), Enter only when submit. HARD daemon-side
        // guard: after claude exits the same bytes would run in a bare shell,
        // so a stale web page must be refused, not trusted.
        this.rpcHandlerManager.registerHandler('mirror-terminal-send', async (params: any) => {
            const parsed = parseMirrorSendParams(params, isValidTerminalId);
            if ('error' in parsed) {
                throw new Error(parsed.error);
            }
            if (!this.mirrorInputAllowed?.(parsed.terminalId)) {
                throw new Error('mirror-not-active');
            }
            const result = sendToVhTerminal(parsed.terminalId, parsed.text, parsed.submit);
            if (!result.ok) {
                throw new Error(result.error ?? 'send failed');
            }
            return { type: 'success' };
        });

        // Scroll a terminal's tmux history (wheel/touch scrollback). The
        // attach-client pty keeps the outer terminal in the alternate screen,
        // so the web xterm has no scrollback of its own — the web intercepts
        // wheel events and drives tmux copy-mode through this RPC instead.
        // lines > 0 scrolls up (into history), < 0 scrolls down.
        this.rpcHandlerManager.registerHandler('terminal-scroll', async (params: any) => {
            const { terminalId, lines } = params || {};
            if (typeof terminalId === 'string' && typeof lines === 'number') {
                this.webTerminal.scroll(terminalId, lines);
            }
            return { type: 'success' };
        });

        // Permanently destroy a terminal's tmux session (sidebar delete).
        this.rpcHandlerManager.registerHandler('kill-terminal', async (params: any) => {
            const { terminalId } = params || {};
            if (typeof terminalId !== 'string' || !terminalId) {
                return { type: 'error', errorMessage: 'Terminal ID is required' };
            }
            if (!this.webTerminal.killSession(terminalId)) {
                return { type: 'error', errorMessage: 'tmux session is still running' };
            }
            this.encTerminals.delete(terminalId);
            return { type: 'success' };
        });

        // List this machine's live tmux terminals. LEGACY polling path: new
        // clients consume daemonState.webTerminals pushes instead; this RPC
        // stays for old clients and returns the SAME list the push carries.
        this.rpcHandlerManager.registerHandler('list-terminals', async () => {
            return { type: 'success', terminals: this.webTerminal.buildTerminalList() };
        });

        // Persist a terminal's title on the machine so every device sees it.
        // The tmux result is transmitted honestly: the web treats this RPC's
        // success as the machine's ack (clearing its `pendingTitle` retry
        // state), so an unconditional success on a failed set-option would
        // strand a rename that never landed.
        this.rpcHandlerManager.registerHandler('set-terminal-title', async (params: any) => {
            const { terminalId, title, ifAbsent } = params || {};
            if (!terminalId || typeof title !== 'string') {
                throw new Error('terminalId and title are required');
            }
            if (!this.webTerminal.setTitle(terminalId, title, !!ifAbsent)) {
                throw new Error('Failed to set terminal title (tmux unavailable or session gone)');
            }
            return { type: 'success' };
        });

        // Register stop session handler
        this.rpcHandlerManager.registerHandler('stop-session', (params: any) => {
            const { sessionId } = params || {};

            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            const success = stopSession(sessionId);
            if (!success) {
                throw new Error('Session not found or failed to stop');
            }

            logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
            return { message: 'Session stopped' };
        });

        // Register Claude session fork handlers (used by app-side fork /
        // duplicate flows). These take the source session's working
        // directory and underlying Claude UUID, copy the on-disk JSONL
        // — optionally truncated at a chosen message — and return the new
        // Claude UUID. The caller then spawns a fresh Happy session with
        // `resumeClaudeSessionId` set so `claude --resume <newUuid>`
        // continues the conversation.
        this.rpcHandlerManager.registerHandler('claude-fork-session', async (params: any) => {
            const { directory, claudeSessionId } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            try {
                const newClaudeSessionId = await claudeForkSession(getProjectPath(directory), claudeSessionId);
                return { type: 'success', newClaudeSessionId };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                throw error;
            }
        });

        // List user-text rewind points directly from the on-disk JSONL.
        // The server-side session log misses claudeUuid for messages typed
        // live in the app (legacy `sentFrom: 'web'` path); disk is the
        // source of truth and carries the right uuids for every message.
        this.rpcHandlerManager.registerHandler('claude-list-rewind-points', async (params: any) => {
            const { directory, claudeSessionId } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            try {
                const points = await listClaudeRewindPoints(getProjectPath(directory), claudeSessionId);
                return { type: 'success', points };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                throw error;
            }
        });

        this.rpcHandlerManager.registerHandler('claude-duplicate-session', async (params: any) => {
            const { directory, claudeSessionId, cutAfterUuid } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            if (typeof cutAfterUuid !== 'string' || !UUID_RE.test(cutAfterUuid)) {
                throw new Error('cutAfterUuid must be a valid UUID');
            }
            try {
                const newClaudeSessionId = await claudeForkAndTruncateSession(
                    getProjectPath(directory),
                    claudeSessionId,
                    cutAfterUuid,
                );
                return { type: 'success', newClaudeSessionId };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                if (error instanceof ForkTruncateUuidNotFoundError) {
                    throw new Error(
                        'The chosen rewind point is no longer present in the source session — try forking without truncation',
                    );
                }
                throw error;
            }
        });

        this.rpcHandlerManager.registerHandler('codex-fork-thread', async (params: any) => {
            const directory = requireNonEmptyString(params?.directory, 'directory');
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');

            const result = await withCodexAppServerClient((client) => forkCodexThread(client, {
                threadId: codexThreadId,
                cwd: directory,
            }));
            return result;
        });

        this.rpcHandlerManager.registerHandler('codex-list-rewind-points', async (params: any) => {
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');

            return withCodexAppServerClient(async (client) => {
                const { thread } = await client.readThread({
                    threadId: codexThreadId,
                    includeTurns: true,
                });
                return {
                    type: 'success',
                    points: listCodexRewindPoints(thread),
                };
            });
        });

        this.rpcHandlerManager.registerHandler('codex-duplicate-thread', async (params: any) => {
            const directory = requireNonEmptyString(params?.directory, 'directory');
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');
            const cutAfterItemId = requireNonEmptyString(params?.cutAfterItemId, 'cutAfterItemId');

            try {
                return await withCodexAppServerClient((client) => forkCodexThread(client, {
                    threadId: codexThreadId,
                    cwd: directory,
                    cutAfterItemId,
                }));
            } catch (error) {
                if (error instanceof CodexForkRewindPointNotFoundError) {
                    throw new Error(
                        'The chosen rewind point is no longer present in the source Codex thread — try forking without truncation',
                    );
                }
                throw error;
            }
        });

        // Register stop daemon handler
        this.rpcHandlerManager.registerHandler('stop-daemon', () => {
            logger.debug('[API MACHINE] Received stop-daemon RPC request');

            // Trigger shutdown callback after a delay
            setTimeout(() => {
                logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
                requestShutdown();
            }, 100);

            return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
        });
    }

    private syncResumeSessionRpcRegistration(): void {
        const method = 'resume-happy-session';

        if (this.resumeSessionHandler) {
            if (!this.rpcHandlerManager.hasHandler(method)) {
                this.rpcHandlerManager.registerHandler(method, async (params: any) => {
                    const { sessionId, model, permissionMode } = params || {};

                    if (!sessionId || typeof sessionId !== 'string') {
                        throw new Error('Session ID is required');
                    }

                    const handler = this.resumeSessionHandler;
                    if (!handler) {
                        throw new Error('Resume session handler not available');
                    }

                    const result = await handler(sessionId, { model, permissionMode });
                    switch (result.type) {
                        case 'success':
                            return { type: 'success', sessionId: result.sessionId };
                        case 'requestToApproveDirectoryCreation':
                            return result;
                        case 'error':
                            throw new Error(result.errorMessage);
                    }
                });
            }
            return;
        }

        if (this.rpcHandlerManager.hasHandler(method)) {
            this.rpcHandlerManager.unregisterHandler(method);
        }
    }

    // ── Terminal mirror integration (B-105) ─────────────────────────────────
    /** Every pushed list also flows to the mirror manager (claude-exit
     *  detection via pane observation). Set by the daemon at startup. */
    private mirrorListObserver: ((terminals: TerminalListItem[]) => void) | null = null;

    /** B-107: gate for mirror-terminal-send — set with the rest of the
     *  mirror integration; absent (daemon still starting) means refuse. */
    private mirrorInputAllowed: ((terminalId: string) => boolean) | null = null;

    /** B-150: one line per daemon start, only when something was restored or
     *  deliberately skipped. Same channel the terminal notifications use, so it
     *  lands wherever the user already routed those (webhook / inbox). */
    private wireAutoRestoreReport(): void {
        this.webTerminal.setOnAutoRestoreSummary((line) => {
            sendTerminalNotification({
                baseUrl: configuration.serverUrl,
                token: this.token,
                title: 'Terminals restored',
                message: line,
                link: `/machine/${this.machine.id}`,
                event: 'completed',
            });
        });
    }

    setMirrorIntegration(integration: {
        resolveMirrorSessionId: (terminalId: string) => string | undefined;
        onTerminalClosed: (terminalId: string) => void;
        onTerminalList: (terminals: TerminalListItem[]) => void;
        isMirrorInputAllowed: (terminalId: string) => boolean;
    }): void {
        this.webTerminal.setMirrorSessionResolver(integration.resolveMirrorSessionId);
        this.webTerminal.setOnTerminalClosed(integration.onTerminalClosed);
        this.mirrorListObserver = integration.onTerminalList;
        this.mirrorInputAllowed = integration.isMirrorInputAllowed;
    }

    /** Mirror bindings changed → re-derive and (on diff) push the list now. */
    requestTerminalListRefresh(): void {
        this.webTerminal.requestListRefresh();
    }

    // ── Terminal-list push ──────────────────────────────────────────────────
    // Always holds the freshest list the tracker produced; the chained write
    // below reads THIS at write time (not a stale closure), so out-of-order
    // CAS retries can never land an older snapshot over a newer one.
    private latestTerminalList: TerminalListItem[] | null = null;
    // Serializes terminal-list daemonState writes: two overlapping
    // updateDaemonState calls would CAS-race and the retry of the FIRST could
    // rewrite an older webTerminals value after the second already landed.
    private terminalPushChain: Promise<void> = Promise.resolve();

    /** Push the tracked terminal list into daemonState.webTerminals (server
     *  persists + broadcasts `update-machine`). Skipped while disconnected —
     *  the connect handler re-ships a full snapshot anyway. */
    private pushTerminalList(terminals: TerminalListItem[]): void {
        try {
            this.mirrorListObserver?.(terminals);
        } catch (err) {
            logger.debug('[API MACHINE] mirror list observer failed:', err);
        }
        this.latestTerminalList = terminals;
        if (!this.socket?.connected) return;
        this.terminalPushChain = this.terminalPushChain
            .then(async () => {
                const list = this.latestTerminalList;
                if (!list) return;
                this.latestTerminalList = null;
                await this.updateDaemonState((state) => ({
                    ...state,
                    // The daemon is connected and pushing — 'running' is the truth
                    // even in the (unreachable) case of a null prior state.
                    status: state?.status ?? 'running',
                    webTerminals: { updatedAt: Date.now(), terminals: list },
                    // B-084: the closed-terminal records ride every list push
                    // (a close always changes the list, so they stay in step).
                    // Read at write time — same freshness rule as the list.
                    closedTerminals: this.webTerminal.getClosedTerminals(),
                }));
                logger.debug(`[API MACHINE] Pushed terminal list (${list.length} terminals)`);
            })
            .catch((err) => {
                logger.debug('[API MACHINE] Terminal list push failed:', err);
            });
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata);

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.metadataVersion
            });

            if (answer.result === 'success') {
                this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
        });
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.daemonState);

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.daemonStateVersion
            });

            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
        });
    }

    connect() {
        const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
        logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);

        this.socket = this.createControlSocket();
        const controlSocket = this.socket;
        this.bindRealtimeHandlers(controlSocket, 'control');

        controlSocket.on('connect', () => {
            if (this.socket !== controlSocket) return;
            this.activateControlSocket(controlSocket);
        });

        controlSocket.on('disconnect', (reason) => {
            logger.debug(`[API MACHINE] Disconnected from server — reason: ${reason}`);
            this.rpcHandlerManager.onSocketDisconnect(controlSocket);
            // No web view can reach us while the socket is down → drop all terminal
            // subscriber counts to 0 so a blip/crash can't inflate them and wedge a
            // pty un-reapable. Views re-subscribe on reconnect (++ from 0).
            if (!this.relaySocket?.connected) this.webTerminal.resetSubscribers();
            this.stopKeepAlive();
            if (this.socket === controlSocket) this.startSmartReconnect();
        });

        this.bindControlDataHandlers(controlSocket);
    }

    private createControlSocket(handover?: ReleaseDrainNotice): Socket<ServerToDaemonEvents, DaemonToServerEvents> {
        const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
        return io(serverUrl, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id,
                happyClient: `cli-daemon/${configuration.currentCliVersion}`,
                ...(handover ? { handoverEpoch: handover.epoch } : {}),
            },
            ...(handover ? { query: { vh_slot: handover.candidateSlot }, forceNew: true } : {}),
            path: '/v1/updates',
            reconnection: false,
            ...(handover ? { autoConnect: false } : {}),
        });
    }

    private activateControlSocket(socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>, rpcAlreadyRegistered = false) {
        logger.debug('[API MACHINE] Connected to server');
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }

            // Terminal-list push channel: the CONNECT write itself carries the
            // full current snapshot, stamped with the SAME clock reading as
            // `startedAt`. Consumers trust webTerminals only when
            // updatedAt >= startedAt (i.e. written by this daemon run), so
            // shipping both in one write means there is never a window where
            // this run's startedAt is visible but its terminal list is not —
            // a reconnect can't flap clients back to the polling fallback.
            const initialTerminals = this.webTerminal.buildTerminalList();
            this.webTerminal.primeListSignature(initialTerminals);
            this.updateDaemonState((state) => {
                const now = Date.now();
                const currentState = withCurrentCliUpdateState(state, this.cliUpdateState);
                return {
                    ...currentState,
                    status: 'running',
                    pid: process.pid,
                    httpPort: this.machine.daemonState?.httpPort,
                    startedAt: now,
                    webTerminals: { updatedAt: now, terminals: initialTerminals },
                    // B-084: closed records survive daemon restarts (persisted
                    // in closed-terminals.json), so the connect snapshot ships
                    // them too — not just the incremental pushes.
                    closedTerminals: this.webTerminal.getClosedTerminals(),
                };
            });
            // From here on, only CHANGES push (signature diff inside the manager).
            this.webTerminal.startListTracking((terminals) => this.pushTerminalList(terminals));

        if (!rpcAlreadyRegistered) this.rpcHandlerManager.onSocketConnect(socket);
        this.syncResumeSessionRpcRegistration();
        this.startKeepAlive();
        void this.reconcileArchivedSessions();
        void this.refreshRelayConnection();
    }

    private bindControlDataHandlers(socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>) {
        // Handle update events from server
        socket.on('update', (data: Update) => {
            // Machine clients should only care about machine updates
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                // Handle machine metadata or daemon state updates from other clients (e.g., mobile app)
                const update = data.body as UpdateMachineBody;

                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.metadata.value));
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.daemonState.value));
                    this.machine.daemonStateVersion = update.daemonState.version;
                }
            } else {
                logger.debug(`[API MACHINE] Received unknown update type: ${(data.body as any).t}`);
            }
        });

        socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`);
            if (this.socket === socket) this.startSmartReconnect();
        });

        socket.io.on('error', (error: any) => {
            logger.debug('[API MACHINE] Socket error:', error);
        });

        socket.on('server-draining', (data) => {
            if (this.socket !== socket) return;
            const parsed = ReleaseDrainNoticeSchema.safeParse(data);
            if (!parsed.success || parsed.data.deadline <= Date.now()) return;
            void this.startReleaseHandover(parsed.data);
        });
    }

    private startReleaseHandover(notice: ReleaseDrainNotice): Promise<void> {
        if (this.handoverInFlight) return this.handoverInFlight;
        this.handoverInFlight = this.releaseHandover(notice).finally(() => { this.handoverInFlight = null; });
        return this.handoverInFlight;
    }

    private async releaseHandover(notice: ReleaseDrainNotice): Promise<void> {
        const startedAt = Date.now();
        const previous = this.socket;
        const candidate = this.createControlSocket(notice);
        let commandsTransferred = false;
        // RPC registration must be make-before-break: the server routes calls to
        // the newest handover epoch once this candidate has registered. Terminal
        // commands are different: they are broadcast to the machine room, so
        // binding them on both sockets would duplicate keystrokes/resizes during
        // the overlap window. Bind only RPC until the atomic listener handoff.
        this.bindRpcRequestHandler(candidate, 'control');
        const timeoutMs = Math.max(1, Math.min(10_000, notice.deadline - Date.now()));
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('release handover timeout')), timeoutMs);
                candidate.once('connect', () => { clearTimeout(timer); resolve(); });
                candidate.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
                candidate.connect();
            });
            await this.rpcHandlerManager.onSocketConnectAndWait(candidate, timeoutMs);
            if (this.socket !== previous) {
                this.rpcHandlerManager.onSocketDisconnect(candidate);
                candidate.close();
                return;
            }
            // No socket event can interleave these synchronous listener changes.
            // The old connection remains physically alive for rollback/output,
            // but only the candidate consumes machine commands from this point.
            this.unbindMachineCommandHandlers(previous);
            this.bindMachineCommandHandlers(candidate);
            commandsTransferred = true;
            this.bindControlDataHandlers(candidate);
            this.socket = candidate;
            candidate.on('connect', () => {
                if (this.socket === candidate) this.activateControlSocket(candidate);
            });
            candidate.on('disconnect', () => {
                this.rpcHandlerManager.onSocketDisconnect(candidate);
                if (!this.relaySocket?.connected) this.webTerminal.resetSubscribers();
                this.stopKeepAlive();
                if (this.socket === candidate) this.startSmartReconnect();
            });
            this.activateControlSocket(candidate, true);
            candidate.emit('release-handover-result', { result: 'success', durationMs: Date.now() - startedAt });
            this.rpcHandlerManager.onSocketDisconnect(previous);
            previous.removeAllListeners('disconnect');
            previous.close();
        } catch (error) {
            if (this.socket === candidate) this.socket = previous;
            if (commandsTransferred) {
                this.unbindMachineCommandHandlers(candidate);
                this.bindMachineCommandHandlers(previous);
            }
            this.rpcHandlerManager.onSocketDisconnect(candidate);
            candidate.close();
            if (previous.connected) previous.emit('release-handover-result', { result: 'failed', durationMs: Date.now() - startedAt });
            logger.debug(`[API MACHINE] Release handover failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) {
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);
            void this.refreshRelayConnection();

            // Re-detect CLI availability and push metadata update if changed
            const newAvailability = detectCLIAvailability();
            const prev = this.lastKnownCLIAvailability;
            const newResumeSupport = detectResumeSupport();
            const prevResume = this.lastKnownResumeSupport;
            const cliAvailabilityChanged = !prev || prev.claude !== newAvailability.claude || prev.codex !== newAvailability.codex || prev.gemini !== newAvailability.gemini || prev.openclaw !== newAvailability.openclaw;
            const resumeSupportChanged = !prevResume
                || prevResume.rpcAvailable !== newResumeSupport.rpcAvailable
                || prevResume.happyAgentAuthenticated !== newResumeSupport.happyAgentAuthenticated;

            if (cliAvailabilityChanged || resumeSupportChanged) {
                this.lastKnownCLIAvailability = newAvailability;
                this.lastKnownResumeSupport = newResumeSupport;
                this.updateMachineMetadata((metadata) => ({
                    ...(metadata || {} as any),
                    cliAvailability: newAvailability,
                    resumeSupport: { ...newResumeSupport, rpcAvailable: !!this.resumeSessionHandler },
                })).catch((err) => {
                    logger.debug('[API MACHINE] Failed to update machine capabilities:', err);
                });
            }
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    private bindRpcRequestHandler(socket: Socket, transport: 'control' | 'regional-relay') {
        socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request via ${transport}:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
        });
    }

    private bindMachineCommandHandlers(socket: Socket) {
        socket.on('terminal-input', (data: any) => {
            let payload = data.data;
            if (data.enc) {
                const dec = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(data.data));
                if (typeof dec !== 'string') return;
                payload = dec;
            }
            this.webTerminal.write(data.terminalId, payload);
        });
        socket.on('terminal-resize', (data: any) => this.webTerminal.resize(data.terminalId, data.cols, data.rows));
        socket.on('terminal-close', (data: any) => this.webTerminal.unsubscribe(data.terminalId));
        socket.on('session-archive', (data: { sessionId?: unknown }) => {
            if (typeof data?.sessionId !== 'string') return;
            const stopped = this.stopSessionHandler?.(data.sessionId) ?? false;
            logger.debug(`[API MACHINE] Server archived session ${data.sessionId}; local process stopped=${stopped}`);
        });
    }

    private unbindMachineCommandHandlers(socket: Socket) {
        socket.removeAllListeners('terminal-input');
        socket.removeAllListeners('terminal-resize');
        socket.removeAllListeners('terminal-close');
        socket.removeAllListeners('session-archive');
    }

    private bindRealtimeHandlers(socket: Socket, transport: 'control' | 'regional-relay') {
        this.bindRpcRequestHandler(socket, transport);
        this.bindMachineCommandHandlers(socket);
    }

    /** Reconcile commands missed while the daemon was offline. The server
     * returns only ids owned by this account and durably archived in the DB. */
    private async reconcileArchivedSessions(): Promise<void> {
        const tracked = this.listTrackedSessionIds?.() ?? [];
        if (tracked.length === 0) return;
        try {
            for (let offset = 0; offset < tracked.length; offset += 500) {
                const response = await fetch(`${configuration.serverUrl}/v1/sessions/archive-status`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json',
                        'X-Happy-Client': `cli-daemon/${configuration.currentCliVersion}`,
                    },
                    body: JSON.stringify({ sessionIds: tracked.slice(offset, offset + 500) }),
                });
                if (response.status === 404) return; // older server
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const body = await response.json() as { archivedSessionIds?: unknown };
                if (!Array.isArray(body.archivedSessionIds)) continue;
                for (const sessionId of body.archivedSessionIds) {
                    if (typeof sessionId === 'string') this.stopSessionHandler?.(sessionId);
                }
            }
        } catch (error) {
            logger.debug(`[API MACHINE] Archived-session reconciliation failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    private async refreshRelayConnection(): Promise<void> {
        if (this.relayRefreshInFlight) return this.relayRefreshInFlight;
        this.relayRefreshInFlight = (async () => {
            const selected = await discoverAndClaimRelay({
                controlUrl: configuration.serverUrl,
                token: this.token,
                machineId: this.machine.id,
                connectedRelayId: this.relaySocket?.connected ? this.relayAssignment?.relayId : undefined,
                switchTracker: this.relaySwitchTracker,
            });
            if (!selected) {
                this.relaySwitchTracker = null;
                return;
            }
            this.relaySwitchTracker = selected.switchTracker;
            const previousUrl = this.relayAssignment?.url;
            this.relayAssignment = selected.assignment;
            const probe = selected.probes.find((item) => item.relayId === selected.assignment.relayId);
            logger.debug(`[API MACHINE] Regional relay selected: ${selected.assignment.relayId} (${selected.assignment.region}), RTT ${probe ? Math.round(probe.rttMs) : 'unknown'}ms`);
            if (this.relaySocket && previousUrl === selected.assignment.url) {
                this.relaySocket.auth = { token: selected.assignment.token };
                if (this.relaySocket.connected) return;
            }
            if (this.relaySocket) {
                this.rpcHandlerManager.onSocketDisconnect(this.relaySocket);
                this.relaySocket.disconnect();
            }
            const relaySocket = io(selected.assignment.url, {
                transports: ['websocket'],
                path: '/v1/relay',
                auth: { token: selected.assignment.token },
                reconnection: true,
                reconnectionDelay: 500,
                reconnectionDelayMax: 5_000,
            });
            this.relaySocket = relaySocket;
            this.bindRealtimeHandlers(relaySocket, 'regional-relay');
            relaySocket.on('connect', () => {
                if (this.relaySocket !== relaySocket) return;
                this.rpcHandlerManager.onSocketConnect(relaySocket);
                this.syncResumeSessionRpcRegistration();
                logger.debug(`[API MACHINE] Connected to regional relay ${selected.assignment.relayId}`);
            });
            relaySocket.on('disconnect', () => {
                this.relaySwitchTracker = null;
                this.rpcHandlerManager.onSocketDisconnect(relaySocket);
                if (!this.socket?.connected) this.webTerminal.resetSubscribers();
            });
        })().finally(() => { this.relayRefreshInFlight = null; });
        return this.relayRefreshInFlight;
    }

    private startSmartReconnect() {
        if (this.reconnectInterval) return;

        this.reconnectInterval = setInterval(() => {
            if (this.socket.connected) {
                clearInterval(this.reconnectInterval!);
                this.reconnectInterval = null;
                return;
            }
            if (!shouldReconnect()) {
                logger.debug('[API MACHINE] Still not ready to reconnect');
                return;
            }
            logger.debug('[API MACHINE] Attempting reconnect');
            this.socket.connect();
        }, 3000);

        if (shouldReconnect()) {
            logger.debug('[API MACHINE] Network up + lid open — reconnecting in 1s');
            setTimeout(() => { if (!this.socket.connected) this.socket.connect() }, 1000);
        }
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        this.webTerminal.stopListTracking();
        this.stopKeepAlive();
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        if (this.socket) {
            this.socket.close();
            logger.debug('[API MACHINE] Socket closed');
        }
        if (this.relaySocket) {
            this.rpcHandlerManager.onSocketDisconnect(this.relaySocket);
            this.relaySocket.close();
            this.relaySocket = null;
            logger.debug('[API MACHINE] Regional relay socket closed');
        }
    }
}
