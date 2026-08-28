import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, FileEventMessage, FileEventMessageSchema, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { decodeBase64, decryptBlob, decrypt, encodeBase64, encrypt } from './encryption';
import { prepareClipboardText } from '@/clipboard/limits';
import { backoff, delay } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { deriveKey } from '@/utils/deriveKey';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { ReleaseDrainNoticeSchema, type ReleaseDrainNotice } from '@slopus/happy-wire';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { calculateCost } from '@/utils/pricing';
import { shouldReconnect } from '@/utils/lidState';
import { RelayAssignmentResponseSchema, type SessionEnvelope, type SessionTurnEndStatus } from '@slopus/happy-wire';
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
    type ClaudeSessionProtocolState,
} from '@/claude/utils/sessionProtocolMapper';
import { InvalidateSync } from '@/utils/sync';
import axios from 'axios';
import { normalizeAgentUsage, usageAgentKey } from './usageReport';
import { MAX_CHAT_ATTACHMENT_ENCRYPTED_BYTES } from '@/utils/attachmentLimits';

/**
 * ACP (Agent Communication Protocol) message data types.
 * This is the unified format for all agent messages - CLI adapts each provider's format to ACP.
 */
export type ACPMessageData =
    // Core message types
    | { type: 'message'; message: string }
    | { type: 'reasoning'; message: string }
    | { type: 'thinking'; text: string }
    // Tool interactions
    | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string }
    | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean }
    // File operations
    | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
    // Terminal/command output
    | { type: 'terminal-output'; data: string; callId: string }
    // Task lifecycle events
    | { type: 'task_started'; id: string }
    | { type: 'task_complete'; id: string }
    | { type: 'turn_aborted'; id: string }
    // Permissions
    | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
    // Usage/metrics
    | { type: 'token_count';[key: string]: unknown };

export type ACPProvider = 'gemini' | 'codex' | 'claude' | 'opencode';

type V3SessionMessage = {
    id: string;
    seq: number;
    content: { t: 'encrypted'; c: string };
    localId: string | null;
    createdAt: number;
    updatedAt: number;
};

type V3GetSessionMessagesResponse = {
    messages: V3SessionMessage[];
    hasMore: boolean;
};

type V3PostSessionMessagesResponse = {
    messages: Array<{
        id: string;
        seq: number;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }>;
};

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private relaySocket: Socket | null = null;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    private pendingFileEvents: FileEventMessage[] = [];
    private pendingFileEventCallback: ((data: FileEventMessage) => void) | null = null;
    private blobKey: Uint8Array | null = null;
    /**
     * In-flight attachment download promises that belong to the *current*
     * (not-yet-drained) batch. Each promise resolves to the decoded blob (or
     * null on failure), so per-message ownership is intrinsic — there is no
     * shared push-array between batches that a late download could leak into.
     */
    private pendingDownloads: Promise<{ data: Uint8Array; mimeType: string; name: string } | null>[] = [];
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private reconnectInterval: NodeJS.Timeout | null = null;
    private ignoreArchiveSignal = false;
    private skipInitialMessages = false;
    private claudeSessionProtocolState: ClaudeSessionProtocolState = {
        currentTurnId: null,
        uuidToProviderSubagent: new Map<string, string>(),
        taskPromptToSubagents: new Map<string, string[]>(),
        providerSubagentToSessionSubagent: new Map<string, string>(),
        subagentTitles: new Map<string, string>(),
        bufferedSubagentMessages: new Map<string, RawJSONLines[]>(),
        hiddenParentToolCalls: new Set<string>(),
        startedSubagents: new Set<string>(),
        activeSubagents: new Set<string>(),
    };
    private readonly seenClaudeUsageEvents = new Set<string>();
    private claudeUsageTotals = {
        total: 0,
        input: 0,
        output: 0,
        cache_creation: 0,
        cache_read: 0,
        costTotal: 0,
        costInput: 0,
        costOutput: 0,
    };
    private lastSeq = 0;
    private pendingOutbox: Array<{ content: string; localId: string }> = [];
    private readonly sendSync: InvalidateSync;
    private readonly receiveSync: InvalidateSync;
    private readonly directInboundLocalIds = new Set<string>();
    private readonly routedInboundLocalIds = new Set<string>();
    private handoverInFlight: Promise<void> | null = null;

    constructor(token: string, session: Session) {
        super()
        this.token = token;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;
        this.sendSync = new InvalidateSync(() => this.flushOutbox());
        this.receiveSync = new InvalidateSync(() => this.fetchMessages());

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });
        registerCommonHandlers(this.rpcHandlerManager, this.metadata.path);

        //
        // Create socket
        //

        this.socket = this.createControlSocket();
        const controlSocket = this.socket;

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully');
            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }
            this.rpcHandlerManager.onSocketConnect(controlSocket);
            this.receiveSync.invalidate();
            void this.connectSessionRelay();
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug(`[API] Socket disconnected: ${reason}`);
            this.rpcHandlerManager.onSocketDisconnect(controlSocket);
            this.startSmartReconnect();
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error);
            this.rpcHandlerManager.onSocketDisconnect(controlSocket);
            if (error.message === 'Session archived') {
                logger.debug('[API] Archived session rejected during reconnect; exiting');
                this.emit('archived');
                return;
            }
            this.startSmartReconnect();
        })

        // Server-owned lifecycle command. The database transition is already
        // committed when this arrives, so cleanup is idempotent and does not
        // decide whether the archive succeeded.
        this.socket.on('session-archive', ({ sessionId }) => {
            if (sessionId !== this.sessionId) return;
            logger.debug('[SOCKET] Server archived this session; exiting...');
            this.emit('archived');
        });

        // Server events
        this.socket.on('update', (data: Update) => {
            try {
                logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', data);

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (data.body.t === 'new-message') {
                    const messageSeq = data.body.message?.seq;
                    if (this.lastSeq === 0) {
                        this.receiveSync.invalidate();
                        return;
                    }
                    if (typeof messageSeq !== 'number' || messageSeq !== this.lastSeq + 1 || data.body.message.content.t !== 'encrypted') {
                        this.receiveSync.invalidate();
                        return;
                    }
                    const localId = data.body.message.localId;
                    if (localId && this.directInboundLocalIds.delete(localId)) {
                        this.lastSeq = messageSeq;
                        return;
                    }
                    const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.message.content.c));
                    logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', body)
                    this.routeIncomingMessage(body, localId);
                    if (localId) this.rememberRoutedInbound(localId);
                    this.lastSeq = messageSeq;
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
                        this.metadataVersion = data.body.metadata.version;
                        // Check if session was archived from web/mobile
                        const meta = this.metadata as any;
                        if (meta?.lifecycleState === 'archiveRequested' || meta?.lifecycleState === 'archived') {
                            if (this.ignoreArchiveSignal) {
                                logger.debug(`[SOCKET] Session archived (${meta.lifecycleState}) but suppressed for reconnect`);
                                this.ignoreArchiveSignal = false;
                            } else {
                                logger.debug(`[SOCKET] Session archived (${meta.lifecycleState}), exiting...`);
                                this.emit('archived');
                            }
                        }
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        this.agentState = data.body.agentState.value ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.agentState.value)) : null;
                        this.agentStateVersion = data.body.agentState.version;
                    }
                } else if (data.body.t === 'update-machine') {
                    // Session clients shouldn't receive machine updates - log warning
                    logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`);
                } else {
                    // If not a user message, it might be a permission response or other message type
                    this.emit('message', data.body);
                }
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error });
            }
        });

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error:', error);
        });

        this.socket.on('server-draining', (data) => {
            const parsed = ReleaseDrainNoticeSchema.safeParse(data);
            if (!parsed.success || parsed.data.deadline <= Date.now()) return;
            void this.startReleaseHandover(parsed.data);
        });

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect();
    }

    private createControlSocket(handover?: ReleaseDrainNotice): Socket<ServerToClientEvents, ClientToServerEvents> {
        return io(configuration.serverUrl, {
            auth: {
                token: this.token,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId,
                happyClient: `cli-coding-session/${configuration.currentCliVersion}`,
                ...(handover ? { handoverEpoch: handover.epoch } : {}),
            },
            ...(handover ? { query: { vh_slot: handover.candidateSlot }, forceNew: true } : {}),
            path: '/v1/updates',
            reconnection: false,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false,
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
        type TransferEvent = 'session-archive' | 'update' | 'error' | 'server-draining';
        const transferredListeners = new Map<TransferEvent, any[]>();
        for (const listener of previous.listeners('rpc-request') as any[]) candidate.on('rpc-request', listener);
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
            for (const event of ['session-archive', 'update', 'error', 'server-draining'] as const) {
                const listeners = previous.listeners(event) as any[];
                previous.removeAllListeners(event);
                for (const listener of listeners) candidate.on(event as any, listener);
                transferredListeners.set(event, listeners);
            }
            this.socket = candidate;
            candidate.on('connect', () => {
                if (this.reconnectInterval) {
                    clearInterval(this.reconnectInterval);
                    this.reconnectInterval = null;
                }
                this.rpcHandlerManager.onSocketConnect(candidate);
                this.receiveSync.invalidate();
            });
            candidate.on('disconnect', () => {
                this.rpcHandlerManager.onSocketDisconnect(candidate);
                this.startSmartReconnect();
            });
            candidate.on('connect_error', () => {
                this.rpcHandlerManager.onSocketDisconnect(candidate);
                this.startSmartReconnect();
            });
            this.receiveSync.invalidate();
            candidate.emit('release-handover-result', { result: 'success', durationMs: Date.now() - startedAt });
            this.rpcHandlerManager.onSocketDisconnect(previous);
            previous.removeAllListeners('disconnect');
            previous.close();
        } catch (error) {
            if (this.socket === candidate) this.socket = previous;
            for (const [event, listeners] of transferredListeners) {
                candidate.removeAllListeners(event);
                for (const listener of listeners) previous.on(event as any, listener);
            }
            this.rpcHandlerManager.onSocketDisconnect(candidate);
            candidate.close();
            if (previous.connected) previous.emit('release-handover-result', { result: 'failed', durationMs: Date.now() - startedAt });
            logger.debug(`[API] Release handover failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    onUserMessage(callback: (data: UserMessage) => void) {
        this.pendingMessageCallback = callback;
        while (this.pendingMessages.length > 0) {
            callback(this.pendingMessages.shift()!);
        }
    }

    onFileEvent(callback: (data: FileEventMessage) => void) {
        this.pendingFileEventCallback = callback;
        while (this.pendingFileEvents.length > 0) {
            callback(this.pendingFileEvents.shift()!);
        }
    }

    /**
     * Derive (and cache) the blob decryption key for this session.
     * Legacy sessions use deriveKey(masterSecret, 'Happy Blobs', ['master']).
     * DataKey sessions use deriveKey(dataKey, 'Happy Blobs', ['session']).
     */
    async getBlobKey(): Promise<Uint8Array> {
        if (!this.blobKey) {
            const path = this.encryptionVariant === 'dataKey' ? ['session'] : ['master'];
            this.blobKey = await deriveKey(this.encryptionKey, 'Happy Blobs', path);
        }
        return this.blobKey;
    }

    /**
     * Download an encrypted attachment blob via the request-download flow:
     * POST /request-download → { downloadUrl } → GET downloadUrl. Local mode
     * downloadUrl points back at our server (Bearer required); S3 mode is a
     * presigned URL that does not accept extra headers.
     */
    async downloadAttachment(ref: string): Promise<Uint8Array> {
        const requestUrl = `${configuration.serverUrl}/v1/sessions/${this.sessionId}/attachments/request-download`;
        const requestRes = await axios.post(
            requestUrl,
            { ref },
            {
                headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
                timeout: 30000,
            },
        );
        const downloadUrl = requestRes.data?.downloadUrl;
        if (typeof downloadUrl !== 'string') {
            throw new Error('request-download returned no downloadUrl');
        }

        const isServerUrl = downloadUrl.startsWith(configuration.serverUrl);
        const headers: Record<string, string> = {};
        if (isServerUrl) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        const response = await axios.get(downloadUrl, {
            headers,
            responseType: 'arraybuffer',
            timeout: 60000,
            maxRedirects: 5,
            maxContentLength: MAX_CHAT_ATTACHMENT_ENCRYPTED_BYTES,
            maxBodyLength: MAX_CHAT_ATTACHMENT_ENCRYPTED_BYTES,
        });
        return new Uint8Array(response.data);
    }

    /**
     * Download and decrypt an attachment blob.
     * Returns the decrypted binary data or null if decryption fails.
     */
    async downloadAndDecryptAttachment(ref: string): Promise<Uint8Array | null> {
        const encrypted = await this.downloadAttachment(ref);
        const key = await this.getBlobKey();
        const decrypted = decryptBlob(encrypted, key);
        return decrypted;
    }

    /**
     * Track an attachment download whose promise resolves to the decoded blob
     * (or null on failure). The download stays in the current batch until the
     * next drainAttachmentsForUserMessage call swaps the bucket out — file
     * events that arrive after the swap go into a fresh bucket bound to the
     * next user-text message.
     */
    trackAttachmentDownload(promise: Promise<{ data: Uint8Array; mimeType: string; name: string } | null>): void {
        this.pendingDownloads.push(promise);
    }

    /**
     * Atomically claim every download started before this call, wait for them
     * to resolve, and return the successful ones. The swap-then-await order
     * guarantees that a late-arriving file event cannot leak into this batch.
     */
    async drainAttachmentsForUserMessage(): Promise<Array<{ data: Uint8Array; mimeType: string; name: string }>> {
        const downloads = this.pendingDownloads;
        this.pendingDownloads = [];
        if (downloads.length === 0) return [];
        const results = await Promise.all(downloads);
        return results.filter((x): x is { data: Uint8Array; mimeType: string; name: string } => x !== null);
    }

    private authHeaders() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
        };
    }

    private routeIncomingMessage(message: unknown, sourceLocalId?: string | null) {
        const messageWithSource = sourceLocalId && typeof message === 'object' && message !== null
            ? { ...message, localKey: (message as { localKey?: unknown }).localKey ?? sourceLocalId }
            : message;
        const userResult = UserMessageSchema.safeParse(messageWithSource);
        if (userResult.success) {
            if (this.pendingMessageCallback) {
                this.pendingMessageCallback(userResult.data);
            } else {
                this.pendingMessages.push(userResult.data);
            }
            return;
        }

        // Check for opaque file events from the app.
        const fileResult = FileEventMessageSchema.safeParse(message);
        if (fileResult.success) {
            logger.debug(`[API] Received file event: ${fileResult.data.content.data.ev.name} (ref: ${fileResult.data.content.data.ev.ref})`);
            if (this.pendingFileEventCallback) {
                this.pendingFileEventCallback(fileResult.data);
            } else {
                this.pendingFileEvents.push(fileResult.data);
            }
            return;
        }

        this.emit('message', message);
    }

    private async fetchMessages() {
        // On reconnect, skip processing existing messages — just advance lastSeq
        const skipRouting = this.skipInitialMessages;
        if (skipRouting) {
            this.skipInitialMessages = false;
            logger.debug('[API] Reconnect mode: skipping existing messages, advancing lastSeq');
        }

        let afterSeq = this.lastSeq;
        while (true) {
            const response = await axios.get<V3GetSessionMessagesResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    params: {
                        after_seq: afterSeq,
                        limit: 100
                    },
                    headers: this.authHeaders(),
                    timeout: 60000
                }
            );

            const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
            let maxSeq = afterSeq;

            for (const message of messages) {
                if (message.seq > maxSeq) {
                    maxSeq = message.seq;
                }

                if (skipRouting) continue;

                if (message.localId && this.directInboundLocalIds.delete(message.localId)) {
                    continue;
                }

                if (message.content?.t !== 'encrypted') {
                    continue;
                }

                try {
                    const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(message.content.c));
                    this.routeIncomingMessage(body, message.localId);
                    if (message.localId) this.rememberRoutedInbound(message.localId);
                } catch (error) {
                    logger.debug('[API] Failed to decrypt fetched message', {
                        sessionId: this.sessionId,
                        seq: message.seq,
                        error
                    });
                }
            }

            this.lastSeq = Math.max(this.lastSeq, maxSeq);
            const hasMore = !!response.data.hasMore;
            if (hasMore && maxSeq === afterSeq) {
                logger.debug('[API] fetchMessages pagination stalled, stopping to avoid infinite loop', {
                    sessionId: this.sessionId,
                    afterSeq
                });
                break;
            }
            afterSeq = maxSeq;
            if (!hasMore) {
                break;
            }
        }
    }

    private static readonly MAX_OUTBOX_BATCH_SIZE = 50;

    private async flushOutbox() {
        // Send OLDEST first (FIFO). pendingOutbox is in creation order, and the
        // server allocates its per-session monotonic `seq` in the order messages
        // arrive within a batch — so flushing front-to-back makes server seq equal
        // creation order, which is THE authoritative ordering the client sorts by.
        // (The old "latest batch first" optimization inverted seq on any >50-msg
        // backlog — messages permanently out of order server-side, unfixable
        // client-side. The client re-sorts by seq anyway, so newest-first bought
        // nothing but the bug.)
        while (this.pendingOutbox.length > 0) {
            const batchSize = Math.min(this.pendingOutbox.length, ApiSessionClient.MAX_OUTBOX_BATCH_SIZE);
            const batch = this.pendingOutbox.slice(0, batchSize);

            const response = await axios.post<V3PostSessionMessagesResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    messages: batch
                },
                {
                    headers: this.authHeaders(),
                    timeout: 60000
                }
            );

            const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
            const maxSeq = messages.reduce((acc, message) => (
                message.seq > acc ? message.seq : acc
            ), this.lastSeq);
            this.lastSeq = maxSeq;
            this.pushCommittedMessagesToRelay(batch, messages);
            this.pendingOutbox.splice(0, batch.length);
        }
    }

    private rememberRoutedInbound(localId: string) {
        this.routedInboundLocalIds.add(localId);
        if (this.routedInboundLocalIds.size > 2_000) {
            const oldest = this.routedInboundLocalIds.values().next().value;
            if (oldest) this.routedInboundLocalIds.delete(oldest);
        }
    }

    private rememberDirectInbound(localId: string) {
        this.directInboundLocalIds.add(localId);
        if (this.directInboundLocalIds.size > 2_000) {
            const oldest = this.directInboundLocalIds.values().next().value;
            if (oldest) this.directInboundLocalIds.delete(oldest);
        }
    }

    private async connectSessionRelay() {
        const machineId = this.metadata?.machineId;
        if (!machineId || this.relaySocket?.connected) return;
        try {
            const response = await fetch(
                `${configuration.serverUrl}/v1/relays/sessions/${encodeURIComponent(this.sessionId)}/machines/${encodeURIComponent(machineId)}`,
                { headers: this.authHeaders(), cache: 'no-store' },
            );
            if (!response.ok) return;
            const assignment = RelayAssignmentResponseSchema.parse(await response.json()).assignment;
            if (!assignment) return;
            const relaySocket = io(assignment.url, {
                path: '/v1/relay',
                auth: { token: assignment.token },
                transports: ['websocket'],
                reconnection: true,
                reconnectionDelay: 500,
                reconnectionDelayMax: 5_000,
            });
            this.relaySocket?.close();
            this.relaySocket = relaySocket;
            relaySocket.on('connect', () => {
                if (this.relaySocket !== relaySocket) return;
                this.rpcHandlerManager.onSocketConnect(relaySocket);
                logger.debug(`[API] Session connected to regional relay ${assignment.relayId}`);
            });
            relaySocket.on('rpc-request', async (data: { method: string; params: string }, callback: (response: string) => void) => {
                callback(await this.rpcHandlerManager.handleRequest(data));
            });
            relaySocket.on('session-message-deliver', async (data: {
                sessionId?: unknown;
                messages?: Array<{ localId?: unknown; content?: unknown }>;
            }, callback: (response: unknown) => void) => {
                if (data?.sessionId !== this.sessionId || !Array.isArray(data.messages) || data.messages.length === 0 || data.messages.length > 50) {
                    callback({ ok: false, error: 'Invalid session message request' });
                    return;
                }
                const unique = new Map<string, { localId: string; content: string }>();
                for (const item of data.messages) {
                    if (typeof item?.localId !== 'string' || !item.localId || typeof item.content !== 'string') {
                        callback({ ok: false, error: 'Invalid session message request' });
                        return;
                    }
                    if (!unique.has(item.localId)) unique.set(item.localId, { localId: item.localId, content: item.content });
                }
                const batch = Array.from(unique.values());
                for (const item of batch) this.rememberDirectInbound(item.localId);
                try {
                    const persisted = await axios.post<V3PostSessionMessagesResponse>(
                        `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                        { messages: batch },
                        { headers: this.authHeaders(), timeout: 60_000 },
                    );
                    const stored = Array.isArray(persisted.data.messages) ? persisted.data.messages : [];
                    const storedLocalIds = new Set(stored.map((message) => message.localId));
                    if (batch.some((item) => !storedLocalIds.has(item.localId))) {
                        throw new Error('Central persistence response omitted a session message');
                    }
                    this.lastSeq = stored.reduce((max, message) => Math.max(max, message.seq), this.lastSeq);
                    for (const item of batch) {
                        if (this.routedInboundLocalIds.has(item.localId)) continue;
                        const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(item.content));
                        this.routeIncomingMessage(body, item.localId);
                        this.rememberRoutedInbound(item.localId);
                    }
                    callback({ ok: true, messages: stored });
                } catch (error) {
                    for (const item of batch) this.directInboundLocalIds.delete(item.localId);
                    callback({ ok: false, error: error instanceof Error ? error.message : 'Failed to persist session messages' });
                }
            });
            relaySocket.on('disconnect', () => {
                if (this.relaySocket === relaySocket) this.rpcHandlerManager.onSocketDisconnect(relaySocket);
            });
        } catch (error) {
            logger.debug(`[API] Session regional relay unavailable: ${error instanceof Error ? error.message : error}`);
        }
    }

    private pushCommittedMessagesToRelay(
        batch: Array<{ content: string; localId: string }>,
        messages: V3PostSessionMessagesResponse['messages'],
    ) {
        if (!this.relaySocket?.connected || messages.length === 0) return;
        const contentByLocalId = new Map(batch.map((item) => [item.localId, item.content]));
        const committed = messages.flatMap((message) => {
            if (!message.localId) return [];
            const content = contentByLocalId.get(message.localId);
            if (!content) return [];
            return [{ ...message, content }];
        });
        if (committed.length > 0) {
            this.relaySocket.emit('session-message-committed', {
                sessionId: this.sessionId,
                messages: committed,
            });
        }
    }

    private enqueueMessage(content: unknown, invalidate: boolean = true, localId?: string) {
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.pendingOutbox.push({
            content: encrypted,
            // Deterministic localIds (terminal mirror, B-105) ride the server's
            // @@unique([sessionId, localId]) for replay idempotency; everything
            // else keeps the fire-once random id.
            localId: localId ?? randomUUID()
        });
        if (invalidate) {
            this.sendSync.invalidate();
        }
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines, opts?: {
        /** Terminal mirror (B-105): deterministic per-envelope localId. The
         *  index argument is REQUIRED in the id — one transcript line maps to
         *  0..N envelopes and a per-line-only id would make the server's
         *  unique constraint swallow every envelope after the first. */
        localIdFor?: (envelopeIndex: number) => string;
    }) {
        // Passive observation tap (boardAnalyzer): every raw line headed for
        // the server, both the SDK pipeline (remote) and the JSONL scanner
        // (local). Listeners must be cheap and never throw into this path.
        this.emit('claude-session-message', body);
        const mapped = mapClaudeLogMessageToSessionEnvelopes(body, this.claudeSessionProtocolState);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        for (const [envelopeIndex, envelope] of mapped.envelopes.entries()) {
            this.sendSessionProtocolMessage(envelope, opts?.localIdFor?.(envelopeIndex));
        }
        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                const eventId = typeof body.uuid === 'string'
                    ? body.uuid
                    : typeof body.message.id === 'string'
                        ? body.message.id
                        : undefined;
                this.sendUsageData(body.message.usage, body.message.model, eventId);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', error);
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }));
        }
    }

    closeClaudeSessionTurn(status: SessionTurnEndStatus = 'completed', meta?: { error?: string }) {
        // Turn-end tap (boardAnalyzer): single choke point both launchers
        // (local + remote) route through, for every end status.
        this.emit('turn-ended', status);
        const mapped = closeClaudeTurnWithStatus(this.claudeSessionProtocolState, status, meta);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        for (const envelope of mapped.envelopes) {
            this.sendSessionProtocolMessage(envelope);
        }
    }

    sendCodexMessage(body: any) {
        let content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body  // This wraps the entire Claude message
            },
            meta: {
                sentFrom: 'cli'
            }
        };
        this.enqueueMessage(content);
    }

    private enqueueSessionProtocolEnvelope(envelope: SessionEnvelope, invalidate: boolean = true, localId?: string) {
        const content = {
            role: 'session',
            content: envelope,
            meta: {
                sentFrom: 'cli'
            }
        };

        this.enqueueMessage(content, invalidate, localId);
    }

    sendSessionProtocolMessage(envelope: SessionEnvelope, localId?: string) {
        this.enqueueSessionProtocolEnvelope(envelope, true, localId);
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(provider: 'gemini' | 'codex' | 'claude' | 'opencode' | 'openclaw', body: ACPMessageData) {
        let content = {
            role: 'agent',
            content: {
                type: 'acp',
                provider,
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        };

        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: body.type, hasMessage: 'message' in body });

        this.enqueueMessage(content);
    }

    sendSessionEvent(event: {
        type: 'switch', mode: 'local' | 'remote'
    } | {
        type: 'message', message: string
    } | {
        type: 'permission-mode-changed', mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    } | {
        type: 'ready'
    }, id?: string) {
        let content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };
        this.enqueueMessage(content);
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        });
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
    }

    /**
     * Push text to the clipboard of every web client the user has open.
     * Encrypted with the SESSION key (same primitive the message stream uses,
     * proven to interop with the web's SessionEncryption.decryptRaw); the
     * server relays it to the user's web clients without reading it.
     * Returns delivery info for the MCP tool to report back to the model.
     */
    pushClipboard(text: string): { delivered: boolean; truncated: boolean; totalBytes: number } {
        const prepared = prepareClipboardText(text);
        if (!this.socket.connected) {
            return { delivered: false, truncated: prepared.truncated, totalBytes: prepared.totalBytes };
        }
        this.socket.emit('clipboard-push', {
            payload: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, prepared.text)),
            enc: true,
            truncated: prepared.truncated,
            totalBytes: prepared.totalBytes
        });
        return { delivered: true, truncated: prepared.truncated, totalBytes: prepared.totalBytes };
    }

    /**
     * B-131: ask every web client the user has open to preview a file.
     *
     * Only the PATH travels — encrypted with the session key exactly like
     * clipboard-push. The web client then reads the file over the existing
     * machine-level fs-read RPC. Two reasons: it adds no new file access
     * (fs-read is already exposed) and it keeps the relay payload tiny, so
     * large files / images / PDFs ride the existing chunked read instead of
     * the 1MB relay cap.
     *
     * The path is encrypted rather than sent in the clear because every other
     * payload on this channel is (clipboard, fs RPC) — and a path leaks
     * project/client names and directory structure.
     */
    pushFilePreview(path: string, mode: 'file' | 'diff' = 'file'): { delivered: boolean; error?: string } {
        if (!this.socket.connected) {
            return { delivered: false, error: 'not connected to the server' };
        }
        this.socket.emit('file-preview-push', {
            payload: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, path)),
            enc: true,
            mode,
        });
        return { delivered: true };
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage, model?: string, eventId?: string) {
        if (eventId && this.seenClaudeUsageEvents.has(eventId)) return;
        if (eventId) this.seenClaudeUsageEvents.add(eventId);

        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        const costs = calculateCost(usage, model);
        this.claudeUsageTotals.total += totalTokens;
        this.claudeUsageTotals.input += usage.input_tokens;
        this.claudeUsageTotals.output += usage.output_tokens;
        this.claudeUsageTotals.cache_creation += usage.cache_creation_input_tokens || 0;
        this.claudeUsageTotals.cache_read += usage.cache_read_input_tokens || 0;
        this.claudeUsageTotals.costTotal += costs.total;
        this.claudeUsageTotals.costInput += costs.input;
        this.claudeUsageTotals.costOutput += costs.output;

        // One cumulative upsert per Happy session prevents the account-level
        // UsageReport quota from growing with every Claude API call. JSONL
        // backfills can replay events; stable UUIDs keep that rebuild idempotent.
        const usageReport = {
            // Keep the legacy key so upgrading replaces the old last-call row
            // instead of making old + new clients double-count one session.
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: this.claudeUsageTotals.total,
                input: this.claudeUsageTotals.input,
                output: this.claudeUsageTotals.output,
                cache_creation: this.claudeUsageTotals.cache_creation,
                cache_read: this.claudeUsageTotals.cache_read,
            },
            cost: {
                total: this.claudeUsageTotals.costTotal,
                input: this.claudeUsageTotals.costInput,
                output: this.claudeUsageTotals.costOutput,
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        this.socket.emit('usage-report', usageReport);
    }

    /** Save a provider's cumulative session snapshot under one upsert key. */
    sendAgentUsageSnapshot(agent: string, rawUsage: unknown): boolean {
        const tokens = normalizeAgentUsage(rawUsage);
        if (!tokens) return false;
        const usageReport = {
            key: `usage:${usageAgentKey(agent)}:session`,
            sessionId: this.sessionId,
            tokens,
            // Provider token-count events do not expose reliable billed cost.
            // The Web treats this sentinel as unknown, not as real $0.00.
            cost: { total: 0 },
        };
        logger.debugLargeJson('[SOCKET] Sending agent usage snapshot:', usageReport);
        this.socket.emit('usage-report', usageReport);
        return true;
    }

    /**
     * Returns the latest session metadata known to the client.
     */
    getMetadata(): Metadata | null {
        return this.metadata;
    }

    /**
     * Returns the latest agent state known to the client (requests,
     * controlledByUser, etc.). Used by the notification producer to classify
     * turn-end events.
     */
    getAgentState(): AgentState | null {
        return this.agentState;
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    suppressNextArchiveSignal() {
        this.ignoreArchiveSignal = true;
    }

    skipExistingMessages() {
        this.skipInitialMessages = true;
    }

    updateMetadata(handler: (metadata: Metadata) => Metadata) {
        this.metadataLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.metadata!); // Weird state if metadata is null - should never happen but here we are
                const answer = await this.socket.emitWithAck('update-metadata', { sid: this.sessionId, expectedVersion: this.metadataVersion, metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) });
                if (answer.result === 'success') {
                    this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    }
                    throw new Error('Metadata version mismatch');
                } else if (answer.result === 'error') {
                    throw new Error('Metadata update failed');
                }
            });
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState) {
        logger.debugLargeJson('Updating agent state', this.agentState);
        this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.agentState || {});
                const answer = await this.socket.emitWithAck('update-state', { sid: this.sessionId, expectedVersion: this.agentStateVersion, agentState: updated ? encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) : null });
                if (answer.result === 'success') {
                    this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    this.agentStateVersion = answer.version;
                    logger.debug('Agent state updated', this.agentState);
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        this.agentStateVersion = answer.version;
                        this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    }
                    throw new Error('Agent state version mismatch');
                } else if (answer.result === 'error') {
                    // A transient server/transaction failure must not silently
                    // drop the newest state (notably permission requests).
                    // Throw so the enclosing backoff retries the same reducer
                    // against the last acknowledged version.
                    throw new Error('Agent state update failed');
                }
            });
        });
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        await Promise.race([
            this.sendSync.invalidateAndAwait(),
            delay(10000)
        ]);
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            this.socket.emit('ping', () => {
                resolve();
            });
            setTimeout(() => {
                resolve();
            }, 10000);
        });
    }

    async close() {
        logger.debug('[API] socket.close() called');
        this.sendSync.stop();
        this.receiveSync.stop();
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        this.socket.close();
        this.relaySocket?.close();
        this.relaySocket = null;
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
                logger.debug('[API] Still not ready to reconnect');
                return;
            }
            logger.debug('[API] Attempting reconnect');
            this.socket.connect();
        }, 3000);

        if (shouldReconnect()) {
            logger.debug('[API] Network up + lid open — reconnecting in 1s');
            setTimeout(() => { if (!this.socket.connected) this.socket.connect() }, 1000);
        }
    }
}
