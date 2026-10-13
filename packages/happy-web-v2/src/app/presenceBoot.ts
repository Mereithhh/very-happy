/**
 * presenceBoot — B-567 review: start presence tracking at BOOT, not when the
 * first session route mounts.
 *
 *  1. Cold start: the tap on the first sidebar row happens BEFORE any
 *     useSeenTracker effect runs; with lazy install that touch was never
 *     recorded, so a phone opening its first session never auto-read it.
 *  2. Push click: the service worker opens/navigates the window with a
 *     one-shot `vh_presence=1` marker (public/push-sw.js notificationclick).
 *     Tapping a notification IS a human gesture, just not one the page can
 *     see — the marker records one presence input and is stripped from the
 *     URL before the router reads it (replaceState, so Back is unaffected).
 *
 * Imported for its side effect by main.tsx, before the router exists.
 */
import { ensurePresenceTracking, notePresenceInput } from '@/sync/userPresence';

export const PRESENCE_URL_MARKER = 'vh_presence';

/** Pure: does `search` carry the marker, and what is the URL without it? */
export function stripPresenceMarker(search: string): { marked: boolean; search: string } {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    if (!params.has(PRESENCE_URL_MARKER)) return { marked: false, search };
    params.delete(PRESENCE_URL_MARKER);
    const rest = params.toString();
    return { marked: true, search: rest ? `?${rest}` : '' };
}

export function bootPresence(win: Window | undefined = typeof window !== 'undefined' ? window : undefined): void {
    if (!win) return;
    ensurePresenceTracking(win);
    const { marked, search } = stripPresenceMarker(win.location.search);
    if (!marked) return;
    // the notification tap the SW saw — equivalent to one trusted input
    notePresenceInput({ isTrusted: true });
    try {
        win.history.replaceState(win.history.state, '', `${win.location.pathname}${search}${win.location.hash}`);
    } catch {
        /* sandboxed / file: — the marker is harmless in the URL */
    }
}

bootPresence();
