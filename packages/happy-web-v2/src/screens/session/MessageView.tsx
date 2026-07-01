/**
 * MessageView — dispatches a single Message by kind. Tool-call grouping happens
 * upstream in ChatList; here we render the leaf kinds and (for grouped tool
 * runs) hand off to ToolGroupView.
 */
import { useState } from 'react';
import { ChevronRight, Terminal } from 'lucide-react';
import type { Message, AgentTextMessage, UserTextMessage, ModeSwitchMessage } from '@/sync/typesMessage';
import { sync } from '@/sync/sync';
import { useTranslation } from '@/i18n/useTranslation';
import { Markdown } from './Markdown';
import { MessageMetaRow } from './MessageMetaRow';
import { stripHarnessBlocks, parseLocalCommandMessage } from './harness';
import { stripThinkingWrapper, formatThoughtFor } from './thinking';
import './message.css';

function UserText({ message }: { message: UserTextMessage }) {
    const raw = message.displayText ?? message.text;
    const parsed = parseLocalCommandMessage(raw);

    if (parsed.kind === 'caveat') return null;
    if (parsed.kind === 'command-run') {
        return (
            <div className="msg msg--user">
                <div className="msg-bubble msg-bubble--cmd">
                    <Terminal size={13} />
                    <span className="msg-cmd-name">/{parsed.commandName}</span>
                    {parsed.args && <span className="msg-cmd-args">{parsed.args}</span>}
                </div>
            </div>
        );
    }

    const text = stripHarnessBlocks(parsed.text);
    if (!text) return null;
    return (
        <div className="msg msg--user">
            <div className="msg-bubble">
                <div className="msg-bubble-scroll">{text}</div>
            </div>
        </div>
    );
}

function AgentText({
    message,
    showMeta,
    sessionId,
    thinkingDurationMs,
}: {
    message: AgentTextMessage;
    showMeta: boolean;
    sessionId: string;
    thinkingDurationMs?: number;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);

    const onOption = (option: string) => {
        void sync.sendMessage(sessionId, option, { source: 'chat' });
    };

    if (message.isThinking) {
        const content = stripThinkingWrapper(stripHarnessBlocks(message.text));
        if (!content) return null;
        const durationLabel = formatThoughtFor(thinkingDurationMs, t);
        return (
            <div className="msg msg--agent">
                <div className="msg-thinking">
                    <button type="button" className="msg-thinking-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                        <ChevronRight size={13} className={`tg-chevron${open ? ' is-open' : ''}`} />
                        <span className="msg-thinking-emoji" aria-hidden>💭</span>
                        <span>{durationLabel ?? t('session.chat.thinkingLabel' as any)}</span>
                    </button>
                    {open && (
                        <div className="msg-thinking-body">
                            <Markdown text={content} />
                        </div>
                    )}
                </div>
            </div>
        );
    }

    const text = stripHarnessBlocks(message.text);
    if (!text && !showMeta) return null;
    return (
        <div className="msg msg--agent">
            {text && (
                <div className="msg-agent-text">
                    <Markdown text={text} onOption={onOption} />
                </div>
            )}
            {showMeta && (
                <MessageMetaRow
                    usage={message.usage}
                    model={message.meta?.model ?? undefined}
                    costUsd={message.costUsd}
                    totalDurationMs={message.totalDurationMs}
                />
            )}
        </div>
    );
}

function formatUnixTime(ts: number): string {
    try {
        return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}

function AgentEventBlock({ message }: { message: ModeSwitchMessage }) {
    const { t } = useTranslation();
    const ev = message.event;
    let label: string;
    let subtle = false;
    switch (ev.type) {
        case 'switch':
            label = t('message.switchedToMode' as any, { mode: ev.mode });
            break;
        case 'message':
            // Title-change / plan-mode / turn / compaction system notes — keep subtle.
            label = ev.message;
            subtle = true;
            break;
        case 'limit-reached':
            label = t('message.usageLimitUntil' as any, {
                time: formatUnixTime(ev.endsAt) || t('message.unknownTime' as any),
            });
            break;
        case 'ready':
            // 'ready' carries turn metadata that the reducer already folds into the
            // final agent-text MessageMetaRow — nothing to render as an event line.
            return null;
        default:
            label = t('message.unknownEvent' as any);
    }
    return (
        <div className="msg msg--event">
            <span className={`msg-event-line${subtle ? ' msg-event-line--subtle' : ''}`}>{label}</span>
        </div>
    );
}

export function MessageView({
    message,
    showMeta,
    sessionId,
    thinkingDurationMs,
}: {
    message: Message;
    showMeta: boolean;
    sessionId: string;
    thinkingDurationMs?: number;
}) {
    switch (message.kind) {
        case 'user-text':
            return <UserText message={message} />;
        case 'agent-text':
            return (
                <AgentText
                    message={message}
                    showMeta={showMeta}
                    sessionId={sessionId}
                    thinkingDurationMs={thinkingDurationMs}
                />
            );
        case 'agent-event':
            return <AgentEventBlock message={message} />;
        default:
            // Never silently drop an unknown kind — show a subtle fallback line.
            return (
                <div className="msg msg--event">
                    <span className="msg-event-line msg-event-line--subtle">
                        {(message as any)?.kind ?? 'message'}
                    </span>
                </div>
            );
    }
}
