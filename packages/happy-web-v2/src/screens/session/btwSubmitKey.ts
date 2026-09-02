/**
 * Keyboard submit policy for the side-question composer (B-279). Pure, so the
 * IME cases are unit-tested against the real guard instead of on a phone:
 *
 * - Composition traffic (isComposing / key 'Process' / Safari's committing
 *   Enter right after compositionend) NEVER submits — the candidate window owns
 *   Enter. Callers pass `guarded` from `useImeGuard().isGuarded(e)`.
 * - Honors the shared `agentInputEnterToSend` setting exactly as the main
 *   composer's hint promises: Enter sends (Shift+Enter newline), or the reverse.
 */
export type BtwKeyAction = 'submit' | 'newline' | 'ignore';

export function resolveBtwComposerKey(input: {
    key: string;
    shiftKey: boolean;
    /** result of `ime.isGuarded(e)` — composition traffic */
    guarded: boolean;
    enterToSend: boolean;
}): BtwKeyAction {
    if (input.key !== 'Enter') return 'ignore';
    if (input.guarded) return 'ignore';
    const sendCombo = input.enterToSend ? !input.shiftKey : input.shiftKey;
    return sendCombo ? 'submit' : 'newline';
}
