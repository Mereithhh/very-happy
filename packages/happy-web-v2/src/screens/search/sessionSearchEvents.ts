/**
 * B-865: one search entry. The sidebar 🔍, ⌘⇧F and the release-notes action
 * all open the ⌘K palette (it searches titles AND what was said). Window
 * event, not a store: the palette is a singleton in AppLayout. Kept apart from
 * the palette so callers can import it without pulling the panel in.
 */
import { IS_MAC } from '@/app/appChord';

export const COMMAND_PALETTE_OPEN_EVENT = 'vh:command-palette-open';

/** Open the ⌘K palette (search focused). */
export function openSessionSearch(): void {
    window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
}

/** Chord labels shown next to the entries. */
export const SESSION_SEARCH_HINT = IS_MAC ? '⌘⇧F' : 'Ctrl+Shift+F';
export const COMMAND_PALETTE_HINT = IS_MAC ? '⌘K' : 'Ctrl+K';
