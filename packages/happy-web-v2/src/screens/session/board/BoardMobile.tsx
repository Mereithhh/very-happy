/**
 * B-766 W-1 — phones (<768px): a 40px summary strip under the header
 * 「等你 2 · 未结 2 · 新汇报 1 ⌄」 that drops the 汇报板 down as a TOP sheet
 * (the strip is at the top, so the gesture direction matches; DESIGN §3 A).
 * D6: B-1's view toggle shares this row through `trailing`.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ClipboardList } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Segmented } from '@/ui/Segmented';
import { boardCopy } from './boardCopy';
import { boardCounts, type BoardTab } from './boardModel';
import { useBoardItemsOrEmpty, useSeenItemIds } from '@/sync/attentionStore';
import { BoardList } from './BoardList';
import './board.css';

export function BoardMobile({ sessionId, open, onOpenChange, trailing }: {
    sessionId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    trailing?: ReactNode;
}) {
    const { lang } = useTranslation();
    const copy = boardCopy(lang.startsWith('zh'));
    const items = useBoardItemsOrEmpty(sessionId);
    const seen = useSeenItemIds(items);
    const [tab, setTab] = useState<BoardTab>('open');
    const c = boardCounts(items, seen);
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onOpenChange]);
    const sheetId = `brf-sheet-${sessionId}`;
    return (
        <div className={`brf-mobile${open ? ' is-open' : ''}`}>
            <div className="brf-strip">
                <button type="button" className="brf-strip-btn" aria-expanded={open} aria-controls={sheetId}
                    aria-label={`${copy.strip.label}: ${copy.strip.need} ${c.need}, ${copy.strip.asked} ${c.asked}, ${copy.strip.fresh} ${c.fresh}`}
                    onClick={() => onOpenChange(!open)}>
                    <span className={`brf-strip-n${c.need ? ' is-hot' : ''}`}>{copy.strip.need} <b>{c.need}</b></span>
                    <span className={`brf-strip-n${c.asked ? ' is-hot' : ''}`}>{copy.strip.asked} <b>{c.asked}</b></span>
                    <span className="brf-strip-n">{copy.strip.fresh} <b>{c.fresh}</b></span>
                    <span className="brf-strip-grow" />
                    <ChevronDown size={14} className="brf-strip-chev" aria-hidden />
                </button>
                {trailing}
            </div>
            {open && (
                <>
                    <div className="brf-sheet-scrim" onClick={() => onOpenChange(false)} aria-hidden />
                    <div className="brf-sheet" id={sheetId} role="dialog" aria-label={copy.title}>
                        <div className="brf-tabs">
                            <Segmented label={copy.title} value={tab} onChange={setTab}
                                options={[{ value: 'open', label: copy.tabs.open }, { value: 'done', label: copy.tabs.done }]} />
                        </div>
                        <div className="brf-scroll">
                            <BoardList sessionId={sessionId} tab={tab} copy={copy} onLeave={() => onOpenChange(false)} />
                        </div>
                        <button type="button" className="brf-sheet-grab" aria-label={copy.close} onClick={() => onOpenChange(false)}><i /></button>
                    </div>
                </>
            )}
        </div>
    );
}

/** Header button: opens the aside tab (desktop) or the top sheet (phone); badge = 「等你」. */
export function BoardHeaderButton({ sessionId, active, onClick }: { sessionId: string; active: boolean; onClick: () => void }) {
    const { lang } = useTranslation();
    const copy = boardCopy(lang.startsWith('zh'));
    const items = useBoardItemsOrEmpty(sessionId);
    const need = boardCounts(items).need;
    const label = need > 0 ? `${copy.title} · ${copy.badge(need)}` : copy.title;
    return (
        <button type="button" className={`ch-icon brf-hbtn${active ? ' is-active' : ''}`} onClick={onClick}
            aria-label={label} title={label} aria-pressed={active}>
            <ClipboardList size={16} aria-hidden />
            {need > 0 && <span className="brf-hbadge" aria-hidden>{need > 9 ? '9+' : need}</span>}
        </button>
    );
}

