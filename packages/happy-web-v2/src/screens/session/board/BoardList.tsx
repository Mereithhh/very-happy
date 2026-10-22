/** B-766 W-1 — the three groups of the 汇报板 (aside panel and phone top sheet share it). */
import { useEffect, useRef, useState } from 'react';
import { requestChatJump } from '@/screens/search/chatJump';
import type { AttentionItem } from '@slopus/happy-wire';
import type { BoardCopy } from './boardCopy';
import { buildBoard, isUnread, type BoardTab } from './boardModel';
import { chooseOption, followUp, resolveItem } from './boardActions';
import { useBoardItemsOrEmpty, useAttentionStore } from '@/sync/attentionStore';
import { BoardCard, type BoardCardActions } from './BoardCard';

export function BoardList({ sessionId, tab, copy, onLeave }: {
    sessionId: string;
    tab: BoardTab;
    copy: BoardCopy;
    /** The board covers the transcript here (phone sheet, overlay aside): get out of the way before a jump / quote. */
    onLeave?: () => void;
}) {
    const items = useBoardItemsOrEmpty(sessionId);
    const seen = useAttentionStore((s) => s.seen);
    const focus = useAttentionStore((s) => s.focus);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const [selected, setSelected] = useState<string | null>(null);
    const cards = useRef(new Map<string, HTMLDivElement>());

    // 「看板 ›」 from the transcript: select, expand and bring the card into view.
    useEffect(() => {
        if (!focus || focus.sessionId !== sessionId) return;
        setSelected(focus.itemId);
        setExpanded((prev) => new Set([...prev, focus.itemId]));
        useAttentionStore.getState().markSeen(focus.itemId);
        const raf = requestAnimationFrame(() => cards.current.get(focus.itemId)?.scrollIntoView({ block: 'nearest' }));
        return () => cancelAnimationFrame(raf);
    }, [focus, sessionId]);

    const actions: BoardCardActions = {
        onToggle: (item) => {
            setSelected(item.id);
            setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                return next;
            });
            useAttentionStore.getState().markSeen(item.id);
        },
        onChoose: (item, optionId) => void chooseOption(item, optionId, copy),
        onResolve: (item) => void resolveItem(item, copy),
        onLocate: (item: AttentionItem) => {
            const a = item.anchor;
            if (!a) return;
            onLeave?.();
            // Same landing as 「已答 ↗」 (B-1): data-message-id, else the turn prompt; `flash` tints it.
            requestChatJump(sessionId, { terms: [], messageId: a.messageId ?? undefined, localId: a.localId ?? undefined, flash: true });
        },
        onFollowUp: (item) => {
            onLeave?.();
            void followUp(item, copy);
        },
    };

    return (
        <div className="brf-list">
            {buildBoard(items, tab).map((section) => (
                <section key={section.group} className="brf-group" aria-label={copy.groups[section.group]}>
                    <div className="brf-group-head">
                        <span>{copy.groups[section.group]}</span>
                        {/* 「进行中」 counts what is still open; 「已处理」 counts what is listed. */}
                        {(tab === 'done' ? section.items.length : section.liveCount) > 0 && <span className="brf-group-count">{tab === 'done' ? section.items.length : section.liveCount}</span>}
                        <span className="brf-group-line" aria-hidden />
                    </div>
                    {section.items.length === 0
                        ? <div className="brf-empty">{tab === 'done' ? copy.emptyDone : copy.emptyOpen}</div>
                        : section.items.map((item) => (
                            <BoardCard key={item.id} item={item} all={items} copy={copy}
                                ref={(el) => { if (el) cards.current.set(item.id, el); else cards.current.delete(item.id); }}
                                expanded={expanded.has(item.id)} selected={selected === item.id}
                                unread={isUnread(item, seen)} actions={actions} />
                        ))}
                </section>
            ))}
        </div>
    );
}
