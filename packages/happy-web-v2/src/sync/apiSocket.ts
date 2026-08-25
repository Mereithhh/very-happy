import { io, Socket } from 'socket.io-client';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import { TokenStorage } from '@/auth/tokenStorage';
import { Encryption } from './encryption/encryption';
import { storage } from './storage';
import { RelayAssignmentResponseSchema, type RelayAssignment } from '@slopus/happy-wire';
import { isMachineRealtimeEvent, shouldIgnoreLegacyRealtime } from './machineRelayRouting';

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

//
// Main Class
//

class ApiSocket {

    // State
    private socket: Socket | null = null;
    private config: SyncSocketConfig | null = null;
    private encryption: Encryption | null = null;
    private messageHandlers: Map<string, (data: any) => void> = new Map();
    private reconnectedListeners: Set<() => void> = new Set();
    private statusListeners: Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void> = new Set();
    private currentStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
    private relaySockets = new Map<string, Socket>();
    private relayConnecting = new Map<string, Promise<Socket | null>>();
    private relayRetryAfter = new Map<string, number>();
    private relayStatuses = new Map<string, MachineRelayStatus>();
    private relayStatusListeners = new Set<(machineId: string, status: MachineRelayStatus) => void>();

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

        this.socket = io(this.config.endpoint, {
            path: '/v1/updates',
            auth: {
                token: this.config.token,
                clientType: 'user-scoped' as const,
                happyClient: getHappyClientId(),
                appState: getCurrentAppState(),
            },
            // Allow HTTP long-polling fallback (+ try every transport on the
            // first attempt) so the socket still connects when wss is blocked by
            // a proxy/VPN (e.g. Clash TUN) — websocket-only would silently hang.
            transports: ['websocket', 'polling'],
            tryAllTransports: true,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });

        this.setupEventHandlers();
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
        this.updateStatus('disconnected');
    }

    //
    // Listener Management
    //

    onReconnected = (listener: () => void) => {
        this.reconnectedListeners.add(listener);
        return () => this.reconnectedListeners.delete(listener);
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
        
        const result = await this.socket!
            .timeout(opts?.timeoutMs ?? ApiSocket.SESSION_RPC_TIMEOUT_MS)
            .emitWithAck('rpc-call', {
                method: `${sessionId}:${method}`,
                params: await sessionEncryption.encryptRaw(params)
            });
        
        if (result.ok) {
            return await sessionEncryption.decryptRaw(result.result) as R;
        }
        throw new Error('RPC call failed');
    }

    /**
     * RPC call for machines - uses legacy/global encryption (for now)
     */
    async machineRPC<R, A>(machineId: string, method: string, params: A, opts?: { timeoutMs?: number }): Promise<R> {
        const machineEncryption = this.encryption!.getMachineEncryption(machineId);
        if (!machineEncryption) {
            throw new Error(`Machine encryption not found for ${machineId}`);
        }

        const relaySocket = await this.ensureMachineRelay(machineId);
        const encryptedParams = await machineEncryption.encryptRaw(params);
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
            relaySocket.close();
            if (this.relaySockets.get(machineId) === relaySocket) this.relaySockets.delete(machineId);
            this.relayRetryAfter.set(machineId, Date.now() + 30_000);
            this.updateRelayStatus(machineId, { transport: 'legacy', state: 'fallback' });
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

    private async ensureMachineRelay(machineId: string): Promise<Socket | null> {
        const existing = this.relaySockets.get(machineId);
        if (existing?.connected) return existing;
        if ((this.relayRetryAfter.get(machineId) ?? 0) > Date.now()) return null;
        const inFlight = this.relayConnecting.get(machineId);
        if (inFlight) return inFlight;
        const connecting = this.connectMachineRelay(machineId).finally(() => this.relayConnecting.delete(machineId));
        this.relayConnecting.set(machineId, connecting);
        return connecting;
    }

    private async connectMachineRelay(machineId: string): Promise<Socket | null> {
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
        } catch { /* connection itself is still usable */ }
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

    private setupEventHandlers() {
        if (!this.socket) return;

        // Connection events
        this.socket.on('connect', () => {
            if (this.isVerboseLogging()) {
                console.log('🔌 SyncSocket: Connected, recovered: ' + this.socket?.recovered);
                console.log('🔌 SyncSocket: Socket ID:', this.socket?.id);
            }
            this.updateStatus('connected');
            if (!this.socket?.recovered) {
                this.reconnectedListeners.forEach(listener => listener());
            }
        });

        this.socket.on('disconnect', (reason) => {
            if (this.isVerboseLogging()) {
                console.log('🔌 SyncSocket: Disconnected', reason);
            }
            this.updateStatus('disconnected');
        });

        // Error events
        this.socket.on('connect_error', (error) => {
            if (this.isVerboseLogging()) {
                console.error('🔌 SyncSocket: Connection error', error);
            }
            this.updateStatus('error');
        });

        this.socket.on('error', (error) => {
            if (this.isVerboseLogging()) {
                console.error('🔌 SyncSocket: Error', error);
            }
            this.updateStatus('error');
        });

        // Message handling
        this.socket.onAny((event, data) => {
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
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();
