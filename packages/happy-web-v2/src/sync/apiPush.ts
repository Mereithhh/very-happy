import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { assertNotAuthFailure } from '@/auth/authLatch';
import { z } from 'zod';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

const PushTokenSchema = z.object({
    id: z.string(),
    token: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

const PushTokenListResponseSchema = z.object({
    tokens: z.array(PushTokenSchema),
});

export type PushToken = z.infer<typeof PushTokenSchema>;

export async function registerPushToken(credentials: AuthCredentials, token: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/push-tokens`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            },
            body: JSON.stringify({ token })
        });

        assertNotAuthFailure(response, 'apiPush'); // B-490: 401/403 are never retried

        if (!response.ok) {
            throw new Error(`Failed to register push token: ${response.status}`);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error('Failed to register push token');
        }
    });
}

export async function fetchPushTokens(credentials: AuthCredentials): Promise<PushToken[]> {
    const API_ENDPOINT = getServerUrl();
    return backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/push-tokens`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });

        assertNotAuthFailure(response, 'apiPush'); // B-490: 401/403 are never retried

        if (!response.ok) {
            throw new Error(`Failed to fetch push tokens: ${response.status}`);
        }

        const data = await response.json();
        return PushTokenListResponseSchema.parse(data).tokens;
    });
}

export async function unregisterPushToken(credentials: AuthCredentials, token: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/push-tokens/${encodeURIComponent(token)}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });

        assertNotAuthFailure(response, 'apiPush'); // B-490: 401/403 are never retried

        if (!response.ok) {
            throw new Error(`Failed to unregister push token: ${response.status}`);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error('Failed to unregister push token');
        }
    });
}

/** B-570 POST /v1/push/test outcome (never throws). */
export type TestPushResult =
    | { kind: 'ok'; configured: boolean; total: number; sent: number; failed: number; pruned: number }
    /** 404 — the server predates the endpoint */
    | { kind: 'unsupported' }
    /** 429 — 1 per 10s per account */
    | { kind: 'rate-limited' }
    | { kind: 'error' };

const TestPushResponseSchema = z.object({
    configured: z.boolean(),
    total: z.number(),
    sent: z.number(),
    failed: z.number(),
    pruned: z.number(),
});

/**
 * Ask the server to send a labelled test notification to every Web Push
 * subscription of this account. Single attempt (a user-triggered button,
 * the server rate-limits it) — no backoff loop.
 */
export async function sendTestPush(
    credentials: AuthCredentials,
    copy: { title: string; body: string },
): Promise<TestPushResult> {
    try {
        const response = await fetch(`${getServerUrl()}/v1/push/test`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            },
            body: JSON.stringify(copy),
        });
        assertNotAuthFailure(response, 'apiPush');
        if (response.status === 404) return { kind: 'unsupported' };
        if (response.status === 429) return { kind: 'rate-limited' };
        if (!response.ok) return { kind: 'error' };
        const parsed = TestPushResponseSchema.safeParse(await response.json());
        return parsed.success ? { kind: 'ok', ...parsed.data } : { kind: 'error' };
    } catch {
        return { kind: 'error' };
    }
}
