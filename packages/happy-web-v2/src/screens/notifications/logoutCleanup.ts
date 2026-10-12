/**
 * B-559: notification state that must not outlive the account on this device.
 * Called from AuthContext.logout — the app-icon badge (and the SW's last
 * reported count) would otherwise keep showing the previous account's unread
 * number, and the device-local "mark unread" overlay belongs to that account.
 */
import { applyAppBadge, type BadgeNavigatorLike } from './appBadge';
import { clearAllUnreadMarks } from '@/sync/notificationUnreadMarksStore';

export function clearNotificationStateOnLogout(
    nav: BadgeNavigatorLike | undefined = typeof navigator !== 'undefined'
        ? (navigator as unknown as BadgeNavigatorLike)
        : undefined,
): void {
    try {
        applyAppBadge(nav, 0); // clearAppBadge + SW count 0
    } catch {
        /* never block sign-out */
    }
    try {
        clearAllUnreadMarks();
    } catch {
        /* never block sign-out */
    }
}
