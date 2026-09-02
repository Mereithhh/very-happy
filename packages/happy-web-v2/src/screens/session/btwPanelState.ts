/**
 * Imperative "open the side-question panel" hook for non-hook call sites
 * (the composer's `/btw` interception). Same window-event singleton pattern
 * as ClipboardHistoryPanel / CommandPalette; the detail screen of the target
 * session listens and flips its `?panel=btw` URL state.
 */
const OPEN_EVENT = 'vh:btw-open';

export interface BtwOpenDetail {
    sessionId: string;
    /** non-empty → ask immediately after opening */
    question?: string;
}

export function openBtwPanel(sessionId: string, question?: string): void {
    window.dispatchEvent(new CustomEvent<BtwOpenDetail>(OPEN_EVENT, { detail: { sessionId, question } }));
}

export function onBtwOpen(cb: (detail: BtwOpenDetail) => void): () => void {
    const handler = (event: Event) => {
        const detail = (event as CustomEvent<BtwOpenDetail>).detail;
        if (detail && typeof detail.sessionId === 'string') cb(detail);
    };
    window.addEventListener(OPEN_EVENT, handler);
    return () => window.removeEventListener(OPEN_EVENT, handler);
}
