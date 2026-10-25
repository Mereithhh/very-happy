/**
 * B-766 B-1 — 「只看我和负责人」 pieces: the view switch (team context row of
 * a lead session), the folded-run summary row, the owner bubble's 「已答 ↗」
 * chip, and (B-809) the 「回复 成员 A 的提交」 line above a lead reply that a
 * member / system message triggered. Rules live in leadView.ts.
 */
import { createContext, useContext } from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import type { LeadFold, LeadViewMode, TurnOrigin } from './leadView';
import { setLeadView, useLeadView } from './leadViewPrefs';
import { useTranslation } from '@/i18n/useTranslation';
import { foldSummary, leadViewCopy } from './leadViewCopy';
import './leadView.css';

function useLeadViewCopy() {
    return leadViewCopy(useTranslation().lang.startsWith('zh'));
}

/** Owner turn id → its answer's message id, and how to land on it. Null outside a lead session. */
export const LeadAnswerContext = createContext<{ answers: ReadonlyMap<string, string>; jump: (answerId: string) => void } | null>(null);

export function AnsweredChip({ messageId }: { messageId: string }) {
    const ctx = useContext(LeadAnswerContext);
    const copy = useLeadViewCopy();
    const answerId = ctx?.answers.get(messageId);
    if (!ctx || !answerId) return null;
    return <button type="button" className="lv-answered" title={copy.jumpToAnswer} aria-label={`${copy.answered}: ${copy.jumpToAnswer}`} onClick={() => ctx.jump(answerId)}>
        {copy.answered}<ArrowUpRight size={12} aria-hidden />
    </button>;
}

/**
 * `.vh-segmented` markup (ui/Segmented) with a full and a phone label per
 * option. `compact` = the phone labels only (W-1's phone summary strip, D6:
 * one row). B-798 P2-2: it was two bare icons, and touch has no tooltip.
 */
export function LeadViewToggle({ sessionId, compact = false }: { sessionId: string; compact?: boolean }) {
    const copy = useLeadViewCopy();
    const mode = useLeadView(sessionId);
    const option = (value: LeadViewMode, full: string, short: string) => <button type="button" aria-pressed={mode === value} title={full}
        aria-label={compact ? full : undefined} onClick={() => { if (mode !== value) setLeadView(sessionId, value); }}>
        {compact ? <span className="lv-label-compact">{short}</span> : <><span className="lv-label-full">{full}</span><span className="lv-label-short">{short}</span></>}
    </button>;
    return <div role="group" aria-label={copy.label} className={`vh-segmented lv-toggle${compact ? ' lv-toggle--compact' : ''}`}>
        {option('all', copy.all, copy.allShort)}
        {option('owner', copy.owner, copy.ownerShort)}
    </div>;
}

/** B-809: what the lead's reply below answers (the folded run above holds it). */
export function LeadVia({ origin }: { origin: TurnOrigin }) {
    return <div className="lv-via">{useLeadViewCopy().via(origin)}</div>;
}

/** Visible member chips on the summary row; the rest become 「+n」. */
const MAX_SENDERS = 3;

export function LeadFoldRow({ fold, open, onToggle }: { fold: LeadFold; open: boolean; onToggle: () => void }) {
    const copy = useLeadViewCopy();
    if (open) {
        return <button type="button" className="lv-fold lv-fold--open" aria-expanded onClick={onToggle}>
            <ChevronDown size={14} className="lv-fold-chevron" aria-hidden />
            <span>{copy.collapse(fold.rows.length)}</span>
        </button>;
    }
    const shown = fold.senders.slice(0, MAX_SENDERS);
    const more = fold.senders.length - shown.length;
    return <button type="button" className="lv-fold" aria-expanded={false} title={copy.expand} onClick={onToggle}>
        <span className="lv-fold-summary">{foldSummary(fold, copy)}</span>
        {shown.length > 0 && <span className="lv-fold-who">
            {shown.map((name) => <span key={name} className="lv-fold-chip">{name}</span>)}
            {more > 0 && <span className="lv-fold-chip">{copy.moreSenders(more)}</span>}
        </span>}
        <ChevronDown size={14} className="lv-fold-chevron" aria-hidden />
    </button>;
}
