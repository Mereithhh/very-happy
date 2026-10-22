/** B-766 W-1 — one 汇报板 card: kind chip, title, status, meta row; expanded:
 *  body, options (pick = decide), first reply / answer, and the actions. */
import { forwardRef } from 'react';
import { CornerDownLeft, CornerUpRight } from 'lucide-react';
import type { AttentionItem } from '@slopus/happy-wire';
import { kindLabel, type BoardCopy } from './boardCopy';
import { choiceLabel, displayTitle, isLive, itemStatus, kindTone, optionMarker, repliesTo, resolveAction, showsLeadRecommendation } from './boardModel';
import { useMessage } from '@/sync/storage';
import { Markdown } from '../Markdown';

export function boardTime(ts: number): string {
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

export interface BoardCardActions {
    onToggle: (item: AttentionItem) => void;
    onChoose: (item: AttentionItem, optionId: string) => void;
    onResolve: (item: AttentionItem) => void;
    onLocate: (item: AttentionItem) => void;
    onFollowUp: (item: AttentionItem) => void;
}

export const BoardCard = forwardRef<HTMLDivElement, {
    item: AttentionItem;
    all: readonly AttentionItem[];
    copy: BoardCopy;
    expanded: boolean;
    selected: boolean;
    unread: boolean;
    actions: BoardCardActions;
}>(function BoardCard({ item, all, copy, expanded, selected, unread, actions }, ref) {
    const status = itemStatus(item);
    const resolve = resolveAction(item);
    const by = item.source === 'owner' ? copy.you : copy.lead;
    const replies = item.kind === 'question' || item.kind === 'request' ? repliesTo(all, item.id) : [];
    const answering = item.replyToId ? all.find((i) => i.id === item.replyToId) : undefined;
    const bodyId = `brf-x-${item.id}`;
    // W0 keeps only the anchor of the lead's first reply: show its snippet, else the transcript text.
    const firstMsg = useMessage(item.sessionId, item.firstReply?.messageId ?? '');
    const firstText = item.firstReply?.snippet ?? (firstMsg?.kind === 'agent-text' ? firstMsg.text : undefined);
    const firstAt = firstMsg?.createdAt;
    const statusLabel = status ? (status.key === 'decided' && status.choice ? copy.decided(choiceLabel(item, status.choice)) : copy.status[status.key]) : null;
    return (
        <div ref={ref} className={`brf-card${expanded ? ' is-open' : ''}${selected ? ' is-selected' : ''}${status?.tone === 'done' ? ' is-done' : ''}`}
            data-item-id={item.id}>
            {unread && <span className="brf-unread" aria-hidden />}
            <button type="button" className="brf-card-head" aria-expanded={expanded} aria-controls={bodyId} onClick={() => actions.onToggle(item)}>
                <span className="brf-r1">
                    <span className={`brf-kind brf-kind--${kindTone(item.kind)}`}>{kindLabel(copy, item.kind)}</span>
                    <span className="brf-title" title={item.title}>{displayTitle(item.title)}</span>
                    {statusLabel && <span className={`brf-status brf-status--${status!.tone}`}>{statusLabel}</span>}
                </span>
                <span className="brf-r2">
                    <span>{by} · {boardTime(item.createdAt)}</span>
                    {item.inferred && <span className="brf-inferred">{copy.inferred}</span>}
                    {item.repostCount > 0 && <span>{copy.merged(item.repostCount)}</span>}
                    {item.links?.map((l) => <span key={`${l.type}:${l.ref}`} className="brf-link">{l.label ?? l.ref}</span>)}
                </span>
                {item.resolveNote && !isLive(item) && <span className="brf-note">{copy.resolveNote}：{item.resolveNote}</span>}
            </button>
            {expanded && (
                <div className="brf-x" id={bodyId}>
                    {item.bodyMd && <div className="brf-body"><Markdown text={item.bodyMd} /></div>}
                    {item.options && item.options.length > 0 && (
                        <div className="brf-opts" role="group" aria-label={copy.kinds.decision}>
                            {item.options.map((o) => (
                                <button key={o.id} type="button" className={`brf-opt${item.ownerChoice === o.id ? ' is-chosen' : ''}`}
                                    aria-pressed={item.ownerChoice === o.id} disabled={item.state !== 'open' && item.state !== 'in_progress'}
                                    onClick={() => actions.onChoose(item, o.id)}>
                                    {optionMarker(o) && <b className="brf-opt-id">{optionMarker(o)}</b>}
                                    <span className="brf-opt-text">
                                        <span>{o.label}</span>
                                        {o.detail && <span className="brf-opt-detail">{o.detail}</span>}
                                    </span>
                                    {showsLeadRecommendation(item, o) && <span className="brf-opt-rec">{copy.recommended}</span>}
                                </button>
                            ))}
                        </div>
                    )}
                    {item.firstReply && firstText && (
                        <div className="brf-ans">
                            <div className="brf-ans-label">{copy.firstReply}{firstAt ? ` · ${boardTime(firstAt)}` : ''}{item.resolvedBy === 'auto-first-reply' ? ` · ${copy.autoAttached}` : ''}</div>
                            {firstText}
                        </div>
                    )}
                    {replies.map((r) => (
                        <div key={r.id} className="brf-ans">
                            <div className="brf-ans-label">{copy.formalAnswer} · {boardTime(r.createdAt)}</div>
                            {r.title}
                        </div>
                    ))}
                    {replies.length === 0 && item.state === 'in_progress' && (item.kind === 'question' || item.kind === 'request') && (
                        <div className="brf-ans">
                            <div className="brf-ans-label">{item.kind === 'request' ? copy.stillWorking : copy.noAnswerYet}</div>
                            {item.kind === 'request' ? copy.stillWorkingHint : copy.noAnswerYetHint}
                        </div>
                    )}
                    {answering && (
                        <div className="brf-ans">
                            <div className="brf-ans-label">{copy.answers} · {boardTime(answering.createdAt)}</div>
                            {answering.title}
                        </div>
                    )}
                    <div className="brf-acts">
                        {item.anchor && (
                            <button type="button" onClick={() => actions.onLocate(item)}><CornerUpRight size={13} aria-hidden />{copy.locate}</button>
                        )}
                        {resolve && <button type="button" onClick={() => actions.onResolve(item)}>{copy.resolve[resolve]}</button>}
                        <button type="button" onClick={() => actions.onFollowUp(item)}><CornerDownLeft size={13} aria-hidden />{copy.followUp}</button>
                    </div>
                </div>
            )}
        </div>
    );
});
