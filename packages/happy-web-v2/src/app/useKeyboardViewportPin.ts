/**
 * useKeyboardViewportPin — iOS soft-keyboard avoidance for full-height screens.
 *
 * Mechanism: iOS Safari treats the keyboard as an OVERLAY — the layout
 * viewport / 100dvh never shrinks; only window.visualViewport does, and Safari
 * "helps" by panning the page to reveal the focused field. (The
 * `interactive-widget=resizes-content` meta we ship only works on Android
 * Chrome 108+ / Firefox 132+; iOS ignores it as of iOS 26 — WebKit bug 259770.)
 * For a flex-column screen with an in-flow composer footer this means: the
 * message list believes it still has full height (its bottom half is under the
 * keyboard, scrollToBottom lands beneath it), and the pan pushes the header
 * off-screen and often leaves a stale scroll offset after the keyboard closes.
 *
 * Fix: while the keyboard is up, pin the screen root's height to
 * visualViewport.height so the whole layout (header + list + composer) fits in
 * the VISIBLE area, and undo Safari's pan. On close, release the pin and zero
 * the scroll residue.
 *
 * Scope guards:
 *  - coarse-pointer only (desktop untouched);
 *  - Android's resizes-content keeps vv.height ≈ innerHeight → the pin simply
 *    never engages there;
 *  - pinch zoom also shrinks vv.height but sets scale > 1 → ignored;
 *  - only `resize` is observed (not vv `scroll`): reacting to vv scroll and
 *    calling scrollTo from it fights iOS's own pan in a feedback loop.
 */
import { useEffect, type RefObject } from 'react';

const IS_COARSE_POINTER =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

export function useKeyboardViewportPin(ref: RefObject<HTMLElement | null>) {
    useEffect(() => {
        if (!IS_COARSE_POINTER) return;
        const vv = window.visualViewport;
        if (!vv) return;
        let pinned = false;
        const onResize = () => {
            const el = ref.current;
            if (!el) return;
            if ((vv.scale ?? 1) > 1.001) return; // pinch zoom, not a keyboard
            if (vv.height < window.innerHeight - 50) {
                pinned = true;
                el.style.height = `${Math.round(vv.height)}px`;
                el.dataset.keyboardOpen = 'true';
                // Undo Safari's reveal-pan next frame (after it settles) so the
                // now-fitting layout starts at the top of the visual viewport.
                requestAnimationFrame(() => window.scrollTo(0, 0));
            } else if (pinned) {
                pinned = false;
                el.style.height = '';
                delete el.dataset.keyboardOpen;
                window.scrollTo({ top: 0 }); // clear iOS's leftover pan offset
            }
        };
        vv.addEventListener('resize', onResize);
        return () => {
            vv.removeEventListener('resize', onResize);
            if (ref.current) {
                ref.current.style.height = '';
                delete ref.current.dataset.keyboardOpen;
            }
        };
    }, [ref]);
}
