/**
 * B-607: ChatList tells the rows inside it whether the reader is following
 * the live end, and when they start following again. A row that is about to
 * collapse content on its own (the finished turn's activity folding) asks
 * first, so it never pulls the text out from under someone who scrolled up to
 * read it — and folds later, the moment the reader is back at the live end
 * (then the turn is entirely above a viewport pinned to the bottom).
 *
 * Outside a ChatList (dev harnesses, tests) there is no reader to protect:
 * the default says "following", which keeps the old fold-on-done behaviour.
 */
import { createContext } from 'react';

export type ReaderFollow = {
    isFollowing: () => boolean;
    /** Called on every detached → following edge. Returns the unsubscribe. */
    onRefollow: (listener: () => void) => () => void;
};

export type ReaderFollowSource = ReaderFollow & {
    /** Record the reader's follow state; fires the listeners on a false → true edge. */
    set: (following: boolean) => void;
};

export function createReaderFollow(initial = true): ReaderFollowSource {
    let following = initial;
    const listeners = new Set<() => void>();
    return {
        isFollowing: () => following,
        onRefollow: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        set: (next) => {
            const refollowed = next && !following;
            following = next;
            if (refollowed) for (const listener of [...listeners]) listener();
        },
    };
}

export const ReaderFollowContext = createContext<ReaderFollow>({ isFollowing: () => true, onRefollow: () => () => {} });
