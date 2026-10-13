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
 *  2. PRESENCE (B-567, was: visibility) — a hidden tab doesn't count, and
 *     neither does a visible one nobody is at: counting and heartbeats need
 *     visible + document.hasFocus() + a trusted input within 5 min
 *     (sync/userPresence). A dwell that elapses without presence waits for
 *     the next trusted input and restarts; a heartbeat missed for absence is
 *     made up on the next input. Exit stamps need a recent input. Phones are
 *     unaffected in practice: the tap that opened the session is the input.
 *  3. HEARTBEAT + EXIT — while the target stays open and visible we re-stamp
 *     every `HEARTBEAT_MS`, and once more on leave. That covers notifications
 *     that arrive DURING the visit (you're staring at the session — the chime
 *     already suppresses itself for the self-view, so the badge shouldn't
 *     contradict it), without leaving the "read" edge at the moment of arrival.
 *     (Arrivals for the self-view are additionally stamped instantly at the
 *     producer — seenOnArrival.ts — so the badge doesn't wait a heartbeat.)
 *  4. GOING AWAY still stamps (B-086) — a counted visit that ends by the tab
 *     going hidden or being torn down (pagehide) writes one last stamp AT THAT
 *     MOMENT. Before this, only an in-app route change wrote the exit stamp,
 *     so "watch the turn finish, close the tab" left that notification unread
 *     forever on every device. The stamp carries the going-away instant, so
 *     anything arriving later stays unread — hidden tabs still can't eat
 *     notifications. The decision table is pure: shouldStampVisit.
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
import { shouldStampVisit, targetKeyOfPath, type VisitPresence } from '@/sync/notificationSeen';
import { ensurePresenceTracking, hasRecentInput, isUserPresent, readPresence, subscribePresenceInput } from '@/sync/userPresence';
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

/** B-567: the human signals for the stamp table, read at event time. */
function visitPresence(): VisitPresence {
    const p = readPresence();
    return { visible: isVisible(), present: isUserPresent(p), recentInput: hasRecentInput(p) };
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
        ensurePresenceTracking();

        let dwellTimer: ReturnType<typeof setTimeout> | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        /** did this visit ever count? only then does the exit stamp apply */
        let counted = false;
        /** B-567: a heartbeat skipped because nobody was there — made up on the next input */
        let missedBeat = false;

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
                // B-567: not present → wait; the next trusted input restarts the dwell
                if (!shouldStampVisit('dwell-elapsed', counted, visitPresence())) return;
                counted = true;
                mark();
                // Clear this device's OS banners for the target we just opened.
                void dismissSystemNotificationsFor(key);
                heartbeat = setInterval(() => {
                    if (shouldStampVisit('heartbeat', counted, visitPresence())) {
                        mark();
                        missedBeat = false;
                    } else {
                        missedBeat = true;
                    }
                }, HEARTBEAT_MS);
            }, DWELL_MS);
        };

        const onVisibility = () => {
            const visible = isVisible();
            // B-086: the instant a counted visit goes hidden is the last
            // moment the user was really looking — stamp it, or a turn that
            // finished just before backgrounding stays unread forever.
            if (shouldStampVisit('went-hidden', counted, visitPresence())) mark();
            if (visible) start();
            else stop();
        };

        // B-086: tab close / unload never runs the effect cleanup, so a
        // counted, still-visible visit gets its exit stamp here instead.
        // The KV push is debounced and may not beat the teardown; the stamp
        // still lands in the local mirror synchronously and is published on
        // this device's next refresh() (the store's offline-reads path).
        const onPageHide = () => {
            if (shouldStampVisit('pagehide', counted, visitPresence())) mark();
        };

        // B-567: a trusted input is the moment presence can become true —
        // start the dwell a non-present visit skipped, or make up a missed
        // heartbeat. Read-state only: no focus/visibility recovery here.
        const onPresenceInput = () => {
            if (!isVisible()) return;
            if (!counted) {
                start();
            } else if (missedBeat && shouldStampVisit('heartbeat', counted, visitPresence())) {
                mark();
                missedBeat = false;
            }
        };
        const offPresence = subscribePresenceInput(onPresenceInput);

        if (isVisible()) start();
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisibility);
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', onPageHide);
        }

        return () => {
            stop();
            offPresence();
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', onVisibility);
            }
            if (typeof window !== 'undefined') {
                window.removeEventListener('pagehide', onPageHide);
            }
            // Exit stamp: everything that arrived during a visit that counted
            // is read too. A route we bounced through (dwell never fired) is
            // deliberately left alone, and so is a route we're leaving while
            // hidden (a programmatic navigation in a background tab is not a
            // human reading anything).
            if (shouldStampVisit('route-exit', counted, visitPresence())) mark();
        };
    }, [key]);
}
