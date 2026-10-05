/**
 * Enter-key policy shared by every multi-line chat composer (main composer,
 * side question, in-place edit, queued-message edit, mirror input). Pure, so
 * the IME and device matrix is unit-tested instead of verified on a phone.
 *
 * Desktop / hardware keyboard, `agentInputEnterToSend` on (default):
 *   Enter → send · Shift+Enter → newline (native) · Cmd/Ctrl/Alt+Enter →
 *   newline (inserted by us: browsers insert nothing for those combos).
 * Desktop, setting off: Enter / Shift+Enter → newline (native) ·
 *   Cmd/Ctrl+Enter → send.
 * Touch-first device (soft keyboard): a phone keyboard has no modifier keys,
 *   so its Return key always inserts a newline (native) and the send button
 *   sends. Cmd/Ctrl+Enter still sends, for tablets with a hardware keyboard.
 *
 * Composition traffic (callers pass `guarded` from `useImeGuard().isGuarded(e)`
 * or `isImeGuardedEvent(e)`) is always `native`: the candidate window owns
 * Enter. Returning `native` (rather than swallowing) on the soft-keyboard path
 * also sidesteps Android keyboards that report Enter as 'Unidentified'/229 —
 * whatever they deliver, the textarea's own newline behavior applies.
 */
export type ComposerEnterAction =
    /** submit the composer; caller must preventDefault */
    | 'send'
    /** insert '\n' at the caret via insertComposerNewline; caller must preventDefault */
    | 'newline'
    /** not ours — let the browser/IME handle the key */
    | 'native';

export interface ComposerKeyLike {
    key: string;
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
}

export function resolveComposerEnter(
    e: ComposerKeyLike,
    opts: {
        /** composition traffic — never act on it */
        guarded: boolean;
        enterToSend: boolean;
        /** touch-first device whose Return key comes from a soft keyboard */
        softKeyboard: boolean;
    },
): ComposerEnterAction {
    if (e.key !== 'Enter' || opts.guarded) return 'native';
    const mod = !!(e.metaKey || e.ctrlKey);
    if (opts.softKeyboard) return mod ? 'send' : 'native';
    if (e.shiftKey) return 'native';
    if (!opts.enterToSend) return mod ? 'send' : 'native';
    return mod || e.altKey ? 'newline' : 'send';
}

/** Touch-first device (no hover, coarse pointer) — its Return key is a soft
 *  keyboard's. Read per call so tests and device-mode switches see the truth. */
export function isSoftKeyboardDevice(): boolean {
    return typeof window !== 'undefined'
        && window.matchMedia?.('(hover: none) and (pointer: coarse)').matches === true;
}

/**
 * Insert a newline at the caret of a (React-controlled) textarea. Prefers
 * execCommand('insertText') so the edit lands on the native undo stack and
 * fires a real input event; falls back to setRangeText + a synthetic input
 * event, which React's value tracker still reports through onChange.
 */
export function insertComposerNewline(ta: HTMLTextAreaElement): void {
    if (document.activeElement !== ta) ta.focus();
    const before = ta.value;
    let inserted = false;
    try {
        inserted = typeof document.execCommand === 'function'
            && document.execCommand('insertText', false, '\n')
            && ta.value !== before;
    } catch {
        inserted = false;
    }
    if (inserted) return;
    const caret = ta.selectionStart + 1;
    ta.setRangeText('\n', ta.selectionStart, ta.selectionEnd, 'end');
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}
