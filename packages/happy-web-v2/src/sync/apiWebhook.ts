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

const WebhookGetResponseSchema = z.object({
    webhook: WebhookConfigSchema.nullable(),
});

export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

function headers(credentials: AuthCredentials): Record<string, string> {
    return {
        'Authorization': `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
        'X-Happy-Client': getHappyClientId(),
    };
}

export async function fetchWebhookConfig(credentials: AuthCredentials): Promise<WebhookConfig | null> {
    const response = await fetch(`${getServerUrl()}/v1/webhook`, {
        method: 'GET',
        headers: headers(credentials),
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch webhook config: ${response.status}`);
    }
    const data = await response.json();
    return WebhookGetResponseSchema.parse(data).webhook;
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

export async function deleteWebhookConfig(credentials: AuthCredentials): Promise<void> {
    const response = await fetch(`${getServerUrl()}/v1/webhook`, {
        method: 'DELETE',
        headers: headers(credentials),
    });
    if (!response.ok) {
        throw new Error(`Failed to delete webhook: ${response.status}`);
    }
}
