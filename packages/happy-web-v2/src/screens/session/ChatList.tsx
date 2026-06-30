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

    const rows = useMemo(() => buildRows(messages), [messages]);

    const reduced =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const scrollToBottom = (smooth: boolean) => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? 'smooth' : 'auto' });
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

    // Auto-stick to bottom on new content when already near the bottom.
    useLayoutEffect(() => {
        if (atBottomRef.current) {
            scrollToBottom(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows.length]);

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
                    title={t('session.chat.emptyTitle' as any)}
                    description={t('session.chat.emptyDescription' as any)}
                />
            </div>
        );
    }

    if (!isLoaded) {
        return (
            <div className="cl cl--loading">
                <Spinner size={20} />
                <span>{t('session.chat.loadingMessages' as any)}</span>
            </div>
        );
    }

    return (
        <div className="cl">
            <div className="cl-scroll" ref={scrollRef} onScroll={onScroll}>
                <div className="cl-inner">
                    {hasMoreOlder && (
                        <div className="cl-loadolder">
                            <Button
                                variant="ghost"
                                size="sm"
                                loading={isLoadingOlder}
                                onClick={() => void sync.loadOlderMessages(sessionId)}
                            >
                                {isLoadingOlder ? t('session.chat.loadingOlder' as any) : t('session.chat.loadOlder' as any)}
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
                    aria-label={t('session.chat.jumpToLatest' as any)}
                    title={t('session.chat.jumpToLatest' as any)}
                >
                    <ChevronDown size={18} />
                </button>
            )}
        </div>
    );
}
