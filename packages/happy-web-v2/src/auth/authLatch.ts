/**
 * B-490: account auth-failure latch.
 *
 * Incident (2026-09-24, vh-sg tcpdump): a tab whose token the server no longer
 * accepted kept hammering the origin with 401s — POST /v1/kv at 12/s growing to
 * ~240/s (~7 MB/s ingress) plus every InvalidateSync endpoint at ~2/s — for
 * days. Nothing treated 401 as terminal: `backoff()` retried forever with a
 * 0–1 s delay, every notification-seen heartbeat started ANOTHER never-ending
 * kvMutate loop, and there was no "token is dead → sign in again" path at all.
 *
 * The contract now:
 *  - 401 / 403 are auth failures, never retried by backoff (`isAuthFailure`).
 *  - The FIRST 401 on a request carrying the current account token trips this
 *    process-wide latch. From then on every account-authenticated request is
 *    refused locally (fetch + axios guards below), backoff loops bail out,
 *    InvalidateSync/ValueSync stop, the socket disconnects and the UI shows the
 *    re-login prompt (AuthExpiredNotice). Only a reload/login clears it.
 *  - 403 is non-retryable but does NOT latch: it also means "not allowed for
 *    this resource" (teams, reauth_required) with a perfectly valid token.
 *
 * Pure module (no React, no app imports) so the policy is unit-testable.
 */

export class AuthFailedError extends Error {
    readonly status: number;
    readonly isAuthFailure = true;
    constructor(status: number, message?: string) {
        super(message ?? `Authentication failed (${status})`);
        this.name = 'AuthFailedError';
        this.status = status;
    }
}

export interface AuthLatchInfo {
    status: number;
    /** path only — never the query (may carry ids) or the token */
    path: string;
    at: number;
}

let latched: AuthLatchInfo | null = null;
const listeners = new Set<(info: AuthLatchInfo) => void>();

export function isAuthLatched(): boolean {
    return latched !== null;
}

export function getAuthLatch(): AuthLatchInfo | null {
    return latched;
}

export function tripAuthLatch(info: { status: number; path?: string }): void {
    if (latched) return;
    latched = { status: info.status, path: info.path ?? '', at: Date.now() };
    console.warn(`[auth] token rejected (${info.status} on ${latched.path || 'request'}) — background sync stopped, sign-in required`);
    for (const listener of [...listeners]) {
        try { listener(latched); } catch (e) { console.error('[auth] latch listener failed', e); }
    }
}

export function subscribeAuthLatch(listener: (info: AuthLatchInfo) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** A fresh login (or a test) starts clean. */
export function resetAuthLatch(): void {
    latched = null;
}

/** 401/403 from fetch helpers (AuthFailedError) or axios (`error.response.status`). */
export function isAuthFailure(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const e = error as { isAuthFailure?: unknown; status?: unknown; response?: { status?: unknown } };
    if (e.isAuthFailure === true) return true;
    const status = typeof e.status === 'number' ? e.status : e.response?.status;
    return status === 401 || status === 403;
}

/**
 * For fetch-based API helpers: throw a non-retryable AuthFailedError on
 * 401/403. Latching is the fetch guard's job (it alone knows whether the
 * rejected token is still the current one).
 */
export function assertNotAuthFailure(response: { status: number }, what: string): void {
    if (response.status === 401 || response.status === 403) {
        throw new AuthFailedError(response.status, `${what}: ${response.status}`);
    }
}

//
// Transport guards
//

export interface AuthGuardDeps {
    /** the account token currently stored (null when logged out) */
    currentToken: () => string | null;
    /** true for URLs on our API server (third-party 401s mean nothing to us) */
    isServerUrl: (url: string) => boolean;
}

function bearerOf(headers: unknown): string | null {
    if (!headers) return null;
    let value: string | null | undefined;
    if (typeof (headers as Headers).get === 'function') {
        value = (headers as Headers).get('authorization');
    } else if (Array.isArray(headers)) {
        value = headers.find(([k]) => String(k).toLowerCase() === 'authorization')?.[1];
    } else {
        for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
            if (k.toLowerCase() === 'authorization' && typeof v === 'string') value = v;
        }
    }
    return value && value.startsWith('Bearer ') ? value.slice(7) : null;
}

function urlOf(input: unknown): string {
    if (typeof input === 'string') return input;
    if (input && typeof input === 'object') {
        if ('url' in input && typeof (input as { url: unknown }).url === 'string') return (input as { url: string }).url;
        if (typeof (input as URL).href === 'string') return (input as URL).href;
    }
    return String(input);
}

function pathOf(url: string): string {
    try {
        return new URL(url, 'http://local').pathname;
    } catch {
        return '';
    }
}

type FetchFn = (input: any, init?: any) => Promise<Response>;

/**
 * Wrap a fetch implementation: account-authenticated requests to our server
 * are refused locally once latched, and a 401 on the CURRENT token trips the
 * latch. A 401 for a stale token (rotated by a login in another tab) or a
 * third-party URL is passed through without latching.
 */
export function wrapFetchWithAuthGuard(inner: FetchFn, deps: AuthGuardDeps): FetchFn {
    return async (input, init) => {
        const url = urlOf(input);
        const bearer = bearerOf(init?.headers) ?? bearerOf((input as Request | undefined)?.headers);
        if (!bearer || !deps.isServerUrl(url)) return inner(input, init);
        if (latched) throw new AuthFailedError(latched.status, 'auth latched: request suppressed');
        const response = await inner(input, init);
        if (response.status === 401 && bearer === deps.currentToken()) {
            tripAuthLatch({ status: 401, path: pathOf(url) });
        }
        return response;
    };
}

interface AxiosLike {
    interceptors: {
        request: { use: (onFulfilled: (config: any) => any) => unknown };
        response: { use: (onFulfilled: (r: any) => any, onRejected: (e: any) => any) => unknown };
    };
}

/** Same policy for the axios default instance (auth/settings helpers use it). */
export function installAxiosAuthGuard(axios: AxiosLike, deps: AuthGuardDeps): void {
    axios.interceptors.request.use((config) => {
        const bearer = bearerOf(config?.headers);
        if (bearer && latched && deps.isServerUrl(String(config?.url ?? ''))) {
            throw new AuthFailedError(latched.status, 'auth latched: request suppressed');
        }
        return config;
    });
    axios.interceptors.response.use((r) => r, (error) => {
        const status = error?.response?.status;
        const config = error?.config;
        const bearer = bearerOf(config?.headers);
        if (status === 401 && bearer && bearer === deps.currentToken() && deps.isServerUrl(String(config?.url ?? ''))) {
            tripAuthLatch({ status: 401, path: pathOf(String(config?.url ?? '')) });
        }
        return Promise.reject(error);
    });
}

let fetchGuardInstalled = false;

/** Idempotent: patch `target.fetch` once. */
export function installFetchAuthGuard(target: { fetch: FetchFn }, deps: AuthGuardDeps): void {
    if (fetchGuardInstalled) return;
    fetchGuardInstalled = true;
    const inner = target.fetch.bind(target);
    target.fetch = wrapFetchWithAuthGuard(inner, deps);
}
