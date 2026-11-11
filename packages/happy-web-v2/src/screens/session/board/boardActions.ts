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
import { applyWrapupCheck, attentionBoardLocalId, isAttentionActive, type AttentionItem } from '@slopus/happy-wire';
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
/** Key prefix of the main agent's dispatch-gate decision cards (CLI `assistant/gates/dispatchGate.ts`). */
export const MAIN_AGENT_DISPATCH_KEY_PREFIX = 'main-agent-dispatch:';

export function choiceMessage(item: AttentionItem, optionId: string, copy: BoardCopy): string {
    const base = `${copy.choicePrefix}${item.title} → ${choiceLabel(item, optionId)}`;
    // B-916c (QA80 P3): the wake-up names the approval, so the main agent can call
    // dispatch_approved even after a new conversation / compaction lost the receipt.
    const key = item.key ?? '';
    if (!key.startsWith(MAIN_AGENT_DISPATCH_KEY_PREFIX)) return base;
    return `${base} (dispatch_approved approvalId=${key.slice(MAIN_AGENT_DISPATCH_KEY_PREFIX.length)} boardItemId=${item.id})`;
}

function optimistic(item: AttentionItem, patch: Partial<AttentionItem>): void {
    useAttentionStore.getState().apply({ ...item, ...patch });
}

/** B-921: owner choices need a signed-in login; an old token is told to sign in again, never failed silently. */
export function isReloginRequired(error: unknown): boolean {
    // Read the fields (AttentionApiError shape), not instanceof: the check must hold wherever the error was built.
    const e = error as { status?: unknown; code?: unknown } | null;
    return !!e && typeof e === 'object' && e.status === 403 && e.code === 'owner_login_required';
}

/** Undo the optimistic change (same version, so it replaces), say so, and resync. */
function failed(item: AttentionItem, copy: BoardCopy, error?: unknown): void {
    useAttentionStore.getState().apply(item);
    if (isReloginRequired(error)) toast.action(copy.reloginRequired, () => { window.location.assign('/settings/account'); });
    else toast.error(copy.actionFailed);
    void loadAttentionItems(item.sessionId);
}

export async function chooseOption(item: AttentionItem, optionId: string, copy: BoardCopy): Promise<void> {
    const now = Date.now();
    optimistic(item, { state: 'resolved', ownerChoice: optionId, resolvedBy: 'owner', resolvedAt: now, updatedAt: now });
    try {
        const { item: next } = await respondToAttentionItem(item.id, { action: 'choose', choice: optionId });
        useAttentionStore.getState().apply(next);
    } catch (error) {
        failed(item, copy, error);
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
    } catch (error) {
        failed(item, copy, error);
    }
}

export async function followUp(item: AttentionItem, copy: BoardCopy): Promise<void> {
    quoteMessage(item.sessionId, followUpQuote(item, copy.followUpPrefix));
    if (isAttentionActive(item.state)) return;
    try {
        const { item: next } = await respondToAttentionItem(item.id, { action: 'reopen' });
        useAttentionStore.getState().apply(next);
    } catch (error) {
        failed(item, copy, error);
    }
}

/**
 * B-915: tick / untick one 待确认 entry of a 收尾 card (`owner-respond {check}`).
 * The tick shows at once; a failure puts the card back and says so.
 */
export async function checkWrapupItem(item: AttentionItem, checkId: string, checked: boolean, copy: BoardCopy): Promise<void> {
    const payload = applyWrapupCheck(item.payload, checkId, checked);
    if (!payload) return;
    optimistic(item, { payload, updatedAt: Date.now() });
    try {
        const { item: next } = await respondToAttentionItem(item.id, { action: 'check', checkId, checked });
        useAttentionStore.getState().apply(next);
    } catch (error) {
        useAttentionStore.getState().apply(item);
        if (isReloginRequired(error)) toast.action(copy.reloginRequired, () => { window.location.assign('/settings/account'); });
        else toast.error(copy.wrapup.checkFailed);
        void loadAttentionItems(item.sessionId);
    }
}
