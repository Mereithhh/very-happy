/**
 * T-014 — the CLI's side of an RPC rate refusal (`rpc-call` over the
 * user-scoped socket, `sessions approve/deny`).
 *
 * The server (central rpcHandler and the regional relay alike) refuses for
 * rate with one of two frozen strings and, since T-014, a `code` plus
 * `retryAfterMs` saying when the bucket next holds a token. The refusal
 * happened BEFORE anything reached the wrapper, so waiting and re-sending the
 * same request cannot double-execute it — unlike a timeout, which may have.
 *
 * Same shape as B-307's stateWriteRetry: bounded ladder, jitter, never a
 * sub-second retry. Different in one way: this is a one-shot CLI command, so
 * it gives up after MAX_RETRIES and tells the caller, instead of waiting
 * forever the way a daemon's state write must.
 */

export const RPC_RATE_LIMIT_ERROR = 'RPC rate limit reached'
export const RPC_ACCOUNT_RATE_LIMIT_ERROR = 'RPC account rate limit reached'

export const RPC_RATE_RETRY_MIN_DELAY_MS = 2_000
export const RPC_RATE_RETRY_MAX_DELAY_MS = 60_000
/** A one-shot command waits at most this many times before reporting the refusal. */
export const RPC_RATE_MAX_RETRIES = 2

export interface RpcRateLimitedAck {
    ok: false
    error: string
    code?: string
    retryAfterMs?: number
}

export function isRpcRateLimitAck(ack: unknown): ack is RpcRateLimitedAck {
    if (!ack || typeof ack !== 'object') return false
    const a = ack as { ok?: unknown; error?: unknown; code?: unknown }
    if (a.ok !== false) return false
    if (a.code === 'rpc_rate_limited' || a.code === 'rpc_account_rate_limited') return true
    return a.error === RPC_RATE_LIMIT_ERROR || a.error === RPC_ACCOUNT_RATE_LIMIT_ERROR
}

/**
 * How long to wait after refusal number `attempt` (1-based). With a server
 * hint: hint × [1.0, 1.5) jitter. Without: 2s·2^(n-1) with full jitter, never
 * below the minimum. Capped at one bucket window.
 */
export function rpcRateRetryDelayMs(attempt: number, retryAfterMs: number | undefined, random: number = Math.random()): number {
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return Math.min(RPC_RATE_RETRY_MAX_DELAY_MS, Math.round(retryAfterMs * (1 + random * 0.5)))
    }
    const exponent = Math.max(0, Math.min(attempt, 32) - 1)
    const ceiling = Math.min(RPC_RATE_RETRY_MIN_DELAY_MS * 2 ** exponent, RPC_RATE_RETRY_MAX_DELAY_MS)
    return Math.round(RPC_RATE_RETRY_MIN_DELAY_MS + random * (ceiling - RPC_RATE_RETRY_MIN_DELAY_MS))
}
