import type { JSX, ReactNode } from 'react';
import { useBackdropDismiss } from './backdropDismiss';

/**
 * B-928: the full-screen backdrop of the wrapper dialog families (Modal,
 * new-session family, board task). A click on it closes the dialog — pressed
 * and released on the backdrop, nothing edited inside; see backdropDismiss.ts.
 * `onClose` undefined keeps it inert.
 */
export function DialogBackdrop({ className, onClose, children }: { className: string; onClose?: () => void; children: ReactNode }) {
    const dismiss = useBackdropDismiss<HTMLDivElement>(onClose);
    return <div className={className} {...dismiss}>{children}</div>;
}

/**
 * P1-1: like DialogBackdrop but exposes `markDirty` so the caller can mark
 * explicit choice buttons (preset / agent) as edits. Returns [element, markDirty].
 */
export function useDialogBackdrop({ className, onClose, children }: { className: string; onClose?: () => void; children: ReactNode }): [JSX.Element, () => void] {
    const dismiss = useBackdropDismiss<HTMLDivElement>(onClose);
    const { markDirty, ...handlers } = dismiss;
    return [<div className={className} {...handlers}>{children}</div>, markDirty];
}
