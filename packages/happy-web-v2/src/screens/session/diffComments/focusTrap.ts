/**
 * B-554: focus containment for the touch comment sheet (aria-modal dialog).
 * Pure index math so the wrap rule is unit-tested without a DOM.
 */
export const FOCUSABLE_SELECTOR = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab should land, or null to let the browser move normally.
 * `current` is the index of document.activeElement among `count` focusables
 * (-1 = focus is outside the dialog → pull it back in).
 */
export function trapFocusTarget(count: number, current: number, shift: boolean): number | null {
    if (count === 0) return null;
    if (current < 0) return shift ? count - 1 : 0;
    if (shift && current === 0) return count - 1;
    if (!shift && current === count - 1) return 0;
    return null;
}

/** Keys that activate a role="button" element that is not a <button>. */
export function isActivationKey(key: string): boolean {
    return key === 'Enter' || key === ' ' || key === 'Spacebar';
}
