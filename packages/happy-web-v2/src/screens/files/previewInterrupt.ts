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
    if (hasBlockingSurface(doc)) return true;
    const active = doc.activeElement;
    return !!active && active !== doc.body && hasText(active);
}

/** An open dialog / sheet a route change would close (the preview's own layer excluded). */
export function hasBlockingSurface(doc: Document): boolean {
    for (const el of Array.from(doc.querySelectorAll(BLOCKING_SURFACES))) {
        if (!el.closest('.fpo-layer')) return true;
    }
    return false;
}

/** The session composer: its text, attachments and comments survive leaving
 *  the page (draft store / attachment stash / per-session MMKV), so it does not
 *  hold a jump — it only delays one while you type (B-918). */
export const COMPOSER_SELECTOR = 'textarea.ci-textarea';

/**
 * B-918: why a jump to another session must wait, if at all.
 *  - 'notice': a dialog is open, or the focused field is NOT the composer and
 *    holds unsent text — leaving would lose it (B-772), so ask instead.
 *  - otherwise go (the composer's draft is kept for when you come back).
 */
export function jumpBlocker(doc: Document): 'notice' | null {
    if (hasBlockingSurface(doc)) return 'notice';
    const active = doc.activeElement;
    if (!active || active === doc.body || active.matches(COMPOSER_SELECTOR)) return null;
    return hasText(active) ? 'notice' : null;
}

/** Quiet period after the last keystroke before a jump may fire, and the cap. */
export const TYPING_QUIET_MS = 2000;
export const TYPING_MAX_WAIT_MS = 10_000;

/**
 * B-918: ms to keep waiting before jumping (0 = go now). You are "typing" if a
 * key went into a text field within the last 2 s; the jump then fires 2 s after
 * you stop, but never later than 10 s after the push arrived.
 */
export function typingHoldMs(now: number, lastKeyAt: number | null, arrivedAt: number): number {
    if (lastKeyAt === null) return 0;
    const quiet = lastKeyAt + TYPING_QUIET_MS - now;
    const cap = arrivedAt + TYPING_MAX_WAIT_MS - now;
    return Math.max(0, Math.min(quiet, cap));
}

function isEditable(el: EventTarget | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) return ['', 'text', 'search', 'url', 'email', 'tel', 'password', 'number'].includes(el.type);
    return el.isContentEditable;
}

let lastKeyAt: number | null = null;
/** When a key last went into a text field (capture-phase, page-wide). */
export function lastTypingAt(): number | null { return lastKeyAt; }
/** Install the keystroke tracker; returns the uninstall function. */
export function trackTyping(doc: Document, now: () => number = Date.now): () => void {
    const onKey = (e: Event) => { if (isEditable(e.target)) lastKeyAt = now(); };
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('input', onKey, true);
    return () => {
        doc.removeEventListener('keydown', onKey, true);
        doc.removeEventListener('input', onKey, true);
    };
}

/** Whether going to `target` leaves the current page (a same-path search
 *  change, e.g. opening the side panel here, is not a move). */
export function leavesPage(target: string | null, pathname: string): boolean {
    if (!target) return false;
    return target.split('?')[0] !== pathname;
}
