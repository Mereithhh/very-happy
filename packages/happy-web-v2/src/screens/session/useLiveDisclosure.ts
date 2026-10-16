/**
 * B-612: open/closed state of a thinking block — open while it is the live
 * one (B-101), folded once it stops being live, unless the user toggled it.
 *
 * The fold follows B-607's rule (shouldFoldFinishedTurn): it happens now only
 * when the reader follows the live end or the block is entirely below the
 * viewport. Otherwise it is DEFERRED to the moment the reader follows again
 * (ReaderFollowContext.onRefollow), when the block sits above a bottom-pinned
 * viewport and folding it moves nothing they see.
 *
 * Deferring beats compensating scrollTop for a detached reader: WebKit drops
 * scrollTop writes during momentum scrolling (B-603), and a compensation done
 * outside ChatList's commit double-counts with its prepend anchor.
 */
import { useCallback, useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { shouldFoldFinishedTurn } from './chatFollow';
import { ReaderFollowContext } from './readerFollow';

export function useLiveDisclosure(live: boolean, blockRef: RefObject<HTMLElement | null>): readonly [boolean, () => void] {
    const reader = useContext(ReaderFollowContext);
    const [open, setOpen] = useState(live);
    const userToggledRef = useRef(false);
    const foldPendingRef = useRef(false);
    const wasLiveRef = useRef(live);

    useEffect(() => {
        const was = wasLiveRef.current;
        wasLiveRef.current = live;
        if (userToggledRef.current || was === live) return;
        if (live) {
            foldPendingRef.current = false;
            setOpen(true);
            return;
        }
        const block = blockRef.current;
        const scroller = block?.closest('.cl-scroll') ?? null;
        const fold = shouldFoldFinishedTurn({
            following: reader.isFollowing(),
            panelTop: block && scroller ? block.getBoundingClientRect().top : null,
            viewportBottom: scroller ? scroller.getBoundingClientRect().bottom : 0,
        });
        foldPendingRef.current = !fold;
        if (fold) setOpen(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [live]);

    useEffect(() => reader.onRefollow(() => {
        if (!foldPendingRef.current || userToggledRef.current) return;
        foldPendingRef.current = false;
        setOpen(false);
    }), [reader]);

    const toggle = useCallback(() => {
        userToggledRef.current = true;  // a manual toggle wins over auto open/fold
        foldPendingRef.current = false;
        setOpen((value) => !value);
    }, []);

    return [open, toggle] as const;
}
