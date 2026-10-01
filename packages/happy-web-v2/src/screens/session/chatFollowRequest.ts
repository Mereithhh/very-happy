/**
 * B-520: "the user just sent something — show the bottom". Sending is an
 * explicit act of joining the live end of the conversation, so it overrides
 * the user's scrolled-back position (the near-bottom gate in ChatList is for
 * content the AGENT adds). Two triggers, both landing here:
 *  - `requestChatFollow` from a send site that wants the jump before the
 *    message lands (a picked suggestion: the button vanishes immediately);
 *  - `latestOwnSendKey` changing in ChatList — covers every send path
 *    (composer, queue, retry) without each one having to remember to call.
 */
import type { Message } from '@/sync/typesMessage';

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

export function requestChatFollow(sessionId: string): void {
    for (const listener of listeners.get(sessionId) ?? []) listener();
}

export function onChatFollowRequest(sessionId: string, listener: Listener): () => void {
    let set = listeners.get(sessionId);
    if (!set) listeners.set(sessionId, (set = new Set()));
    set.add(listener);
    return () => {
        set!.delete(listener);
        if (set!.size === 0) listeners.delete(sessionId);
    };
}

/**
 * The newest of THIS client's in-flight user messages (storage order:
 * newest-first). Only our own outbox carries `sendState`, so another device's
 * message never yanks this view. Null when nothing is in flight.
 */
export function latestOwnSendKey(newestFirst: readonly Message[]): string | null {
    for (const message of newestFirst) {
        if (message.kind === 'user-text' && message.sendState === 'sending' && message.localId) return message.localId;
    }
    return null;
}
