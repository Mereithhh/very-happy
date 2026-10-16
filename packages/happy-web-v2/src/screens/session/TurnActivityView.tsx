import { memo, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
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
import { shouldFoldFinishedTurn } from './chatFollow';
import { ReaderFollowContext } from './readerFollow';
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
    abortedAt: liftedAbortedAt,
    holdsAnswer = false,
}: {
    messages: Message[];
    live: boolean;
    sessionId: string;
    durationSeconds?: number;
    /** B-519: the task notification that started this turn. */
    trigger?: Message;
    /** B-578: set when the turn's stop line was lifted out of `messages`. */
    abortedAt?: number;
    /** B-615: the turn's answer is still inside this row (chatTurns `keepLastTurnOpen`). */
    holdsAnswer?: boolean;
}) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(live);
    const wasLiveRef = useRef(live);
    const detailId = useId();
    const detailRef = useRef<HTMLDivElement>(null);
    const reader = useContext(ReaderFollowContext);
    // B-607: the live→done fold was skipped for a detached reader; it runs when
    // they follow the live end again, unless they toggled this turn by hand.
    const foldPendingRef = useRef(false);

    // A running turn is transparent by default. The exact live→done transition
    // folds it once; subsequent renders never override a user's history toggle.
    // B-607: not while the reader is reading it — folding pulled the text out
    // from under them and, on a live→done→live flicker, left them at the
    // start of the turn (the top, when the turn is the whole transcript).
    useEffect(() => {
        if (live && !wasLiveRef.current) {
            foldPendingRef.current = false;
            setExpanded(true);
        }
        if (!live && wasLiveRef.current) {
            const fold = foldsAwayFromReader(detailRef.current, reader.isFollowing);
            foldPendingRef.current = !fold;
            if (fold) setExpanded(false);
        }
        wasLiveRef.current = live;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [live]);
    // Back at the live end, the turn sits entirely above a bottom-pinned
    // viewport: folding it now moves nothing the reader sees.
    // B-615: not while the answer is still inside this row — folding would
    // hide it until ChatList lifts it out once the scroll settles. The fold
    // runs when the answer leaves (below), the reader still following.
    const holdsAnswerRef = useRef(holdsAnswer);
    holdsAnswerRef.current = holdsAnswer;
    useEffect(() => reader.onRefollow(() => {
        if (!foldPendingRef.current || holdsAnswerRef.current) return;
        foldPendingRef.current = false;
        setExpanded(false);
    }), [reader]);
    useEffect(() => {
        if (holdsAnswer || !foldPendingRef.current || !reader.isFollowing()) return;
        foldPendingRef.current = false;
        setExpanded(false);
    }, [holdsAnswer, reader]);

    // B-260: a folded turn should still say how many sub-agents ran inside it.
    const subagentCount = useMemo(() => countSubagentCards(messages), [messages]);
    const runningSubagents = useMemo(() => countRunningSubagentCards(messages, liftedAbortedAt), [messages, liftedAbortedAt]);
    // B-317: a user abort inside this turn ends its sub-agents, whatever their
    // last lifecycle event said (subagentAbort.ts).
    const abortedAt = useMemo(() => liftedAbortedAt ?? userAbortedAt(messages), [liftedAbortedAt, messages]);

    const elapsed = useElapsedSeconds(live ? activityStart(messages) : null);
    const duration = live ? elapsed : durationSeconds ?? activityDurationSeconds(messages);
    const notification = trigger?.kind === 'user-text' ? parseTaskNotification(trigger.displayText ?? trigger.text) : null;
    const triggerLabel = notification ? notification.summary ?? t('message.taskNotificationGeneric') : null;

    return (
        <section className={`ta${live ? ' ta--live' : ''}${notification ? ' ta--triggered' : ''}`}>
            <button
                type="button"
                className="ta-head vh-disclosure-trigger"
                onClick={() => {
                    foldPendingRef.current = false; // a manual toggle wins over the deferred fold
                    setExpanded((value) => !value);
                }}
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
                <div id={detailId} ref={detailRef} className="ta-detail vh-disclosure-panel">
                    <ActivityMessages messages={messages} sessionId={sessionId} stalled={!live} abortedAt={abortedAt} />
                </div>
            )}
        </section>
    );
}

/** B-607: may the finished turn fold now without moving what the reader is looking at? */
function foldsAwayFromReader(panel: HTMLElement | null, isFollowing: () => boolean): boolean {
    const scroller = panel?.closest('.cl-scroll') ?? null;
    return shouldFoldFinishedTurn({
        following: isFollowing(),
        panelTop: panel && scroller ? panel.getBoundingClientRect().top : null,
        viewportBottom: scroller ? scroller.getBoundingClientRect().bottom : 0,
    });
}

/** B-311: see rowMemo — same rebuilt-array-of-stable-elements shape as
 *  ToolGroupView. */
export const TurnActivityView = memo(TurnActivityViewImpl, (prev, next) => (
    sameItems(prev.messages, next.messages)
    && prev.live === next.live
    && prev.sessionId === next.sessionId
    && prev.durationSeconds === next.durationSeconds
    && prev.trigger === next.trigger
    && prev.abortedAt === next.abortedAt
    && prev.holdsAnswer === next.holdsAnswer
));
