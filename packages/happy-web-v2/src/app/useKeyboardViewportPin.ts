/**
 * useKeyboardViewportPin — iOS soft-keyboard avoidance for full-height screens.
 *
 * Mechanism: iOS Safari treats the keyboard as an OVERLAY — the layout
 * viewport / 100dvh never shrinks; only window.visualViewport does, and Safari
 * "helps" by panning the page to reveal the focused field. (The
 * `interactive-widget=resizes-content` meta we ship only works on Android
 * Chrome 108+ / Firefox 132+; iOS ignores it as of iOS 26 — WebKit bug 259770.)
 *
 * B-797: the measuring moved to app/viewportVars.ts, which publishes the
 * visible area as `--vv-h` / `--vv-top`, shrinks `--app-h` to it and pins
 * #root to the visual viewport (base.css) — following iOS's pan through CSS
 * variables instead of undoing it with scrollTo (the old inline height +
 * scrollTo(0,0) left the iPhone Duo page draggable into a blank band). This
 * hook locks the document scroll while its screen is mounted and mirrors the
 * keyboard state onto the screen root as `data-keyboard-open` (session.css
 * drops the composer's home-indicator padding; composerSendFocus reads it).
 *
 * Scope guards live in keyboardViewport(): coarse pointer only, pinch zoom
 * ignored, Android's resizes-content never registers as an overlay keyboard.
 */
import { useEffect, type RefObject } from 'react';
import { getKeyboardViewport, subscribeKeyboardViewport, useRootScrollLock } from './viewportVars';

export function useKeyboardViewportPin(ref: RefObject<HTMLElement | null>) {
    useRootScrollLock();
    useEffect(() => {
        let wasOpen = false;
        const apply = (open: boolean) => {
            const el = ref.current;
            if (el) {
                if (open) el.dataset.keyboardOpen = 'true';
                else delete el.dataset.keyboardOpen;
            }
            // Clear any scroll residue iOS's reveal-pan left behind on close.
            if (wasOpen && !open && window.scrollY) window.scrollTo({ top: 0 });
            wasOpen = open;
        };
        apply(getKeyboardViewport().open);
        const off = subscribeKeyboardViewport((kb) => apply(kb.open));
        return () => {
            off();
            if (ref.current) delete ref.current.dataset.keyboardOpen;
        };
    }, [ref]);
}
