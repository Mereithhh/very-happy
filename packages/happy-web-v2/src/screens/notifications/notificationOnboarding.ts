/**
 * B-570 — pure decisions for "is notification delivery working / should we
 * invite the user to turn it on". No DOM, no network (notificationOnboarding.test.ts).
 *
 * Opt-in gate idea from Orca `mobile/src/notifications/notification-opt-in-gate.ts`
 * (MIT): only ask while the decision is still open — here `permission ===
 * 'default'` (never granted, never denied) and the card was not dismissed.
 */

import type { TestPushResult } from '@/sync/apiPush';

export const NOTIF_OPT_IN_DISMISSED_STORAGE = 'vh-notif-optin-dismissed-v1';
/** Delay before the card slides in, so it never competes with first paint. */
export const NOTIF_OPT_IN_REVEAL_MS = 2_500;

export interface OptInGateInput {
    /** Notification API + Service Worker + PushManager available */
    supported: boolean;
    permission: NotificationPermission | 'unsupported';
    dismissed: boolean;
    /** the PWA install card is on screen — never stack two cards */
    installPromptVisible: boolean;
    /** already on settings → notifications, where the toggle lives */
    onNotificationSettings: boolean;
}

export function shouldOfferNotificationOptIn(input: OptInGateInput): boolean {
    if (!input.supported || input.permission !== 'default') return false;
    if (input.dismissed || input.installPromptVisible || input.onNotificationSettings) return false;
    return true;
}

export type TestPushMessage =
    | { key: 'notifications.testPushSent'; params: { count: number } }
    | { key: 'notifications.testPushSentPartial'; params: { sent: number; failed: number } }
    | { key: 'notifications.testPushNoDevices' }
    | { key: 'notifications.testPushNotConfigured' }
    | { key: 'notifications.testPushUnsupported' }
    | { key: 'notifications.testPushRateLimited' }
    | { key: 'notifications.testPushFailed' };

export function describeTestPushResult(result: TestPushResult): TestPushMessage {
    switch (result.kind) {
        case 'unsupported':
            return { key: 'notifications.testPushUnsupported' };
        case 'rate-limited':
            return { key: 'notifications.testPushRateLimited' };
        case 'error':
            return { key: 'notifications.testPushFailed' };
        case 'ok':
            if (!result.configured) return { key: 'notifications.testPushNotConfigured' };
            if (result.sent === 0) {
                // every subscription was dead (now pruned) counts as "none"
                return result.total === 0 || result.pruned >= result.total
                    ? { key: 'notifications.testPushNoDevices' }
                    : { key: 'notifications.testPushFailed' };
            }
            return result.failed > 0
                ? { key: 'notifications.testPushSentPartial', params: { sent: result.sent, failed: result.failed } }
                : { key: 'notifications.testPushSent', params: { count: result.sent } };
    }
}

/** A 404 means the server predates the endpoint: keep the button disabled. */
export function testPushUnavailable(result: TestPushResult | null): boolean {
    return result?.kind === 'unsupported';
}
