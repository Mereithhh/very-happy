/**
 * B-766 — Owner actions on a 汇报板 card (DESIGN §4.4, W0 owner-respond).
 *
 * - 选项: `owner-respond {choose}` settles the item, then the choice is also an
 *   Owner chat message (the lead gets an ordinary user turn). Its localId comes
 *   from `attentionBoardLocalId` so the server's owner-replied rule skips it.
 * - 知道了 / 标为完成 / 已经答了 / 不用跟了: `owner-respond {resolve}`.
 * - 追问: quotes the item into the composer; a closed item is reopened.
 * The card updates at once; the server snapshot (higher version) replaces it.
 */
import { attentionBoardLocalId, isAttentionActive, type AttentionItem } from '@slopus/happy-wire';
import { sync } from '@/sync/sync';
import { respondToAttentionItem } from '@/sync/apiAttention';
import { loadAttentionItems, useAttentionStore } from '@/sync/attentionStore';
import { toast } from '@/ui/Toast';
import { quoteMessage } from '../messageQuote';
import type { BoardCopy } from './boardCopy';
import { choiceLabel, followUpQuote } from './boardModel';

function nonce(): string {
    return Math.random().toString(36).slice(2, 10);
}

/** The chat line a board choice sends: 「［汇报板 · 决定］<标题> → B. <label>」. */
export function choiceMessage(item: AttentionItem, optionId: string, copy: BoardCopy): string {
    return `${copy.choicePrefix}${item.title} → ${choiceLabel(item, optionId)}`;
}

function optimistic(item: AttentionItem, patch: Partial<AttentionItem>): void {
    useAttentionStore.getState().apply({ ...item, ...patch });
}

/** Undo the optimistic change (same version, so it replaces), say so, and resync. */
function failed(item: AttentionItem, copy: BoardCopy): void {
    useAttentionStore.getState().apply(item);
    toast.error(copy.actionFailed);
    void loadAttentionItems(item.sessionId);
}

export async function chooseOption(item: AttentionItem, optionId: string, copy: BoardCopy): Promise<void> {
    const now = Date.now();
    optimistic(item, { state: 'resolved', ownerChoice: optionId, resolvedBy: 'owner', resolvedAt: now, updatedAt: now });
    try {
        const { item: next } = await respondToAttentionItem(item.id, { action: 'choose', choice: optionId });
        useAttentionStore.getState().apply(next);
    } catch {
        failed(item, copy);
        return;
    }
    try {
        await sync.sendMessage(item.sessionId, choiceMessage(item, optionId, copy), { source: 'chat', localId: attentionBoardLocalId(item.id, nonce()) });
    } catch {
        // The item is already settled server-side; only the message to the lead failed.
        toast.error(copy.choiceNotSent);
    }
}

export async function resolveItem(item: AttentionItem, copy: BoardCopy): Promise<void> {
    const now = Date.now();
    optimistic(item, { state: 'resolved', resolvedBy: 'owner', resolvedAt: now, updatedAt: now });
    try {
        const { item: next } = await respondToAttentionItem(item.id, { action: 'resolve' });
        useAttentionStore.getState().apply(next);
    } catch {
        failed(item, copy);
    }
}

export async function followUp(item: AttentionItem, copy: BoardCopy): Promise<void> {
    quoteMessage(item.sessionId, followUpQuote(item, copy.followUpPrefix));
    if (isAttentionActive(item.state)) return;
    try {
        const { item: next } = await respondToAttentionItem(item.id, { action: 'reopen' });
        useAttentionStore.getState().apply(next);
    } catch {
        failed(item, copy);
    }
}
