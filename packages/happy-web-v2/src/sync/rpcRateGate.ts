/**
 * rpcRateGate (T-014) — what the web does when the server says an RPC was
 * refused for RATE, and how it stops the next hundred calls from saying it
 * again.
 *
 * Two server strings exist and both were previously invisible: the central
 * rpcHandler's per-socket `'RPC rate limit reached'` and the account bucket's
 * `'RPC account rate limit reached'` (central AND regional relay — same
 * bucket function, `terminalRateLimit.ts`). `machineRPC` rethrew the string
 * to a caller that usually swallowed it; `sessionRPC` collapsed it into
 * `'RPC call failed'`. Nobody backed off, so every retry (InvalidateSync's
 * ≤1s `backoff`, a git-status fan-out, a chunked upload loop) hit the empty
 * bucket again — the same amplifier B-307 found on the state-write bucket.
 *
 * Policy, per route (central control socket vs. each machine relay):
 *
 * 1. A refusal CLOSES the route for `retryAfterMs` from the server (jittered
 *    ×1.0–1.5 so tabs don't march back in lockstep) or, if the ack carries
 *    none (older server), an exponential ladder 2s→60s with full jitter.
 * 2. While closed, calls WAIT at the gate instead of being sent. Identical
 *    calls (same scoped method + params) waiting together collapse onto one
 *    promise — a retry storm becomes one request.
 * 3. When the route reopens, waiters are released one at a time with
 *    `RECOVERY_SPACING_MS` between them (the account bucket refills at a few
 *    per second; releasing 40 at once just re-closes the route). The first
 *    success ends recovery and the spacing.
 * 4. The gated call itself retries at most `MAX_RETRIES` times on a rate
 *    refusal. This is safe for rate refusals specifically: both limiters
 *    reject BEFORE the request reaches any daemon, so nothing can have
 *    executed. It is NOT applied to any other error.
 * 5. Every window is announced once (`onLimited`) so the UI can toast; a
 *    second refusal inside the same window extends it silently.
 *
 * Pure: time, random and the announce hook are injected. `apiSocket` owns the
 * one instance and wires the toast.
 */

export const RPC_RATE_LIMIT_ERROR = 'RPC rate limit reached';
export const RPC_ACCOUNT_RATE_LIMIT_ERROR = 'RPC account rate limit reached';

/** Fallback ladder when the server did not say how long (pre-T-014 servers). */
export const RATE_RETRY_MIN_DELAY_MS = 2_000;
export const RATE_RETRY_MAX_DELAY_MS = 60_000;
/** Hard ceiling on any single wait, server hint included. */
export const RATE_WAIT_CAP_MS = 60_000;
/** Spacing between releases while a route is recovering from a refusal. */
export const RECOVERY_SPACING_MS = 250;
/** Bounded: a call refused this many times in a row fails to its caller. */
export const MAX_RETRIES = 2;

export type RpcRateLimitedAck = {
    ok: false;
    error: string;
    code?: string;
    retryAfterMs?: number;
};

/** True for the server's rate refusals — both strings, either entry point. */
export function isRpcRateLimitAck(ack: unknown): ack is RpcRateLimitedAck {
    if (!ack || typeof ack !== 'object') return false;
    const a = ack as { ok?: unknown; error?: unknown; code?: unknown };
    if (a.ok !== false) return false;
    if (a.code === 'rpc_rate_limited' || a.code === 'rpc_account_rate_limited') return true;
    return a.error === RPC_RATE_LIMIT_ERROR || a.error === RPC_ACCOUNT_RATE_LIMIT_ERROR;
}

/** The error a gated call throws when its bounded retries are exhausted. */
export class RpcRateLimitedError extends Error {
    readonly retryAfterMs: number;
    readonly route: string;
    constructor(route: string, retryAfterMs: number, serverError: string) {
        // Keep the server's string as the message: existing callers regex on it
        // and the CLI's classification is by string too.
        super(serverError);
        this.name = 'RpcRateLimitedError';
        this.route = route;
        this.retryAfterMs = retryAfterMs;
    }
}

export function isRpcRateLimitedError(error: unknown): error is RpcRateLimitedError {
    return error instanceof RpcRateLimitedError
        || (error instanceof Error && (error.message === RPC_RATE_LIMIT_ERROR || error.message === RPC_ACCOUNT_RATE_LIMIT_ERROR));
}

/**
 * How long to close a route after refusal number `attempt` (1-based).
 * With a server hint: the hint ×[1.0, 1.5) jitter. Without: 2s·2^(n-1) full
 * jitter, never below the minimum. Both capped at RATE_WAIT_CAP_MS.
 */
export function rateWindowMs(attempt: number, retryAfterMs: number | undefined, random: number = Math.random()): number {
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return Math.min(RATE_WAIT_CAP_MS, Math.round(retryAfterMs * (1 + random * 0.5)));
    }
    const exponent = Math.max(0, Math.min(attempt, 32) - 1);
    const ceiling = Math.min(RATE_RETRY_MIN_DELAY_MS * 2 ** exponent, RATE_RETRY_MAX_DELAY_MS);
    return Math.min(RATE_WAIT_CAP_MS, Math.round(RATE_RETRY_MIN_DELAY_MS + random * (ceiling - RATE_RETRY_MIN_DELAY_MS)));
}

/** Small, stable key for "same call": scoped method + a hash of the params. */
export function rpcDedupKey(route: string, scopedMethod: string, params: unknown): string {
    let serialized = '';
    try { serialized = JSON.stringify(params) ?? ''; } catch { serialized = String(params); }
    // djb2 — collisions only cost a shared result between two calls that
    // happened to hash alike inside the same closed window; acceptable.
    let hash = 5381;
    for (let i = 0; i < serialized.length; i++) hash = ((hash << 5) + hash + serialized.charCodeAt(i)) | 0;
    return `${route}|${scopedMethod}|${serialized.length}:${hash >>> 0}`;
}

export type RpcRateGateEvent = {
    route: string;
    /** Milliseconds the route will stay closed. */
    waitMs: number;
    /** Consecutive refusals on this route (1 = first). */
    attempt: number;
    serverError: string;
};

type RouteState = {
    closedUntil: number;
    attempt: number;
    /** Set while a refusal has happened and no success has followed. */
    recovering: boolean;
    /** Release chain: each waiter appends itself so releases are serialized. */
    lastRelease: Promise<void>;
    nextReleaseAt: number;
};

export interface RpcRateGateDeps {
    now?: () => number;
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onLimited?: (event: RpcRateGateEvent) => void;
}

export class RpcRateGate {
    private readonly routes = new Map<string, RouteState>();
    private readonly inFlight = new Map<string, Promise<unknown>>();
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private onLimited?: (event: RpcRateGateEvent) => void;

    constructor(deps: RpcRateGateDeps = {}) {
        this.now = deps.now ?? (() => Date.now());
        this.random = deps.random ?? Math.random;
        this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.onLimited = deps.onLimited;
    }

    /** Late-bound announce hook (the UI layer installs it after boot). */
    setOnLimited(listener: ((event: RpcRateGateEvent) => void) | undefined): void {
        this.onLimited = listener;
    }

    private route(route: string): RouteState {
        let state = this.routes.get(route);
        if (!state) {
            state = { closedUntil: 0, attempt: 0, recovering: false, lastRelease: Promise.resolve(), nextReleaseAt: 0 };
            this.routes.set(route, state);
        }
        return state;
    }

    /** Ms until the route accepts a new call; 0 when open. */
    waitFor(route: string): number {
        const state = this.routes.get(route);
        if (!state) return 0;
        return Math.max(0, state.closedUntil - this.now());
    }

    /** Whether a refusal has closed the route and no success has reopened it yet. */
    isRecovering(route: string): boolean {
        return this.routes.get(route)?.recovering ?? false;
    }

    /**
     * Record a refusal. Returns the window it closed the route for. Announces
     * only when this refusal actually opened a NEW window (not while one is
     * already running) so the UI hears about the incident once.
     */
    noteLimited(route: string, ack: RpcRateLimitedAck): number {
        const state = this.route(route);
        const now = this.now();
        const alreadyClosed = state.closedUntil > now;
        state.attempt += 1;
        state.recovering = true;
        const waitMs = rateWindowMs(state.attempt, ack.retryAfterMs, this.random());
        const closedUntil = now + waitMs;
        if (closedUntil > state.closedUntil) state.closedUntil = closedUntil;
        if (!alreadyClosed) {
            this.onLimited?.({ route, waitMs: state.closedUntil - now, attempt: state.attempt, serverError: ack.error });
        }
        return state.closedUntil - now;
    }

    noteSuccess(route: string): void {
        const state = this.routes.get(route);
        if (!state) return;
        state.attempt = 0;
        state.recovering = false;
        state.closedUntil = 0;
        state.nextReleaseAt = 0;
    }

    /** Wait until the route is open, then take the next paced release slot. */
    private async admit(route: string): Promise<void> {
        const state = this.route(route);
        // Loop: a refusal by someone else can re-close the route while we sleep.
        for (;;) {
            const wait = state.closedUntil - this.now();
            if (wait <= 0) break;
            await this.sleep(wait);
        }
        if (!state.recovering) return;
        // Serialize releases while recovering: each waiter chains behind the
        // previous one and leaves RECOVERY_SPACING_MS before the next.
        const previous = state.lastRelease;
        let release!: () => void;
        state.lastRelease = new Promise<void>((resolve) => { release = resolve; });
        try {
            await previous;
            if (!state.recovering) return;
            const gap = state.nextReleaseAt - this.now();
            if (gap > 0) await this.sleep(gap);
            state.nextReleaseAt = this.now() + RECOVERY_SPACING_MS;
        } finally {
            release();
        }
    }

    /**
     * Run `fn` through the gate for `route`. `fn` performs ONE emit and returns
     * the raw ack (any shape; only rate refusals are interpreted here).
     * Identical calls (`dedupKey`) already waiting share the same promise.
     */
    run<T>(route: string, dedupKey: string, fn: () => Promise<T>): Promise<T> {
        const shared = this.inFlight.get(dedupKey);
        if (shared) return shared as Promise<T>;
        const promise = this.runOnce(route, fn).finally(() => {
            if (this.inFlight.get(dedupKey) === promise) this.inFlight.delete(dedupKey);
        });
        this.inFlight.set(dedupKey, promise);
        return promise;
    }

    private async runOnce<T>(route: string, fn: () => Promise<T>): Promise<T> {
        let refusals = 0;
        for (;;) {
            await this.admit(route);
            const ack = await fn();
            if (!isRpcRateLimitAck(ack)) {
                this.noteSuccess(route);
                return ack;
            }
            refusals += 1;
            const waitMs = this.noteLimited(route, ack);
            if (refusals > MAX_RETRIES) {
                throw new RpcRateLimitedError(route, waitMs, ack.error);
            }
        }
    }

    /** Test hook. */
    reset(): void {
        this.routes.clear();
        this.inFlight.clear();
    }
}
