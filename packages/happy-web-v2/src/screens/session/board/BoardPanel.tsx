/** B-766 W-1 — `?panel=board`: the 汇报板 as an aside tab (≥768px). */
import { useState } from 'react';
import { useTranslation } from '@/i18n/useTranslation';
import { useMediaQuery } from '@/app/useMediaQuery';
import { Segmented } from '@/ui/Segmented';
import { boardCopy } from './boardCopy';
import { boardCounts, type BoardTab } from './boardModel';
import { useBoardItemsOrEmpty, useAttentionStore } from '@/sync/attentionStore';
import { BoardList } from './BoardList';
import './board.css';

export function BoardPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const { lang } = useTranslation();
    const copy = boardCopy(lang.startsWith('zh'));
    const items = useBoardItemsOrEmpty(sessionId);
    const seen = useAttentionStore((s) => s.seen);
    const [tab, setTab] = useState<BoardTab>('open');
    // Below 1100px the aside overlays the transcript (session.css): a jump must close it to be seen.
    const inline = useMediaQuery('(min-width: 1100px)');
    const c = boardCounts(items, seen);
    return (
        <div className="brf-panel">
            {/* The workspace tab already says 「汇报板」: tabs + summary share one row. */}
            <div className="brf-tabs">
                <Segmented label={copy.title} value={tab} onChange={setTab}
                    options={[{ value: 'open', label: copy.tabs.open }, { value: 'done', label: copy.tabs.done }]} />
                <span className="brf-head-sum">{copy.summary(c.need, c.asked)}</span>
            </div>
            <div className="brf-scroll">
                <BoardList sessionId={sessionId} tab={tab} copy={copy} onLeave={inline ? undefined : onClose} />
            </div>
        </div>
    );
}
