import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Message } from '@/sync/typesMessage';
import { useTranslation } from '@/i18n/useTranslation';
import { MessageView } from './MessageView';
import { ToolGroupView } from './ToolGroupView';
import { activityDurationSeconds, buildLeafRows } from './chatTurns';
import { countRunningSubagentCards, countSubagentCards } from './subagentPills';
import { StatusDot } from '@/ui';
import { useElapsedSeconds } from './useElapsed';
import './turnactivity.css';

function activityStart(messages: Message[]): number | null {
    if (messages.length === 0) return null;
    return Math.min(...messages.map((message) => message.createdAt));
}

export function TurnActivityView({
    messages,
    live,
    sessionId,
    durationSeconds,
}: {
    messages: Message[];
    live: boolean;
    sessionId: string;
    durationSeconds?: number;
}) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(live);
    const wasLiveRef = useRef(live);
    const detailId = useId();

    // A running turn is transparent by default. The exact live→done transition
    // folds it once; subsequent renders never override a user's history toggle.
    useEffect(() => {
        if (live && !wasLiveRef.current) setExpanded(true);
        if (!live && wasLiveRef.current) setExpanded(false);
        wasLiveRef.current = live;
    }, [live]);

    // Inside a turn, every tool call is its own disclosure row. Grouping them
    // would reintroduce an unnecessary hierarchy and prevent independent folds.
    const rows = useMemo(() => buildLeafRows(messages, null, false, false), [messages]);
    // B-260: a folded turn should still say how many sub-agents ran inside it.
    const subagentCount = useMemo(() => countSubagentCards(messages), [messages]);
    const runningSubagents = useMemo(() => countRunningSubagentCards(messages), [messages]);

    const elapsed = useElapsedSeconds(live ? activityStart(messages) : null);
    const duration = live ? elapsed : durationSeconds ?? activityDurationSeconds(messages);

    return (
        <section className={`ta${live ? ' ta--live' : ''}`}>
            <button
                type="button"
                className="ta-head vh-disclosure-trigger"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
                aria-controls={detailId}
            >
                <span className="ta-title">
                    {t('session.chat.activityElapsed', { seconds: duration })}
                </span>
                {subagentCount > 0 && (
                    <span className={`ta-subagents${runningSubagents > 0 ? ' ta-subagents--live' : ''}`}>
                        {runningSubagents > 0 && <StatusDot status="thinking" size={6} pulse />}
                        {runningSubagents > 0
                            ? t('session.chat.subagentRunningCount', { running: runningSubagents, count: subagentCount })
                            : t('session.chat.subagentCount', { count: subagentCount })}
                    </span>
                )}
                <ChevronRight size={14} className={`tg-chevron${expanded ? ' is-open' : ''}`} />
            </button>
            {expanded && (
                <div id={detailId} className="ta-detail vh-disclosure-panel">
                    {rows.map((row) =>
                        row.type === 'toolgroup' ? (
                            <ToolGroupView key={row.key} tools={row.tools} collapseCompleted />
                        ) : (
                            <MessageView
                                key={row.key}
                                message={row.message}
                                showMeta={false}
                                sessionId={sessionId}
                                thinkingDurationMs={row.thinkingDurationMs}
                            />
                        ),
                    )}
                </div>
            )}
        </section>
    );
}
