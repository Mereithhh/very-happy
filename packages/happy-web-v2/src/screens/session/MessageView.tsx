/**
 * MessageView — dispatches a single Message by kind. Tool-call grouping happens
 * upstream in ChatList; here we render the leaf kinds and (for grouped tool
 * runs) hand off to ToolGroupView.
 */
import { useState } from 'react';
import { ChevronRight, Terminal } from 'lucide-react';
import type { Message, AgentTextMessage, UserTextMessage, ModeSwitchMessage } from '@/sync/typesMessage';
import { useTranslation } from '@/i18n/useTranslation';
import { Markdown } from './Markdown';
import { MessageMetaRow } from './MessageMetaRow';
import { stripHarnessBlocks, parseLocalCommandMessage } from './harness';
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
            <div className="msg-bubble">{text}</div>
        </div>
    );
}

function AgentText({ message, showMeta }: { message: AgentTextMessage; showMeta: boolean }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const text = stripHarnessBlocks(message.text);

    if (message.isThinking) {
        if (!text) return null;
        return (
            <div className="msg msg--agent">
                <div className="msg-thinking">
                    <button type="button" className="msg-thinking-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                        <ChevronRight size={13} className={`tg-chevron${open ? ' is-open' : ''}`} />
                        <span>{t('session.chat.thinkingLabel' as any)}</span>
                    </button>
                    {open && <div className="msg-thinking-body"><Markdown text={text} /></div>}
                </div>
            </div>
        );
    }

    if (!text && !showMeta) return null;
    return (
        <div className="msg msg--agent">
            {text && (
                <div className="msg-agent-text">
                    <Markdown text={text} />
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

function AgentEvent({ message }: { message: ModeSwitchMessage }) {
    const { t } = useTranslation();
    const ev = message.event as any;
    let label = t('message.unknownEvent' as any);
    if (ev?.type === 'switch' || ev?.mode) {
        label = t('message.switchedToMode' as any, { mode: ev.mode ?? ev.to ?? '' });
    } else if (ev?.type === 'message' && typeof ev.message === 'string') {
        label = ev.message;
    }
    return (
        <div className="msg msg--event">
            <span className="msg-event-line">{label}</span>
        </div>
    );
}

export function MessageView({ message, showMeta }: { message: Message; showMeta: boolean }) {
    switch (message.kind) {
        case 'user-text':
            return <UserText message={message} />;
        case 'agent-text':
            return <AgentText message={message} showMeta={showMeta} />;
        case 'agent-event':
            return <AgentEvent message={message} />;
        default:
            return null;
    }
}
