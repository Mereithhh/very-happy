/** B-766 W-1 — the one-line 「已上板 · 决定｜标题  看板 ›」 left in the transcript
 *  where the lead posted an item (design-language §5.9 pointer). Exported for
 *  B-1's 「只看我和负责人」 view, which keeps these pointers. */
import { ChevronRight } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import type { AttentionItem } from './attentionTypes';
import { boardCopy } from './boardCopy';
import { kindTone, pointersAt } from './boardModel';
import { useBoardItems, useBoardStore } from './boardStore';
import './board.css';

export function BoardPointer({ item, onOpen }: { item: AttentionItem; onOpen: (item: AttentionItem) => void }) {
    const { lang } = useTranslation();
    const copy = boardCopy(lang.startsWith('zh'));
    return (
        <button type="button" className="brf-ptr" onClick={() => onOpen(item)}>
            <span className={`brf-kind brf-kind--${kindTone(item.kind)}`}>{copy.pointer(copy.kinds[item.kind])}</span>
            <span className="brf-ptr-title">{item.title}</span>
            <span className="brf-ptr-go">{copy.pointerGo}<ChevronRight size={12} aria-hidden /></span>
        </button>
    );
}

/** Pointers for one transcript message; renders nothing when the session has no board. */
export function BoardPointers({ sessionId, messageId }: { sessionId: string; messageId: string }) {
    const items = useBoardItems(sessionId);
    if (!items) return null;
    const here = pointersAt(items, messageId);
    if (here.length === 0) return null;
    const open = (item: AttentionItem) => useBoardStore.getState().focusItem(sessionId, item.id);
    return <div className="brf-ptrs">{here.map((item) => <BoardPointer key={item.id} item={item} onOpen={open} />)}</div>;
}
