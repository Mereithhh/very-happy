/**
 * User-scoped control socket for one-shot RPC calls from the CLI.
 *
 * The session wrapper (`apiSession.ts`) and the daemon (`apiMachine.ts`) each
 * hold a long-lived socket that is scoped to *their own* session / machine and
 * only *answers* RPCs. Calling an RPC on some other session — the way the web
 * does when it approves a permission request — needs the third kind of client
 * the server accepts: `user-scoped`, authenticated with the account token
 * alone (`socketIdentity.ts` on the server treats a missing clientType as
 * user-scoped and asks for nothing else).
 *
 * This is deliberately a short-lived connection: connect, one `rpc-call`,
 * close. No reconnection, no handover epoch, no relay selection — a CLI
 * invocation is not a long-lived client and must not look like one to the
 * server's presence bookkeeping.
 *
 * The transport is an interface so the RPC layer on top (`permissionOps.ts`)
 * can be unit-tested with a fake; `openUserScopedSocket` is the only place
 * that touches socket.io-client.
 */

import { io } from 'socket.io-client'
import { configuration } from '@/configuration'

/** The server's ack shape for `rpc-call` (see server `socket/rpcHandler.ts`). */
export interface RpcCallAck {
    ok: boolean
    /** Encrypted, base64 — the wrapper's `RpcHandlerManager` response. */
    result?: string
    error?: string
}

export interface UserRpcTransport {
    /** Emit one `rpc-call` and wait for the server's ack (bounded). */
    rpcCall(payload: { method: string; params: string }, timeoutMs: number): Promise<RpcCallAck>
    close(): void
}

/** Connecting takes a bounded time too; a dead relay must not hang the CLI. */
export const USER_SOCKET_CONNECT_TIMEOUT_MS = 15_000

export async function openUserScopedSocket(
    token: string,
    options: { connectTimeoutMs?: number } = {},
): Promise<UserRpcTransport> {
    const socket = io(configuration.serverUrl, {
        auth: {
            token,
            clientType: 'user-scoped' as const,
            happyClient: `cli-session-ops/${configuration.currentCliVersion}`,
        },
        path: '/v1/updates',
        transports: ['websocket'],
        reconnection: false,
        autoConnect: false,
    })

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.close()
            reject(new Error(`Timed out connecting to ${configuration.serverUrl}`))
        }, options.connectTimeoutMs ?? USER_SOCKET_CONNECT_TIMEOUT_MS)
        socket.once('connect', () => { clearTimeout(timer); resolve() })
        socket.once('connect_error', (error: Error) => {
            clearTimeout(timer)
            socket.close()
            reject(new Error(`Could not connect to ${configuration.serverUrl}: ${error.message}`))
        })
        socket.connect()
    })

    return {
        async rpcCall(payload, timeoutMs) {
            const ack = await socket.timeout(timeoutMs).emitWithAck('rpc-call', payload) as RpcCallAck
            return ack
        },
        close() {
            socket.close()
        },
    }
}
