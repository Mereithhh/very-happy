/**
 * B-823 (B-816 Q4): the session list request leaves at boot, not after the
 * whole startup graph.
 *
 * `/v1/sessions` used to go out only after every startup chunk had run and
 * syncRestore had derived the keys (phone · slow 4G: ~1.25s after
 * navigation), although all it needs is the stored token. main.tsx now starts
 * it right away (only the request — nothing is parsed or decrypted here) and
 * the first fetchSessions adopts it as its first hedged attempt instead of
 * sending its own.
 *
 * Rules: one use only (taken by the first fetchSessions; a later list GET is
 * a real refresh); only for the token it was sent with (re-login / another
 * account sends its own); built by the same sessionListRequest as the regular
 * read and bounded by the same headers/idle deadlines; a 401 trips the auth
 * latch exactly like the guarded fetch would (the guards are installed later,
 * in AppRoot: the prefetch wraps its own fetch with the same guard); any other
 * failure only fails this attempt and the regular path runs.
 */
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './happyClientId';
import { fetchWithDeadline, SYNC_READ_TIMEOUT_MS } from './requestDeadline';
import { hedgePoolInit } from './hedgedRead';
import { wrapFetchWithAuthGuard } from '@/auth/authLatch';

const AUTH_KEY = 'auth_credentials'; // tokenStorage.ts (web)

/** Responses older than this are not adopted: a list that old is a refresh, not a boot. */
export const PREFETCH_MAX_AGE_MS = 30_000;

export interface SessionListPrefetch {
    token: string;
    startedAt: number;
    /** Abort the prefetch (adopting attempt was aborted / superseded). */
    abort: (reason?: unknown) => void;
    /** Resolves when the response headers are in; stays pending if they never come (never rejects). */
    headers: Promise<void>;
    /** The parsed body and its `Date` header; rejects on a network error, timeout or non-2xx status. */
    body: Promise<SessionListResponse>;
}

/** What a `/v1/sessions` read hands fetchSessions: the body, and the server's `Date` (sessionListDelta.ts). */
export interface SessionListResponse {
    data: unknown;
    date: string | null;
}

/**
 * The one way to ask for the session list (prefetch and fetchSessions alike;
 * B-824 swaps the URL for its incremental read here). `unarchived` (Owner
 * 10-27): every unarchived row instead of the 150 newest — read once per page
 * load after the first list (sync.ts fetchUnarchivedSessions); an old server
 * ignores the parameter and answers with the window, which merges harmlessly.
 */
export function sessionListRequest(serverUrl: string, token: string, scope: 'recent' | 'unarchived' = 'recent'): { url: string; headers: Record<string, string> } {
    return {
        url: scope === 'unarchived' ? `${serverUrl}/v1/sessions?scope=unarchived` : `${serverUrl}/v1/sessions`,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
    };
}

let pending: SessionListPrefetch | null = null;

function storedToken(storage: Pick<Storage, 'getItem'>): string | null {
    try {
        const raw = storage.getItem(AUTH_KEY);
        if (!raw) return null;
        const token = (JSON.parse(raw) as { token?: unknown }).token;
        return typeof token === 'string' && token ? token : null;
    } catch {
        return null;
    }
}

export function startSessionListPrefetch(deps: {
    fetchImpl?: typeof fetch;
    storage?: Pick<Storage, 'getItem'>;
    now?: () => number;
    serverUrl?: string;
} = {}): SessionListPrefetch | null {
    const token = storedToken(deps.storage ?? localStorage);
    if (!token) return null;
    const storage = deps.storage ?? localStorage;
    // Same policy as the app's guarded fetch: suppressed while latched, a 401 on the stored token latches.
    const fetchImpl = wrapFetchWithAuthGuard(deps.fetchImpl ?? ((input, init) => fetch(input, init)), {
        currentToken: () => storedToken(storage),
        isServerUrl: () => true,
    });
    const controller = new AbortController();
    let headersArrived!: () => void;
    const headers = new Promise<void>((resolve) => { headersArrived = resolve; });
    const request = sessionListRequest(deps.serverUrl ?? getServerUrl(), token);
    const body = fetchWithDeadline(fetchImpl, request.url, {
        headers: request.headers,
        timeoutMs: SYNC_READ_TIMEOUT_MS,
        signal: controller.signal,
        onResponse: () => headersArrived(),
        ...hedgePoolInit(0),
    }).then(async (response) => {
        if (!response.ok) throw new Error(`Failed to fetch sessions: ${response.status}`);
        return { data: await response.json() as unknown, date: response.headers.get('date') };
    });
    // An unadopted failure must not surface as unhandled.
    body.catch(() => {});
    pending = {
        token,
        startedAt: (deps.now ?? Date.now)(),
        abort: (reason) => controller.abort(reason),
        headers,
        body,
    };
    return pending;
}

/**
 * Hand the prefetch to its one consumer: same token, not stale. Anything else
 * (no prefetch, another token, too old) returns null and drops it.
 */
export function takeSessionListPrefetch(token: string, now: number = Date.now()): SessionListPrefetch | null {
    const prefetch = pending;
    pending = null;
    if (!prefetch) return null;
    if (prefetch.token !== token || now - prefetch.startedAt > PREFETCH_MAX_AGE_MS) {
        prefetch.abort(new DOMException('Prefetch not adopted', 'AbortError'));
        return null;
    }
    return prefetch;
}

/**
 * Run a taken prefetch as a hedgedRead attempt: `onResponse` fires once its
 * headers are in (committing it, like a regular attempt), and the attempt's
 * abort (a hedge won, the caller gave up) aborts the request.
 */
export function adoptSessionListPrefetch(prefetch: SessionListPrefetch, signal: AbortSignal, onResponse: () => void): Promise<SessionListResponse> {
    if (signal.aborted) {
        prefetch.abort(signal.reason);
        return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    const onAbort = () => prefetch.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void prefetch.headers.then(() => { if (!signal.aborted) onResponse(); });
    return new Promise<SessionListResponse>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        prefetch.body.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort);
            signal.removeEventListener('abort', abort);
        });
    });
}

/** test-only */
export function resetSessionListPrefetchForTest(): void {
    pending = null;
}
