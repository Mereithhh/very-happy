/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration, encryption/decryption, and handler execution
 */

import { logger as defaultLogger } from '@/ui/logger';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import {
    RpcHandler,
    RpcHandlerMap,
    RpcRequest,
    RpcHandlerConfig,
} from './types';
import { Socket } from 'socket.io-client';

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map();
    /**
     * B-506: methods whose params/result are PLAINTEXT JSON strings instead of
     * machine-key ciphertext. The caller is a CLI on another machine of the
     * same account, which holds neither this machine's key nor the account
     * content key; the trusted relay sees the payload either way (this fork
     * is server-trusted, not e2e). Only `registerPlainHandler` puts a method
     * here; everything else keeps decrypting.
     */
    private plainMethods = new Set<string>();
    private readonly scopePrefix: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: 'legacy' | 'dataKey';
    private readonly logger: (message: string, data?: any) => void;
    private sockets = new Set<Socket>();

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix;
        this.encryptionKey = config.encryptionKey;
        this.encryptionVariant = config.encryptionVariant;
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, data));
    }

    /**
     * Register an RPC handler for a specific method
     * @param method - The method name (without prefix)
     * @param handler - The handler function
     */
    registerHandler<TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>
    ): void {
        const prefixedMethod = this.getPrefixedMethod(method);

        // Store the handler
        this.handlers.set(prefixedMethod, handler);

        for (const socket of this.sockets) socket.emit('rpc-register', { method: prefixedMethod });
    }

    unregisterHandler(method: string): void {
        const prefixedMethod = this.getPrefixedMethod(method);
        this.handlers.delete(prefixedMethod);
        this.plainMethods.delete(prefixedMethod);

        for (const socket of this.sockets) socket.emit('rpc-unregister', { method: prefixedMethod });
    }

    /**
     * B-506: register a method whose request is a plaintext JSON string and
     * whose response is returned as a plaintext JSON string (see
     * `plainMethods`). The handler receives the parsed params; a throw is
     * answered with `{ error }` like the encrypted path.
     */
    registerPlainHandler<TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>
    ): void {
        this.plainMethods.add(this.getPrefixedMethod(method));
        this.registerHandler(method, handler);
    }

    isPlainMethod(prefixedMethod: string): boolean {
        return this.plainMethods.has(prefixedMethod);
    }

    /**
     * Handle an incoming RPC request
     * @param request - The RPC request data
     * @param callback - The response callback
     */
    async handleRequest(
        request: RpcRequest,
    ): Promise<any> {
        if (this.plainMethods.has(request.method)) {
            return this.handlePlainRequest(request);
        }
        try {
            const handler = this.handlers.get(request.method);

            if (!handler) {
                this.logger('[RPC] [ERROR] Method not found', { method: request.method });
                const errorResponse = { error: 'Method not found' };
                const encryptedError = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, errorResponse));
                return encryptedError;
            }

            // Decrypt the incoming params
            const decryptedParams = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(request.params));

            // Call the handler
            this.logger('[RPC] Calling handler', { method: request.method });
            const result = await handler(decryptedParams);
            this.logger('[RPC] Handler returned', { method: request.method, hasResult: result !== undefined });

            // Encrypt and return the response
            const encryptedResponse = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, result));
            this.logger('[RPC] Sending encrypted response', { method: request.method, responseLength: encryptedResponse.length });
            return encryptedResponse;
        } catch (error) {
            this.logger('[RPC] [ERROR] Error handling request', { error });
            const errorResponse = {
                error: error instanceof Error ? error.message : 'Unknown error'
            };
            return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, errorResponse));
        }
    }

    /** Plaintext variant of handleRequest (B-506). Never throws; never encrypts. */
    private async handlePlainRequest(request: RpcRequest): Promise<string> {
        const handler = this.handlers.get(request.method);
        if (!handler) return JSON.stringify({ error: 'Method not found' });
        let params: unknown;
        try {
            params = typeof request.params === 'string' && request.params.length > 0 ? JSON.parse(request.params) : {};
        } catch {
            return JSON.stringify({ error: 'Invalid JSON params' });
        }
        try {
            this.logger('[RPC] Calling plain handler', { method: request.method });
            const result = await handler(params);
            return JSON.stringify(result === undefined ? null : result);
        } catch (error) {
            this.logger('[RPC] [ERROR] Error handling plain request', { error });
            return JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' });
        }
    }

    onSocketConnect(socket: Socket): void {
        this.sockets.add(socket);
        for (const [prefixedMethod] of this.handlers) {
            socket.emit('rpc-register', { method: prefixedMethod });
        }
    }

    /**
     * Attach a candidate transport and wait until the server confirms every
     * method before a release handover closes the old transport.
     */
    async onSocketConnectAndWait(socket: Socket, timeoutMs = 10_000): Promise<void> {
        this.sockets.add(socket);
        const pending = new Set(this.handlers.keys());
        const acknowledged = new Set<string>();
        await new Promise<void>((resolve, reject) => {
            let settleTimer: NodeJS.Timeout | null = null;
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`RPC registration timed out (${pending.size} pending)`));
            }, timeoutMs);
            timer.unref?.();
            const maybeSettle = () => {
                if (pending.size > 0 || settleTimer) return;
                settleTimer = setTimeout(() => {
                    settleTimer = null;
                    for (const prefixedMethod of this.handlers.keys()) {
                        if (acknowledged.has(prefixedMethod) || pending.has(prefixedMethod)) continue;
                        pending.add(prefixedMethod);
                        socket.emit('rpc-register', { method: prefixedMethod });
                    }
                    if (pending.size === 0) {
                        cleanup();
                        resolve();
                    }
                }, 0);
                settleTimer.unref?.();
            };
            const onRegistered = (data: { method?: unknown }) => {
                if (typeof data?.method !== 'string') return;
                acknowledged.add(data.method);
                pending.delete(data.method);
                maybeSettle();
            };
            const cleanup = () => {
                clearTimeout(timer);
                if (settleTimer) clearTimeout(settleTimer);
                socket.off('rpc-registered', onRegistered);
            };
            socket.on('rpc-registered', onRegistered);
            for (const prefixedMethod of pending) socket.emit('rpc-register', { method: prefixedMethod });
            maybeSettle();
        }).catch((error) => {
            this.sockets.delete(socket);
            throw error;
        });
    }

    onSocketDisconnect(socket?: Socket): void {
        if (socket) this.sockets.delete(socket);
        else this.sockets.clear();
    }

    /**
     * Get the number of registered handlers
     */
    getHandlerCount(): number {
        return this.handlers.size;
    }

    /**
     * Check if a handler is registered
     * @param method - The method name (without prefix)
     */
    hasHandler(method: string): boolean {
        const prefixedMethod = this.getPrefixedMethod(method);
        return this.handlers.has(prefixedMethod);
    }

    /**
     * Clear all handlers
     */
    clearHandlers(): void {
        this.handlers.clear();
        this.logger('Cleared all RPC handlers');
    }

    /**
     * Get the prefixed method name
     * @param method - The method name
     */
    private getPrefixedMethod(method: string): string {
        return `${this.scopePrefix}:${method}`;
    }
}

/**
 * Factory function to create an RPC handler manager
 */
export function createRpcHandlerManager(config: RpcHandlerConfig): RpcHandlerManager {
    return new RpcHandlerManager(config);
}
