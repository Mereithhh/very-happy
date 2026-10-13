/**
 * B-577 touch path: the selection that the message's own action bar offers to
 * quote (no floating button on touch — the system selection menu owns that
 * space). SelectionQuote writes it once the selection has been still for
 * 500ms; the MessageActions whose message contains `source` reads it.
 */
import { useSyncExternalStore, type RefObject } from 'react';

export type TouchQuoteOffer = { source: Element; text: string };

let offer: TouchQuoteOffer | null = null;
const listeners = new Set<() => void>();

export function setTouchQuoteOffer(next: TouchQuoteOffer | null): void {
    if (offer === next || (offer && next && offer.source === next.source && offer.text === next.text)) return;
    offer = next;
    for (const listener of listeners) listener();
}

export function getTouchQuoteOffer(): TouchQuoteOffer | null {
    return offer;
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** The offered text when the selection sits in the message that owns `hostRef`. */
export function useTouchQuoteOffer(hostRef: RefObject<Element | null>): string | null {
    return useSyncExternalStore(subscribe, () => {
        const host = hostRef.current?.closest('.msg-agent-text, .msg-bubble-wrap');
        return offer && host?.contains(offer.source) ? offer.text : null;
    }, () => null);
}
