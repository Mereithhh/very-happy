/**
 * B-766 — per-session 汇报板 items (W0 `AttentionItem`), memory only.
 *
 * Fed by `GET /v1/attention-items?sessionId=` when a session opens and by the
 * `attention-item` socket update (full snapshot; highest `version` wins). The
 * server flag off / an older server answers 404 → `disabled`, and nothing of
 * the board renders anywhere (no button, strip or pointer).
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { ATTENTION_LIMITS, type AttentionItem } from '@slopus/happy-wire';
import { isAttentionDisabled, listAttentionItems } from './apiAttention';
import { isSeenAt, type SeenMap } from './notificationSeen';
import { useNotificationSeen, useSeenMap } from './notificationSeenStore';

export interface BoardFocus { sessionId: string; itemId: string; nonce: number }

interface AttentionStoreState {
    /** Server has no board (flag off / older server). */
    disabled: boolean;
    bySession: Record<string, AttentionItem[]>;
    /** Last 「看板 ›」 request: the screen opens the board and the card scrolls into view. */
    focus: BoardFocus | null;
    setItems: (sessionId: string, items: AttentionItem[]) => void;
    clear: (sessionId: string) => void;
    apply: (item: AttentionItem) => void;
    focusItem: (sessionId: string, itemId: string) => void;
}

let nonce = 0;

/** Insert or replace by id, never going back in `version`. */
export function mergeItem(list: readonly AttentionItem[] | undefined, item: AttentionItem): AttentionItem[] {
    const current = list ?? [];
    const at = current.findIndex((i) => i.id === item.id);
    if (at < 0) return [...current, item];
    if (current[at].version > item.version) return current as AttentionItem[];
    const next = current.slice();
    next[at] = item;
    return next;
}

export const useAttentionStore = create<AttentionStoreState>((set) => ({
    disabled: false,
    bySession: {},
    focus: null,
    setItems: (sessionId, items) => set((s) => ({ bySession: { ...s.bySession, [sessionId]: items } })),
    clear: (sessionId) => set((s) => {
        const next = { ...s.bySession };
        delete next[sessionId];
        return { bySession: next };
    }),
    apply: (item) => set((s) => ({ bySession: { ...s.bySession, [item.sessionId]: mergeItem(s.bySession[item.sessionId], item) } })),
    focusItem: (sessionId, itemId) => set({ focus: { sessionId, itemId, nonce: ++nonce } }),
}));

/** Socket `attention-item` update (sync.ts). */
export function applyAttentionItem(item: AttentionItem): void {
    useAttentionStore.getState().apply(item);
}

const inflight = new Map<string, Promise<void>>();

/** Load one session's items (all states: 「已处理」 needs the closed ones too). */
export function loadAttentionItems(sessionId: string): Promise<void> {
    const store = useAttentionStore.getState();
    if (store.disabled) return Promise.resolve();
    const running = inflight.get(sessionId);
    if (running) return running;
    const work = listAttentionItems({ sessionId, state: 'all', limit: ATTENTION_LIMITS.listMax })
        .then(({ items }) => {
            // Socket snapshots that raced the fetch keep their higher version.
            const live = useAttentionStore.getState().bySession[sessionId];
            useAttentionStore.getState().setItems(sessionId, items.reduce((acc, item) => mergeItem(acc, item), live ?? []));
        })
        .catch((error) => {
            if (isAttentionDisabled(error)) useAttentionStore.setState({ disabled: true });
            // Anything else: keep what we have; the next open retries.
        })
        .finally(() => inflight.delete(sessionId));
    inflight.set(sessionId, work);
    return work;
}

/**
 * All open needs-owner items of the account (DESIGN §6.1: badges / 「需要你」
 * across sessions). Socket updates keep them fresh; this covers app start and
 * resume (sync.onResume).
 */
export function loadNeedsYouItems(): Promise<void> {
    if (useAttentionStore.getState().disabled) return Promise.resolve();
    return listAttentionItems({ state: 'open', limit: ATTENTION_LIMITS.listMax, needsOwner: '1' })
        .then(({ items }) => { for (const item of items) useAttentionStore.getState().apply(item); })
        .catch((error) => { if (isAttentionDisabled(error)) useAttentionStore.setState({ disabled: true }); });
}

// ─── Read state: synced KV `vh.notif-seen.v1`, key `item:<id>` (§6.4) ─────────

export const itemSeenKey = (id: string) => `item:${id}`;

/** Seen = opened at or after its last change; a repost / reopen makes it new again. */
export function seenItemIds(items: readonly AttentionItem[], seen: SeenMap): ReadonlySet<string> {
    const out = new Set<string>();
    for (const item of items) if (isSeenAt(seen, itemSeenKey(item.id), item.updatedAt)) out.add(item.id);
    return out;
}

export function markItemSeen(itemId: string): void {
    useNotificationSeen.getState().markSeen([itemSeenKey(itemId)]);
}

export function useSeenItemIds(items: readonly AttentionItem[]): ReadonlySet<string> {
    const seen = useSeenMap();
    return useMemo(() => seenItemIds(items, seen), [items, seen]);
}

const EMPTY: AttentionItem[] = [];

/** The session's items; `undefined` = not loaded / board off. */
export function useBoardItems(sessionId: string): AttentionItem[] | undefined {
    return useAttentionStore((s) => (s.disabled ? undefined : s.bySession[sessionId]));
}

export function useBoardItemsOrEmpty(sessionId: string): AttentionItem[] {
    return useAttentionStore((s) => s.bySession[sessionId] ?? EMPTY);
}
