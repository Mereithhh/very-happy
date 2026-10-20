/**
 * B-655 / B-640: which ↑/↓ presses move a list that is driven from a text
 * field (command palette, QuickOpen, the composer's / list). Only a bare
 * arrow does; with ⌘/Ctrl/Alt/Shift the key is a caret or selection key
 * (⌘↑/⌘↓ = start/end of text on macOS, Shift+↑/↓ = extend selection) and
 * belongs to the field, so the caller must leave it alone (no preventDefault).
 */
export interface ListArrowKeyLike {
    key: string;
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
}

/** +1 for a bare ArrowDown, -1 for a bare ArrowUp, otherwise null (not ours). */
export function listArrowDelta(e: ListArrowKeyLike): 1 | -1 | null {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
    if (e.key === 'ArrowDown') return 1;
    if (e.key === 'ArrowUp') return -1;
    return null;
}
