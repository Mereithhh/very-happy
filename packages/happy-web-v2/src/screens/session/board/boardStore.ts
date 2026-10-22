/**
 * B-766 W-1 — per-session 汇报板 items, memory only.
 *
 * Nothing feeds this in production yet: `bySession` stays empty, so no board
 * button, strip or pointer renders (the feature is inert until W0/S-1 land and
 * sync writes here). The DEV harness seeds it with a local example. Owner
 * actions only change local state for now; with S-1 they become the
 * owner-respond call (a choice is also an Owner message, DESIGN §4.4).
 */
import { create } from 'zustand';
import type { AttentionItem } from './attentionTypes';

export interface BoardFocus { sessionId: string; itemId: string; nonce: number }

interface BoardState {
    bySession: Record<string, AttentionItem[]>;
    /** Item ids the Owner has expanded / opened (W-2 moves this to KV `vh.notif-seen.v1` `item:<id>`). */
    seen: ReadonlySet<string>;
    /** Last 「看板 ›」 request: the screen opens the board and the card scrolls into view. */
    focus: BoardFocus | null;
    setItems: (sessionId: string, items: AttentionItem[]) => void;
    clear: (sessionId: string) => void;
    markSeen: (itemId: string) => void;
    focusItem: (sessionId: string, itemId: string) => void;
    choose: (sessionId: string, itemId: string, optionId: string) => void;
    resolve: (sessionId: string, itemId: string) => void;
}

let nonce = 0;

function patch(items: AttentionItem[] | undefined, id: string, change: (item: AttentionItem) => AttentionItem): AttentionItem[] | undefined {
    return items?.map((item) => (item.id === id ? change(item) : item));
}

export const useBoardStore = create<BoardState>((set) => ({
    bySession: {},
    seen: new Set(),
    focus: null,
    setItems: (sessionId, items) => set((s) => ({ bySession: { ...s.bySession, [sessionId]: items } })),
    clear: (sessionId) => set((s) => {
        const next = { ...s.bySession };
        delete next[sessionId];
        return { bySession: next };
    }),
    markSeen: (itemId) => set((s) => (s.seen.has(itemId) ? s : { seen: new Set([...s.seen, itemId]) })),
    focusItem: (sessionId, itemId) => set({ focus: { sessionId, itemId, nonce: ++nonce } }),
    choose: (sessionId, itemId, optionId) => set((s) => {
        const now = Date.now();
        const items = patch(s.bySession[sessionId], itemId, (i) => ({ ...i, state: 'resolved', ownerChoice: optionId, updatedAt: now, resolvedAt: now }));
        return items ? { bySession: { ...s.bySession, [sessionId]: items } } : s;
    }),
    resolve: (sessionId, itemId) => set((s) => {
        const now = Date.now();
        const items = patch(s.bySession[sessionId], itemId, (i) => ({ ...i, state: 'resolved', updatedAt: now, resolvedAt: now }));
        return items ? { bySession: { ...s.bySession, [sessionId]: items } } : s;
    }),
}));

const EMPTY: AttentionItem[] = [];

/** The session's items; `undefined` = this session has no board (button and strip stay hidden). */
export function useBoardItems(sessionId: string): AttentionItem[] | undefined {
    return useBoardStore((s) => s.bySession[sessionId]);
}

export function useBoardItemsOrEmpty(sessionId: string): AttentionItem[] {
    return useBoardStore((s) => s.bySession[sessionId] ?? EMPTY);
}
