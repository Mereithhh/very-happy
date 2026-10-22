import {
    ATTENTION_DISABLED_ERROR,
    type AttentionItemListQuery, type AttentionItemListResponse, type AttentionItemPatch, type AttentionItemPost,
    type AttentionItemPostResponse, type AttentionItemResolve, type AttentionItemResponse,
} from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { readCredentialsForConfiguredRelay } from '@/persistence';

/**
 * B-766 briefing board REST client (`/v1/attention-items`, W0 contract in
 * `happy-wire/src/attention.ts`). Account token, same trust tier as the
 * projects client.
 *
 * Compatibility: an older server has no route (Fastify 404 `Not Found`) and a
 * gated one answers 404 `owner_board_disabled`. Both switch the client off for
 * `UNSUPPORTED_BACKOFF_MS`; every call then fails fast with
 * `AttentionUnsupportedError` and callers fall back to the pre-board behaviour.
 */

export const UNSUPPORTED_BACKOFF_MS = 10 * 60_000;

export class AttentionUnsupportedError extends Error {
    constructor() { super('This Very Happy server has no briefing board'); }
}
export class AttentionRequestError extends Error {
    constructor(public status: number, public code: string | null) {
        super(code ? `Briefing board request failed: ${code}` : `Briefing board request failed (HTTP ${status})`);
    }
}

type Fetch = typeof fetch;
export type AttentionClientDeps = {
    serverUrl?: string;
    token?: () => Promise<string | null>;
    fetch?: Fetch;
    now?: () => number;
};

/** A 404 that names an item is an ordinary answer, not a missing feature. */
function isItemErrorCode(code: unknown): boolean {
    return (typeof code === 'string' && code.startsWith('attention_')) || code === 'session_not_found';
}

export function createAttentionClient(deps: AttentionClientDeps = {}) {
    const now = deps.now ?? Date.now;
    const doFetch = deps.fetch ?? fetch;
    const token = deps.token ?? (async () => (await readCredentialsForConfiguredRelay())?.token ?? null);
    let disabledUntil = 0;

    // Bodies never reach logs or errors beyond the error code.
    async function request<T>(path: string, method: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
        if (now() < disabledUntil) throw new AttentionUnsupportedError();
        const bearer = await token();
        if (!bearer) throw new AttentionRequestError(401, 'not_signed_in');
        const response = await doFetch(`${deps.serverUrl ?? configuration.serverUrl}${path}`, {
            method, redirect: 'error',
            headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        let json: any = null;
        try { json = await response.json(); } catch { /* non-JSON (old server 404 page) */ }
        if (response.status === 404 && (json?.error === ATTENTION_DISABLED_ERROR || !isItemErrorCode(json?.error))) {
            disabledUntil = now() + UNSUPPORTED_BACKOFF_MS;
            throw new AttentionUnsupportedError();
        }
        if (!response.ok) throw new AttentionRequestError(response.status, typeof json?.error === 'string' ? json.error : null);
        return json as T;
    }
    const enc = encodeURIComponent;
    return {
        isDisabled: () => now() < disabledUntil,
        /** True when this server serves the board for this account (feature flag on). Network errors throw. */
        async probe(sessionId: string, timeoutMs = 5_000): Promise<boolean> {
            try {
                await request<AttentionItemListResponse>(`/v1/attention-items?sessionId=${enc(sessionId)}&limit=1`, 'GET', undefined, timeoutMs);
                return true;
            } catch (error) {
                if (error instanceof AttentionUnsupportedError) return false;
                throw error;
            }
        },
        post: (input: AttentionItemPost) => request<AttentionItemPostResponse>('/v1/attention-items', 'POST', input),
        patch: (id: string, patch: AttentionItemPatch) => request<AttentionItemResponse>(`/v1/attention-items/${enc(id)}`, 'PATCH', patch),
        resolve: (id: string, input: AttentionItemResolve) => request<AttentionItemResponse>(`/v1/attention-items/${enc(id)}/resolve`, 'POST', input),
        list: (query: AttentionItemListQuery, timeoutMs?: number) => {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
            return request<AttentionItemListResponse>(`/v1/attention-items?${params.toString()}`, 'GET', undefined, timeoutMs);
        },
    };
}
export type AttentionClient = ReturnType<typeof createAttentionClient>;

let shared: AttentionClient | null = null;
/** One client per process, so the unsupported-server backoff is shared by tools, request_human and the lead tracker. */
export function sharedAttentionClient(): AttentionClient {
    return shared ??= createAttentionClient();
}
