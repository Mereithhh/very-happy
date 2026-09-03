/**
 * Which structured-chat header controls stay on the bar.
 *
 * Unlike the terminal header this one does not overflow — but it does starve
 * the one thing that identifies the conversation: at 360-390px the three rigid
 * 36px icon buttons plus the diagnostic relay pill leave the title 8-12
 * characters. On mobile this header is the ONLY chrome a session has (the
 * sidebar, which owns the session action menu, is unmounted while a session is
 * open), so the fix is the same shape as the terminal's: one "⋯" trigger.
 *
 * Nothing here is a primary toggle the way the terminal's structured-view
 * button is, so on a compact viewport every icon collapses.
 */
export type ChatHeaderActionKey = 'notes' | 'btw' | 'files';

export function planChatHeaderActions(input: {
    compact: boolean;
    /** B-283 `/btw` side-question panel; absent ⇒ this session can't host it. */
    hasBtw: boolean;
    hasFiles: boolean;
}): { inline: ChatHeaderActionKey[]; overflow: ChatHeaderActionKey[] } {
    const available: ChatHeaderActionKey[] = ['notes'];
    if (input.hasBtw) available.push('btw');
    if (input.hasFiles) available.push('files');
    if (!input.compact) return { inline: available, overflow: [] };
    return { inline: [], overflow: available };
}
