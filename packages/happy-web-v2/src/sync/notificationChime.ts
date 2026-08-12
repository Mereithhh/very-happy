/**
 * notificationChime — the single gate every notification sound goes through.
 * Called from BOTH producer lanes (sync.ts on incoming feed notifications,
 * useNotificationGenerator on board lifecycle transitions), so the rules live
 * in exactly one place:
 *
 *  - sound prefs: master switch + per-event toggle (soundPrefs.ts);
 *  - quiet hours: shares the browser-notification DND window;
 *  - self-view: the event's own session/terminal, currently on screen in a
 *    VISIBLE tab, stays silent (you're already looking at it). A hidden tab
 *    always rings — that's the whole point;
 *  - cooldown: the same target+event within 5s plays once. This also folds
 *    the two producer lanes together when they observe the same underlying
 *    event (feed permission_request + board 'permission' transition share
 *    the session-id key).
 */

import { getSoundPrefs } from './soundPrefs';
import { getNotificationPrefs, isWithinQuietHours } from './notificationPrefs';
import { isSameTarget, type SoundEvent } from './notificationInbox';
import { playChime } from '@/utils/chimes';

const COOLDOWN_MS = 5_000;
const lastPlayed = new Map<string, number>();

function isViewingTarget(href: string): boolean {
    if (typeof document === 'undefined' || typeof window === 'undefined') return false;
    if (document.visibilityState !== 'visible') return false; // hidden page → not "viewing"
    return isSameTarget(href, window.location.pathname, window.location.search);
}

export interface ChimeInput {
    event: SoundEvent;
    /** dedup key — session id or `t:<terminalId>` */
    key: string;
    /** the event's target view (self-view suppression) */
    href: string;
}

/** Best-effort: never throws; silently does nothing when gated. */
export function maybePlayNotificationSound(input: ChimeInput): void {
    if (typeof window === 'undefined') return;
    try {
        const prefs = getSoundPrefs();
        if (!prefs.enabled || !prefs.events[input.event]) return;
        if (isWithinQuietHours(getNotificationPrefs())) return;
        if (isViewingTarget(input.href)) return;
        const k = `${input.key}:${input.event}`;
        const now = Date.now();
        const last = lastPlayed.get(k);
        if (last !== undefined && now - last < COOLDOWN_MS) return;
        // bounded: drop expired entries once the map grows past a page of keys
        if (lastPlayed.size > 256) {
            for (const [key, at] of lastPlayed) {
                if (now - at >= COOLDOWN_MS) lastPlayed.delete(key);
            }
        }
        lastPlayed.set(k, now);
        playChime(prefs.voice, prefs.volume);
    } catch {
        // a broken chime must never break message handling
    }
}
