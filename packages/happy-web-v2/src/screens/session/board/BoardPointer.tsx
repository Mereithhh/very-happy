/** B-766 W-1 — the one-line 「已上板 · 决定｜标题  看板 ›」 left in the transcript
 *  where the lead posted an item (design-language §5.9 pointer). Exported for
 *  B-1's 「只看我和负责人」 view, which keeps these pointers. */
import { ChevronRight } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import type { AttentionItem } from '@slopus/happy-wire';
import { boardCopy, kindLabel } from './boardCopy';
import { kindTone } from './boardModel';
import { useAttentionStore } from '@/sync/attentionStore';
import './board.css';

export function BoardPointer({ item, onOpen }: { item: AttentionItem; onOpen: (item: AttentionItem) => void }) {
    const { lang } = useTranslation();
    const copy = boardCopy(lang.startsWith('zh'));
    return (
        <button type="button" className="brf-ptr" onClick={() => onOpen(item)}>
            <span className={`brf-kind brf-kind--${kindTone(item.kind)}`}>{copy.pointer(kindLabel(copy, item.kind))}</span>
            <span className="brf-ptr-title">{item.title}</span>
            <span className="brf-ptr-go">{copy.pointerGo}<ChevronRight size={12} aria-hidden /></span>
        </button>
    );
}

/**
 * Pointers under one transcript row: `items` were resolved to its messages by
 * `boardAnchors` (boardAnchor.ts). `data-board-for` lets 「在消息流中定位」 land
 * here when the anchored reply itself is folded inside an activity row.
 */
export function BoardPointers({ sessionId, items, anchorIds }: { sessionId: string; items: readonly AttentionItem[]; anchorIds: readonly string[] }) {
    if (items.length === 0) return null;
    const open = (item: AttentionItem) => useAttentionStore.getState().focusItem(sessionId, item.id);
    return <div className="brf-ptrs" data-board-for={anchorIds.join(' ')}>{items.map((item) => <BoardPointer key={item.id} item={item} onOpen={open} />)}</div>;
}
