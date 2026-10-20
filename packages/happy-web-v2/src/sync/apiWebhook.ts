/**
 * apiWebhook — account webhook notification config (server-side outbound
 * notifications to a user-owned HTTPS endpoint, e.g. a notify-gateway ingest
 * URL that forwards to a group chat).
 *
 * Companion to apiPush.ts. The server stores the config in the same
 * AccountPushToken table (as a `webhook:`-prefixed blob) but exposes a
 * dedicated /v1/webhook API with replace semantics: one webhook per account,
 * saving again replaces the previous one.
 */

import { AuthCredentials } from '@/auth/tokenStorage';
import { z } from 'zod';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

export const WEBHOOK_EVENTS = ['completed', 'permission'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const WebhookConfigSchema = z.object({
    url: z.string(),
    events: z.array(z.enum(WEBHOOK_EVENTS)),
});

/** B-026: the server process's delivery counters for this account (absent on older servers). */
const WebhookDeliverySchema = z.object({
    since: z.number(),
    delivered: z.number(),
    failed: z.number(),
    retries: z.number(),
    lastSuccessAt: z.number().nullable(),
    lastFailureAt: z.number().nullable(),
    lastError: z.string().nullable(),
});

const WebhookGetResponseSchema = z.object({
    webhook: WebhookConfigSchema.nullable(),
    delivery: WebhookDeliverySchema.optional(),
});

export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

function headers(credentials: AuthCredentials): Record<string, string> {
    return {
        'Authorization': `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
        'X-Happy-Client': getHappyClientId(),
    };
}

export async function fetchWebhookStatus(credentials: AuthCredentials): Promise<{ webhook: WebhookConfig | null; delivery: WebhookDelivery | null }> {
    const response = await fetch(`${getServerUrl()}/v1/webhook`, {
        method: 'GET',
        headers: headers(credentials),
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch webhook config: ${response.status}`);
    }
    const data = WebhookGetResponseSchema.parse(await response.json());
    return { webhook: data.webhook, delivery: data.delivery ?? null };
}

export async function fetchWebhookConfig(credentials: AuthCredentials): Promise<WebhookConfig | null> {
    return (await fetchWebhookStatus(credentials)).webhook;
}

/**
 * Save (create or replace) the account webhook. Throws with the server's
 * validation message on 400 (e.g. non-https or private-address URLs).
 */
export async function saveWebhookConfig(credentials: AuthCredentials, config: WebhookConfig): Promise<void> {
    const response = await fetch(`${getServerUrl()}/v1/webhook`, {
        method: 'POST',
        headers: headers(credentials),
        body: JSON.stringify(config),
    });
    if (!response.ok) {
        let message = `Failed to save webhook: ${response.status}`;
        try {
            const data = await response.json();
            if (typeof data?.error === 'string') message = data.error;
        } catch { /* keep generic message */ }
        throw new Error(message);
    }
}

/**
 * Ask the server to forward a manual notification (e.g. "mark done" on the
 * task board) through the account's configured webhook. Best-effort by
 * contract: returns false on ANY failure (no webhook configured, old server
 * without the endpoint, rate-limited, network error) and never throws — a
 * lost notification must never fail the action that triggered it.
 */
export async function notifyWebhook(
    credentials: AuthCredentials,
    payload: { title: string; message?: string; sessionId?: string; taskId?: string },
    opts?: { keepalive?: boolean },
): Promise<boolean> {
    try {
        const response = await fetch(`${getServerUrl()}/v1/webhook/notify`, {
            method: 'POST',
            headers: headers(credentials),
            body: JSON.stringify(payload),
            // B-566: a mark-done committed while the page is going away
            ...(opts?.keepalive ? { keepalive: true } : {}),
        });
        if (!response.ok) return false;
        const data = await response.json();
        return data?.delivered === true;
    } catch {
        return false;
    }
}

export async function deleteWebhookConfig(credentials: AuthCredentials): Promise<void> {
    const response = await fetch(`${getServerUrl()}/v1/webhook`, {
        method: 'DELETE',
        headers: headers(credentials),
    });
    if (!response.ok) {
        throw new Error(`Failed to delete webhook: ${response.status}`);
    }
}
