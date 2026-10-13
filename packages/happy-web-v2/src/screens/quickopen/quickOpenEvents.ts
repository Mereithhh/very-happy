/**
 * ⌘P quick open (B-576): programmatic open from the ⌘K palette (the phone
 * entry). Window event, same pattern as openCommandPalette — QuickOpen is
 * mounted by the session page only, so outside a session nothing listens.
 */
const OPEN_EVENT = 'vh:quick-open';
/** CommandPalette's programmatic-open event (mirrored here to avoid importing the palette chunk). */
export const COMMAND_PALETTE_OPEN_EVENT = 'vh:command-palette-open';

export function openQuickOpen(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new Event(OPEN_EVENT));
}

export function onQuickOpen(handler: () => void): () => void {
    window.addEventListener(OPEN_EVENT, handler);
    return () => window.removeEventListener(OPEN_EVENT, handler);
}

/** ⌘P on macOS, Ctrl+P elsewhere — no Shift/Alt (Ctrl+Shift+P stays the browser's). */
export function matchQuickOpenChord(
    e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string },
    isMac: boolean,
): boolean {
    if (e.code !== 'KeyP' || e.altKey || e.shiftKey) return false;
    return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
