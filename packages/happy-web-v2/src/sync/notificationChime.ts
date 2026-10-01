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
 *  - B-525 end-of-turn fold: one finished turn used to ring TWICE, a few
 *    seconds apart and in two near-identical clips (Owner 2026-10-02) — the
 *    feed's `reply_done` ('done') and the board's transition, which lands on
 *    'review'/'blocked' ('question') once the daemon's analyzer has judged the
 *    turn, often more than 5s later. 'done' and 'question' for one target
 *    within END_OF_TURN_FOLD_MS are one event. Permission stays separate.
 *  - B-525 one tab: every open tab (and the PWA) ran this gate on its own and
 *    rang together. A Web Lock held for the cooldown lets exactly one tab of
 *    this origin ring per target+event.
 */

import { getSoundPrefs } from './soundPrefs';
import { getNotificationPrefs, isWithinQuietHours } from './notificationPrefs';
import { isSameTarget, type SoundEvent } from './notificationInbox';
import { playChime } from '@/utils/chimes';
import { playPackSound } from '@/utils/soundPackPlayer';

const COOLDOWN_MS = 5_000;
export const END_OF_TURN_FOLD_MS = 30_000;
const lastPlayed = new Map<string, number>();

/** The dedup key and its window: 'done'/'question' share one end-of-turn slot per target. */
export function chimeSlot(key: string, event: SoundEvent): { slot: string; windowMs: number } {
    return event === 'permission'
        ? { slot: `${key}:permission`, windowMs: COOLDOWN_MS }
        : { slot: `${key}:end-of-turn`, windowMs: END_OF_TURN_FOLD_MS };
}

/**
 * Cross-tab claim: the first tab to take `vh-chime:<slot>` holds it for the
 * window; the others see it held and stay silent. Without Web Locks (old
 * browsers) every tab decides alone, as before.
 */
function claimAcrossTabs(slot: string, windowMs: number, ring: () => void): void {
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    if (!locks?.request) { ring(); return; }
    void locks.request(`vh-chime:${slot}`, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        ring();
        await new Promise((resolve) => setTimeout(resolve, windowMs));
    }).catch(() => {});
}

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
    /** B-469: the underlying inbox category was an error (picks `task.error`
     *  lines in packs that have them; the event stays 'question'). */
    error?: boolean;
}

/** Best-effort: never throws; silently does nothing when gated. */
export function maybePlayNotificationSound(input: ChimeInput): void {
    if (typeof window === 'undefined') return;
    try {
        const prefs = getSoundPrefs();
        if (!prefs.enabled || !prefs.events[input.event]) return;
        if (isWithinQuietHours(getNotificationPrefs())) return;
        if (isViewingTarget(input.href)) return;
        const { slot, windowMs } = chimeSlot(input.key, input.event);
        const now = Date.now();
        const last = lastPlayed.get(slot);
        if (last !== undefined && now - last < windowMs) return;
        // bounded: drop expired entries once the map grows past a page of keys
        if (lastPlayed.size > 256) {
            for (const [key, at] of lastPlayed) {
                if (now - at >= END_OF_TURN_FOLD_MS) lastPlayed.delete(key);
            }
        }
        lastPlayed.set(slot, now);
        claimAcrossTabs(slot, windowMs, () => {
            // B-469: a chosen OpenPeon pack plays its line; if the pack cannot be
            // fetched/decoded right now the chime rings instead — never silence.
            if (prefs.pack) {
                const { voice, volume } = prefs;
                void playPackSound(prefs.pack, input.event, volume, { error: input.error })
                    .then((outcome) => { if (outcome !== 'played') playChime(voice, volume); });
                return;
            }
            playChime(prefs.voice, prefs.volume);
        });
    } catch {
        // a broken chime must never break message handling
    }
}
