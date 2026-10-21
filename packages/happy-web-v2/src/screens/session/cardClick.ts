/**
 * B-716: a folded card opens its reader from a click anywhere on it — except
 * on its own links/buttons (they do their own thing) and when the click ends a
 * text selection (people copy from cards).
 */
export function cardClickOpens(event: { target: EventTarget | null }, selection: string = typeof window === 'undefined' ? '' : window.getSelection?.()?.toString() ?? ''): boolean {
    if (selection.trim()) return false;
    const target = event.target as Element | null;
    return !target?.closest?.('a, button, input, textarea, select, summary, [role="button"]');
}
