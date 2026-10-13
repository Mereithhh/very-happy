/**
 * B-568 ①: where the composer caret goes after a send.
 *
 * - Desktop always refocuses (clicking Send returns the caret to the textarea).
 * - Touch: a send that went to the agent WHILE A SOFT KEYBOARD IS UP hands the
 *   turn over — the keyboard would cover the very reply the user now waits
 *   for, so put it away. A coarse device typing on a hardware keyboard (iPad +
 *   Magic Keyboard, Cmd+Enter) has nothing to dismiss and keeps the caret
 *   (Orca agent-send-keyboard-dismissal, MIT). A QUEUED send keeps the old rule:
 *   people stack several prompts while the agent works, and re-summoning the
 *   keyboard between each costs more than the covered rows. A failed send also
 *   keeps it (the draft is back for a fix-and-retry).
 * - The old touch rule: refocus only when the textarea owned focus before the
 *   send; a refocus outside the gesture stack would leave a focused textarea
 *   with no keyboard that the next tap cannot summon.
 */
export type SendOutcome = 'sent' | 'queued' | 'failed';
export type FocusAfterSend = 'focus' | 'blur' | 'none';

export function focusAfterSend(input: { coarse: boolean; hadFocus: boolean; softKeyboard: boolean; outcome: SendOutcome }): FocusAfterSend {
    if (!input.coarse) return 'focus';
    if (input.outcome === 'sent' && input.hadFocus && input.softKeyboard) return 'blur';
    return input.hadFocus ? 'focus' : 'none';
}

/**
 * Is an on-screen keyboard up? Two existing signals, one per platform:
 * - iOS overlays the keyboard: useKeyboardViewportPin marks the session root
 *   `data-keyboard-open` (visualViewport shorter than the layout viewport);
 *   the raw visualViewport gap is checked too for composers outside `.sd`.
 * - Android resizes the layout viewport (resizes-content): the window becomes
 *   much shorter than the screen's edge for the current orientation.
 * A hardware keyboard produces neither.
 */
export function isSoftKeyboardOpen(s: {
    keyboardOpenAttr: boolean;
    visualHeight: number | null;
    innerWidth: number;
    innerHeight: number;
    screenWidth: number;
    screenHeight: number;
}): boolean {
    if (s.keyboardOpenAttr) return true;
    if (s.visualHeight !== null && s.visualHeight < s.innerHeight - 50) return true;
    const landscape = s.innerWidth > s.innerHeight;
    const edge = landscape ? Math.min(s.screenWidth, s.screenHeight) : Math.max(s.screenWidth, s.screenHeight);
    return edge > 0 && s.innerHeight < edge * 0.75;
}
