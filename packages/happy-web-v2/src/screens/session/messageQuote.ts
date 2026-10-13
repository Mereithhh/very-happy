const EVENT = 'vh:message-quote';
/**
 * `append` (default, B-454 whole-message quote): add to the end of the draft.
 * `cursor` (B-577 selection quote): insert at the composer's caret.
 * Listeners that predate `mode` ignore it and append.
 */
export type QuoteMode = 'append' | 'cursor';
export function quoteMessage(sessionId: string, text: string, mode: QuoteMode = 'append') {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { sessionId, text, mode } }));
}
export function onMessageQuote(sessionId: string, callback: (text: string, mode: QuoteMode) => void) {
    const listener = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (detail?.sessionId === sessionId && typeof detail.text === 'string') {
            callback(detail.text, detail.mode === 'cursor' ? 'cursor' : 'append');
        }
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
}
