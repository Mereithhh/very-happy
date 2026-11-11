import { useRef, type MouseEvent, type PointerEvent, type SyntheticEvent } from 'react';

/**
 * B-928: clicking outside a dialog closes it — but only a real click on the
 * backdrop, and never at the cost of the user's input.
 *
 *  - The press AND the release must both land on the backdrop. A text
 *    selection started inside the card and released outside fires `click` on
 *    the common ancestor (the backdrop); that is not a click outside.
 *  - Once anything in the dialog was edited (an `input`/`change` event, or a
 *    choice in an option/radio/checkbox/switch control), outside clicks are
 *    ignored: Esc and × remain the explicit ways out.
 *  - A press that only dismisses an open popup (picker, suggestions) inside
 *    the dialog does not also close the dialog.
 *
 * `wrapper` families put the handlers on the full-screen backdrop element that
 * contains the card. A native `<dialog>` (showModal) has no element for its
 * ::backdrop — clicks there target the dialog itself, so `dialog` mode also
 * checks the pointer is outside the dialog's box.
 */
export type BackdropMode = 'wrapper' | 'dialog';

interface Box { left: number; top: number; right: number; bottom: number }

export function isOutsideBox(box: Box, x: number, y: number): boolean {
    return x < box.left || x > box.right || y < box.top || y > box.bottom;
}

export function isBackdropHit(mode: BackdropMode, current: Element, target: EventTarget | null, x: number, y: number): boolean {
    if (target !== current) return false;
    return mode === 'wrapper' || isOutsideBox(current.getBoundingClientRect(), x, y);
}

const OPEN_POPUP = '[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"], [role="combobox"][aria-expanded="true"]';
const CHOICE = '[role="option"], [role="radio"], [role="checkbox"], [role="switch"], [role="menuitemradio"], [role="menuitemcheckbox"]';

export function hasOpenPopup(root: Element): boolean {
    return root.querySelector(OPEN_POPUP) !== null;
}

export function isChoiceTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest(CHOICE) !== null;
}

export interface BackdropDismissProps<T extends Element> {
    onPointerDown: (event: PointerEvent<T>) => void;
    onClick: (event: MouseEvent<T>) => void;
    /** capture: the card stops click propagation, choices inside must still count */
    onClickCapture: (event: MouseEvent<T>) => void;
    onInput: (event: SyntheticEvent<T>) => void;
    onChange: (event: SyntheticEvent<T>) => void;
}

/**
 * Spread the result on the backdrop wrapper (or the native `<dialog>`). React
 * events bubble through portals, so pickers portalled out of the card still
 * count as part of the dialog. Pass `onClose` undefined to keep the backdrop
 * inert (e.g. while an import is running).
 */
export function useBackdropDismiss<T extends Element = HTMLElement>(onClose: (() => void) | undefined, mode: BackdropMode = 'wrapper'): BackdropDismissProps<T> {
    const pressed = useRef(false);
    const dirty = useRef(false);
    const markDirty = () => { dirty.current = true; };
    return {
        onPointerDown: (event) => {
            pressed.current = !!onClose && event.button === 0
                && isBackdropHit(mode, event.currentTarget, event.target, event.clientX, event.clientY)
                && !hasOpenPopup(event.currentTarget);
        },
        onClickCapture: (event) => { if (isChoiceTarget(event.target)) markDirty(); },
        onClick: (event) => {
            const outside = pressed.current && isBackdropHit(mode, event.currentTarget, event.target, event.clientX, event.clientY);
            pressed.current = false;
            if (outside && !dirty.current) onClose?.();
        },
        onInput: markDirty,
        onChange: markDirty,
    };
}
