import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useOutsideDirtyGuard, hasOpenPopup } from './backdropDismiss';

/**
 * B-928: Radix `Dialog.Content` for the shared dialog shell. A press outside
 * still closes it, except after the user edited something inside (see
 * useOutsideDirtyGuard) or when a dropdown inside is open (P1-2).
 * Rendered inside Dialog.Portal, so it mounts per open.
 */
export const DialogContent = forwardRef<ElementRef<typeof Dialog.Content>, ComponentPropsWithoutRef<typeof Dialog.Content>>(
    function DialogContent({ onInput, onChange, onClickCapture, onPointerDownOutside, onInteractOutside, ...props }, ref) {
        const guard = useOutsideDirtyGuard<HTMLDivElement>();
        return <Dialog.Content
            ref={ref}
            {...props}
            onInput={(e) => { guard.onInput(e); onInput?.(e); }}
            onChange={(e) => { guard.onChange(e); onChange?.(e); }}
            onClickCapture={(e) => { guard.onClickCapture(e); onClickCapture?.(e); }}
            onPointerDownOutside={(e) => {
                // P1-2: if a dropdown inside is open, prevent closing on outside click.
                // e.currentTarget is the overlay, not the content. The ref may not be attached yet
                // (e.g., in tests), so search from the document: if any .vh-dialog has an open popup, block.
                const contentEl = ref && typeof ref !== 'function' && ref.current
                    ? ref.current
                    : (e.target as Element).ownerDocument?.querySelector('.vh-dialog');
                if (contentEl && hasOpenPopup(contentEl)) {
                    e.preventDefault();
                }
                onPointerDownOutside?.(e);
            }}
            onInteractOutside={(e) => {
                // P1-2: if a dropdown inside is open, clicking outside closes
                // only the dropdown, not the whole dialog. Check this first.
                const contentEl = ref && typeof ref !== 'function' && ref.current
                    ? ref.current
                    : (e.target as Element).ownerDocument?.querySelector('.vh-dialog');
                if (contentEl && hasOpenPopup(contentEl)) {
                    e.preventDefault();
                }
                guard.onInteractOutside(e);
                onInteractOutside?.(e);
            }}
        />;
    },
);
