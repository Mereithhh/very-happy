import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Bot, ChevronRight } from 'lucide-react';
import { parseTaskNotification } from './harness';
import type { Message } from '@/sync/typesMessage';
import { sameItems } from './rowMemo';
import { useTranslation } from '@/i18n/useTranslation';
import { ActivityMessages } from './ActivityMessages';
import { activityDurationSeconds } from './chatTurns';
import { countRunningSubagentCards, countSubagentCards } from './subagentPills';
import { userAbortedAt } from './subagentAbort';
import { StatusDot } from '@/ui';
import { useElapsedSeconds } from './useElapsed';
import './turnactivity.css';

function activityStart(messages: Message[]): number | null {
    if (messages.length === 0) return null;
    return Math.min(...messages.map((message) => message.createdAt));
}

function TurnActivityViewImpl({
    messages,
    live,
    sessionId,
    durationSeconds,
    trigger,
}: {
    messages: Message[];
    live: boolean;
    sessionId: string;
    durationSeconds?: number;
    /** B-519: the task notification that started this turn. */
    trigger?: Message;
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

    // B-260: a folded turn should still say how many sub-agents ran inside it.
    const subagentCount = useMemo(() => countSubagentCards(messages), [messages]);
    const runningSubagents = useMemo(() => countRunningSubagentCards(messages), [messages]);
    // B-317: a user abort inside this turn ends its sub-agents, whatever their
    // last lifecycle event said (subagentAbort.ts).
    const abortedAt = useMemo(() => userAbortedAt(messages), [messages]);

    const elapsed = useElapsedSeconds(live ? activityStart(messages) : null);
    const duration = live ? elapsed : durationSeconds ?? activityDurationSeconds(messages);
    const notification = trigger?.kind === 'user-text' ? parseTaskNotification(trigger.displayText ?? trigger.text) : null;
    const triggerLabel = notification ? notification.summary ?? t('message.taskNotificationGeneric') : null;

    return (
        <section className={`ta${live ? ' ta--live' : ''}${notification ? ' ta--triggered' : ''}`}>
            <button
                type="button"
                className="ta-head vh-disclosure-trigger"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
                aria-controls={detailId}
            >
                {triggerLabel !== null && (
                    <span className={`ta-trigger${notification?.status === 'failed' ? ' ta-trigger--error' : ''}`} title={triggerLabel}>
                        <Bot size={13} aria-hidden />
                        <span className="ta-trigger-text">
                            {notification?.status === 'failed' ? t('message.taskNotificationFailed', { summary: triggerLabel }) : triggerLabel}
                        </span>
                    </span>
                )}
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
                    <ActivityMessages messages={messages} sessionId={sessionId} stalled={!live} abortedAt={abortedAt} />
                </div>
            )}
        </section>
    );
}

/** B-311: see rowMemo — same rebuilt-array-of-stable-elements shape as
 *  ToolGroupView. */
export const TurnActivityView = memo(TurnActivityViewImpl, (prev, next) => (
    sameItems(prev.messages, next.messages)
    && prev.live === next.live
    && prev.sessionId === next.sessionId
    && prev.durationSeconds === next.durationSeconds
    && prev.trigger === next.trigger
));
