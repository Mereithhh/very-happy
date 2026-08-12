/**
 * ChatList — scrollable transcript. Messages arrive newest-last; we render
 * chronologically with the newest at the bottom and auto-stick to the bottom
 * when the user is already near it. Consecutive tool-calls collapse into a
 * single ToolGroupView. "Load older" appears when hasMoreOlder.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useTranslation } from '@/i18n/useTranslation';
import { Button, EmptyState, Spinner } from '@/ui';
import { MessageView } from './MessageView';
import { ToolGroupView } from './ToolGroupView';
import { PermissionCard } from './PermissionCard';
import './chatlist.css';

type Row =
    | { type: 'message'; key: string; message: Message; showMeta: boolean; thinkingDurationMs?: number }
    | { type: 'toolgroup'; key: string; tools: ToolCallMessage[] };

function buildRows(messages: Message[]): Row[] {
    const rows: Row[] = [];
    // index of the last agent-text message (the turn's final answer) so we only
    // show the meta row there.
    let lastAgentTextIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].kind === 'agent-text' && !(messages[i] as any).isThinking) {
            lastAgentTextIdx = i;
            break;
        }
    }

    let i = 0;
    while (i < messages.length) {
        const m = messages[i];
        if (m.kind === 'tool-call') {
            const tools: ToolCallMessage[] = [];
            while (i < messages.length && messages[i].kind === 'tool-call') {
                tools.push(messages[i] as ToolCallMessage);
                i++;
            }
            rows.push({ type: 'toolgroup', key: `tg-${tools[0].id}`, tools });
            continue;
        }
        // Approximate thinking duration: from this thinking message's createdAt
        // to the next message's createdAt (the moment output started).
        let thinkingDurationMs: number | undefined;
        if (m.kind === 'agent-text' && (m as any).isThinking) {
            const next = messages[i + 1];
            if (next && next.createdAt > m.createdAt) {
                thinkingDurationMs = next.createdAt - m.createdAt;
            }
        }
        rows.push({ type: 'message', key: m.id, message: m, showMeta: i === lastAgentTextIdx, thinkingDurationMs });
        i++;
    }
    return rows;
}

export function ChatList({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const { messages, isLoaded, hasMoreOlder, isLoadingOlder } = useSessionMessages(sessionId);
    const scrollRef = useRef<HTMLDivElement>(null);
    const atBottomRef = useRef(true);
    const [showJump, setShowJump] = useState(false);
    const prevHeightRef = useRef(0);

    // storage keeps messages sorted NEWEST-FIRST (compareMessagesNewestFirst,
    // used by the sidebar's latest-message needs). The transcript reads top→
    // bottom = oldest→newest, so reverse into chronological order once here.
    // (Rendering the raw newest-first array is what showed the whole conversation
    // upside-down.) buildRows + the streaming signal below both consume this.
    const chronological = useMemo(() => [...messages].reverse(), [messages]);
    const rows = useMemo(() => buildRows(chronological), [chronological]);

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
        el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? 'smooth' : 'auto' });
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
        setShowJump(!atBottom);
    };

    // Auto-stick to bottom on new content when already near the bottom. Keyed on
    // both row count (new messages) and the streaming message's growing length
    // (in-place text updates) so the view follows live streamed output.
    useLayoutEffect(() => {
        if (atBottomRef.current) {
            scrollToBottom(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows.length, lastContentLen]);

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

    // Initial scroll to bottom once loaded.
    useEffect(() => {
        if (isLoaded) {
            requestAnimationFrame(() => scrollToBottom(false));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLoaded]);

    if (isLoaded && messages.length === 0) {
        return (
            <div className="cl cl--empty">
                <EmptyState
                    title={t('session.chat.emptyTitle')}
                    description={t('session.chat.emptyDescription')}
                />
            </div>
        );
    }

    if (!isLoaded) {
        return (
            <div className="cl cl--loading">
                <Spinner size={20} />
                <span>{t('session.chat.loadingMessages')}</span>
            </div>
        );
    }

    return (
        <div className="cl">
            <div
                className="cl-scroll"
                ref={scrollRef}
                onScroll={onScroll}
                onTouchMove={onTouchMoveDismissKeyboard}
            >
                <div className="cl-inner">
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
                        row.type === 'toolgroup' ? (
                            <ToolGroupView key={row.key} tools={row.tools} />
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
                    <PermissionCard sessionId={sessionId} />
                </div>
            </div>
            {showJump && (
                <button
                    type="button"
                    className="cl-jump"
                    onClick={() => scrollToBottom(true)}
                    aria-label={t('session.chat.jumpToLatest')}
                    title={t('session.chat.jumpToLatest')}
                >
                    <ChevronDown size={18} />
                </button>
            )}
        </div>
    );
}
