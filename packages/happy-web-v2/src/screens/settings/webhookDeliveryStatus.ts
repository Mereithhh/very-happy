import type { WebhookDelivery } from '@/sync/apiWebhook';

/**
 * B-026: one-word health of the account webhook for the diagnostics page.
 * `failing` = the most recent outcome was a give-up (after retries);
 * `recovered` = something failed since the server started, but a later one
 * got through; `ok` = every notification arrived; `idle` = nothing sent yet.
 */
export type WebhookHealth = 'failing' | 'recovered' | 'ok' | 'idle';

export function webhookHealth(d: WebhookDelivery): WebhookHealth {
    if (d.failed === 0) return d.delivered === 0 ? 'idle' : 'ok';
    if (d.lastFailureAt !== null && (d.lastSuccessAt === null || d.lastFailureAt >= d.lastSuccessAt)) return 'failing';
    return 'recovered';
}
