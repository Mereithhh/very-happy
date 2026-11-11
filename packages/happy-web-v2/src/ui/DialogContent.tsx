import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useOutsideDirtyGuard } from './backdropDismiss';

/**
 * B-928: Radix `Dialog.Content` for the shared dialog shell. A press outside
 * still closes it, except after the user edited something inside (see
 * useOutsideDirtyGuard). Rendered inside Dialog.Portal, so it mounts per open.
 */
export const DialogContent = forwardRef<ElementRef<typeof Dialog.Content>, ComponentPropsWithoutRef<typeof Dialog.Content>>(
    function DialogContent({ onInput, onChange, onClickCapture, onInteractOutside, ...props }, ref) {
        const guard = useOutsideDirtyGuard<HTMLDivElement>();
        return <Dialog.Content
            ref={ref}
            {...props}
            onInput={(e) => { guard.onInput(e); onInput?.(e); }}
            onChange={(e) => { guard.onChange(e); onChange?.(e); }}
            onClickCapture={(e) => { guard.onClickCapture(e); onClickCapture?.(e); }}
            onInteractOutside={(e) => { guard.onInteractOutside(e); onInteractOutside?.(e); }}
        />;
    },
);
