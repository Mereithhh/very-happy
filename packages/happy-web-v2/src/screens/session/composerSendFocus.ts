/**
 * B-568 ①: where the composer caret goes after a send.
 *
 * - Desktop always refocuses (clicking Send returns the caret to the textarea).
 * - Touch: a send that went to the agent hands the turn over — the keyboard
 *   would cover the very reply the user now waits for, so put it away
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

export function focusAfterSend(input: { coarse: boolean; hadFocus: boolean; outcome: SendOutcome }): FocusAfterSend {
    if (!input.coarse) return 'focus';
    if (input.outcome === 'sent') return 'blur';
    return input.hadFocus ? 'focus' : 'none';
}
