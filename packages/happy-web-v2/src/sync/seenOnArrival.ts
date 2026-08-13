/**
 * seenOnArrival — B-086, the "badge contradicts the self-view" half.
 *
 * A notification whose target is CURRENTLY on screen in a visible tab must
 * not bump the unread badge: the user is literally looking at the thing the
 * badge would tell them to look at. The chime already suppresses itself for
 * this case (notificationChime.isViewingTarget); before this module the READ
 * state did not — the seen stamp only advanced on the tracker's 60s heartbeat
 * or on route exit, so a turn finishing under the user's nose left the badge
 * at +1 for up to a minute (and forever, if the tab was closed before the
 * next stamp — the B-086 stray).
 *
 * Both producer lanes call `stampSeenOnArrival` when an entry is born
 * (useNotificationGenerator for board transitions, sync.ts for feed items).
 * The decisions are pure and tested in notificationSeen.ts
 * (shouldStampOnArrival / arrivalStampAt); this file is only the DOM/store
 * carrier.
 */

import { arrivalStampAt, shouldStampOnArrival } from './notificationSeen';
import { useNotificationSeen } from './notificationSeenStore';

/**
 * Stamp `key` seen iff its target is the visible current view. Safe to call
 * from any producer; no-ops outside the DOM (native / SSR).
 */
export function stampSeenOnArrival(key: string, href: string, createdAt: number): void {
    if (!key || !href) return;
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const visible = document.visibilityState === 'visible';
    if (!shouldStampOnArrival(visible, href, window.location.pathname, window.location.search)) {
        return;
    }
    useNotificationSeen.getState().markSeen([key], arrivalStampAt(Date.now(), createdAt));
}
