import { io, Socket } from 'socket.io-client';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import { TokenStorage } from '@/auth/tokenStorage';
import { Encryption } from './encryption/encryption';
import { storage } from './storage';
import { RelayAssignmentResponseSchema, ReleaseDrainNoticeSchema, type RelayAssignment, type ReleaseDrainNotice } from '@slopus/happy-wire';
import { isMachineRealtimeEvent, shouldIgnoreLegacyRealtime } from './machineRelayRouting';
import { decideAfterProbe, decideProbe, LIVENESS_PROBE_MS } from './socketLiveness';

export function getHappyClientId(): string {
    let platform: string = Platform.OS; // 'ios' | 'android' | 'web'
    if (platform === 'web' && typeof window !== 'undefined' && '__TAURI__' in window) {
        platform = 'desktop';
    }
    const version = Constants.expoConfig?.version || '0.0.0';
    return `${platform}/${version}`;
}

/**
 * Compute the current "active" or "background" state for the current platform.
 * Mobile uses AppState. Web/desktop uses document.visibilityState + window focus —
 * "active" means the tab is visible AND has focus, so a backgrounded tab or an
 * unfocused window correctly counts as background and won't suppress mobile pushes.
 */
export function getCurrentAppState(): 'active' | 'background' {
    if (Platform.OS === 'web') {
        if (typeof document === 'undefined') {
            return 'active';
        }
        const visible = document.visibilityState === 'visible';
        const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
        return visible && focused ? 'active' : 'background';
    }
    return AppState.currentState === 'active' ? 'active' : 'background';
}

//
// Types
//

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
}

export interface SyncSocketState {
    isConnected: boolean;
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError: Error | null;
}

export type SyncSocketListener = (state: SyncSocketState) => void;

export type MachineRelayStatus = {
    transport: 'legacy' | 'regional';
    state: 'connecting' | 'connected' | 'fallback';
    relayId?: string;
    region?: string;
    rttMs?: number;
};

export type LivenessResult = 'alive' | 'reconnected' | 'skipped';

export type SessionDeliveryResult = {
    ok: boolean;
    messages?: Array<{
        id: string;
        seq: number;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }>;
    error?: string;
};

//
// Main Class
//

class ApiSocket {

    // State
    private socket: Socket | null = null;
    private config: SyncSocketConfig | null = null;
    private encryption: Encryption | null = null;
    private messageHandlers: Map<string, (data: any) => void> = new Map();
    private reconnectedListeners: Set<() => void | Promise<void>> = new Set();
    private recoveredListeners: Set<() => void> = new Set();
    private livenessInFlight: Promise<LivenessResult> | null = null;
    private livenessAfterHandover = false;
    private statusListeners: Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void> = new Set();
    private currentStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
    private relaySockets = new Map<string, Socket>();
    private relayConnecting = new Map<string, Promise<Socket | null>>();
    private relayRetryAfter = new Map<string, number>();
    private relayStatuses = new Map<string, MachineRelayStatus>();
    private relayStatusListeners = new Set<(machineId: string, status: MachineRelayStatus) => void>();
    private sessionRelayRetryAfter = new Map<string, number>();
    private handoverInFlight: Promise<void> | null = null;

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: Encryption) {
        this.config = config;
        this.encryption = encryption;
        this.connect();
    }

    //
    // Connection Management
    //

    connect() {
        if (!this.config || this.socket) {
            return;
        }

        this.updateStatus('connecting');

        this.socket = this.createControlSocket();

        this.setupEventHandlers(this.socket);
    }

    private createControlSocket(handover?: ReleaseDrainNotice): Socket {
        return io(this.config!.endpoint, {
            path: '/v1/updates',
            // Function form: socket.io re-evaluates it on EVERY connect, so a
            // reconnect (forced or automatic) carries the current focus state
            // and token instead of the values captured when the manager was
            // created. The server reads the same `handshake.auth` shape.
            auth: (cb) => cb({
                token: this.config!.token,
                clientType: 'user-scoped' as const,
                happyClient: getHappyClientId(),
                appState: getCurrentAppState(),
                ...(handover ? { handoverEpoch: handover.epoch } : {}),
            }),
            ...(handover ? { query: { vh_slot: handover.candidateSlot }, forceNew: true } : {}),
            // Allow HTTP long-polling fallback (+ try every transport on the
            // first attempt) so the socket still connects when wss is blocked by
            // a proxy/VPN (e.g. Clash TUN) — websocket-only would silently hang.
            transports: ['websocket', 'polling'],
            tryAllTransports: true,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity,
            ...(handover ? { autoConnect: false } : {}),
        });
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        for (const socket of this.relaySockets.values()) socket.disconnect();
        this.relaySockets.clear();
        this.relayConnecting.clear();
        this.relayRetryAfter.clear();
        this.sessionRelayRetryAfter.clear();
        this.updateStatus('disconnected');
    }

    //
    // Listener Management
    //

    onReconnected = (listener: () => void) => {
        this.reconnectedListeners.add(listener);
        return () => this.reconnectedListeners.delete(listener);
    };

    /**
     * `connect` with `socket.recovered === true` (connectionStateRecovery
     * replayed the server-side gap). onReconnected deliberately does NOT fire
     * then — but events emitted into the dead link BEFORE the server noticed
     * the disconnect were never delivered and are not in the replay, so the
     * current view still needs a bounded refetch. Spec §C.
     */
    onRecovered = (listener: () => void) => {
        this.recoveredListeners.add(listener);
        return () => this.recoveredListeners.delete(listener);
    };

    onStatusChange = (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
        this.statusListeners.add(listener);
        // Immediately notify with current status
        listener(this.currentStatus);
        return () => this.statusListeners.delete(listener);
    };

    onMachineRelayStatus = (listener: (machineId: string, status: MachineRelayStatus) => void) => {
        this.relayStatusListeners.add(listener);
        return () => { this.relayStatusListeners.delete(listener); };
    };

    getMachineRelayStatus(machineId: string): MachineRelayStatus {
        return this.relayStatuses.get(machineId) ?? { transport: 'legacy', state: 'fallback' };
    }

    //
    // Message Handling
    //

    onMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.set(event, handler);
        return () => this.messageHandlers.delete(event);
    }

    offMessage(event: string, _handler: (data: any) => void) {
        this.messageHandlers.delete(event);
    }

    /**
     * RPC 超时（B-138）。此前两条 RPC 路径都用**裸 `emitWithAck`（无 timeout）**，
     * server 一旦不应答就是永久 pending —— UI 一直转圈而不是报错。所有 fs 操作、
     * 终端 open/list 都吃这个洞。
     *
     * 两个值刻意不同：machine RPC 全是 fs-list / fs-read / 终端操作，都该是秒级；
     * session RPC 会跑 bash，可以合法地跑几分钟，所以给一个宽松但**有界**的上限
     * ——重点不是卡得紧，是不能无限等。
     */
    static readonly MACHINE_RPC_TIMEOUT_MS = 60_000;
    static readonly SESSION_RPC_TIMEOUT_MS = 300_000;

    /**
     * RPC call for sessions - uses session-specific encryption
     */
    async sessionRPC<R, A>(sessionId: string, method: string, params: A, opts?: { timeoutMs?: number }): Promise<R> {
        const sessionEncryption = this.encryption!.getSessionEncryption(sessionId);
        if (!sessionEncryption) {
            throw new Error(`Session encryption not found for ${sessionId}`);
        }
        
        const encryptedParams = await sessionEncryption.encryptRaw(params);
        const machineId = storage.getState().sessions[sessionId]?.metadata?.machineId;
        const relayAllowed = typeof machineId === 'string' && (this.sessionRelayRetryAfter.get(sessionId) ?? 0) <= Date.now();
        const relayCandidate = relayAllowed ? await this.ensureMachineRelay(machineId) : null;
        // Re-check right before emitting: a relay that died between
        // ensureMachineRelay and here (resume liveness probe closing it, or a
        // ping-expired close) would park the packet in its sendBuffer forever
        // (`reconnection: false`) until the ack timer fires. Nothing has been
        // sent yet, so routing to control instead cannot double-execute.
        const relaySocket = relayCandidate?.connected ? relayCandidate : null;
        const callCentral = () => this.socket!
            .timeout(opts?.timeoutMs ?? ApiSocket.SESSION_RPC_TIMEOUT_MS)
            .emitWithAck('rpc-call', {
                method: `${sessionId}:${method}`,
                params: encryptedParams,
            });
        let result: any;
        if (relaySocket) {
            try {
                result = await relaySocket
                    .timeout(opts?.timeoutMs ?? ApiSocket.SESSION_RPC_TIMEOUT_MS)
                    .emitWithAck('session-rpc-call', {
                        sessionId,
                        method: `${sessionId}:${method}`,
                        params: encryptedParams,
                    });
                if (!result?.ok && result?.error === 'Session unavailable') {
                    // The relay proved there was no runner to receive the
                    // request, so central fallback cannot double-execute it.
                    this.sessionRelayRetryAfter.set(sessionId, Date.now() + 30_000);
                    result = await callCentral();
                } else if (!result?.ok) {
                    throw new Error(result?.error || 'Regional session RPC failed');
                }
            } catch (error) {
                // The runner may have completed a mutating RPC even if its ack
                // was lost. Never replay the same call over control; put only
                // subsequent explicit calls on the compatibility path.
                // Only when this relay socket is still the current one: a
                // forced relay rebuild rejects in-flight acks synchronously and
                // must not re-arm the cooldown it just cleared.
                if (this.relaySockets.get(machineId as string) === relaySocket) {
                    this.sessionRelayRetryAfter.set(sessionId, Date.now() + 30_000);
                }
                throw error;
            }
        } else {
            result = await callCentral();
        }
        
        if (result.ok) {
            return await sessionEncryption.decryptRaw(result.result) as R;
        }
        throw new Error('RPC call failed');
    }

    /**
     * Deliver encrypted structured messages to the session runner through its
     * machine's regional relay. The runner durably writes the batch before it
     * acknowledges; null means the caller must use the central v3 endpoint.
     */
    async deliverSessionMessages(
        machineId: string,
        sessionId: string,
        messages: Array<{ localId: string; content: string }>,
    ): Promise<SessionDeliveryResult | null> {
        if ((this.sessionRelayRetryAfter.get(sessionId) ?? 0) > Date.now()) return null;
        const relaySocket = await this.ensureMachineRelaySoon(machineId, 800);
        if (!relaySocket) return null;
        try {
            const result = await relaySocket.timeout(3_000).emitWithAck('session-message-deliver', {
                sessionId,
                messages,
            }) as SessionDeliveryResult;
            if (!result?.ok || !Array.isArray(result.messages)) {
                this.sessionRelayRetryAfter.set(sessionId, Date.now() + 30_000);
                return null;
            }
            this.sessionRelayRetryAfter.delete(sessionId);
            return result;
        } catch {
            // localId makes an ack-loss fallback idempotent at the central API.
            this.sessionRelayRetryAfter.set(sessionId, Date.now() + 30_000);
            return null;
        }
    }

    prepareMachineRelay(machineId: string) {
        void this.ensureMachineRelay(machineId);
    }

    /**
     * RPC call for machines - uses legacy/global encryption (for now)
     */
    async machineRPC<R, A>(machineId: string, method: string, params: A, opts?: { timeoutMs?: number }): Promise<R> {
        const machineEncryption = this.encryption!.getMachineEncryption(machineId);
        if (!machineEncryption) {
            throw new Error(`Machine encryption not found for ${machineId}`);
        }

        const relayCandidate = await this.ensureMachineRelay(machineId);
        const encryptedParams = await machineEncryption.encryptRaw(params);
        // See sessionRPC: re-check after the async encrypt so a relay that died
        // meanwhile doesn't swallow the packet until the ack timer (10–60s).
        const relaySocket = relayCandidate?.connected ? relayCandidate : null;
        const call = (socket: Socket) => socket
            .timeout(opts?.timeoutMs ?? ApiSocket.MACHINE_RPC_TIMEOUT_MS)
            .emitWithAck('rpc-call', {
                method: `${machineId}:${method}`,
                params: encryptedParams
            });
        let result: any;
        try {
            result = await call(relaySocket ?? this.socket!);
            if (relaySocket && !result?.ok) throw new Error(result?.error || 'Regional relay RPC failed');
        } catch (error) {
            if (!relaySocket) throw error;
            // Cooldown + fallback only if this socket is still the current
            // relay. A forced rebuild (resume liveness) deletes the map entry
            // BEFORE closing, and its synchronous `_clearAcks` lands here — it
            // must not re-arm the 30s cooldown or overwrite the `connecting`
            // status it just published.
            const stillCurrent = this.relaySockets.get(machineId) === relaySocket;
            relaySocket.close();
            if (stillCurrent) {
                this.relaySockets.delete(machineId);
                this.relayRetryAfter.set(machineId, Date.now() + 30_000);
                this.updateRelayStatus(machineId, { transport: 'legacy', state: 'fallback' });
            }
            // The relay may have delivered a mutating RPC even when its ack was
            // lost. Retrying inside the same call could spawn/stop/write twice.
            // Fail this bounded call; the next explicit user action uses the
            // compatibility path during the cooldown.
            throw error;
        }

        if (result.ok) {
            return await machineEncryption.decryptRaw(result.result) as R;
        }
        throw new Error(result.error || 'RPC call failed');
    }

    /**
     * Sends app focus state to server for push notification routing.
     * Server uses this to suppress pushes when the mobile app is in foreground.
     */
    sendAppState(state: string) {
        this.socket?.emit('app-state', { state });
    }

    /**
     * Web resumed from background (spec `specs/2026-08-web-resume-sync.md` §B).
     * Decides in one place whether the control socket and the connected
     * regional relays are really alive, and forces exactly one
     * `disconnect(); connect()` per dead socket. Sequencing matters — see
     * socketLiveness.ts for why each step is where it is. Concurrent calls
     * share the in-flight run (one action per resume).
     */
    checkLiveness(): Promise<LivenessResult> {
        if (this.livenessInFlight) return this.livenessInFlight;
        this.livenessInFlight = this.runLiveness().finally(() => { this.livenessInFlight = null; });
        return this.livenessInFlight;
    }

    private async runLiveness(): Promise<LivenessResult> {
        const socket = this.socket;
        if (!socket) return 'skipped';
        // Step 1: one emit. If the engine's ping deadline already passed while
        // we were frozen, socket.io-client closes it on the next microtask.
        this.sendAppState(getCurrentAppState());
        // Step 2: let that close chain (all synchronous inside one microtask) run.
        await Promise.resolve();
        // Step 3.
        const probe = decideProbe({ connectedAfterEmit: socket.connected, handoverInFlight: this.handoverInFlight !== null });
        // Relays are probed in parallel with the control socket; they don't
        // depend on its verdict (terminal output rides the relay when connected).
        const relays = this.probeRelays();
        if (probe === 'skip') {
            if (this.handoverInFlight) this.livenessAfterHandover = true;
            await relays;
            return 'skipped';
        }
        // Step 4: `ping` with NO payload — the server handler's first argument
        // is the ack callback (pingHandler.ts), a payload would shift it.
        let acked = false;
        try {
            await socket.timeout(LIVENESS_PROBE_MS).emitWithAck('ping');
            acked = true;
        } catch {
            acked = false;
        }
        // Step 5: re-validate before acting — a queued `close` may have
        // rejected the ack via _clearAcks, and the manager is then already
        // reconnecting; disconnecting again would kill its own attempt.
        const decision = decideAfterProbe({
            acked,
            sameSocket: this.socket === socket,
            connected: socket.connected,
            handoverInFlight: this.handoverInFlight !== null,
        });
        let result: LivenessResult = 'skipped';
        if (decision === 'alive') {
            result = 'alive';
        } else if (decision === 'reconnect') {
            if (this.isVerboseLogging()) console.log('🔌 SyncSocket: liveness probe failed — forcing reconnect');
            // `disconnect()` clears the manager's backoff state and rejects
            // in-flight acks (never replayed: a daemon may have executed the
            // call). `connect()` opens immediately; the resulting `connect`
            // carries recovered=false → onReconnected does the full refetch.
            socket.disconnect();
            socket.connect();
            result = 'reconnected';
        }
        await relays;
        return result;
    }

    /**
     * Probe every connected regional relay with the existing `relay-ping` ack.
     * A relay that answers nothing is rebuilt WITHOUT the 30s legacy cooldown
     * (the cooldown exists for relays that refuse us, not for links the OS
     * silently dropped). Order inside forceRelayRebuild is load-bearing.
     */
    private async probeRelays(): Promise<void> {
        const probes: Promise<void>[] = [];
        for (const [machineId, socket] of this.relaySockets) {
            if (!socket.connected) continue;
            probes.push(this.probeRelay(machineId, socket));
        }
        await Promise.allSettled(probes);
    }

    private async probeRelay(machineId: string, socket: Socket): Promise<void> {
        // Same emit → microtask → connected dance as the control socket: on a
        // relay whose ping deadline passed, this emit closes it and the buffered
        // ack is NOT rejected by _clearAcks — without the check we'd wait the
        // full probe window for nothing.
        const ack = socket.timeout(LIVENESS_PROBE_MS).emitWithAck('relay-ping', { sentAt: Date.now() }).then(() => true, () => false);
        await Promise.resolve();
        if (!socket.connected) {
            // The ordinary disconnect handler already ran (map entry gone, 30s
            // cooldown armed). Resume is not a refusal: clear it and reconnect.
            if (this.relaySockets.get(machineId) !== socket) {
                this.relayRetryAfter.delete(machineId);
                void this.ensureMachineRelay(machineId, { strictPing: true });
            }
            return;
        }
        const acked = await ack;
        if (acked) return;
        if (this.relaySockets.get(machineId) !== socket || !socket.connected) return;
        this.forceRelayRebuild(machineId, socket);
    }

    private forceRelayRebuild(machineId: string, socket: Socket) {
        // 1. Unmap first so the socket's own `disconnect` handler (which runs
        //    synchronously inside close()) skips its cooldown/fallback write.
        this.relaySockets.delete(machineId);
        // 2. No cooldown: we are replacing a dropped link, not being refused.
        this.relayRetryAfter.delete(machineId);
        // 3. Publish the transition ourselves (the skipped handler won't), so
        //    the terminal chip shows connecting instead of a stale connected.
        this.updateRelayStatus(machineId, { transport: 'regional', state: 'connecting' });
        // 4. Close → rejects in-flight acks (a stuck catch-up RPC unblocks now).
        socket.close();
        // 5. Rebuild. strictPing: if the fresh socket also fails relay-ping, it
        //    takes the ordinary 30s cooldown — caps a wedged relay at one
        //    rebuild per resume instead of looping.
        void this.ensureMachineRelay(machineId, { strictPing: true });
    }

    send(event: string, data: any) {
        if (isMachineRealtimeEvent(event) && typeof data?.machineId === 'string') {
            const relay = this.relaySockets.get(data.machineId);
            if (relay?.connected) {
                relay.emit(event, data);
                return true;
            }
        }
        this.socket!.emit(event, data);
        return true;
    }

    async emitWithAck<T = any>(event: string, data: any): Promise<T> {
        if (!this.socket) {
            throw new Error('Socket not connected');
        }
        return await this.socket.emitWithAck(event, data);
    }

    //
    // HTTP Requests
    //

    async request(path: string, options?: RequestInit): Promise<Response> {
        if (!this.config) {
            throw new Error('SyncSocket not initialized');
        }

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            throw new Error('No authentication credentials');
        }

        const url = `${this.config.endpoint}${path}`;
        const headers = {
            'Authorization': `Bearer ${credentials.token}`,
            'X-Happy-Client': getHappyClientId(),
            ...options?.headers
        };

        return fetch(url, {
            ...options,
            headers
        });
    }

    //
    // Token Management
    //

    updateToken(newToken: string) {
        if (this.config && this.config.token !== newToken) {
            this.config.token = newToken;

            if (this.socket) {
                this.disconnect();
                this.connect();
            }
        }
    }

    //
    // Private Methods
    //

    private isVerboseLogging(): boolean {
        try {
            return storage.getState().localSettings.verboseLogging;
        } catch {
            return false;
        }
    }

    private updateStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error') {
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusListeners.forEach(listener => listener(status));
        }
    }

    private updateRelayStatus(machineId: string, status: MachineRelayStatus) {
        this.relayStatuses.set(machineId, status);
        for (const listener of this.relayStatusListeners) listener(machineId, status);
    }

    private async ensureMachineRelay(machineId: string, opts?: { strictPing?: boolean }): Promise<Socket | null> {
        const existing = this.relaySockets.get(machineId);
        if (existing?.connected) return existing;
        if ((this.relayRetryAfter.get(machineId) ?? 0) > Date.now()) return null;
        const inFlight = this.relayConnecting.get(machineId);
        if (inFlight) return inFlight;
        const connecting = this.connectMachineRelay(machineId, opts).finally(() => this.relayConnecting.delete(machineId));
        this.relayConnecting.set(machineId, connecting);
        return connecting;
    }

    private async ensureMachineRelaySoon(machineId: string, timeoutMs: number): Promise<Socket | null> {
        const existing = this.relaySockets.get(machineId);
        if (existing?.connected) return existing;
        const connecting = this.ensureMachineRelay(machineId);
        return await Promise.race([
            connecting,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
    }

    private async connectMachineRelay(machineId: string, opts?: { strictPing?: boolean }): Promise<Socket | null> {
        if (!this.config) return null;
        this.updateRelayStatus(machineId, { transport: 'regional', state: 'connecting' });
        let assignment: RelayAssignment | null = null;
        try {
            const response = await fetch(`${this.config.endpoint}/v1/relays/machines/${encodeURIComponent(machineId)}`, {
                headers: { Authorization: `Bearer ${this.config.token}`, 'X-Happy-Client': getHappyClientId() },
                cache: 'no-store',
            });
            if (!response.ok) throw new Error(`relay discovery failed (${response.status})`);
            assignment = RelayAssignmentResponseSchema.parse(await response.json()).assignment;
        } catch {
            this.updateRelayStatus(machineId, { transport: 'legacy', state: 'fallback' });
            return null;
        }
        if (!assignment) {
            this.updateRelayStatus(machineId, { transport: 'legacy', state: 'fallback' });
            return null;
        }

        const socket = io(assignment.url, {
            path: '/v1/relay',
            auth: { token: assignment.token },
            transports: ['websocket'],
            reconnection: false,
            timeout: 5_000,
        });
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('relay connect timeout')), 5_000);
                socket.once('connect', () => { clearTimeout(timer); resolve(); });
                socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
            });
        } catch {
            socket.close();
            this.relayRetryAfter.set(machineId, Date.now() + 30_000);
            this.updateRelayStatus(machineId, { transport: 'legacy', state: 'fallback' });
            return null;
        }

        this.relaySockets.get(machineId)?.close();
        this.relaySockets.set(machineId, socket);
        socket.onAny((event, data) => {
            if (this.relaySockets.get(machineId) !== socket) return;
            const handler = this.messageHandlers.get(event);
            if (handler) handler(data);
        });
        socket.on('disconnect', () => {
            if (this.relaySockets.get(machineId) !== socket) return;
            this.relaySockets.delete(machineId);
            this.relayRetryAfter.set(machineId, Date.now() + 30_000);
            this.updateRelayStatus(machineId, { transport: 'legacy', state: 'fallback' });
        });
        const startedAt = performance.now();
        let rttMs: number | undefined;
        try {
            await socket.timeout(3_000).emitWithAck('relay-ping', { sentAt: Date.now() });
            rttMs = Math.max(0, performance.now() - startedAt);
        } catch {
            // Normally tolerated (connection itself is still usable). After a
            // forced rebuild it is the loop cap: a relay that accepted the
            // handshake but answers nothing goes to legacy for the usual 30s.
            if (opts?.strictPing && this.relaySockets.get(machineId) === socket) {
                this.relaySockets.delete(machineId);
                socket.close();
                this.relayRetryAfter.set(machineId, Date.now() + 30_000);
                this.updateRelayStatus(machineId, { transport: 'legacy', state: 'fallback' });
                return null;
            }
        }
        if (!socket.connected || this.relaySockets.get(machineId) !== socket) return null;
        this.relayRetryAfter.delete(machineId);
        this.updateRelayStatus(machineId, {
            transport: 'regional',
            state: 'connected',
            relayId: assignment.relayId,
            region: assignment.region,
            rttMs,
        });
        return socket;
    }

    private setupEventHandlers(socket: Socket) {

        // Connection events
        socket.on('connect', () => {
            if (this.socket !== socket) return;
            if (this.isVerboseLogging()) {
                console.log('🔌 SyncSocket: Connected, recovered: ' + socket.recovered);
                console.log('🔌 SyncSocket: Socket ID:', socket.id);
            }
            this.updateStatus('connected');
            if (!socket.recovered) {
                this.reconnectedListeners.forEach(listener => listener());
            } else {
                this.recoveredListeners.forEach(listener => listener());
            }
        });

        socket.on('disconnect', (reason) => {
            if (this.socket !== socket) return;
            if (this.isVerboseLogging()) {
                console.log('🔌 SyncSocket: Disconnected', reason);
            }
            this.updateStatus('disconnected');
        });

        // Error events
        socket.on('connect_error', (error) => {
            if (this.socket !== socket) return;
            if (this.isVerboseLogging()) {
                console.error('🔌 SyncSocket: Connection error', error);
            }
            this.updateStatus('error');
        });

        socket.on('error', (error) => {
            if (this.socket !== socket) return;
            if (this.isVerboseLogging()) {
                console.error('🔌 SyncSocket: Error', error);
            }
            this.updateStatus('error');
        });

        // Message handling
        socket.on('server-draining', (data: unknown) => {
            if (this.socket !== socket) return;
            const parsed = ReleaseDrainNoticeSchema.safeParse(data);
            if (!parsed.success || parsed.data.deadline <= Date.now()) return;
            void this.startHandover(parsed.data);
        });

        socket.onAny((event, data) => {
            if (this.socket !== socket) return;
            if (this.isVerboseLogging()) {
                console.log(`📥 SyncSocket: Received event '${event}':`, JSON.stringify(data).substring(0, 200));
            }
            if (shouldIgnoreLegacyRealtime(event, data?.machineId,
                typeof data?.machineId === 'string' && this.relaySockets.get(data.machineId)?.connected === true)) return;
            const handler = this.messageHandlers.get(event);
            if (handler) {
                handler(data);
            }
        });
    }

    private startHandover(notice: ReleaseDrainNotice): Promise<void> {
        if (this.handoverInFlight) return this.handoverInFlight;
        this.handoverInFlight = this.handover(notice).finally(() => {
            this.handoverInFlight = null;
            // A resume that landed mid-handover skipped its probe; on a dead
            // link the candidate times out and `previous` is kept — nobody
            // else would ever probe it. Run the deferred check now.
            if (this.livenessAfterHandover) {
                this.livenessAfterHandover = false;
                void this.checkLiveness();
            }
        });
        return this.handoverInFlight;
    }

    private async handover(notice: ReleaseDrainNotice): Promise<void> {
        if (!this.config || !this.socket || notice.deadline <= Date.now()) return;
        const startedAt = Date.now();
        const previous = this.socket;
        const candidate = this.createControlSocket(notice);
        const timeoutMs = Math.max(1, Math.min(10_000, notice.deadline - Date.now()));
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('release handover timeout')), timeoutMs);
                candidate.once('connect', () => { clearTimeout(timer); resolve(); });
                candidate.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
                candidate.connect();
            });
            if (this.socket !== previous) {
                candidate.disconnect();
                return;
            }
            this.socket = candidate;
            this.setupEventHandlers(candidate);
            this.updateStatus('connected');
            await Promise.allSettled([...this.reconnectedListeners].map((listener) => Promise.resolve(listener())));
            candidate.emit('release-handover-result', { result: 'success', durationMs: Date.now() - startedAt });
            previous.disconnect();
        } catch (error) {
            if (this.socket === candidate) this.socket = previous;
            candidate.disconnect();
            if (previous.connected) previous.emit('release-handover-result', { result: 'failed', durationMs: Date.now() - startedAt });
            if (this.isVerboseLogging()) console.error('🔌 SyncSocket: release handover failed', error);
        }
    }
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();
