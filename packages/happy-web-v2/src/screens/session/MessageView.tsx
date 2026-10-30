/**
 * MessageView — dispatches a single Message by kind. Tool-call grouping happens
 * upstream in ChatList; here we render the leaf kinds and (for grouped tool
 * runs) hand off to ToolGroupView.
 */
import { memo, useCallback, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Ban, Bot, Brain, Check, ChevronDown, ChevronRight, Play, Square, Terminal } from 'lucide-react';
import type { Message, AgentTextMessage, UserTextMessage, ModeSwitchMessage, ToolCallMessage } from '@/sync/typesMessage';
import { sync } from '@/sync/sync';
import { useSession, useSessionThinking, useMachine } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { restartBrokenSession, useRestartState } from '@/app/sessionRestartAction';
import { useTranslation } from '@/i18n/useTranslation';
import { CopyButton } from '@/ui/CopyButton';
import { CollapsePanel } from '@/ui/CollapsePanel';
import { useLiveDisclosure } from './useLiveDisclosure';
import { RecoverableBoundary } from '@/ui/RecoverableBoundary';
import { Markdown } from './Markdown';
import { MessageMetaRow } from './MessageMetaRow';
import { stripHarnessBlocks, parseLocalCommandMessage, parseTaskNotification } from './harness';
import { estimateWrappedLines, shouldCollapseBubble } from './codeCollapse';
import { stripThinkingWrapper, formatThoughtFor, thinkingPreview, isLiveThinking } from './thinking';
import { presentServiceEvent } from './serviceEvent';
import { AUTO_UPDATED_EVENT_KIND, parseAutoUpdatedLine } from '@/app/autoRestartPolicy';
import { parseAttachedFiles, stripAttachedFiles } from './attachedFiles';
import { attachmentsFromFileEvents, attachmentsFromManifest, UserAttachments, type AttachmentItem } from './UserAttachments';
import { discardedReasonKey } from './discardedInput';
import { MessageActions } from './MessageActions';
import { MessageTime } from './MessageTime';
import { requestChatFollow } from './chatFollowRequest';
import { SendFailedActions, SendingIndicator, SentFlash, useSendSpinnerReset } from './SendStatusView';
import { turnSendStatus } from './sendStatusModel';
import './message.css';
import { presentTeamMessage } from './teamMessage';
import { TeamMessageCard } from './TeamMessageCard';
import { presentSessionPeerMessage } from './sessionPeerMessage';
import { presentSharedMessage } from './sharedMessage';
import { PenLine, Users } from 'lucide-react';
import './shared.css';
import { SessionPeerMessageCard } from './SessionPeerMessageCard';
import { AnsweredChip } from './LeadView';
import { isMirrorSession } from '@/assistant/assistantSession';
import { composerGate } from '@/app/sessionRestoreRules';
import { DraftScopeProvider } from './DraftBlock';
import { splitEditedDrafts, stripEditedDrafts } from '@/sync/editableDrafts';

function UserText({ message, sessionId, attachments }: { message: UserTextMessage; sessionId: string; attachments?: ToolCallMessage[] }) {
    const { t } = useTranslation();
    // Long-message collapse (B-102): clamp + fade + explicit expand replaces
    // the old 40dvh nested scroll area (wheel must bubble to the transcript).
    const [expanded, setExpanded] = useState(false);
    const contentId = useId();
    // B-513: failed > sending across the text and its attachments.
    const send = turnSendStatus(message, attachments);
    useSendSpinnerReset(send, message.localId);
    const teamContent = presentTeamMessage(message);
    if (teamContent) return <TeamMessageCard content={teamContent} sessionId={sessionId} localId={message.localId} createdAt={message.createdAt} />;
    // B-497: a message from another session on the same machine, or the
    // daemon's edit-conflict notice — a source card with a link to that session.
    const peerContent = presentSessionPeerMessage(message);
    if (peerContent) return <SessionPeerMessageCard content={peerContent} sessionId={sessionId} createdAt={message.createdAt} />;
    // B-619: a message another person wrote into this (shared) session — an
    // ordinary user bubble with the sender's name above it.
    const shared = presentSharedMessage(message);
    // B-642: the `<edited_drafts>` block went to the model; the bubble shows the
    // user's own text (displayText already excludes it, a server-queued prompt does not).
    const attachedDraftCount = splitEditedDrafts(message.text).count;
    const raw = stripEditedDrafts(shared ? shared.body : (message.displayText ?? message.text));
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
    // B-355: attachments are part of THIS user turn. Prefer the `file` events
    // (they carry the server ref, so images can be previewed); fall back to the
    // <attached_files> manifest when there are none — stripping the block must
    // never lose information (history, or a CLI-side send).
    const attachmentItems: AttachmentItem[] = attachments && attachments.length > 0
        ? attachmentsFromFileEvents(attachments)
        : attachmentsFromManifest(parseAttachedFiles(raw));
    const parsed = parseLocalCommandMessage(raw);

    if (parsed.kind === 'caveat') return null;
    if (parsed.kind === 'command-run') {
        return (
            <div className="msg msg--user" data-chat-prompt-id={message.id} data-message-id={message.id}>
                <div className={`msg-bubble msg-bubble--cmd${send ? ' msg-bubble--unsent' : ''}`}>
                    <Terminal size={13} />
                    <span className="msg-cmd-name">/{parsed.commandName}</span>
                    {parsed.args && <span className="msg-cmd-args">{parsed.args}</span>}
                </div>
                <div className="msg-actions">
                    {send?.state === 'failed'
                        ? <SendFailedActions sessionId={sessionId} status={send} />
                        : <>
                            {send?.state === 'sending' && <SendingIndicator localId={message.localId ?? send.localId} />}
                            {!send && <SentFlash localId={message.localId} />}
                            <MessageTime createdAt={message.createdAt} />
                        </>}
                </div>
            </div>
        );
    }

    // stripAttachedFiles is applied HERE and not inside stripHarnessBlocks:
    // the CLI only appends the manifest to user prompts, and agent prose in this
    // repository legitimately talks about the tag (B-355).
    const text = stripAttachedFiles(stripHarnessBlocks(parsed.text));
    if (!text && attachmentItems.length === 0) return null;
    const canCollapse = shouldCollapseBubble(estimateWrappedLines(text));
    const clamped = canCollapse && !expanded;
    // B-332: the CLI destroyed this queued message before it ever ran. Say so
    // under the bubble instead of letting it pass for a delivered prompt.
    const discarded = discardedReasonKey(message);
    const answeredChip = <AnsweredChip messageId={message.id} />;
    return (
        <div className="msg msg--user" data-chat-prompt-id={message.id} data-message-id={message.id}>
            {shared && shared.displayName && (
                <span className="msg-sender" title={shared.accountId ?? undefined}><Users size={11} aria-hidden />{shared.displayName}</span>
            )}
            <UserAttachments sessionId={sessionId} items={attachmentItems} />
            <div className={`msg-bubble-wrap vh-copyhost${send ? ' msg-bubble-wrap--unsent' : ''}`}>
                <MessageActions text={text} sessionId={sessionId} userMessage={message} hasAttachments={attachmentItems.length > 0} send={send} status={answeredChip}>
                {text && <div className="msg-bubble">
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
                </div>}
                </MessageActions>
            </div>
            {attachedDraftCount > 0 && (
                <span className="msg-drafts-attached">
                    <PenLine size={12} aria-hidden />
                    {t('session.chat.draft.attached', { count: attachedDraftCount })}
                </span>
            )}
            {discarded && (
                <span className="msg-discarded" role="status">
                    <Ban size={12} aria-hidden />
                    {t(`session.chat.discarded.${discarded}`)}
                </span>
            )}
        </div>
    );
}

function AgentText({
    message,
    showMeta,
    showActions = true,
    sessionId,
    thinkingDurationMs,
    optionsActive = false,
}: {
    message: AgentTextMessage;
    showMeta: boolean;
    showActions?: boolean;
    sessionId: string;
    thinkingDurationMs?: number;
    optionsActive?: boolean;
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
    // B-612: the fold waits for a detached reader to follow again (useLiveDisclosure).
    const thinkingRef = useRef<HTMLDivElement>(null);
    const [open, toggleOpen] = useLiveDisclosure(live, thinkingRef);
    const thinkingId = useId();

    // Must be stable: `Markdown` memoises its parsed tree on [segments,
    // components, onOption], and this component re-renders on every
    // `session.thinking` flip (twice per turn). With an inline arrow, every one
    // of those re-parsed EVERY agent message in the transcript — measured at
    // +1 full parse per re-render, ~300ms for 100 messages on desktop.
    // B-520: a picked suggestion disappears at once — the user message it
    // sends may take an encryption round before it lands in the transcript
    // (which is what retires `optionsActive`).
    const [picked, setPicked] = useState(false);
    const onOption = useCallback((option: string) => {
        setPicked(true);
        requestChatFollow(sessionId);
        void sync.sendMessage(sessionId, option, { source: 'chat' }).catch(() => setPicked(false));
    }, [sessionId]);
    const offerOptions = optionsActive && !picked;

    if (message.isThinking) {
        const content = stripThinkingWrapper(stripHarnessBlocks(message.text));
        if (!content) return null;
        const durationLabel = formatThoughtFor(thinkingDurationMs, t);
        const preview = thinkingPreview(content);
        return (
            <div className="msg msg--agent" data-message-id={message.id}>
                <div ref={thinkingRef} className="msg-thinking">
                    <button type="button" className="msg-thinking-head vh-disclosure-trigger" onClick={toggleOpen} aria-expanded={open} aria-controls={thinkingId}>
                        <ChevronRight size={13} className={`tg-chevron${open ? ' is-open' : ''}`} />
                        <Brain size={13} className="msg-thinking-icon" aria-hidden />
                        <span>{durationLabel ?? t('session.chat.thinkingLabel')}</span>
                        {!open && preview && <span className="msg-thinking-preview">{preview}</span>}
                    </button>
                    {/* B-612: height-animated; unmounts once the close transition ends. */}
                    <CollapsePanel id={thinkingId} open={open} className="msg-thinking-body vh-copyhost">
                        <Markdown text={content} />
                        {/* copies the thinking source text (wrapper stripped) */}
                        <CopyButton text={content} className="vh-copy--overlay vh-hit" label={t('message.copyMessage')} />
                    </CollapsePanel>
                </div>
            </div>
        );
    }

    const text = stripHarnessBlocks(message.text);
    if (!text && !showMeta) return null;
    const prose = text;
    return (
        // B-766: the anchor 「已答 ↗」 lands on (and phase 2's board pointers).
        <div className="msg msg--agent" data-message-id={message.id}>
            {prose && (
                <div className="msg-agent-text vh-copyhost">
                    <DraftScopeProvider sessionId={sessionId} seq={message.seq}>
                        <Markdown text={prose} onOption={offerOptions ? onOption : undefined} hideOptions={!offerOptions} />
                    </DraftScopeProvider>
                    {showActions && <MessageActions text={text} sessionId={sessionId} createdAt={message.createdAt} />}
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

/**
 * B-578: 「继续」 on the latest 「已由你停止」 (chatTurns marks which one). A
 * plain user message through the same path as B-520's option picks. ChatList
 * withholds it while the agent works or a prompt is queued; hidden here on
 * mirrors (read-only) and archived sessions (the composer's restore-first
 * path owns those).
 */
function ContinueAction({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const [busy, setBusy] = useState(false);
    // Liveness and the queue are judged by ChatList (it only passes
    // `continueOffer` while the session is idle with nothing queued).
    if (!session || isMirrorSession(session) || composerGate(session) !== 'send') return null;
    // The button text is what gets sent, in the UI language (B-578).
    const label = t('session.chat.readingAids.continue');
    const onContinue = () => {
        if (busy) return;
        setBusy(true);
        requestChatFollow(sessionId);
        void sync.sendMessage(sessionId, label, { source: 'chat' })
            .then((receipt) => { if (!receipt) setBusy(false); })
            .catch(() => setBusy(false));
    };
    return (
        <button
            type="button"
            className="msg-event-continue"
            title={t('session.chat.readingAids.continueHint')}
            disabled={busy}
            onClick={onContinue}
        >
            <Play size={12} aria-hidden />
            <span>{label}</span>
        </button>
    );
}

function AgentEventBlock({ message, sessionId, continueOffer = false }: { message: ModeSwitchMessage; sessionId: string; continueOffer?: boolean }) {
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
                // B-852: the daemon restarted this session onto new code by itself — one quiet line.
                const autoUpdated = ev.kind === AUTO_UPDATED_EVENT_KIND ? parseAutoUpdatedLine(ev.message) : null;
                if (autoUpdated) {
                    label = autoUpdated.agent
                        ? t('autoRestart.updatedAgentLine', { agent: autoUpdated.agent, version: autoUpdated.version })
                        : t('autoRestart.updatedLine', { version: autoUpdated.version });
                    subtle = true;
                    break;
                }
                const presentation = presentServiceEvent(ev.message);
                if (presentation.kind === 'hidden') return null;
                // B-297: same card for CLIs too old to tag the event structurally.
                if (presentation.kind === 'claude-auth') {
                    return <ClaudeAuthFailedBlock sessionId={sessionId} />;
                }
                if (presentation.kind === 'stopped') {
                    return (
                        <div className="msg msg--event">
                            <span className="msg-event-stopped-row">
                                <span className="msg-event-line msg-event-line--stopped"><Square size={11} fill="currentColor" />{t(presentation.textKey)}</span>
                                {continueOffer && <ContinueAction sessionId={sessionId} />}
                            </span>
                        </div>
                    );
                }
                if (presentation.kind === 'error') {
                    return (
                        <div className="msg msg--event">
                            <span className="msg-event-line msg-event-line--error"><AlertTriangle size={13} />{t(presentation.textKey)}</span>
                            <RestartAction sessionId={sessionId} />
                        </div>
                    );
                }
                if (presentation.kind === 'agent-error') {
                    return <div className="msg msg--event"><span className="msg-event-line msg-event-line--error"><AlertTriangle size={13} />{presentation.text}</span></div>;
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
/**
 * B-311 的 memo 契约是「reducer 只重建真正变了的消息，所以 message 引用相等就是精确
 * 判据」。`attachments` 打破了默认浅比较：`extractUserAttachments` 每次都新建那个数组。
 * 比较器保留 message 的引用判据，只对附件按 id 序列比较。
 */
function sameTools(a?: ToolCallMessage[], b?: ToolCallMessage[]): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    return a.every((tool, i) => tool === b[i]);
}

type MessageViewProps = {
    message: Message;
    showMeta: boolean;
    showActions?: boolean;
    sessionId: string;
    thinkingDurationMs?: number;
    /** B-355: `file` events the user sent with this message. */
    attachments?: ToolCallMessage[];
    /** B-520: this answer's `<options>` are the live suggestions (see chatTurns). */
    optionsActive?: boolean;
    /** B-578: the latest user stop — offer 「继续」 (see chatTurns). */
    continueOffer?: boolean;
};

/** B-565: one message row = one boundary. resetKey is the message object —
 *  the reducer rebuilds it only when its content changed (B-311), so it is
 *  "id + content version" for free; a fixed message re-renders by itself. */
export const MessageView = memo(function MessageView(props: MessageViewProps) {
    return (
        <RecoverableBoundary region="message" resetKey={props.message} compact>
            <MessageViewBody {...props} />
        </RecoverableBoundary>
    );
}, (prev, next) => (
    prev.message === next.message
    && prev.showActions === next.showActions
    && prev.showMeta === next.showMeta
    && prev.sessionId === next.sessionId
    && prev.thinkingDurationMs === next.thinkingDurationMs
    && prev.optionsActive === next.optionsActive
    && prev.continueOffer === next.continueOffer
    && sameTools(prev.attachments, next.attachments)
));

function MessageViewBody({
    message,
    showMeta,
    showActions = true,
    sessionId,
    thinkingDurationMs,
    attachments,
    optionsActive = false,
    continueOffer = false,
}: MessageViewProps) {
    switch (message.kind) {
        case 'user-text':
            return <UserText message={message} sessionId={sessionId} attachments={attachments} />;
        case 'agent-text':
            return (
                <AgentText
                    message={message}
                    showMeta={showMeta}
                    showActions={showActions}
                    sessionId={sessionId}
                    thinkingDurationMs={thinkingDurationMs}
                    optionsActive={optionsActive}
                />
            );
        case 'agent-event':
            return <AgentEventBlock message={message} sessionId={sessionId} continueOffer={continueOffer} />;
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
