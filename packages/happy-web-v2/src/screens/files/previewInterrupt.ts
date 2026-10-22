/**
 * B-772 (QA4 O1): a pushed preview (B-526) must not yank the user away while
 * they are in the middle of something — the route change unmounted an open
 * 新建团队 dialog and lost what was typed. When a push would move you to
 * another page and you are busy, it becomes a clickable notice instead.
 */

/** Open dialogs / sheets that a route change would close. The preview's own
 *  overlay (`.fpo-panel`) does not count: a newer push replaces it anyway. */
const BLOCKING_SURFACES = '[role="dialog"], [role="alertdialog"], dialog[open], .vh-picker-sheet';

function hasText(el: Element): boolean {
    if (el instanceof HTMLTextAreaElement) return el.value.trim() !== '';
    if (el instanceof HTMLInputElement) {
        const textual = ['', 'text', 'search', 'url', 'email', 'tel', 'password', 'number'];
        return textual.includes(el.type) && el.value.trim() !== '';
    }
    return el instanceof HTMLElement && el.isContentEditable && (el.textContent ?? '').trim() !== '';
}

/** True while an interrupting navigation would lose or disrupt user work: a
 *  dialog/sheet is open, or the focused field holds unsent text. */
export function userIsBusy(doc: Document): boolean {
    for (const el of Array.from(doc.querySelectorAll(BLOCKING_SURFACES))) {
        if (!el.closest('.fpo-layer')) return true;
    }
    const active = doc.activeElement;
    return !!active && active !== doc.body && hasText(active);
}

/** Whether going to `target` leaves the current page (a same-path search
 *  change, e.g. opening the side panel here, is not a move). */
export function leavesPage(target: string | null, pathname: string): boolean {
    if (!target) return false;
    return target.split('?')[0] !== pathname;
}
