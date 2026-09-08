const EVENT = 'vh:message-quote';
export function quoteMessage(sessionId: string, text: string) {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { sessionId, text } }));
}
export function onMessageQuote(sessionId: string, callback: (text: string) => void) {
    const listener = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (detail?.sessionId === sessionId && typeof detail.text === 'string') callback(detail.text);
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
}
