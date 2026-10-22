/**
 * B-766 W-fix (QA5 F1) — where a 汇报板 item sits in the transcript.
 *
 * The CLI's `this_turn` anchor is `{ localId, snippet? }`: the localId of the
 * prompt that opened the turn (an Owner message, or a `teams-message-*`
 * notification for a member turn) and the turn's latest reply text when the
 * tool ran (`leadBoard.ts` `thisTurnAnchor`, whitespace-collapsed, clipped with
 * `…`). It never knows the server message id. This one resolver turns either
 * shape into a message id for the 「已上板」 pointer, the 「只看我和负责人」 keep
 * and 「在消息流中定位」 — they must agree, or a pointer sits where the jump
 * never lands.
 *
 * Order: an explicit `messageId` that is loaded; else the prompt with that
 * localId, then within its turn the agent text matching the snippet, else the
 * turn's last agent text, else the prompt itself. Pure; no React, no store.
 */
import type { AttentionItem } from '@slopus/happy-wire';
import type { Message } from '@/sync/typesMessage';
import { opensTurn, renderableAgentText, type ChatRow } from '../chatTurns';

/** An item's anchor as stored: the CLI writes `{ localId, snippet? }`, REST callers may add `messageId`. */
export type BoardAnchor = { localId?: string; messageId?: string; snippet?: string };

/** Whitespace-collapsed, lower-cased, without the clip's trailing ellipsis — the CLI's `clip` shape. */
function flatten(text: string): string {
    return text.replace(/\s+/g, ' ').trim().replace(/…$/, '').trim().toLowerCase();
}

/** `chronological` is old → new (the transcript order). Null when the anchor is not in the loaded history. */
export function resolveBoardAnchor(chronological: readonly Message[], anchor: BoardAnchor | null | undefined): string | null {
    if (!anchor) return null;
    if (anchor.messageId && chronological.some((m) => m.id === anchor.messageId)) return anchor.messageId;
    if (!anchor.localId) return null;
    const at = chronological.findIndex((m) => m.kind === 'user-text' && m.localId === anchor.localId);
    if (at < 0) return null;
    let end = at + 1;
    while (end < chronological.length && !opensTurn(chronological, end, at + 1)) end++;
    const replies = chronological
        .slice(at + 1, end)
        .filter((m): m is Extract<Message, { kind: 'agent-text' }> => m.kind === 'agent-text' && !m.isThinking && renderableAgentText(m));
    const needle = anchor.snippet ? flatten(anchor.snippet) : '';
    const matched = needle ? [...replies].reverse().find((m) => flatten(m.text).includes(needle)) : undefined;
    return (matched ?? replies.at(-1) ?? chronological[at]).id;
}

/** Agent-side items by the message their pointer sits under (oldest first); Owner items never point. */
export function boardAnchors(chronological: readonly Message[], items: readonly AttentionItem[]): ReadonlyMap<string, AttentionItem[]> {
    const out = new Map<string, AttentionItem[]>();
    for (const item of [...items].sort((a, b) => a.createdAt - b.createdAt)) {
        if (item.source === 'owner') continue;
        const id = resolveBoardAnchor(chronological, item.anchor);
        if (!id) continue;
        const list = out.get(id);
        if (list) list.push(item); else out.set(id, [item]);
    }
    return out;
}

/**
 * The messages a transcript row shows — a pointer anchored at any of them sits
 * under that row. A collapsed activity row still counts its folded replies, so
 * an anchor on a mid-turn reply keeps a visible pointer.
 */
export function rowMessageIds(row: ChatRow): string[] {
    if (row.type === 'message') return [row.message.id];
    if (row.type !== 'activity') return [];
    // A held answer (B-615) is one of `messages`; a notification opener is not.
    const ids = row.messages.map((m) => m.id);
    if (row.trigger) ids.push(row.trigger.id);
    return ids;
}
