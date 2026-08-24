export type TerminalRelayLimit = {
    bytesPerSecond: number;
    burstBytes: number;
    eventsPerSecond: number;
    burstEvents: number;
};

export type RelayLimitResource = 'terminal-relay' | 'clipboard-relay' | 'file-preview-relay' | 'access-key-read';

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
const DEFAULT_RPC_LIMIT: TerminalRelayLimit = {
    bytesPerSecond: 2 * 1024 * 1024,
    burstBytes: 20 * 1024 * 1024,
    eventsPerSecond: 2,
    burstEvents: 120,
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
export class AccountTerminalRateLimiter {
    private readonly buckets = new Map<string, Bucket>();
    private checks = 0;

    constructor(private readonly limit: TerminalRelayLimit) {}

    consume(accountId: string, bytes: number, now = Date.now()): boolean {
        if (this.limit.bytesPerSecond === 0 && this.limit.eventsPerSecond === 0) return true;
        if (!Number.isFinite(bytes) || bytes < 0) return false;

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
        if (!byteAllowed || !eventAllowed) return false;

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
        return true;
    }
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
