/**
 * B-650: open the session search from anywhere (sidebar 🔍, ⌘K). Window event,
 * same pattern as openCommandPalette — the panel is a singleton in AppLayout.
 * Kept apart from the panel so the palette can import it without a cycle.
 */
import { IS_MAC } from '@/app/appChord';

export const SESSION_SEARCH_OPEN_EVENT = 'vh:session-search-open';

export function openSessionSearch(): void {
    window.dispatchEvent(new Event(SESSION_SEARCH_OPEN_EVENT));
}

/** Chord label shown next to the entries. */
export const SESSION_SEARCH_HINT = IS_MAC ? '⌘⇧F' : 'Ctrl+Shift+F';
