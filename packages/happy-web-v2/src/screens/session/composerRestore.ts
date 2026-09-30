/**
 * B-513: hand the text of a failed message back to the mounted composer of the
 * same session (same pattern as messageQuote.ts). The composer registers while
 * mounted, so the transcript can hide "put back" when there is nowhere to put it.
 */
import { useSyncExternalStore } from 'react';

type Listener = (text: string) => void;

const composers = new Map<string, Set<Listener>>();
const watchers = new Set<() => void>();

function notify() {
    for (const watcher of [...watchers]) watcher();
}

/** Composer side: receive restored text while mounted. */
export function onComposerRestore(sessionId: string, listener: Listener): () => void {
    let set = composers.get(sessionId);
    if (!set) {
        set = new Set();
        composers.set(sessionId, set);
    }
    set.add(listener);
    notify();
    return () => {
        const current = composers.get(sessionId);
        current?.delete(listener);
        if (current && current.size === 0) composers.delete(sessionId);
        notify();
    };
}

export function hasComposer(sessionId: string): boolean {
    return (composers.get(sessionId)?.size ?? 0) > 0;
}

/** Deliver text to the session's composer. Returns false when none is mounted. */
export function restoreToComposer(sessionId: string, text: string): boolean {
    const set = composers.get(sessionId);
    if (!set || set.size === 0) return false;
    for (const listener of [...set]) listener(text);
    return true;
}

function subscribe(callback: () => void) {
    watchers.add(callback);
    return () => { watchers.delete(callback); };
}

export function useHasComposer(sessionId: string): boolean {
    return useSyncExternalStore(subscribe, () => hasComposer(sessionId), () => false);
}

/** The composer's own merge rule for returned text: prepend, keep what is being typed. */
export function mergeRestoredDraft(restored: string, current: string): string {
    return restored && current ? `${restored}\n${current}` : restored || current;
}
