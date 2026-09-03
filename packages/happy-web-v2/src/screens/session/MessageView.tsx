/**
 * MessageView — dispatches a single Message by kind. Tool-call grouping happens
 * upstream in ChatList; here we render the leaf kinds and (for grouped tool
 * runs) hand off to ToolGroupView.
 */
import { memo, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Bot, Brain, Check, ChevronDown, ChevronRight, Square, Terminal } from 'lucide-react';
import type { Message, AgentTextMessage, UserTextMessage, ModeSwitchMessage } from '@/sync/typesMessage';
import { sync } from '@/sync/sync';
import { useSession, useSessionThinking, useMachine } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { restartBrokenSession, useRestartState } from '@/app/sessionRestartAction';
import { useTranslation } from '@/i18n/useTranslation';
import { CopyButton } from '@/ui/CopyButton';
import { Markdown } from './Markdown';
import { MessageMetaRow } from './MessageMetaRow';
import { stripHarnessBlocks, parseLocalCommandMessage, parseTaskNotification } from './harness';
import { estimateWrappedLines, shouldCollapseBubble } from './codeCollapse';
import { stripThinkingWrapper, formatThoughtFor, thinkingPreview, isLiveThinking } from './thinking';
import { presentServiceEvent } from './serviceEvent';
import { parseDecisionBlock, parseTickReport } from './supervisorCards';
import { DecisionCard, TickReportCard } from './SupervisorCardViews';
import './message.css';

function UserText({ message }: { message: UserTextMessage }) {
    const { t } = useTranslation();
    // Long-message collapse (B-102): clamp + fade + explicit expand replaces
    // the old 40dvh nested scroll area (wheel must bubble to the transcript).
    const [expanded, setExpanded] = useState(false);
    const contentId = useId();
    const raw = message.displayText ?? message.text;
    // B-260: a background-task notification is a machine-facing user message.
    // Stripping used to leave an invisible empty bubble; render the one useful
    // line instead (summary + status), mono, event-styled — not a user bubble.
    const notification = parseTaskNotification(raw);
    if (notification) {
        const label = notification.summary ?? t('message.taskNotificationGeneric');
        const failed = notification.status === 'failed';
        return (
            <div className="msg msg--event">
                <span className={`msg-event-line msg-event-line--subtle msg-event-line--notification${failed ? ' msg-event-line--error' : ''}`}>
                    <Bot size={13} />
                    {failed ? t('message.taskNotificationFailed', { summary: label }) : label}
                </span>
            </div>
        );
    }
    const parsed = parseLocalCommandMessage(raw);

    if (parsed.kind === 'caveat') return null;
    // B-353: a vh-supervisor tick is a machine-composed user message; render its items as cards.
    if (parsed.kind === 'text') {
        const tick = parseTickReport(parsed.text);
        if (tick) return <TickReportCard report={tick} />;
    }
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
    const canCollapse = shouldCollapseBubble(estimateWrappedLines(text));
    const clamped = canCollapse && !expanded;
    return (
        <div className="msg msg--user">
            <div className="msg-bubble-wrap vh-copyhost">
                <div className="msg-bubble">
                    <div id={contentId} className={`msg-bubble-text${clamped ? ' msg-bubble-text--clamped' : ''}`}>
                        {text}
                        {clamped && <div className="msg-bubble-fade" aria-hidden />}
                    </div>
                    {canCollapse && (
                        <button
                            type="button"
                            className="msg-bubble-expand vh-disclosure-trigger"
                            onClick={() => setExpanded((v) => !v)}
                            aria-expanded={!clamped}
                            aria-controls={contentId}
                        >
                            <span>{clamped ? t('session.chat.expandMessage') : t('session.chat.collapseLines')}</span>
                            <ChevronDown size={13} className={`vh-disclosure-icon${!clamped ? ' is-open' : ''}`} aria-hidden />
                        </button>
                    )}
                </div>
                {/* copy the raw message text — sits in the empty gutter left of the bubble */}
                <CopyButton text={text} className="vh-copy--overlay msg-copy--user" label={t('message.copyMessage')} />
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
    // Live-thinking auto-expand (B-101): while the session is working and no
    // message follows this thinking block yet, it's the one being streamed —
    // open it. When it stops being live (turn ended / next message arrived),
    // fold it back, unless the user toggled it by hand.
    // B-311: subscribe to the boolean, not the whole Session — the keepAlive
    // moves `activeAt` every 2s and used to re-render every thinking block.
    const sessionThinking = useSessionThinking(sessionId);
    const live =
        message.isThinking === true &&
        isLiveThinking({
            sessionThinking,
            thinkingDurationMs,
            createdAt: message.createdAt,
            now: Date.now(),
        });
    const [open, setOpen] = useState(live);
    const thinkingId = useId();
    const userToggledRef = useRef(false);
    useEffect(() => {
        if (!userToggledRef.current) setOpen(live);
    }, [live]);
    const toggleOpen = () => {
        userToggledRef.current = true;
        setOpen((v) => !v);
    };

    const onOption = (option: string) => {
        void sync.sendMessage(sessionId, option, { source: 'chat' });
    };

    if (message.isThinking) {
        const content = stripThinkingWrapper(stripHarnessBlocks(message.text));
        if (!content) return null;
        const durationLabel = formatThoughtFor(thinkingDurationMs, t);
        const preview = thinkingPreview(content);
        return (
            <div className="msg msg--agent">
                <div className="msg-thinking">
                    <button type="button" className="msg-thinking-head vh-disclosure-trigger" onClick={toggleOpen} aria-expanded={open} aria-controls={thinkingId}>
                        <ChevronRight size={13} className={`tg-chevron${open ? ' is-open' : ''}`} />
                        <Brain size={13} className="msg-thinking-icon" aria-hidden />
                        <span>{durationLabel ?? t('session.chat.thinkingLabel')}</span>
                        {!open && preview && <span className="msg-thinking-preview">{preview}</span>}
                    </button>
                    <div id={thinkingId} className="msg-thinking-body vh-copyhost vh-disclosure-panel" hidden={!open}>
                        {open && <>
                            <Markdown text={content} />
                            {/* copies the thinking source text (wrapper stripped) */}
                            <CopyButton text={content} className="vh-copy--overlay" label={t('message.copyMessage')} />
                        </>}
                    </div>
                </div>
            </div>
        );
    }

    const text = stripHarnessBlocks(message.text);
    if (!text && !showMeta) return null;
    // B-353: charter decisions JSON at the end of a supervisor reply → card; prose above stays markdown.
    const decisionBlock = text ? parseDecisionBlock(text) : null;
    const prose = decisionBlock ? decisionBlock.prose : text;
    return (
        <div className="msg msg--agent">
            {prose && (
                <div className="msg-agent-text vh-copyhost">
                    <Markdown text={prose} onOption={onOption} />
                    {/* copies the markdown SOURCE of the whole message, not the rendered text */}
                    <CopyButton text={text} className="vh-copy--overlay msg-copy--agent" label={t('message.copyMessage')} />
                </div>
            )}
            {decisionBlock && <DecisionCard decisions={decisionBlock.decisions} />}
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

/** B-264: inline "Restart" on a processFailed event — asks the daemon to stop
 *  the broken wrapper and relaunch it on current CLI code. Disabled while a
 *  restart is in flight or the machine is offline. */
function RestartAction({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const restart = useRestartState(sessionId);
    const session = useSession(sessionId);
    const machine = useMachine(session?.metadata?.machineId ?? '');
    const machineOnline = !!machine && isMachineOnline(machine);
    const pending = restart?.phase === 'spawning' || restart?.phase === 'awaiting-online';
    const failed = restart?.phase === 'failed';
    return (
        <span className="msg-event-restart">
            <button
                type="button"
                className="msg-event-restart-btn"
                onClick={() => { void restartBrokenSession(sessionId); }}
                disabled={pending || !machineOnline}
            >
                {pending ? t('session.chat.restarting') : t('session.chat.restart')}
            </button>
            {failed && (
                <span className="msg-event-restart-hint">
                    {restart?.reason === 'daemon-too-old'
                        ? t('session.chat.restartDaemonTooOld')
                        : t('session.chat.restartFailed')}
                </span>
            )}
        </span>
    );
}

/** B-276: jump from an auth-failed turn to the machine's Claude login status. */
function MachineAuthLink({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const session = useSession(sessionId);
    const machineId = session?.metadata?.machineId;
    if (!machineId) return null;
    return (
        <span className="msg-event-restart">
            <button type="button" className="msg-event-restart-btn" onClick={() => navigate(`/machine/${machineId}`)}>
                {t('session.chat.claudeAuthOpenMachine')}
            </button>
        </span>
    );
}

/** B-276/B-297: the one auth-failure card, reached both from the structured
 *  `claude-auth-failed` event (CLI ≥ v0.2.97) and from the raw SDK text that
 *  older wrappers emit. Restart is not repeated here — on the old-CLI path the
 *  adjacent `Process exited unexpectedly` event already carries it. */
function ClaudeAuthFailedBlock({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    return (
        <div className="msg msg--event">
            <span className="msg-event-line msg-event-line--error"><AlertTriangle size={13} />{t('session.chat.claudeAuthFailed')}</span>
            <MachineAuthLink sessionId={sessionId} />
        </div>
    );
}

function AgentEventBlock({ message, sessionId }: { message: ModeSwitchMessage; sessionId: string }) {
    const { t } = useTranslation();
    const ev = message.event;
    let label: string;
    let subtle = false;
    switch (ev.type) {
        case 'switch':
            label = t('message.switchedToMode', { mode: ev.mode });
            break;
        case 'message':
            {
                if (ev.kind === 'claude-auth-failed') {
                    return <ClaudeAuthFailedBlock sessionId={sessionId} />;
                }
                const presentation = presentServiceEvent(ev.message);
                if (presentation.kind === 'hidden') return null;
                // B-297: same card for CLIs too old to tag the event structurally.
                if (presentation.kind === 'claude-auth') {
                    return <ClaudeAuthFailedBlock sessionId={sessionId} />;
                }
                if (presentation.kind === 'stopped') {
                    return <div className="msg msg--event"><span className="msg-event-line msg-event-line--stopped"><Square size={11} fill="currentColor" />{t(presentation.textKey)}</span></div>;
                }
                if (presentation.kind === 'error') {
                    return (
                        <div className="msg msg--event">
                            <span className="msg-event-line msg-event-line--error"><AlertTriangle size={13} />{t(presentation.textKey)}</span>
                            <RestartAction sessionId={sessionId} />
                        </div>
                    );
                }
                label = presentation.text;
                subtle = true;
                break;
            }
        case 'limit-reached':
            label = t('message.usageLimitUntil', {
                time: formatUnixTime(ev.endsAt) || t('message.unknownTime'),
            });
            break;
        case 'ready':
            // 'ready' carries turn metadata that the reducer already folds into the
            // final agent-text MessageMetaRow — nothing to render as an event line.
            return null;
        case 'subagent':
            return (
                <div className="msg msg--event">
                    <span className={`msg-event-line msg-event-line--subagent msg-event-line--${ev.status}`}>
                        {ev.status === 'running' ? <Bot size={13} /> : <Check size={13} />}
                        {ev.status === 'running'
                            ? t('message.subagentStarted', { name: ev.title ?? t('message.subagent') })
                            : t('message.subagentCompleted', { name: ev.title ?? t('message.subagent') })}
                    </span>
                </div>
            );
        default:
            label = t('message.unknownEvent');
    }
    return (
        <div className="msg msg--event">
            <span className={`msg-event-line${subtle ? ' msg-event-line--subtle' : ''}`}>{label}</span>
        </div>
    );
}

/**
 * B-311: memoised. The transcript has no virtualisation, so without this every
 * store change — a 2s keepAlive, a per-second elapsed tick inside one running
 * tool, a single new message — re-rendered every message ever loaded, markdown
 * and all. `message` objects come from the reducer, which only rebuilds the
 * ones that actually changed, so reference equality is an exact test.
 */
export const MessageView = memo(function MessageView({
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
            return <AgentEventBlock message={message} sessionId={sessionId} />;
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
});
