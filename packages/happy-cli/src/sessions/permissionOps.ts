/**
 * Approve / deny a pending permission request from the CLI (Lane B of the
 * supervisor batch).
 *
 * The web answers a permission card with a session RPC:
 *   apiSocket.sessionRPC(sessionId, 'permission', { id, approved, decision, … })
 * (`happy-web-v2/src/sync/ops.ts` sessionAllow / sessionDeny). The wrapper
 * handles it in `claude/utils/permissionHandler.ts` (`registerHandler(
 * 'permission', …)`) and `utils/BasePermissionHandler.ts` for the other
 * runners. This module sends the *same* payload over a user-scoped socket so
 * a script or an external meta-agent can do what the card does.
 *
 * Three facts shape the design — each was verified against the code, not
 * assumed:
 *
 * 1. RPC params are ENCRYPTED with the session key end to end. The web
 *    encrypts before `emitWithAck('rpc-call')` (`apiSocket.ts` sessionRPC:
 *    `sessionEncryption.encryptRaw(params)`), the server forwards the opaque
 *    string (`socket/rpcHandler.ts`), and the wrapper decrypts it
 *    (`api/rpc/RpcHandlerManager.ts` handleRequest → `decrypt(...)`). So this
 *    CLI needs the session key from `~/.happy/sessions.json`, which exists
 *    only for sessions this machine's daemon spawned. Approve/deny is
 *    therefore LOCAL-KEY-ONLY, exactly like `sessions read`. Not a permission
 *    error — a scope limit, until the CLI can hold the account content key.
 *
 * 2. The wrapper does NOT report an unknown request id as an error: its
 *    handler logs "not found or already resolved" and returns undefined, and
 *    `RpcHandlerManager` wraps that in a normal, successful ack. A blind
 *    approve of a stale id would therefore look identical to a real one. So we
 *    read the session's agentState over REST first and refuse to send unless
 *    the id is actually pending, then re-read afterwards to report whether the
 *    request really left `requests` (`settled`).
 *
 * 3. Handler exceptions arrive as a normal ack whose decrypted body is
 *    `{ error }` (AGENTS.md rule 17). `interpretPermissionAck` checks that
 *    before trusting the payload; the server's own failures come as
 *    `{ ok: false, error }` and are classified separately (offline / timeout).
 *
 * A plain tool approval carries NO `mode` and NO `allowTools`: rule 14 —
 * wrappers 0.2.79–0.2.90 nest a control request inside canUseTool when
 * `mode` is present and the approval becomes a deny.
 */

import axios from 'axios'
import { configuration } from '@/configuration'
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption'
import { readCredentialsForConfiguredRelay, readPersistedSessions, type PersistedSession } from '@/persistence'
import { openUserScopedSocket, type RpcCallAck, type UserRpcTransport } from '@/api/userSocket'
import type { AgentState } from '@/api/types'

/** Client tag on the REST / socket calls these operations make. */
const PERMISSION_OPS_CLIENT = 'session-ops'

/** Server-side `rpc-call` gives up at 30s; wait no longer than that. */
export const PERMISSION_RPC_TIMEOUT_MS = 30_000

/** How long to wait for the wrapper's agentState write after a successful ack. */
export const SETTLE_TIMEOUT_MS = 5_000
const SETTLE_POLL_MS = 500

/** Same shape the web sends (ops.ts `SessionPermissionRequest`), minus the fields a plain CLI verdict must not carry. */
export interface PermissionRpcPayload {
    id: string
    approved: boolean
    decision: 'approved' | 'approved_for_session' | 'denied'
    reason?: string
}

export type PermissionVerdict =
    | { kind: 'approve'; forSession?: boolean }
    | { kind: 'deny'; reason?: string }

/** Pure: the exact params the wrapper's `permission` handler expects. */
export function buildPermissionRpcPayload(requestId: string, verdict: PermissionVerdict): PermissionRpcPayload {
    if (verdict.kind === 'approve') {
        return {
            id: requestId,
            approved: true,
            decision: verdict.forSession ? 'approved_for_session' : 'approved',
        }
    }
    return {
        id: requestId,
        approved: false,
        decision: 'denied',
        ...(verdict.reason ? { reason: verdict.reason } : {}),
    }
}

export type PermissionAckOutcome =
    /** Server relayed it and the wrapper's handler returned without error. */
    | { status: 'acknowledged' }
    /** No wrapper has the `${sid}:permission` RPC registered — session is not online. */
    | { status: 'offline'; message: string }
    /** The server or the wrapper did not answer within the deadline. */
    | { status: 'timeout'; message: string }
    /** The wrapper's handler threw; its message is in `message` (rule 17 envelope). */
    | { status: 'handler-error'; message: string }
    /** Any other server-side refusal (rate limit, payload, internal). */
    | { status: 'rejected'; message: string }

/**
 * Pure: classify the server ack + the decrypted handler response.
 *
 * `decryptResult` is injected so the classification can be tested without
 * real keys; it must return the wrapper's decrypted body (or null/undefined
 * when there was no body, which is what an ignored request looks like).
 */
export function interpretPermissionAck(
    ack: RpcCallAck,
    decryptResult: (encrypted: string) => unknown,
): PermissionAckOutcome {
    if (!ack.ok) {
        const message = ack.error ?? 'RPC call failed'
        if (message === 'RPC method not available') {
            return { status: 'offline', message: 'no running wrapper has registered the permission RPC for this session' }
        }
        if (/timed? ?out|disconnected/i.test(message)) {
            return { status: 'timeout', message }
        }
        return { status: 'rejected', message }
    }
    let body: unknown = null
    if (typeof ack.result === 'string' && ack.result.length > 0) {
        try {
            body = decryptResult(ack.result)
        } catch {
            body = null
        }
    }
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
        return { status: 'handler-error', message: (body as { error: string }).error }
    }
    return { status: 'acknowledged' }
}

export interface PendingPermissionRequest {
    id: string
    tool: string
    kind?: 'tool' | 'elicitation' | 'user_dialog'
    createdAt?: number
    /** Milliseconds between `createdAt` and `now`; absent when createdAt is missing. */
    waitingMs?: number
}

/** Pure: the pending requests of a decrypted agentState, oldest first. */
export function pendingRequestsOf(agentState: AgentState | null | undefined, now: number): PendingPermissionRequest[] {
    const requests = agentState?.requests
    if (!requests || typeof requests !== 'object') return []
    return Object.entries(requests)
        .map(([id, request]) => ({
            id,
            tool: typeof request?.tool === 'string' ? request.tool : 'unknown',
            ...(request?.kind ? { kind: request.kind } : {}),
            ...(typeof request?.createdAt === 'number' ? { createdAt: request.createdAt, waitingMs: Math.max(0, now - request.createdAt) } : {}),
        }))
        .sort((a, b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER))
}

export interface ResolvePermissionResult {
    sessionId: string
    requestId: string
    payload: PermissionRpcPayload
    outcome: PermissionAckOutcome
    /**
     * After an acknowledged RPC: true once the request has left
     * `agentState.requests`; false if it was still pending when we stopped
     * waiting (the wrapper writes agentState asynchronously, so a false here
     * means "unconfirmed", not "refused").
     */
    settled?: boolean
}

/** Slack past the transport's own timer before we declare the call hung ourselves. */
const RPC_DEADLINE_GRACE_MS = 2_000

/** Pure: reject with `message` if `promise` has not settled within `ms`. */
export function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${message} (timed out)`)), ms)
        promise.then(
            (value) => { clearTimeout(timer); resolve(value) },
            (error) => { clearTimeout(timer); reject(error) },
        )
    })
}

export interface ResolvePermissionDeps {
    now?: () => number
    /** Test hook: shrink the RPC deadline. */
    rpcTimeoutMs?: number
    readPersisted?: () => Record<string, PersistedSession>
    fetchAgentState?: (sessionId: string, persisted: PersistedSession, token: string) => Promise<AgentState | null>
    openTransport?: (token: string) => Promise<UserRpcTransport>
    bearerToken?: () => Promise<string>
    sleep?: (ms: number) => Promise<void>
    settleTimeoutMs?: number
}

/**
 * Deliver a verdict for one pending permission request.
 *
 * Throws (exit 1 for the CLI) when there is no local key, when the request is
 * not pending, or when the transport cannot be opened. RPC-level failures are
 * returned in `outcome` so the caller can print a precise reason.
 */
export async function resolvePermissionRequest(
    sessionId: string,
    requestId: string,
    verdict: PermissionVerdict,
    deps: ResolvePermissionDeps = {},
): Promise<ResolvePermissionResult> {
    const now = deps.now ?? Date.now
    const persisted = (deps.readPersisted ?? readPersistedSessions)()[sessionId]
    if (!persisted) {
        throw new Error(
            `No local key for session ${sessionId} — approve/deny needs the session key from ~/.happy/sessions.json ` +
            '(the RPC payload is encrypted with it), so only sessions this machine\'s daemon spawned within 14 days can be answered from here.',
        )
    }
    const token = await (deps.bearerToken ?? bearerToken)()
    const fetchState = deps.fetchAgentState ?? fetchDecryptedAgentState
    const before = pendingRequestsOf(await fetchState(sessionId, persisted, token), now())
    if (!before.some((request) => request.id === requestId)) {
        const hint = before.length > 0
            ? `Pending request ids: ${before.map((request) => `${request.id} (${request.tool})`).join(', ')}`
            : 'The session has no pending requests.'
        throw new Error(`Request ${requestId} is not pending on session ${sessionId}. ${hint}`)
    }

    const payload = buildPermissionRpcPayload(requestId, verdict)
    const key = decodeBase64(persisted.encryptionKey)
    const params = encodeBase64(encrypt(key, persisted.encryptionVariant, payload))
    const transport = await (deps.openTransport ?? openUserScopedSocket)(token)
    const rpcTimeoutMs = deps.rpcTimeoutMs ?? PERMISSION_RPC_TIMEOUT_MS
    let ack: RpcCallAck
    try {
        // socket.io has its own ack timer, but this deadline is OURS: a CLI
        // invocation must terminate even if the transport never settles
        // (a one-shot command that hangs is worse than one that fails).
        ack = await withDeadline(
            transport.rpcCall({ method: `${sessionId}:permission`, params }, rpcTimeoutMs),
            rpcTimeoutMs + RPC_DEADLINE_GRACE_MS,
            `permission RPC did not settle within ${rpcTimeoutMs}ms`,
        )
    } catch (error) {
        ack = { ok: false, error: error instanceof Error ? error.message : 'RPC call failed' }
    } finally {
        transport.close()
    }
    const outcome = interpretPermissionAck(ack, (encrypted) => decrypt(key, persisted.encryptionVariant, decodeBase64(encrypted)))
    if (outcome.status !== 'acknowledged') {
        return { sessionId, requestId, payload, outcome }
    }

    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const deadline = now() + (deps.settleTimeoutMs ?? SETTLE_TIMEOUT_MS)
    let settled = false
    for (;;) {
        const pending = pendingRequestsOf(await fetchState(sessionId, persisted, token), now())
        if (!pending.some((request) => request.id === requestId)) { settled = true; break }
        if (now() >= deadline) break
        await sleep(SETTLE_POLL_MS)
    }
    return { sessionId, requestId, payload, outcome, settled }
}

async function bearerToken(): Promise<string> {
    const credentials = await readCredentialsForConfiguredRelay()
    if (!credentials) throw new Error('CLI is not authenticated (no ~/.happy/access.key)')
    return credentials.token
}

/** One session by id (B-265 projection); agentState decrypted with the local key. */
async function fetchDecryptedAgentState(sessionId: string, persisted: PersistedSession, token: string): Promise<AgentState | null> {
    const response = await axios.get(
        `${configuration.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
        {
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Happy-Client': `${PERMISSION_OPS_CLIENT}/${configuration.currentCliVersion}`,
            },
            timeout: 15_000,
        },
    )
    const raw = response.data?.session?.agentState
    if (typeof raw !== 'string' || raw.length === 0) return null
    return decrypt(decodeBase64(persisted.encryptionKey), persisted.encryptionVariant, decodeBase64(raw)) as AgentState | null
}
