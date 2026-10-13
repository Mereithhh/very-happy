/**
 * userPresence — B-567, "is a human actually looking?" for AUTO-READ only.
 *
 * Auto-read (useSeenTracker, seenOnArrival) used to trust `visibilityState`
 * alone, so a visible-but-unattended window (second monitor, user away, another
 * app focused) silently retired every notification that arrived meanwhile.
 * Now a stamp needs: visible AND document.hasFocus() AND a trusted input
 * (pointerdown / keydown / wheel / touchstart) within the last 5 minutes.
 * Unknown presence (never any input, hasFocus unavailable) does NOT clear.
 *
 * Idea from Orca's useAutoAckViewedAgent / agent-auto-ack-presence (MIT).
 *
 * This module is the ONLY input-timestamp listener (capture + passive). It is
 * a read-state signal, NOT a resume path: it never touches resumeSync /
 * checkLiveness and registers no focus/visibility listeners (rule 13).
 * `pointermove` is deliberately excluded: Chrome dispatches synthetic mouse
 * moves when content scrolls under a still cursor (streaming autoscroll),
 * which would read an empty chair as present.
 */

/** how long after the last trusted input the user still counts as present */
export const PRESENCE_INPUT_WINDOW_MS = 5 * 60_000;
export const PRESENCE_INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
/** input notifications to subscribers are throttled (lastInputAt is not) */
export const PRESENCE_NOTIFY_THROTTLE_MS = 1_000;

export interface PresenceSnapshot {
    visible: boolean;
    /** document.hasFocus(); null = unavailable (unknown) */
    focused: boolean | null;
    /** last trusted input; null = none seen in this page */
    lastInputAt: number | null;
    now: number;
}

/** Pure: had a trusted input within the window (unknown → false). */
export function hasRecentInput(p: PresenceSnapshot, windowMs: number = PRESENCE_INPUT_WINDOW_MS): boolean {
    if (p.lastInputAt == null) return false;
    const age = p.now - p.lastInputAt;
    return age >= -windowMs && age <= windowMs; // tolerate tiny clock steps backwards
}

/** Pure: visible + focused + recent input. Any unknown → not present. */
export function isUserPresent(p: PresenceSnapshot, windowMs: number = PRESENCE_INPUT_WINDOW_MS): boolean {
    return p.visible && p.focused === true && hasRecentInput(p, windowMs);
}

// ---------------------------------------------------------------------------
// DOM carrier (single listener set for the whole app)
// ---------------------------------------------------------------------------

let lastInputAt: number | null = null;
let lastNotifyAt = -Infinity;
const subscribers = new Set<() => void>();
let uninstall: (() => void) | null = null;

/** Record a trusted input. Exported for the listener and tests. */
export function notePresenceInput(event: Pick<Event, 'isTrusted'>, now: number = Date.now()): void {
    if (!event.isTrusted) return;
    lastInputAt = now;
    if (now - lastNotifyAt < PRESENCE_NOTIFY_THROTTLE_MS) return;
    lastNotifyAt = now;
    for (const cb of [...subscribers]) {
        try {
            cb();
        } catch (error) {
            console.error('[userPresence] subscriber failed', error);
        }
    }
}

/** Install the capture+passive input listeners once (idempotent). */
export function ensurePresenceTracking(target: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined =
    typeof window !== 'undefined' ? window : undefined): void {
    if (uninstall || !target) return;
    const handler = (event: Event) => notePresenceInput(event);
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of PRESENCE_INPUT_EVENTS) target.addEventListener(type, handler, opts);
    uninstall = () => {
        for (const type of PRESENCE_INPUT_EVENTS) target.removeEventListener(type, handler, opts);
    };
}

/** Called (≤1/s) when a trusted input arrives — lets the tracker re-evaluate. */
export function subscribePresenceInput(cb: () => void): () => void {
    subscribers.add(cb);
    return () => {
        subscribers.delete(cb);
    };
}

/** Current snapshot from the DOM. Outside the DOM: not visible, unknown focus. */
export function readPresence(now: number = Date.now()): PresenceSnapshot {
    if (typeof document === 'undefined') return { visible: false, focused: null, lastInputAt, now };
    const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : null;
    return { visible: document.visibilityState === 'visible', focused, lastInputAt, now };
}

export function resetPresenceForTest(): void {
    uninstall?.();
    uninstall = null;
    lastInputAt = null;
    lastNotifyAt = -Infinity;
    subscribers.clear();
}
