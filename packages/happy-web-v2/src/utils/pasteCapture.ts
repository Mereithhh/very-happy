/**
 * Earliest possible read of a paste's plain text.
 *
 * Chrome's paste DataTransfer reads the system pasteboard lazily and returns
 * '' once the pasteboard has changed since the paste began. Tools that paste
 * by swapping the pasteboard and synthesizing Cmd+V (Wispr Flow, Raycast,
 * password managers) restore the old contents moments later, so a handler
 * that reads late — and Chrome's own default insertion — can find nothing.
 * Measured 2026-10-16 in the Very Happy PWA on Wispr's second dictation:
 * paste event text/plain len=17 at window capture, then beforeinput
 * insertFromPaste with empty data and no input event.
 *
 * One window capture listener, installed before any app listener, snapshots
 * the text per event so a composer can insert it itself.
 */

const captured = new WeakMap<Event, string>();
let installed = false;

export function installPasteCapture(target: Pick<Window, 'addEventListener'> = window): void {
    if (installed) return;
    installed = true;
    target.addEventListener('paste', (e) => {
        const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
        if (text) captured.set(e, text);
    }, true);
}

/** The paste's plain text: the earliest snapshot, else a late read; null when none. */
export function pastedPlainText(event: Event, data: Pick<DataTransfer, 'getData'> | null | undefined): string | null {
    const text = captured.get(event) || (data?.getData('text/plain') ?? '');
    return text ? text : null;
}

/** Test seam. */
export function resetPasteCaptureForTest(): void {
    installed = false;
}
