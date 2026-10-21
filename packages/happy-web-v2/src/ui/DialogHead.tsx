import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '@/text';

/**
 * B-728 (UI-P1-05): the one dialog title row — title (+ description) on the
 * left, a ghost × pinned top-right. Pairs with `.vh-dialog` / `.vh-dialog-foot`
 * in styles/dialog.css. Radix dialogs build the same row from Dialog.Title /
 * Dialog.Close with the same classes.
 */
const FIRST_FIELD = ':is(textarea, input:not([type="hidden"], [type="checkbox"], [type="radio"]), select):not(:disabled)';

/**
 * B-728 (UI-P1-03): a dialog opened from a menu or a ＋ left focus on the
 * trigger behind it. On open, move focus inside: the first field on a fine
 * pointer (§6 default focus), the card itself on touch (no surprise keyboard).
 * A field that already took focus (autoFocus) is left alone.
 */
export function moveFocusIntoDialog(card: HTMLElement | null, finePointer: boolean): void {
    if (!card || card.contains(document.activeElement)) return;
    const field = finePointer ? card.querySelector<HTMLElement>(FIRST_FIELD) : null;
    if (field) { field.focus(); return; }
    if (!card.hasAttribute('tabindex')) card.tabIndex = -1;
    card.focus({ preventScroll: true });
}

export function DialogHead({ title, description, onClose, titleId, closeLabel }: {
    title: ReactNode;
    description?: ReactNode;
    /** Omit for dialogs that must not be dismissed from the corner (e.g. a running import). */
    onClose?: () => void;
    titleId?: string;
    closeLabel?: string;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const id = requestAnimationFrame(() => moveFocusIntoDialog(ref.current?.closest<HTMLElement>('.vh-dialog') ?? null, window.matchMedia?.('(pointer: fine)').matches ?? true));
        return () => cancelAnimationFrame(id);
    }, []);
    return (
        <div className="vh-dialog-head" ref={ref}>
            <div>
                <h2 className="vh-dialog-title" id={titleId}>{title}</h2>
                {description ? <p className="vh-dialog-description">{description}</p> : null}
            </div>
            {onClose && (
                <button type="button" className="vh-dialog-close" aria-label={closeLabel ?? t('common.close')} onClick={onClose}>
                    <X size={18} aria-hidden />
                </button>
            )}
        </div>
    );
}
