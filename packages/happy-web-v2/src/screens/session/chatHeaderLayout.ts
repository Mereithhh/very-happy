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

/**
 * B-795: the header's own width decides compact, not the viewport. A 626px
 * unfolded foldable (or a 630px detail pane beside a sidebar) cleared the old
 * ≥600px viewport test and put five icons, the agent and the relay pill next to
 * a title cut to one character. Below this width the header uses the phone plan.
 */
export const CHAT_HEADER_WIDE_MIN = 720;

export function chatHeaderCompact(headerWidth: number | null, viewportTablet: boolean): boolean {
    return headerWidth === null ? !viewportTablet : headerWidth < CHAT_HEADER_WIDE_MIN;
}

/**
 * B-798 P1-9: a phone header held back, trail, title, agent · machine, relay,
 * 汇报板 and ⋯ — the trail read 「[QA] …」 and the title 「QA走查…」. Below
 * this header width the identity and the relay badge (diagnostics, not
 * navigation) fold into ⋯ as 「会话信息」, leaving 上一级 › 当前 the room.
 */
export const CHAT_HEADER_IDENTITY_MIN = 480;

export function chatHeaderFoldsIdentity(headerWidth: number | null, viewportTablet: boolean): boolean {
    return headerWidth === null ? !viewportTablet : headerWidth < CHAT_HEADER_IDENTITY_MIN;
}
