/**
 * ChatList — scrollable transcript. Messages arrive newest-last; we render
 * chronologically with the newest at the bottom and auto-stick to the bottom
 * when the user is already near it. Consecutive tool-calls collapse into a
 * single ToolGroupView. "Load older" appears when hasMoreOlder.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';
import { useSession, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { sessionCancelQueuedMessage } from '@/sync/ops';
import { useTranslation } from '@/i18n/useTranslation';
import { Button, EmptyState, OrbitLoader, Spinner, useToast } from '@/ui';
import { MessageView } from './MessageView';
import { ToolGroupView } from './ToolGroupView';
import { MarkdownPathProvider } from './Markdown';
import { PermissionCard } from './PermissionCard';
import { SessionLiveStatusBar } from './SessionLiveStatusBar';
import { LiveStreamView } from './LiveStreamView';
import { endLiveStreamTurn } from '@/sync/liveStreamStore';
import { TurnActivityView } from './TurnActivityView';
import { buildChatRows } from './chatTurns';
import {
    nextAwaySnapshot,
    unseenRows,
    formatUnseen,
    shouldFollowGrowth,
    shouldFollowShrink,
    shouldSmoothJumpToLatest,
} from './chatFollow';
import { isHiddenToolName } from './toolVisibility';
import { countRunningSubagentCards, suppressSubagentPills } from './subagentPills';
import { userAbortedAt } from './subagentAbort';
import { currentTurnMessages, isAgentWorkLive } from '@/sync/agentLiveness';
import './chatlist.css';
import { useHeartbeatFresh } from '@/sync/heartbeatLease';

export function ChatList({
    sessionId,
    showLiveStatus = true,
}: {
    sessionId: string;
    showLiveStatus?: boolean;
}) {
    const { t } = useTranslation();
    const toast = useToast();
    const session = useSession(sessionId);
    const { messages, isLoaded, hasMoreOlder, isLoadingOlder } = useSessionMessages(sessionId);
    const scrollRef = useRef<HTMLDivElement>(null);
    const innerRef = useRef<HTMLDivElement>(null);
    const atBottomRef = useRef(true);
    const [showJump, setShowJump] = useState(false);
    const [cancelingLocalKey, setCancelingLocalKey] = useState<string | null>(null);
    const prevHeightRef = useRef(0);
    // B-099 ②：离底时刻的 rows.length 快照（贴底时为 null）。之后新到的 row 数
    // = rows.length - 快照，渲染成 .cl-jump 上的数字 badge；回底清零。
    const awaySnapshotRef = useRef<number | null>(null);

    // storage keeps messages sorted NEWEST-FIRST (compareMessagesNewestFirst,
    // used by the sidebar's latest-message needs). The transcript reads top→
    // bottom = oldest→newest, so reverse into chronological order once here.
    // (Rendering the raw newest-first array is what showed the whole conversation
    // upside-down.) buildRows + the streaming signal below both consume this.
    const queuedMessages = useMemo(
        () => [...messages]
            .reverse()
            .filter((message) => message.inputState === 'queued'),
        [messages],
    );
    const chronological = useMemo(
        () => suppressSubagentPills([...messages].reverse().filter((message) =>
            message.inputState === undefined &&
            (message.kind !== 'tool-call' || !isHiddenToolName(message.tool.name)))),
        [messages],
    );
    // B-260-P2: a background sub-agent keeps the turn live after the main
    // agent's stub tool_result — the CLI publishes its lifecycle.
    // B-295: only the CURRENT turn's sub-agents vote, and a `running` tool call
    // never votes on its own — see sync/agentLiveness.ts for why.
    const currentTurn = useMemo(() => currentTurnMessages(chronological), [chronological]);
    const runningSubagents = useMemo(() => countRunningSubagentCards(currentTurn), [currentTurn]);
    // B-317: an abort ends the turn it interrupted and nothing else, so both
    // the marker and the rows it may silence come from the current turn only —
    // a historical card must never be repainted by a later stop.
    const abortedAt = useMemo(() => userAbortedAt(currentTurn), [currentTurn]);
    const currentTurnStartedAt = currentTurn.length > 0 ? currentTurn[0].createdAt : Number.POSITIVE_INFINITY;
    // B-322: thinking 是租约不是闩锁（sync/heartbeatLease.ts）。
    const leaseFresh = useHeartbeatFresh(sessionId);
    const sessionLive = isAgentWorkLive({
        presence: session?.presence,
        thinking: session?.thinking,
        runningSubagentsInTurn: runningSubagents,
        heartbeatFresh: leaseFresh,
    });
    const rows = useMemo(
        () => buildChatRows(chronological, sessionLive),
        [chronological, sessionLive],
    );

    const cancelQueued = async (index: number) => {
        const message = queuedMessages[index];
        if (message?.kind !== 'user-text' || !message.localId || cancelingLocalKey) return;
        const targetLocalKeys = [message.localId];
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
            const previous = queuedMessages[cursor];
            if (previous.kind !== 'tool-call' || previous.tool.name !== 'file') break;
            if (previous.localId) targetLocalKeys.unshift(previous.localId);
        }
        setCancelingLocalKey(message.localId);
        try {
            const removed = await sessionCancelQueuedMessage(
                sessionId,
                message.localId,
                message.text,
                targetLocalKeys,
            );
            if (!removed) toast.error(t('session.chat.queueCancelTooLate'));
        } catch {
            toast.error(t('session.chat.queueCancelFailed'));
        } finally {
            setCancelingLocalKey(null);
        }
    };

    // Streaming signal: the last (newest) message's text grows in place (same
    // message id, so rows.length stays constant) while the agent streams. Auto-
    // stick must react to that growth too, not just to new rows — otherwise a
    // long streamed answer scrolls off the bottom and the user has to chase it.
    const lastContentLen = chronological.length
        ? ((chronological[chronological.length - 1] as any).text?.length ?? 0)
        : 0;

    const reduced =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const scrollToBottom = (smooth: boolean) => {
        const el = scrollRef.current;
        if (!el) return;
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        const animate = smooth && !reduced && shouldSmoothJumpToLatest(distance, el.clientHeight);
        el.scrollTo({ top: el.scrollHeight, behavior: animate ? 'smooth' : 'auto' });
    };

    // Touch-scrolling the transcript dismisses the composer keyboard — the
    // native `keyboardDismissMode="onDrag"` convention (iOS Messages, Telegram,
    // every chat app): dragging the list means "let me read", and on iOS the
    // overlay keyboard would otherwise keep covering the bottom 40% with no
    // way to see what's under it. touchmove only fires on touch devices, so
    // desktop (mouse wheel / trackpad) is untouched. blur() needs no gesture
    // stack (unlike focus()) and is idempotent, so firing per-move is fine.
    const onTouchMoveDismissKeyboard = () => {
        const ae = document.activeElement;
        if (
            ae instanceof HTMLElement &&
            (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)
        ) {
            ae.blur();
        }
    };

    // Track whether the user is near the bottom.
    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        const atBottom = distance < 80;
        atBottomRef.current = atBottom;
        awaySnapshotRef.current = nextAwaySnapshot(awaySnapshotRef.current, atBottom, rows.length);
        setShowJump(!atBottom);
    };

    // 未读增量在渲染时现算：离底后快照不动，rows.length 变化本身就触发重渲染；
    // 回底由 onScroll 清快照并 setShowJump(false) 触发重渲染，badge 随之消失。
    const unseenLabel = formatUnseen(unseenRows(awaySnapshotRef.current, rows.length));

    // Auto-stick to bottom on new content when already near the bottom. Keyed on
    // both row count (new messages) and the streaming message's growing length
    // (in-place text updates) so the view follows live streamed output.
    useLayoutEffect(() => {
        if (atBottomRef.current) {
            scrollToBottom(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows.length, lastContentLen]);

    // B-099 ①：工具输出原地增长（同一条 tool-call 的 stdout 变长、running→done
    // 展开）时 rows.length 与 lastContentLen 都不变，上面的 effect 不触发——用
    // ResizeObserver 盯内容 wrapper（.cl-inner）补住：高度增长且仍贴底才跟随
    // （非 smooth，防抖到 rAF）。atBottom 门控保持：用户上滚回看绝不能被拉回。
    const hasTranscript = isLoaded && messages.length > 0;
    useEffect(() => {
        const inner = innerRef.current;
        if (!hasTranscript || !inner || typeof ResizeObserver === 'undefined') return;
        let raf = 0;
        let prevHeight = inner.getBoundingClientRect().height;
        const ro = new ResizeObserver((entries) => {
            const next =
                entries[entries.length - 1]?.contentRect.height ??
                inner.getBoundingClientRect().height;
            const follow = shouldFollowGrowth(prevHeight, next, atBottomRef.current);
            prevHeight = next;
            if (!follow || raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                scrollToBottom(false);
            });
        });
        ro.observe(inner);
        // B-114 ②：滚动容器自身变矮（软键盘弹起 resize 视口）时保持贴底——
        // 内容没变，上面的 growth 路永远不触发。同一个 rAF 防抖共用。
        const scroller = scrollRef.current;
        let prevScrollerHeight = scroller?.getBoundingClientRect().height ?? 0;
        const roScroller = scroller
            ? new ResizeObserver((entries) => {
                const next =
                    entries[entries.length - 1]?.contentRect.height ??
                    scroller.getBoundingClientRect().height;
                const follow = shouldFollowShrink(prevScrollerHeight, next, atBottomRef.current);
                prevScrollerHeight = next;
                if (!follow || raf) return;
                raf = requestAnimationFrame(() => {
                    raf = 0;
                    scrollToBottom(false);
                });
            })
            : null;
        if (roScroller && scroller) roScroller.observe(scroller);
        return () => {
            ro.disconnect();
            roScroller?.disconnect();
            if (raf) cancelAnimationFrame(raf);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hasTranscript]);

    // Preserve scroll position when older messages are prepended.
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        if (isLoadingOlder) {
            prevHeightRef.current = el.scrollHeight;
        } else if (prevHeightRef.current > 0) {
            const delta = el.scrollHeight - prevHeightRef.current;
            if (delta > 0 && !atBottomRef.current) {
                el.scrollTop += delta;
            }
            prevHeightRef.current = 0;
        }
    }, [isLoadingOlder]);

    // A route can reuse this component while switching between two already
    // cached sessions (`isLoaded` stays true). Reset the previous session's
    // mid-history state and land at latest BEFORE paint; late markdown/tool
    // growth is then covered by the ResizeObserver while atBottom remains true.
    useLayoutEffect(() => {
        if (!isLoaded) return;
        atBottomRef.current = true;
        awaySnapshotRef.current = null;
        prevHeightRef.current = 0;
        setShowJump(false);
        scrollToBottom(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, isLoaded]);

    // B-309: a wrapper that dies mid-turn never sends `turn-end`, so liveness
    // dropping is the other signal that drafts are done. Arms the same delayed
    // sweep — not an immediate clear (see endLiveStreamTurn).
    useEffect(() => {
        if (!sessionLive) endLiveStreamTurn(sessionId);
    }, [sessionLive, sessionId]);

    if (isLoaded && messages.length === 0) {
        return (
            <div className="cl cl--empty">
                <EmptyState
                    title={t('session.chat.emptyTitle')}
                    description={t('session.chat.emptyDescription')}
                />
                <SessionLiveStatusBar sessionId={sessionId} />
                <PermissionCard sessionId={sessionId} />
            </div>
        );
    }

    if (!isLoaded) {
        return (
            <div className="cl cl--loading">
                <div className="cl-scroll">
                    <OrbitLoader size="compact" label={t('session.chat.loadingMessages')} />
                </div>
                <SessionLiveStatusBar sessionId={sessionId} />
            </div>
        );
    }

    return (
        // B-145 finding 2: 路径白名单在**会话根**挂一次。挂在每条消息上会让长会话
        // 变成 O(N²)（每条各订阅全量 messages 并各扫一遍），流式输出时尤其明显。
        <MarkdownPathProvider sessionId={sessionId}>
        <div className="cl">
            <div
                className="cl-scroll"
                ref={scrollRef}
                onScroll={onScroll}
                onTouchMove={onTouchMoveDismissKeyboard}
            >
                <div className="cl-inner" ref={innerRef}>
                    {hasMoreOlder && (
                        <div className="cl-loadolder">
                            <Button
                                variant="ghost"
                                size="sm"
                                loading={isLoadingOlder}
                                onClick={() => void sync.loadOlderMessages(sessionId)}
                            >
                                {isLoadingOlder ? t('session.chat.loadingOlder') : t('session.chat.loadOlder')}
                            </Button>
                        </div>
                    )}
                    {rows.map((row) =>
                        row.type === 'activity' ? (
                            <TurnActivityView
                                key={row.key}
                                messages={row.messages}
                                live={row.live}
                                sessionId={sessionId}
                                durationSeconds={row.durationSeconds}
                            />
                        ) : row.type === 'toolgroup' ? (
                            <ToolGroupView
                                key={row.key}
                                tools={row.tools}
                                stalled={!sessionLive}
                                abortedAt={row.tools[0].createdAt >= currentTurnStartedAt ? abortedAt : null}
                            />
                        ) : (
                            <MessageView
                                key={row.key}
                                message={row.message}
                                showMeta={row.showMeta}
                                sessionId={sessionId}
                                thinkingDurationMs={row.thinkingDurationMs}
                            />
                        ),
                    )}
                    {/* B-309: the draft of what is being generated right now,
                        between the last persisted message and the status bar.
                        Not a row: it has no id, no seq, no place in history —
                        storage claims it away the instant the real message
                        lands. */}
                    <LiveStreamView sessionId={sessionId} />
                    {/* Keep a dedicated running pulse at the end of the transcript for
                        the whole turn. Activity rows can contain streamed assistant text
                        and tools, but they are content rather than a persistent liveness
                        signal and may be visually quiet between SDK events. */}
                    {showLiveStatus && <SessionLiveStatusBar sessionId={sessionId} />}
                    <PermissionCard sessionId={sessionId} />
                </div>
            </div>
            {queuedMessages.length > 0 && (
                <section className="cl-queue" aria-label={t('session.chat.queuedTitle', { count: queuedMessages.length })}>
                    <div className="cl-queue-head">
                        <div className="cl-queue-labels">
                            <span>{t('session.chat.queuedTitle', { count: queuedMessages.length })}</span>
                            <span className="cl-queue-hint">{t('session.chat.queuedHint')}</span>
                        </div>
                        {showJump && (
                            <button
                                type="button"
                                className="cl-queue-jump"
                                onClick={() => scrollToBottom(true)}
                                aria-label={t('session.chat.jumpToLatest')}
                                title={t('session.chat.jumpToLatest')}
                            >
                                {unseenLabel !== null && <span>{unseenLabel}</span>}
                                <ChevronDown size={16} />
                            </button>
                        )}
                    </div>
                    <div className="cl-queue-items">
                        {queuedMessages.map((message, index) => (
                            <div className="cl-queue-item" key={('localId' in message ? message.localId : null) ?? message.id}>
                                <span className="cl-queue-index">{index + 1}</span>
                                <span className="cl-queue-text">
                                    {message.kind === 'user-text'
                                        ? (message.displayText ?? message.text)
                                        : message.kind === 'tool-call' && message.tool.name === 'file'
                                            ? t('session.chat.queuedFile', { name: String(message.tool.input?.name ?? '') })
                                            : ''}
                                </span>
                                {session?.metadata?.queueCancellation === true && message.kind === 'user-text' && message.localId && (
                                    <button
                                        type="button"
                                        className="cl-queue-cancel"
                                        disabled={cancelingLocalKey !== null}
                                        aria-busy={cancelingLocalKey === message.localId}
                                        aria-label={t('session.chat.queueCancel')}
                                        title={t('session.chat.queueCancel')}
                                        onClick={() => void cancelQueued(index)}
                                    >
                                        {cancelingLocalKey === message.localId ? <Spinner size={14} /> : <Trash2 size={15} />}
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                </section>
            )}
            {showJump && queuedMessages.length === 0 && (
                <button
                    type="button"
                    className="cl-jump"
                    onClick={() => scrollToBottom(true)}
                    aria-label={t('session.chat.jumpToLatest')}
                    title={t('session.chat.jumpToLatest')}
                >
                    {unseenLabel !== null && (
                        <span className="cl-jump-badge" aria-hidden="true">
                            {unseenLabel}
                        </span>
                    )}
                    <ChevronDown size={18} />
                </button>
            )}
        </div>
        </MarkdownPathProvider>
    );
}
