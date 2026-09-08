export type TerminalRelayLimit = {
    bytesPerSecond: number;
    burstBytes: number;
    eventsPerSecond: number;
    burstEvents: number;
};

export type RelayLimitResource = 'terminal-relay' | 'clipboard-relay' | 'file-preview-relay' | 'access-key-read' | 'session-stream-relay';

type RelaySocket = {
    emit: (event: string, data: unknown) => unknown;
    disconnect: (close?: boolean) => unknown;
};

// Socket.IO framing adds a small amount beyond the event payload itself. The
// exact transport envelope differs between websocket and polling, so charge a
// conservative fixed overhead in addition to every byte of the raw JSON body.
const RELAY_FRAME_OVERHEAD_BYTES = 64;

type Bucket = {
    bytes: number;
    events: number;
    updatedAt: number;
};

const DEFAULT_LIMIT: TerminalRelayLimit = {
    bytesPerSecond: 2 * 1024 * 1024,
    burstBytes: 8 * 1024 * 1024,
    eventsPerSecond: 200,
    burstEvents: 400,
};

// One 8 MiB terminal handoff becomes roughly 15 MiB of RPC wire data after
// chunk base64, encryption, and the outer encoded envelope. Keep this separate
// from the interactive terminal bucket so a valid handoff neither bypasses an
// account-wide bound nor starves terminal input/output.
//
// Event numbers (T-014, 2026-09-07 — measured on the production web, see
// docs/backlog.md B-375 and docs/operations.md「RPC 限流」): this bucket is
// shared by EVERY tab and every CLI process of one account, and the central
// server's rpcHandler consumes the same instance. A single legitimate user
// action is a burst of up to ~90 RPCs (8 MiB handoff = 88 `uploadFileChunk`,
// terminal-history/fs-read paging ≈ 32) finished in a few seconds, and a
// healthy tab is otherwise ~0 RPC/min at idle. The old 2/s + 120 was one
// handoff; two tabs doing anything sizeable at once tripped it, and the refusal
// then cascaded into the central per-socket limiter through the relay
// fallback. 5/s + 300 is three concurrent handoffs, still far below anything a
// daemon cannot absorb; both values stay env-tunable (RPC_RELAY_*).
const DEFAULT_RPC_LIMIT: TerminalRelayLimit = {
    bytesPerSecond: 2 * 1024 * 1024,
    burstBytes: 20 * 1024 * 1024,
    eventsPerSecond: 5,
    burstEvents: 300,
};

function nonNegativeInteger(value: string | undefined, fallback: number): number {
    if (value === undefined || value.trim() === '') return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveTerminalRelayLimit(env: NodeJS.ProcessEnv = process.env): TerminalRelayLimit {
    const bytesPerSecond = nonNegativeInteger(env.TERMINAL_RELAY_BYTES_PER_SECOND, DEFAULT_LIMIT.bytesPerSecond);
    const eventsPerSecond = nonNegativeInteger(env.TERMINAL_RELAY_EVENTS_PER_SECOND, DEFAULT_LIMIT.eventsPerSecond);
    return {
        bytesPerSecond,
        eventsPerSecond,
        burstBytes: nonNegativeInteger(
            env.TERMINAL_RELAY_BURST_BYTES,
            bytesPerSecond === 0 ? 0 : Math.max(DEFAULT_LIMIT.burstBytes, bytesPerSecond),
        ),
        burstEvents: nonNegativeInteger(
            env.TERMINAL_RELAY_BURST_EVENTS,
            eventsPerSecond === 0 ? 0 : Math.max(DEFAULT_LIMIT.burstEvents, eventsPerSecond),
        ),
    };
}

/**
 * B-309: live session-stream drafts get their OWN bucket, deliberately not the
 * shared interactive one.
 *
 * The shared bucket's overflow policy is to disconnect (see
 * allowAccountRelay), and drafts are a steady ~17 events/s per running
 * session — around a dozen concurrent sessions would drain the account
 * allowance and take the user's TERMINAL socket down with it. Drafts are
 * disposable; terminal input is not. Separate buckets keep a burst of the
 * former from being able to touch the latter.
 */
const DEFAULT_SESSION_STREAM_LIMIT: TerminalRelayLimit = {
    bytesPerSecond: 512 * 1024,
    burstBytes: 2 * 1024 * 1024,
    eventsPerSecond: 400,
    burstEvents: 800,
};

export function resolveSessionStreamRelayLimit(env: NodeJS.ProcessEnv = process.env): TerminalRelayLimit {
    const bytesPerSecond = nonNegativeInteger(env.SESSION_STREAM_RELAY_BYTES_PER_SECOND, DEFAULT_SESSION_STREAM_LIMIT.bytesPerSecond);
    const eventsPerSecond = nonNegativeInteger(env.SESSION_STREAM_RELAY_EVENTS_PER_SECOND, DEFAULT_SESSION_STREAM_LIMIT.eventsPerSecond);
    return {
        bytesPerSecond,
        eventsPerSecond,
        burstBytes: nonNegativeInteger(
            env.SESSION_STREAM_RELAY_BURST_BYTES,
            bytesPerSecond === 0 ? 0 : Math.max(DEFAULT_SESSION_STREAM_LIMIT.burstBytes, bytesPerSecond),
        ),
        burstEvents: nonNegativeInteger(
            env.SESSION_STREAM_RELAY_BURST_EVENTS,
            eventsPerSecond === 0 ? 0 : Math.max(DEFAULT_SESSION_STREAM_LIMIT.burstEvents, eventsPerSecond),
        ),
    };
}

export function resolveRpcRelayLimit(env: NodeJS.ProcessEnv = process.env): TerminalRelayLimit {
    const bytesPerSecond = nonNegativeInteger(env.RPC_RELAY_BYTES_PER_SECOND, DEFAULT_RPC_LIMIT.bytesPerSecond);
    const eventsPerSecond = nonNegativeInteger(env.RPC_RELAY_EVENTS_PER_SECOND, DEFAULT_RPC_LIMIT.eventsPerSecond);
    return {
        bytesPerSecond,
        eventsPerSecond,
        burstBytes: nonNegativeInteger(
            env.RPC_RELAY_BURST_BYTES,
            bytesPerSecond === 0 ? 0 : Math.max(DEFAULT_RPC_LIMIT.burstBytes, bytesPerSecond),
        ),
        burstEvents: nonNegativeInteger(
            env.RPC_RELAY_BURST_EVENTS,
            eventsPerSecond === 0 ? 0 : Math.max(DEFAULT_RPC_LIMIT.burstEvents, eventsPerSecond),
        ),
    };
}

/**
 * Per-account token bucket for high-volume interactive relay traffic. Terminal,
 * clipboard, file-preview, and access-key read events share one instance so an account cannot
 * evade the allowance by switching event names. This is deliberately
 * process-local: every forwarded event is local to the Socket.IO process that
 * accepted it, so it bounds amplification on that process without a Redis round
 * trip on every keystroke. Multi-replica operators should divide the configured
 * allowance by their maximum replica count when they need a strict cluster-wide
 * ceiling.
 */
export type RateLimitVerdict =
    | { ok: true }
    /**
     * Refused. `retryAfterMs` is when the bucket will next hold enough for
     * THIS request (both dimensions), assuming nobody else drains it meanwhile
     * — the client's hint, not a promise. Never 0: a refusal always needs some
     * refill, and a 0 would invite an immediate retry.
     */
    | { ok: false; retryAfterMs: number };

/** Floor for retryAfterMs so a client that obeys it never spins. */
const MIN_RETRY_AFTER_MS = 100;

export class AccountTerminalRateLimiter {
    private readonly buckets = new Map<string, Bucket>();
    private checks = 0;

    constructor(private readonly limit: TerminalRelayLimit) {}

    consume(accountId: string, bytes: number, now = Date.now()): boolean {
        return this.tryConsume(accountId, bytes, now).ok;
    }

    /**
     * Like consume, but a refusal says how long until this same request would
     * fit. A refused request is NOT charged (B-307: charging refusals is how a
     * bucket self-locks — the retries themselves keep it empty).
     */
    tryConsume(accountId: string, bytes: number, now = Date.now()): RateLimitVerdict {
        if (this.limit.bytesPerSecond === 0 && this.limit.eventsPerSecond === 0) return { ok: true };
        if (!Number.isFinite(bytes) || bytes < 0) return { ok: false, retryAfterMs: MIN_RETRY_AFTER_MS };

        let bucket = this.buckets.get(accountId);
        if (!bucket) {
            bucket = {
                bytes: this.limit.burstBytes,
                events: this.limit.burstEvents,
                updatedAt: now,
            };
            this.buckets.set(accountId, bucket);
        } else {
            const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
            bucket.bytes = Math.min(this.limit.burstBytes, bucket.bytes + elapsedSeconds * this.limit.bytesPerSecond);
            bucket.events = Math.min(this.limit.burstEvents, bucket.events + elapsedSeconds * this.limit.eventsPerSecond);
            bucket.updatedAt = now;
        }

        const byteCost = Math.max(0, Math.ceil(bytes));
        const byteAllowed = this.limit.bytesPerSecond === 0 || bucket.bytes >= byteCost;
        const eventAllowed = this.limit.eventsPerSecond === 0 || bucket.events >= 1;
        if (!byteAllowed || !eventAllowed) {
            const byteWaitMs = byteAllowed ? 0 : ((byteCost - bucket.bytes) / this.limit.bytesPerSecond) * 1000;
            const eventWaitMs = eventAllowed ? 0 : ((1 - bucket.events) / this.limit.eventsPerSecond) * 1000;
            const waitMs = Math.max(byteWaitMs, eventWaitMs);
            // A request larger than the whole burst never fits; say so with a
            // finite (one window) hint rather than Infinity/NaN on the wire.
            const bounded = Number.isFinite(waitMs) ? waitMs : 60_000;
            return { ok: false, retryAfterMs: Math.max(MIN_RETRY_AFTER_MS, Math.ceil(bounded)) };
        }

        if (this.limit.bytesPerSecond !== 0) bucket.bytes -= byteCost;
        if (this.limit.eventsPerSecond !== 0) bucket.events -= 1;

        // Authenticated public accounts can still be numerous. Expire idle
        // buckets opportunistically so this protection cannot become a leak.
        this.checks += 1;
        if (this.checks % 1024 === 0) {
            const expiry = now - 10 * 60 * 1000;
            for (const [id, candidate] of this.buckets) {
                if (candidate.updatedAt < expiry) this.buckets.delete(id);
            }
        }
        return { ok: true };
    }
}

/**
 * The two RPC refusals every RPC entry point (central rpcHandler, regional
 * relay) sends. The `error` strings are frozen — happy-cli's permissionOps
 * classifies on them and pre-2026-09 web builds surface them verbatim; the
 * `code` + `retryAfterMs` fields are the additive, machine-readable part
 * (old clients ignore unknown fields — AGENTS 铁律 4).
 */
export const RPC_RATE_LIMIT_ERROR = 'RPC rate limit reached';
export const RPC_ACCOUNT_RATE_LIMIT_ERROR = 'RPC account rate limit reached';

export type RpcRateLimitAck = {
    ok: false;
    error: typeof RPC_RATE_LIMIT_ERROR | typeof RPC_ACCOUNT_RATE_LIMIT_ERROR;
    code: 'rpc_rate_limited' | 'rpc_account_rate_limited';
    retryAfterMs: number;
};

export function rpcRateLimitAck(scope: 'socket' | 'account', retryAfterMs: number): RpcRateLimitAck {
    return scope === 'socket'
        ? { ok: false, error: RPC_RATE_LIMIT_ERROR, code: 'rpc_rate_limited', retryAfterMs }
        : { ok: false, error: RPC_ACCOUNT_RATE_LIMIT_ERROR, code: 'rpc_account_rate_limited', retryAfterMs };
}

/**
 * Charge the complete untrusted event body before parsing or rebuilding it.
 * This is load-bearing: charging only the forwarded fields lets a huge unknown
 * field or identifier consume Socket.IO bandwidth while appearing tiny to the
 * limiter. Values that cannot be serialized fail closed.
 */
export function relayPayloadBytes(payload: unknown): number {
    try {
        const serialized = JSON.stringify(payload);
        if (serialized === undefined) return Number.MAX_SAFE_INTEGER;
        const bytes = Buffer.byteLength(serialized, 'utf8') + RELAY_FRAME_OVERHEAD_BYTES;
        return Number.isSafeInteger(bytes) ? bytes : Number.MAX_SAFE_INTEGER;
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
}

/**
 * Budget check for relay traffic that is DISPOSABLE (B-309 session stream
 * drafts). Over-budget frames are dropped silently instead of disconnecting
 * the producer: these frames are already best-effort (`volatile` on the CLI
 * side, swept on turn end), so losing a few is invisible, while killing the
 * socket would take the session's real message path down with it.
 */
export function allowDroppableRelay(options: {
    limiter?: AccountTerminalRateLimiter;
    accountId: string;
    payload: unknown;
}): boolean {
    if (!options.limiter) return true;
    return options.limiter.consume(options.accountId, relayPayloadBytes(options.payload));
}

export function allowAccountRelay(options: {
    limiter?: AccountTerminalRateLimiter;
    accountId: string;
    socket: RelaySocket;
    resource: RelayLimitResource;
    payload: unknown;
}): boolean {
    if (!options.limiter || options.limiter.consume(options.accountId, relayPayloadBytes(options.payload))) {
        return true;
    }
    options.socket.emit('limit-reached', { resource: options.resource });
    options.socket.disconnect(true);
    return false;
}
