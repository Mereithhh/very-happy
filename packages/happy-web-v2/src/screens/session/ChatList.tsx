/**
 * ChatList — scrollable transcript. Messages arrive newest-last; we render
 * chronologically with the newest at the bottom and auto-stick to the bottom
 * when the user is already near it. Consecutive tool-calls collapse into a
 * single ToolGroupView. "Load older" appears when hasMoreOlder.
 */
import { stripEditedDrafts } from '@/sync/editableDrafts';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';
import { useSession, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { sessionCancelQueuedMessage } from '@/sync/ops';
import { useTranslation } from '@/i18n/useTranslation';
import { Button, EmptyState, OrbitLoader, Spinner, useToast } from '@/ui';
import { MessageView } from './MessageView';
import { BoardPointers } from './board/BoardPointer';
import { ToolGroupView } from './ToolGroupView';
import { MarkdownPathProvider } from './Markdown';
import { PermissionPointer } from './PermissionCard';
import { SessionLiveStatusBar } from './SessionLiveStatusBar';
import { LiveStreamView } from './LiveStreamView';
import { endLiveStreamTurn, useHasLiveDraft } from '@/sync/liveStreamStore';
import { TurnActivityView } from './TurnActivityView';
import { TurnDiffRollup } from './TurnDiffRollup';
import { CompactionDivider } from './CompactionDivider';
import { buildChatRows, newestTurnOpenerId } from './chatTurns';
import { NO_HELD_TURNS, holdEndedTurn } from './turnHold';
import {
    nextAwaySnapshot,
    unseenRows,
    formatUnseen,
    isBottomEdgeChange,
    shouldFollowGrowth,
    shouldFollowShrink,
    shouldSmoothJumpToLatest,
    followAfterScroll,
    isUpwardWheel,
    isUpwardTouch,
    isUpwardScrollKey,
    heldTranscript,
    settleWait,
    anchorIndex,
    SCROLL_SETTLE_MS,
    shouldRequestOlder,
    parkConfirmWait,
    compensationLost,
    COMPENSATION_RETRY_MS,
    COMPENSATION_RETRY_MIN_DELTA,
} from './chatFollow';
import { countRunningSubagentCards } from './subagentPills';
import { transcriptChronological } from './transcriptMessages';
import { userAbortedAt } from './subagentAbort';
import { currentTurnMessages, isAgentWorkLive } from '@/sync/agentLiveness';
import { MessageTimeTooltip } from './MessageTimeTooltip';
import './chatlist.css';
import { useHeartbeatFresh } from '@/sync/heartbeatLease';
import { SendFailedActions, SendingIndicator, SentFlash, useSendSpinnerResetAll } from './SendStatusView';
import { turnSendStatus } from './sendStatusModel';
import { latestOwnSendKey, onChatFollowRequest } from './chatFollowRequest';
import { SelectionQuote } from './SelectionQuote';
import { ChatPromptRail } from './ChatPromptRail';
import { ReaderFollowContext, createReaderFollow, type ReaderFollowSource } from './readerFollow';
import './chatReadingAids.css';
import { useChatJump } from '@/screens/search/useChatJump';
import { requestChatJump } from '@/screens/search/chatJump';
import { useTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { teamSessionMembership } from '@/screens/sessions/teamNavigation';
import { leadViewEntries, leadViewKeys, ownerAnswers, turnOpenerIds, turnOrigin } from './leadView';
import { useLeadView } from './leadViewPrefs';
import { LeadAnswerContext, LeadFoldRow } from './LeadView';
import type { ChatRow } from './chatTurns';

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
    // B-607: mirrors atBottomRef for the rows (TurnActivityView's deferred fold).
    const readerFollowRef = useRef<ReaderFollowSource | null>(null);
    if (readerFollowRef.current === null) readerFollowRef.current = createReaderFollow(true);
    const setAtBottom = (next: boolean) => {
        atBottomRef.current = next;
        readerFollowRef.current!.set(next);
    };
    const [showJump, setShowJump] = useState(false);
    const [cancelingLocalKey, setCancelingLocalKey] = useState<string | null>(null);
    // B-099 ②：离底时刻最新一行的 key（贴底时为 null）。排在它后面的 row 数
    // 渲染成 .cl-jump 上的数字 badge；回底清零。顶部插入的旧历史不计。
    const awaySnapshotRef = useRef<string | null>(null);
    // B-598: the reader made an upward scroll gesture. While set, the 80px
    // follow band no longer re-arms `atBottom` — only the real bottom does
    // (followAfterScroll), or send / jump / session switch clear it.
    const detachedRef = useRef(false);
    // Last `.cl-inner` height the growth follower saw (shared with the prepend compensation).
    const innerHeightRef = useRef(0);

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
    useSendSpinnerResetAll(queuedMessages as readonly { localId?: string | null; sendState?: string }[]);
    // B-561: one derivation shared with the board/sidebar (transcriptMessages.ts)
    // — the filters below decide where a turn starts, so both must agree.
    const chronological = useMemo(() => transcriptChronological(messages), [messages]);
    // B-603: while the transcript is moving (finger down, momentum / smooth
    // scroll still emitting scroll events) older history is not rendered — it
    // waits in the store and lands once the scroll settles (see chatFollow).
    const [holdFromId, setHoldFromId] = useState<string | null>(null);
    const shownChronological = useMemo(() => heldTranscript(chronological, holdFromId), [chronological, holdFromId]);
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
    // B-615 (turnHold.ts): a turn that stops being the live one while the
    // reader is scrolled up — liveness dropped, or the next turn started —
    // keeps its live shape (answer inside the activity row) until they follow
    // the live end again. Decided in the render that sees the edge, so the
    // restructure never reaches the DOM before it.
    const liveTurn = useMemo(
        () => (sessionLive ? newestTurnOpenerId(shownChronological) : null),
        [sessionLive, shownChronological],
    );
    const [liveTurnSeen, setLiveTurnSeen] = useState({ sessionId, turn: liveTurn });
    const [heldTurns, setHeldTurns] = useState(NO_HELD_TURNS);
    if (liveTurnSeen.sessionId !== sessionId || liveTurnSeen.turn !== liveTurn) {
        setLiveTurnSeen({ sessionId, turn: liveTurn });
        if (liveTurnSeen.sessionId === sessionId) {
            const following = atBottomRef.current;
            setHeldTurns((held) => holdEndedTurn(held, liveTurnSeen.turn, liveTurn, following));
        }
    }
    const liveDraft = useHasLiveDraft(sessionId);
    const rows = useMemo(
        () => buildChatRows(shownChronological, sessionLive, { turnDiffs: true, keepTurnsOpen: heldTurns, liveDraft }),
        [shownChronological, sessionLive, heldTurns, liveDraft],
    );
    // B-766 B-1: in the team lead's conversation, 「只看我和负责人」 folds runs of
    // member / system turns into one summary row (leadView.ts). Follow and the
    // unseen badge read the keys on screen, so noise folding in counts as nothing.
    const teams = useTeamNavigation();
    const leadTeam = useMemo(() => {
        const membership = teamSessionMembership(teams).get(sessionId);
        return membership?.bot.root ? membership.team : undefined;
    }, [teams, sessionId]);
    const leadView = useLeadView(sessionId);
    const origin = useMemo(() => (m: Parameters<typeof turnOrigin>[0]) => turnOrigin(m, leadTeam), [leadTeam]);
    const answers = useMemo(() => (leadTeam ? ownerAnswers(shownChronological, origin) : null), [leadTeam, shownChronological, origin]);
    const entries = useMemo(
        () => (leadTeam && leadView === 'owner' ? leadViewEntries(rows, turnOpenerIds(shownChronological), origin) : null),
        [leadTeam, leadView, rows, shownChronological, origin],
    );
    const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set());
    const toggleFold = (key: string) => setOpenFolds((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
    });
    const visibleRows = useMemo(
        () => (entries ? entries.flatMap((entry) => (entry.type === 'row' ? [entry.row] : openFolds.has(entry.key) ? entry.rows : [])) : rows),
        [entries, openFolds, rows],
    );
    const rowKeys = useMemo(() => (entries ? leadViewKeys(entries, openFolds) : rows.map((row) => row.key)), [entries, openFolds, rows]);
    // B-578: 「继续」 only while nothing runs or waits — same liveness verdict
    // as the transcript, and a queued prompt already is the continuation.
    const canOfferContinue = !sessionLive && queuedMessages.length === 0;

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
        if (!animate) ownScrollTopRef.current = el.scrollTop;
    };

    // B-603: scroll motion → hold older history until the scroll settles.
    // An instant scroll we wrote ourselves (follow / compensation) is not
    // motion: its scroll event lands on exactly the value we wrote.
    const ownScrollTopRef = useRef<number | null>(null);
    const motionRef = useRef({ touching: false, lastAt: 0 });
    const holdRef = useRef<string | null>(null);
    const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const chronologicalRef = useRef(chronological);
    chronologicalRef.current = chronological;
    const olderPendingRef = useRef(false);
    olderPendingRef.current = !!hasMoreOlder || !!isLoadingOlder;
    // B-616: older history is fetched on demand — one page when the reader
    // parks the top of the loaded history within a screen and the scroll has
    // settled (chatFollow.shouldRequestOlder). Checked when a scroll settles
    // and after each commit that changed the rows or the pagination flags, so
    // a window shorter than the viewport fills up, and a landed page that
    // left the reader still near the top is followed by the next one.
    const hasMoreOlderRef = useRef(!!hasMoreOlder);
    hasMoreOlderRef.current = !!hasMoreOlder;
    const isLoadingOlderRef = useRef(!!isLoadingOlder);
    isLoadingOlderRef.current = !!isLoadingOlder;
    const settledNow = () => holdRef.current === null
        && settleWait(performance.now(), motionRef.current.lastAt, motionRef.current.touching) === 0;
    const olderWanted = (el: HTMLElement) => shouldRequestOlder({
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        hasMoreOlder: hasMoreOlderRef.current,
        isLoadingOlder: isLoadingOlderRef.current,
        settled: settledNow(),
    });
    const parkConfirmRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestOlderIfParked = () => {
        const el = scrollRef.current;
        if (!el || parkConfirmRef.current !== null || !olderWanted(el)) return;
        // B-617 ①: "settled" by events is not enough on iOS — confirm the
        // position itself has not moved after a short wait (longer at the very
        // top, where the bounce lives) before asking for a page.
        const at = el.scrollTop;
        parkConfirmRef.current = setTimeout(() => {
            parkConfirmRef.current = null;
            const now = scrollRef.current;
            if (!now || now.scrollTop !== at || !olderWanted(now)) return;
            void sync.loadOlderMessages(sessionId);
        }, parkConfirmWait(at));
    };
    const requestOlderRef = useRef(requestOlderIfParked);
    requestOlderRef.current = requestOlderIfParked;

    // B-617 ②: the prepend compensation, verified. WebKit drops a programmatic
    // scrollTop while a scroll animation (momentum, smooth) is running (B-603)
    // — the view then shows the inserted page: the jump. Re-apply every frame
    // while the write is seen to be lost (position still where it was before
    // the write), until it holds or the window runs out.
    const compensationRef = useRef<number | null>(null);
    const cancelCompensationRetry = () => {
        if (compensationRef.current !== null) cancelAnimationFrame(compensationRef.current);
        compensationRef.current = null;
    };
    const compensate = (el: HTMLElement, delta: number) => {
        cancelCompensationRetry();
        const write = () => {
            const before = el.scrollTop;
            const max = Math.max(0, el.scrollHeight - el.clientHeight);
            el.scrollTop = Math.min(before + delta, max);
            ownScrollTopRef.current = el.scrollTop;
            return { before, clamped: before + delta > max };
        };
        let last = write();
        if (last.clamped || Math.abs(delta) < COMPENSATION_RETRY_MIN_DELTA) return;
        const until = performance.now() + COMPENSATION_RETRY_MS;
        const verify = () => {
            compensationRef.current = null;
            if (!compensationLost(el.scrollTop, last.before, delta) || performance.now() >= until) return;
            last = write();
            if (last.clamped) return;
            compensationRef.current = requestAnimationFrame(verify);
        };
        compensationRef.current = requestAnimationFrame(verify);
    };
    const releaseWhenSettled = () => {
        if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
        const check = () => {
            const wait = settleWait(performance.now(), motionRef.current.lastAt, motionRef.current.touching);
            if (wait > 0) {
                settleTimerRef.current = setTimeout(check, wait);
                return;
            }
            settleTimerRef.current = null;
            holdRef.current = null;
            setHoldFromId(null);
            requestOlderRef.current();
        };
        settleTimerRef.current = setTimeout(check, SCROLL_SETTLE_MS);
    };
    const noteMotion = () => {
        motionRef.current.lastAt = performance.now();
        if (holdRef.current === null) {
            // Nothing older can land: no need to freeze anything.
            const oldest = chronologicalRef.current[0]?.id ?? null;
            if (!olderPendingRef.current || oldest === null) return;
            holdRef.current = oldest;
            setHoldFromId(oldest);
        }
        releaseWhenSettled();
    };
    useEffect(() => () => {
        if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
        if (parkConfirmRef.current !== null) clearTimeout(parkConfirmRef.current);
        cancelCompensationRetry();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // B-615: held turns are released once the reader follows the live end AND
    // the scroll has settled. Restructuring mid-scroll (the smooth 「跳到最新」
    // still running) left WebKit 8–21px short of the bottom: it ignores the
    // follow's scroll write while an animation runs (B-603).
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const check = () => {
            const wait = settleWait(performance.now(), motionRef.current.lastAt, motionRef.current.touching);
            if (wait > 0) {
                timer = setTimeout(check, wait);
                return;
            }
            timer = null;
            if (atBottomRef.current) setHeldTurns(NO_HELD_TURNS);
        };
        const stop = readerFollowRef.current!.onRefollow(() => {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(check, 0);
        });
        return () => {
            stop();
            if (timer !== null) clearTimeout(timer);
        };
    }, []);

    // B-598: an upward scroll gesture leaves the live end immediately, whatever
    // the distance. Without it a trackpad / slow wheel / touch scroll moving a
    // few px per event stayed inside the 80px band between two streamed tokens
    // and every token snapped it back to the bottom.
    const detach = () => {
        const el = scrollRef.current;
        // Nothing above to read (short transcript / already at the top): don't
        // stop following for a gesture that cannot move the view.
        if (!el || el.scrollTop <= 0) return;
        detachedRef.current = true;
        setAtBottom(false);
        awaySnapshotRef.current = nextAwaySnapshot(awaySnapshotRef.current, false, rowKeys[rowKeys.length - 1] ?? null);
        setShowJump(true);
    };
    // Document-level listeners below are installed once; they call the latest.
    const detachRef = useRef(detach);
    detachRef.current = detach;
    // B-650: a session-search click lands on its hit (screens/search/chatJump.ts).
    useChatJump({ sessionId, scrollRef, chronological, isLoaded, hasMoreOlder: !!hasMoreOlder,
        isLoadingOlder: !!isLoadingOlder, onDetach: () => detachRef.current() });

    const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
        if (isUpwardWheel(e.deltaY) && !nestedScrollerTakesUp(e.target, e.currentTarget)) detach();
    };

    // Highest finger position of the current touch gesture: a finger moving
    // DOWN from it scrolls the content UP (reading back).
    const touchAnchorYRef = useRef<number | null>(null);
    const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
        touchAnchorYRef.current = e.touches[0]?.clientY ?? null;
        motionRef.current.touching = true;
        noteMotion();
    };
    const onTouchEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
        if (e.touches.length > 0) return;
        motionRef.current.touching = false;
        noteMotion();
    };
    const onTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
        onTouchMoveDismissKeyboard();
        const y = e.touches[0]?.clientY;
        const anchor = touchAnchorYRef.current;
        if (y === undefined || anchor === null) return;
        if (y < anchor) touchAnchorYRef.current = y;
        else if (isUpwardTouch(anchor, y) && !nestedScrollerTakesUp(e.target, e.currentTarget)) detach();
    };

    // Keyboard scrolling (PageUp / ↑ / Home / Shift+Space) lands on the
    // transcript when focus is inside it, or on <body> after the reader last
    // clicked in it. Typing in the composer (or any field) never counts.
    useEffect(() => {
        let pointerInside = false;
        const onPointerDown = (e: PointerEvent) => {
            const el = scrollRef.current;
            pointerInside = !!el && e.target instanceof Node && el.contains(e.target);
        };
        const onKeyDown = (e: KeyboardEvent) => {
            const el = scrollRef.current;
            if (!el || e.defaultPrevented || !isUpwardScrollKey(e) || isEditableTarget(e.target)) return;
            const target = e.target instanceof Node ? e.target : null;
            const onTranscript = !!target && el.contains(target);
            const onPage = target === document.body || target === document.documentElement;
            if (onTranscript || (onPage && pointerInside)) detachRef.current();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, []);

    // Dragging the scrollbar: the pointerdown lands on the scroller itself.
    // Only an actual upward move while dragging detaches (see onScroll).
    const scrollbarDragRef = useRef(false);
    const lastScrollTopRef = useRef(0);
    const onScrollerPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        scrollbarDragRef.current = true;
        const release = () => {
            scrollbarDragRef.current = false;
            window.removeEventListener('pointerup', release, true);
            window.removeEventListener('pointercancel', release, true);
        };
        window.addEventListener('pointerup', release, true);
        window.addEventListener('pointercancel', release, true);
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
        if (ownScrollTopRef.current !== null && Math.abs(el.scrollTop - ownScrollTopRef.current) < 1) {
            ownScrollTopRef.current = null;
        } else {
            ownScrollTopRef.current = null;
            noteMotion();
        }
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        const movedUp = el.scrollTop < lastScrollTopRef.current;
        lastScrollTopRef.current = el.scrollTop;
        if (scrollbarDragRef.current && movedUp) detachedRef.current = true;
        // B-598: once detached, the 80px band no longer re-arms following.
        const { atBottom, detached } = followAfterScroll(detachedRef.current, distance);
        detachedRef.current = detached;
        setAtBottom(atBottom);
        awaySnapshotRef.current = nextAwaySnapshot(awaySnapshotRef.current, atBottom, rowKeys[rowKeys.length - 1] ?? null);
        setShowJump(!atBottom);
    };

    // 未读增量在渲染时现算：离底后快照不动，rows 变化本身就触发重渲染；
    // 回底由 onScroll 清快照并 setShowJump(false) 触发重渲染，badge 随之消失。
    const unseenLabel = formatUnseen(unseenRows(awaySnapshotRef.current, rowKeys));

    // Older history landed at the top (a page requested while parked near the
    // top, 「加载更早」, a held page released after the scroll settled, the
    // load-older slot going away): keep the reader's content where it was, in
    // the same commit, before paint.
    // Measured on an anchor row in the viewport — not the top row, which the
    // insert may rebuild (its turn gains the older messages) — so growth at the
    // bottom in the same commit is not mistaken for the prepend. Also keeps a
    // reader at the very bottom at the bottom (distance unchanged).
    const topEdge = `${hasMoreOlder ? 1 : 0}|${rows[0]?.key ?? ''}`;
    const topEdgeRef = useRef(topEdge);
    const anchorRef = useRef<{ node: Element; top: number } | null>(null);
    useLayoutEffect(() => {
        const el = scrollRef.current;
        const inner = innerRef.current;
        if (!el || !inner) {
            anchorRef.current = null;
            return;
        }
        const innerTop = () => inner.getBoundingClientRect().top;
        const prev = anchorRef.current;
        if (topEdgeRef.current !== topEdge && prev && prev.node.isConnected && prev.node.parentElement === inner) {
            const delta = prev.node.getBoundingClientRect().top - innerTop() - prev.top;
            if (delta !== 0) {
                compensate(el, delta);
                // Not new content at the bottom: don't let the growth follower read it so.
                innerHeightRef.current = inner.getBoundingClientRect().height;
            }
        }
        topEdgeRef.current = topEdge;
        const children = inner.children;
        const firstRow = inner.firstElementChild?.classList.contains('cl-loadolder') ? 1 : 0;
        const line = el.getBoundingClientRect().top;
        const at = anchorIndex(children.length, (i) => children[i].getBoundingClientRect().bottom, line, firstRow + 1);
        anchorRef.current = at < 0 ? null : { node: children[at], top: children[at].getBoundingClientRect().top - innerTop() };
    });

    // B-616: after the compensation above has run, see whether the reader is
    // (still) parked near the top of what is loaded and ask for the next page.
    useEffect(() => {
        requestOlderRef.current();
    }, [rows.length, hasMoreOlder, isLoadingOlder, isLoaded]);

    // Auto-stick to bottom on new content when already near the bottom. Keyed on
    // both row count (new messages) and the streaming message's growing length
    // (in-place text updates) so the view follows live streamed output.
    // Only a change at the BOTTOM edge follows: older history prepended at the
    // top (a page loaded on demand / 「加载更早」) also bumps rows.length, and
    // snapping on it dragged a reader slowly scrolling up inside the 80px band
    // back to 0 on every page — they could never get out (isBottomEdgeChange).
    const newestRowKey = rowKeys[rowKeys.length - 1] ?? null;
    const bottomEdgeRef = useRef({ newestKey: newestRowKey, lastContentLen });
    useLayoutEffect(() => {
        const prev = bottomEdgeRef.current;
        const next = { newestKey: newestRowKey, lastContentLen };
        bottomEdgeRef.current = next;
        if (atBottomRef.current && isBottomEdgeChange(prev, next)) {
            scrollToBottom(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows.length, lastContentLen, newestRowKey]);

    // B-615: releasing held turns restructures rows above a reader pinned to
    // the bottom (the answer leaves its activity row for a row of its own).
    // WebKit clamps that commit short of the new bottom, and nothing at the
    // bottom edge changed to trigger the follow above — re-pin explicitly.
    // The scroll has settled by then (release waits for it).
    const heldCountRef = useRef(heldTurns.size);
    useLayoutEffect(() => {
        const released = heldTurns.size < heldCountRef.current;
        heldCountRef.current = heldTurns.size;
        if (released && atBottomRef.current) scrollToBottom(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [heldTurns]);

    // B-520: sending is joining the live end — override a scrolled-back view.
    // atBottom=true also arms the growth/row followers for the reply.
    const followNow = () => {
        detachedRef.current = false;
        setAtBottom(true);
        awaySnapshotRef.current = null;
        setShowJump(false);
        scrollToBottom(false);
    };
    const ownSendKey = useMemo(() => latestOwnSendKey(messages), [messages]);
    const lastOwnSendKeyRef = useRef(ownSendKey);
    useLayoutEffect(() => {
        if (ownSendKey !== null && ownSendKey !== lastOwnSendKeyRef.current) followNow();
        lastOwnSendKeyRef.current = ownSendKey;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ownSendKey]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => onChatFollowRequest(sessionId, followNow), [sessionId]);

    // B-099 ①：工具输出原地增长（同一条 tool-call 的 stdout 变长、running→done
    // 展开）时 rows.length 与 lastContentLen 都不变，上面的 effect 不触发——用
    // ResizeObserver 盯内容 wrapper（.cl-inner）补住：高度增长且仍贴底才跟随
    // （非 smooth，防抖到 rAF）。atBottom 门控保持：用户上滚回看绝不能被拉回。
    // Growth while an older page is in flight is history landing at the TOP —
    // the prepend effect below compensates it; following it would yank the
    // reader (same trap as the row effect above). The baseline is shared so
    // that compensation can re-arm it.
    const hasTranscript = isLoaded && messages.length > 0;
    useEffect(() => {
        const inner = innerRef.current;
        if (!hasTranscript || !inner || typeof ResizeObserver === 'undefined') return;
        let raf = 0;
        innerHeightRef.current = inner.getBoundingClientRect().height;
        // The decision is taken here but the scroll lands a frame later: a
        // reader who scrolled away in between must not be pulled back.
        const followNextFrame = () => {
            raf = requestAnimationFrame(() => {
                raf = 0;
                if (atBottomRef.current) scrollToBottom(false);
            });
        };
        // Border box on every read (not contentRect): the prepend effect
        // re-arms this baseline from outside the observer with the same measure.
        const ro = new ResizeObserver(() => {
            const next = inner.getBoundingClientRect().height;
            const follow = !isLoadingOlderRef.current
                && shouldFollowGrowth(innerHeightRef.current, next, atBottomRef.current);
            innerHeightRef.current = next;
            if (!follow || raf) return;
            followNextFrame();
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
                followNextFrame();
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

    // A route can reuse this component while switching between two already
    // cached sessions (`isLoaded` stays true). Reset the previous session's
    // mid-history state and land at latest BEFORE paint; late markdown/tool
    // growth is then covered by the ResizeObserver while atBottom remains true.
    useLayoutEffect(() => {
        if (!isLoaded) return;
        detachedRef.current = false;
        setAtBottom(true);
        awaySnapshotRef.current = null;
        holdRef.current = null;
        setHoldFromId(null);
        setShowJump(false);
        scrollToBottom(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, isLoaded]);

    // B-766: switching the lead view keeps a reader at the live end there.
    const filtered = entries !== null;
    useLayoutEffect(() => {
        if (atBottomRef.current) scrollToBottom(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filtered]);

    // B-766: 「已答 ↗」 goes through the session-search jump (chatJump): it lands
    // on the answer's `data-message-id` anchor and tints it; an answer not on
    // screen (inside a folded activity) lands on its question.
    const answerContext = useMemo(
        () => (answers ? { answers, jump: (answerId: string) => requestChatJump(sessionId, { terms: [], messageId: answerId, flash: true }) } : null),
        [answers, sessionId],
    );

    // 「跳到最新」 is asking to follow again: drop the detach so the smooth
    // catch-up re-arms through the follow band like before B-598.
    const jumpToLatest = () => {
        detachedRef.current = false;
        scrollToBottom(true);
    };

    // B-309: a wrapper that dies mid-turn never sends `turn-end`, so liveness
    // dropping is the other signal that drafts are done. Arms the same delayed
    // sweep — not an immediate clear (see endLiveStreamTurn).
    useEffect(() => {
        if (!sessionLive) endLiveStreamTurn(sessionId);
    }, [sessionLive, sessionId]);

    if (isLoaded && messages.length === 0) {
        return (
            <div className="cl cl--empty">
                <div className="cl-scroll">
                    <div className="cl-inner">
                        <EmptyState
                            title={t('session.chat.emptyTitle')}
                            description={t('session.chat.emptyDescription')}
                        />
                        <PermissionPointer sessionId={sessionId} />
                        {showLiveStatus && <SessionLiveStatusBar sessionId={sessionId} />}
                    </div>
                </div>
            </div>
        );
    }

    if (!isLoaded) {
        return (
            <div className="cl cl--loading">
                <div className="cl-scroll">
                    <div className="cl-inner">
                        <OrbitLoader size="compact" label={t('session.chat.loadingMessages')} />
                        {showLiveStatus && <SessionLiveStatusBar sessionId={sessionId} />}
                    </div>
                </div>
            </div>
        );
    }

    const renderRow = (row: ChatRow) =>
        row.type === 'activity' ? (
            <TurnActivityView
                key={row.key}
                messages={row.messages}
                live={row.live}
                sessionId={sessionId}
                durationSeconds={row.durationSeconds}
                trigger={row.trigger}
                abortedAt={row.abortedAt}
                answer={row.answer}
            />
        ) : row.type === 'turn-diff' ? (
            <TurnDiffRollup key={row.key} sessionId={sessionId} diff={row.diff} />
        ) : row.type === 'compaction' ? (
            <CompactionDivider key={row.key} state={row.state} startedAt={row.startedAt}
                durationSeconds={row.durationSeconds} error={row.error} />
        ) : row.type === 'toolgroup' ? (
            <ToolGroupView
                key={row.key}
                tools={row.tools}
                stalled={!sessionLive}
                abortedAt={row.tools[0].createdAt >= currentTurnStartedAt ? abortedAt : null}
            />
        ) : (
            <Fragment key={row.key}>
            <MessageView
                message={row.message}
                showMeta={row.showMeta}
                showActions={row.showActions}
                sessionId={sessionId}
                thinkingDurationMs={row.thinkingDurationMs}
                attachments={row.attachments}
                optionsActive={row.optionsActive}
                continueOffer={row.continueOffer === true && canOfferContinue}
            />
            {/* B-766: 「已上板」 pointers the lead posted from this message (none without a board). */}
            <BoardPointers sessionId={sessionId} messageId={row.message.id} />
            </Fragment>
        );

    return (
        // B-145 finding 2: 路径白名单在**会话根**挂一次。挂在每条消息上会让长会话
        // 变成 O(N²)（每条各订阅全量 messages 并各扫一遍），流式输出时尤其明显。
        <MarkdownPathProvider sessionId={sessionId}>
        <ReaderFollowContext.Provider value={readerFollowRef.current}>
        <LeadAnswerContext.Provider value={answerContext}>
        <div className="cl">
            {/* B-473: one delegated hover-time bubble for every row below. */}
            <MessageTimeTooltip containerRef={scrollRef} />
            <div
                className="cl-scroll"
                ref={scrollRef}
                onScroll={onScroll}
                onWheel={onWheel}
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                onTouchCancel={onTouchEnd}
                onPointerDown={onScrollerPointerDown}
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
                    {entries
                        ? entries.map((entry) => entry.type === 'row' ? renderRow(entry.row) : (
                            <Fragment key={entry.key}>
                                <LeadFoldRow fold={entry} open={openFolds.has(entry.key)} onToggle={() => toggleFold(entry.key)} />
                                {openFolds.has(entry.key) && entry.rows.map(renderRow)}
                            </Fragment>
                        ))
                        : rows.map(renderRow)}
                    {/* B-309: the draft of what is being generated right now,
                        between the last persisted message and the status bar.
                        Not a row: it has no id, no seq, no place in history —
                        storage claims it away the instant the real message
                        lands. */}
                    <LiveStreamView sessionId={sessionId} />
                    {/* B-563: the actionable card is pinned above the composer
                        (SessionDetailScreen); the transcript keeps one pointer. */}
                    <PermissionPointer sessionId={sessionId} />
                    {/* Part of scrollback: innerRef observes growth, while manual
                        scrollback keeps the user's position. No empty footer slot. */}
                    {showLiveStatus && <SessionLiveStatusBar sessionId={sessionId} />}
                </div>
            </div>
            {/* B-577 / B-579: selection quote and the 「你的提问」 rail. */}
            <SelectionQuote rootRef={scrollRef} sessionId={sessionId} />
            <ChatPromptRail
                rows={visibleRows}
                scrollRef={scrollRef}
                innerRef={innerRef}
                hasMoreOlder={!!hasMoreOlder}
                isLoadingOlder={!!isLoadingOlder}
                sessionId={sessionId}
                navVisible={showJump && queuedMessages.length === 0}
                onNavigateUp={detach}
            />
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
                                onClick={jumpToLatest}
                                aria-label={t('session.chat.jumpToLatest')}
                                title={t('session.chat.jumpToLatest')}
                            >
                                {unseenLabel !== null && <span>{unseenLabel}</span>}
                                <ChevronDown size={16} />
                            </button>
                        )}
                    </div>
                    <div className="cl-queue-items">
                        {queuedMessages.map((message, index) => {
                            // B-513: failed > sending > queued.
                            const send = message.kind === 'user-text' || message.kind === 'tool-call' ? turnSendStatus(message) : null;
                            return (
                            <div className={`cl-queue-item${send ? ` cl-queue-item--${send.state}` : ''}`} key={('localId' in message ? message.localId : null) ?? message.id}>
                                <span className="cl-queue-index">{index + 1}</span>
                                <span className="cl-queue-text">
                                    {message.kind === 'user-text'
                                        ? stripEditedDrafts(message.displayText ?? message.text)
                                        : message.kind === 'tool-call' && message.tool.name === 'file'
                                            ? t('session.chat.queuedFile', { name: String(message.tool.input?.name ?? '') })
                                            : ''}
                                </span>
                                {send?.state === 'sending' && <SendingIndicator localId={send.localId} />}
                                {send?.state === 'failed' && <SendFailedActions sessionId={sessionId} status={send} />}
                                {!send && <SentFlash localId={'localId' in message ? message.localId : null} />}
                                {!send && session?.metadata?.queueCancellation === true && message.kind === 'user-text' && message.localId && (
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
                            );
                        })}
                    </div>
                </section>
            )}
            {showJump && queuedMessages.length === 0 && (
                <button
                    type="button"
                    className="cl-jump"
                    onClick={jumpToLatest}
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
        </LeadAnswerContext.Provider>
        </ReaderFollowContext.Provider>
        </MarkdownPathProvider>
    );
}

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable;
}

/**
 * Does a nested vertical scroller between the event target and the
 * transcript take this upward gesture itself (it can still scroll up)?
 * Then the transcript does not move and must keep following. At its top
 * edge the gesture chains to the transcript (B-467) and counts.
 */
function nestedScrollerTakesUp(target: EventTarget | null, scroller: HTMLElement): boolean {
    for (let node = target instanceof Element ? target : null; node && node !== scroller; node = node.parentElement) {
        if (!(node instanceof HTMLElement) || node.scrollTop <= 0 || node.scrollHeight <= node.clientHeight) continue;
        const overflowY = getComputedStyle(node).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') return true;
    }
    return false;
}
