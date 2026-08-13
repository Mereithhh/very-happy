/**
 * systemNotificationDismiss — close the OS-level notification banners this
 * device already raised for a target, once the user actually opens that target.
 *
 * Two producers can have live notifications for one session/terminal:
 *   - foreground `new Notification()` (webNotifications.ts), tagged with the
 *     session id;
 *   - Web Push shown by the service worker (public/push-sw.js), which carries
 *     `data.url` (`/session/<id>` / `/terminal/<m>?tid=<id>`) and no tag.
 * `registration.getNotifications()` returns BOTH (any notification owned by the
 * registration), so one sweep covers both. Matching is pure and tested —
 * `systemNotificationMatchesKey` in notificationSeen.ts.
 *
 * Scope: THIS device only. There is no API to close a banner on another
 * device — a phone whose PWA isn't running can't be told to dismiss anything,
 * so a stale banner may still sit in another device's notification shade. The
 * in-app read state does sync (notificationSeenStore); the OS shade does not.
 */

import { systemNotificationMatchesKey } from '@/sync/notificationSeen';

/**
 * Close every live system notification for `key` on this device.
 * Best-effort and never throws; returns how many were closed.
 */
export async function dismissSystemNotificationsFor(key: string): Promise<number> {
    if (!key) return 0;
    try {
        if (typeof navigator === 'undefined' || !navigator.serviceWorker) return 0;
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration?.getNotifications) return 0;
        const notifications = await registration.getNotifications();
        let closed = 0;
        for (const notification of notifications) {
            if (!systemNotificationMatchesKey(notification, key)) continue;
            notification.close();
            closed++;
        }
        return closed;
    } catch {
        return 0;
    }
}
