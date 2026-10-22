/**
 * B-766 — per-session 汇报板 items (W0 `AttentionItem`), memory only.
 *
 * Fed by `GET /v1/attention-items?sessionId=` when a session opens and by the
 * `attention-item` socket update (full snapshot; highest `version` wins). The
 * server flag off / an older server answers 404 → `disabled`, and nothing of
 * the board renders anywhere (no button, strip or pointer).
 */
import { create } from 'zustand';
import { ATTENTION_LIMITS, type AttentionItem } from '@slopus/happy-wire';
import { isAttentionDisabled, listAttentionItems } from './apiAttention';

export interface BoardFocus { sessionId: string; itemId: string; nonce: number }

interface AttentionStoreState {
    /** Server has no board (flag off / older server). */
    disabled: boolean;
    bySession: Record<string, AttentionItem[]>;
    /** Item ids the Owner has expanded / opened (W-2 moves this to KV `vh.notif-seen.v1` `item:<id>`). */
    seen: ReadonlySet<string>;
    /** Last 「看板 ›」 request: the screen opens the board and the card scrolls into view. */
    focus: BoardFocus | null;
    setItems: (sessionId: string, items: AttentionItem[]) => void;
    clear: (sessionId: string) => void;
    apply: (item: AttentionItem) => void;
    markSeen: (itemId: string) => void;
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
    seen: new Set(),
    focus: null,
    setItems: (sessionId, items) => set((s) => ({ bySession: { ...s.bySession, [sessionId]: items } })),
    clear: (sessionId) => set((s) => {
        const next = { ...s.bySession };
        delete next[sessionId];
        return { bySession: next };
    }),
    apply: (item) => set((s) => ({ bySession: { ...s.bySession, [item.sessionId]: mergeItem(s.bySession[item.sessionId], item) } })),
    markSeen: (itemId) => set((s) => (s.seen.has(itemId) ? s : { seen: new Set([...s.seen, itemId]) })),
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

const EMPTY: AttentionItem[] = [];

/** The session's items; `undefined` = not loaded / board off. */
export function useBoardItems(sessionId: string): AttentionItem[] | undefined {
    return useAttentionStore((s) => (s.disabled ? undefined : s.bySession[sessionId]));
}

export function useBoardItemsOrEmpty(sessionId: string): AttentionItem[] {
    return useAttentionStore((s) => s.bySession[sessionId] ?? EMPTY);
}
