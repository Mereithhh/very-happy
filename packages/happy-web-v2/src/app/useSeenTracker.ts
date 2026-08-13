/**
 * useSeenTracker — the WRITER of the synced notification read state.
 *
 * Mounted once at AppLayout level (always alive while authed). It watches the
 * route, decides whether the user is really LOOKING at a notification target
 * (`/session/<id>` or `/terminal/<m>?tid=<t>` — targetKeyOfPath), and stamps
 * `lastSeenAt[key] = now` in notificationSeenStore, which retires every
 * notification for that target that predates the visit — on every device.
 *
 * Three rules make "really looking" honest:
 *
 *  1. DWELL — a route must stay put for `DWELL_MS` before it counts. Without
 *     it a pass-through render (redirects, a mistyped ⌘K jump, back-button
 *     bounces, the board's "next item" hops) would silently mark a target read
 *     the user never saw.
 *  2. VISIBILITY — a hidden tab doesn't count. A backgrounded PWA parked on a
 *     session must not eat that session's notifications; the dwell restarts
 *     when the tab comes back.
 *  3. HEARTBEAT + EXIT — while the target stays open and visible we re-stamp
 *     every `HEARTBEAT_MS`, and once more on leave. That covers notifications
 *     that arrive DURING the visit (you're staring at the session — the chime
 *     already suppresses itself for the self-view, so the badge shouldn't
 *     contradict it), without leaving the "read" edge at the moment of arrival.
 *
 * Writes are monotonic per key (planSeenWrites) and the KV push is debounced,
 * so the heartbeat costs at most one small blob write per interval per tab.
 *
 * Opening a target also dismisses THIS device's live OS banners for it
 * (systemNotificationDismiss — other devices can't be reached, by design).
 */

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { targetKeyOfPath } from '@/sync/notificationSeen';
import { setSeenCredentials, useNotificationSeen } from '@/sync/notificationSeenStore';
import { dismissSystemNotificationsFor } from '@/sync/systemNotificationDismiss';

/** how long a target route must hold still before it counts as "seen" */
export const DWELL_MS = 700;
/** re-stamp cadence while the target stays open and visible */
export const HEARTBEAT_MS = 60_000;

function isVisible(): boolean {
    if (typeof document === 'undefined') return true;
    return document.visibilityState !== 'hidden';
}

export function useSeenTracker(): void {
    const location = useLocation();
    const { credentials } = useAuth();
    const key = targetKeyOfPath(location.pathname, location.search);

    // Load the synced map and keep it fresh across socket gaps: live
    // `kv-batch-update` pushes are wired inside the store; the visibility
    // refresh covers the "laptop slept for an hour" case, where pushes were
    // simply missed. Credentials come from CONTEXT, not the getCurrentAuth
    // global — that one is published from AuthProvider's effect, which runs
    // AFTER this child effect on the first commit (see setSeenCredentials).
    useEffect(() => {
        setSeenCredentials(credentials);
        if (!credentials) return;
        void useNotificationSeen.getState().initialize();
        if (typeof document === 'undefined') return;
        const onVisible = () => {
            if (isVisible()) void useNotificationSeen.getState().refresh();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [credentials]);

    useEffect(() => {
        if (!key) return;

        let dwellTimer: ReturnType<typeof setTimeout> | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        /** did this visit ever count? only then does the exit stamp apply */
        let counted = false;

        const stop = () => {
            if (dwellTimer) {
                clearTimeout(dwellTimer);
                dwellTimer = null;
            }
            if (heartbeat) {
                clearInterval(heartbeat);
                heartbeat = null;
            }
        };

        const mark = () => useNotificationSeen.getState().markSeen([key]);

        const start = () => {
            if (dwellTimer || heartbeat) return;
            dwellTimer = setTimeout(() => {
                dwellTimer = null;
                if (!isVisible()) return;
                counted = true;
                mark();
                // Clear this device's OS banners for the target we just opened.
                void dismissSystemNotificationsFor(key);
                heartbeat = setInterval(() => {
                    if (isVisible()) mark();
                }, HEARTBEAT_MS);
            }, DWELL_MS);
        };

        const onVisibility = () => {
            if (isVisible()) start();
            else stop();
        };

        if (isVisible()) start();
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisibility);
        }

        return () => {
            stop();
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', onVisibility);
            }
            // Exit stamp: everything that arrived during a visit that counted
            // is read too. A route we bounced through (dwell never fired) is
            // deliberately left alone, and so is a route we're leaving while
            // hidden (a programmatic navigation in a background tab is not a
            // human reading anything).
            if (counted && isVisible()) mark();
        };
    }, [key]);
}
