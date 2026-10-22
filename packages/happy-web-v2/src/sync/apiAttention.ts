/**
 * B-766: REST client for the 汇报板 items (`/v1/attention-items`, W0 contract,
 * served by S-1). Same shape as apiAutomations.ts. With the server flag off
 * (or an older server) every route is 404 `owner_board_disabled` — callers
 * treat that as "no board here", never as a failure.
 */
import {
    ATTENTION_DISABLED_ERROR,
    type AttentionItemListQuery,
    type AttentionItemListResponse,
    type AttentionItemOwnerRespond,
    type AttentionItemResponse,
} from '@slopus/happy-wire';
import { getCurrentAuth } from '@/auth/AuthContext';
import { assertNotAuthFailure } from '@/auth/authLatch';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

export class AttentionApiError extends Error {
    constructor(public status: number, public code: string) {
        super(code);
        this.name = 'AttentionApiError';
    }
}

/** Feature off / older server: hide the board. */
export function isAttentionDisabled(error: unknown): boolean {
    return error instanceof AttentionApiError && error.status === 404 && (error.code === ATTENTION_DISABLED_ERROR || error.code === 'http_404');
}

async function request<T>(path: string, body?: unknown): Promise<T> {
    const credentials = getCurrentAuth()?.credentials;
    if (!credentials) throw new AttentionApiError(401, 'unauthorized');
    const response = await fetch(`${getServerUrl()}/v1/attention-items${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
            Authorization: `Bearer ${credentials.token}`,
            'X-Happy-Client': getHappyClientId(),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assertNotAuthFailure(response, 'apiAttention');
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new AttentionApiError(response.status, (data as { error?: string } | null)?.error ?? `http_${response.status}`);
    if (!data || typeof data !== 'object') throw new AttentionApiError(502, 'invalid_response');
    return data as T;
}

export function listAttentionItems(query: Pick<AttentionItemListQuery, 'sessionId' | 'state' | 'limit' | 'needsOwner'>): Promise<AttentionItemListResponse> {
    const params = new URLSearchParams();
    if (query.sessionId) params.set('sessionId', query.sessionId);
    if (query.state) params.set('state', query.state);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.needsOwner) params.set('needsOwner', query.needsOwner);
    const qs = params.toString();
    return request(qs ? `?${qs}` : '');
}

export function respondToAttentionItem(id: string, body: AttentionItemOwnerRespond): Promise<AttentionItemResponse> {
    return request(`/${encodeURIComponent(id)}/owner-respond`, body);
}
