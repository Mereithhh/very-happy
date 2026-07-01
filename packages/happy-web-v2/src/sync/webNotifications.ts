/**
 * webNotifications — web-only foreground browser Notifications for incoming
 * session notification feed items.
 *
 * Companion to webTabTitle.ts (which prefixes the tab title with an unread
 * count). This module raises a real `Notification` when:
 *   - the platform is web and the Notification API exists,
 *   - the user has opted in (notificationPrefs.enabled + per-type + not in DND),
 *   - permission has been granted, AND
 *   - the tab is not currently focused/visible (mirrors Telegram/Discord — no
 *     point interrupting a user who is already looking at the app).
 *
 * Clicking a notification focuses the tab and navigates to the originating
 * session. Notifications are tagged by sessionId so a newer one for the same
 * session replaces the previous (avoids stacking).
 */

import { Platform } from 'react-native';
import { shouldNotify, getNotificationPrefs, setNotificationPrefs } from './notificationPrefs';
import type { NotifType } from './feedTypes';
import { log } from '@/log';

function notificationApiAvailable(): boolean {
    return (
        Platform.OS === 'web' &&
        typeof window !== 'undefined' &&
        typeof Notification !== 'undefined'
    );
}

function isTabFocused(): boolean {
    if (typeof document === 'undefined') return true;
    const visible = document.visibilityState === 'visible';
    const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    return visible && focused;
}

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
    if (!notificationApiAvailable()) return 'unsupported';
    return Notification.permission;
}

/**
 * Ask the browser for Notification permission. Should only be called from a
 * user gesture (e.g. flipping the settings toggle). Returns the resulting
 * permission. On grant we flip the master pref on; on denial we leave it off.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (!notificationApiAvailable()) return 'unsupported';
    try {
        const result = await Notification.requestPermission();
        const prefs = getNotificationPrefs();
        if (result === 'granted') {
            setNotificationPrefs({ ...prefs, enabled: true });
        } else if (prefs.enabled) {
            setNotificationPrefs({ ...prefs, enabled: false });
        }
        return result;
    } catch (e) {
        log.log(`🔔 requestNotificationPermission failed: ${e}`);
        return Notification.permission;
    }
}

// The app layout registers a navigation handler so notification clicks can use
// expo-router instead of a hard page reload. Falls back to window.location.
type Navigator = (sessionId: string) => void;
let navigateToSession: Navigator | null = null;

export function registerNotificationNavigator(fn: Navigator | null): void {
    navigateToSession = fn;
}

function openSession(sessionId: string): void {
    if (typeof window !== 'undefined') {
        try {
            window.focus();
        } catch {
            // ignore — focus is best-effort
        }
    }
    if (navigateToSession) {
        navigateToSession(sessionId);
    } else if (typeof window !== 'undefined') {
        window.location.href = `/session/${sessionId}`;
    }
}

export interface ForegroundNotificationInput {
    type: NotifType;
    sessionId: string;
    title: string;
    body?: string;
}

/**
 * Show a browser Notification for an incoming session notification, subject to
 * the user's preferences and the tab being unfocused. No-op on native / when
 * unsupported / when not permitted. Best-effort: never throws.
 */
export function maybeShowNotification(input: ForegroundNotificationInput): void {
    if (!notificationApiAvailable()) return;
    if (Notification.permission !== 'granted') return;
    if (!shouldNotify(input.type)) return;
    // Only interrupt when the user isn't already looking at the app.
    if (isTabFocused()) return;

    try {
        const notification = new Notification(input.title, {
            body: input.body || undefined,
            tag: input.sessionId,        // replace prior notification for same session
            renotify: false,
        } as NotificationOptions);

        notification.onclick = () => {
            openSession(input.sessionId);
            notification.close();
        };
    } catch (e) {
        log.log(`🔔 maybeShowNotification failed: ${e}`);
    }
}
