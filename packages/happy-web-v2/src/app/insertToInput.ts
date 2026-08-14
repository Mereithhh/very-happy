/**
 * insertToInput — a tiny window-event channel that lets the notes panel (or
 * anything else) drop text into whatever input the CURRENT route owns:
 * the chat composer (AgentInput) or the web terminal (bracketed paste, never
 * auto-executes). Same singleton pattern as the command palette's open event.
 *
 * dispatchEvent runs listeners synchronously, so the `handled` flag on the
 * detail is readable right after dispatch — the caller can toast when no
 * input is mounted (e.g. on /board).
 */

const INSERT_EVENT = 'vh:insert-to-input';

interface InsertToInputDetail {
    text: string;
    handled: boolean;
}

/** Returns true if some mounted input consumed the text. */
export function requestInsertToInput(text: string): boolean {
    const detail: InsertToInputDetail = { text, handled: false };
    window.dispatchEvent(new CustomEvent<InsertToInputDetail>(INSERT_EVENT, { detail }));
    return detail.handled;
}

/**
 * Subscribe as an insert target. First mounted listener wins (routes are
 * exclusive, so in practice there is at most one). Returns the unsubscriber.
 */
export function onInsertToInput(handler: (text: string) => void): () => void {
    const listener = (e: Event) => {
        const detail = (e as CustomEvent<InsertToInputDetail>).detail;
        if (!detail || detail.handled || detail.text.length === 0) return;
        detail.handled = true;
        handler(detail.text);
    };
    window.addEventListener(INSERT_EVENT, listener);
    return () => window.removeEventListener(INSERT_EVENT, listener);
}
