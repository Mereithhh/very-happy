import { useReadOnlyTranscript } from './readOnlyTranscript';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { GitFork, Pencil, Quote, TextQuote, Trash2 } from 'lucide-react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import type { Session } from '@/sync/storageTypes';
import { isMirrorSession } from '@/assistant/assistantSession';
import { Spinner } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { CopyButton } from '@/ui/CopyButton';
import { Button } from '@/ui/Button';
import { useSession, useSetting } from '@/sync/storage';
import type { UserTextMessage } from '@/sync/typesMessage';
import { useImeGuard } from '@/utils/ime';
import { insertComposerNewline, isSoftKeyboardDevice, resolveComposerEnter } from '@/utils/composerEnter';
import { quoteMessage } from './messageQuote';
import { getTouchQuoteOffer, setTouchQuoteOffer, useTouchQuoteOffer } from './selectionQuoteOffer';
import { messageActionsCopy } from './messageActionsCopy';
import { MessageTime } from './MessageTime';
import { DeliverOnResumeHint, SendFailedActions, SendingIndicator, SentFlash } from './SendStatusView';
import type { TurnSendStatus } from './sendStatusModel';
import { RewindFailure, rewindConversation } from './conversationRewind';
import { ForkFailure, forkFromMessage, messageForkTarget } from './forkFlow';
import { forkReasonText, isForkableFlavor } from './forkModel';
import './messageActions.css';

/**
 * MessageActions — copy / quote / edit / delete row under a message, plus the
 * in-place editor and delete confirmation.
 *
 * B-528: edit and delete REPLACE history like Claude Desktop / Codex. Edit
 * turns the bubble itself into an editor; sending it drops this prompt and
 * everything after it — from the screen AND from the agent's memory — and
 * sends the new text as the next prompt. Delete drops just this prompt's turn
 * (the prompt and its replies). Both stop a running turn first. File changes
 * are not rolled back. Claude sessions only: the runner rewinds its own
 * transcript (conversationRewind.ts).
 */
export function MessageActions({ text, sessionId, userMessage, createdAt = userMessage?.createdAt, hasAttachments = false, send = null, status, children }: {
    text: string; sessionId: string; userMessage?: UserTextMessage; createdAt?: number; hasAttachments?: boolean;
    /** B-513: not yet confirmed by the server — copy only; a failed turn shows its recovery actions instead of the time. */
    send?: TurnSendStatus | null;
    /** B-766: an always-visible chip before the time (the owner bubble's 「已答 ↗」). */
    status?: ReactNode;
    children?: ReactNode;
}) {
    if (useReadOnlyTranscript()) return <>{children}</>;
    return <EditableMessageActions text={text} sessionId={sessionId} userMessage={userMessage} createdAt={createdAt} hasAttachments={hasAttachments} send={send} status={status}>{children}</EditableMessageActions>;
}

function EditableMessageActions({ text, sessionId, userMessage, createdAt, hasAttachments, send, status, children }: {
    text: string; sessionId: string; userMessage?: UserTextMessage; createdAt?: number; hasAttachments: boolean; send: TurnSendStatus | null; status?: ReactNode; children?: ReactNode;
}) {
    const { t, lang } = useTranslation();
    const copy = messageActionsCopy(lang);
    const session = useSession(sessionId);
    const enterToSend = useSetting('agentInputEnterToSend');
    const ime = useImeGuard();
    const hintId = useId();
    const editButton = useRef<HTMLButtonElement>(null);
    const deleteButton = useRef<HTMLButtonElement>(null);
    const textarea = useRef<HTMLTextAreaElement>(null);
    // B-577 touch: a selection inside this message, still for 500ms (SelectionQuote).
    const actionsRef = useRef<HTMLDivElement>(null);
    const selectionQuote = useTouchQuoteOffer(actionsRef);
    const [mode, setMode] = useState<'idle' | 'edit' | 'delete'>('idle');
    const [edited, setEdited] = useState(text);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const [error, setError] = useState<string | null>(null);
    const [forkNote, setForkNote] = useState<string | null>(null);
    const inRouter = useInRouterContext();

    // Only a Claude runner can rewind its own conversation; mirrors are read-only.
    const flavor = session?.metadata?.flavor ?? 'claude';
    // B-619: rewind / edit-and-resend are owner operations (session RPC); a grantee only reads.
    const canRewind = !!userMessage && !send && flavor === 'claude' && typeof userMessage.seq === 'number' && !session?.share;
    // B-851: 「从这里分叉」 — Claude and Codex; a blocked fork explains itself under the row.
    const canFork = inRouter && !!userMessage && !!session && !send && !session.share && !isMirrorSession(session) && isForkableFlavor(session.metadata?.flavor);

    // Grow with the text, like the bubble it replaces.
    useLayoutEffect(() => {
        const el = textarea.current;
        if (!el || mode !== 'edit') return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [edited, mode]);

    const close = (focus: 'edit' | 'delete') => {
        if (busyRef.current) return;
        setMode('idle');
        setError(null);
        requestAnimationFrame(() => (focus === 'edit' ? editButton : deleteButton).current?.focus());
    };
    const openEditor = () => {
        setEdited(text);
        setError(null);
        setMode('edit');
        requestAnimationFrame(() => {
            const el = textarea.current;
            if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
        });
    };
    const failureText = (cause: unknown) => {
        if (cause instanceof RewindFailure) {
            if (cause.kind === 'unsupported') return copy.unsupported;
            if (cause.kind === 'unsent') return copy.unsent;
            if (cause.kind === 'send') return copy.sendFailed;
            if (cause.kind === 'record') return copy.recordFailed;
            return `${copy.failed} ${cause.message}`;
        }
        return copy.failed;
    };
    const run = async (request: { action: 'delete' } | { action: 'edit'; text: string }) => {
        if (busyRef.current || !userMessage) return;
        busyRef.current = true;
        setBusy(true);
        setError(null);
        try {
            await rewindConversation(sessionId, userMessage, request);
            busyRef.current = false;
            setMode('idle');
        } catch (cause) {
            setError(failureText(cause));
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };
    const submitEdit = () => {
        const next = edited.trim();
        if (!next) return;
        if (next === text.trim()) { close('edit'); return; }
        void run({ action: 'edit', text: edited });
    };

    if (userMessage && mode === 'edit') {
        return <section className="msg-edit-inline" aria-label={copy.edit} onKeyDown={event => {
            if (event.key === 'Escape' && !ime.isGuarded(event)) { event.preventDefault(); close('edit'); }
        }}>
            <textarea
                ref={textarea}
                rows={1}
                value={edited}
                disabled={busy}
                aria-label={copy.text}
                aria-describedby={hintId}
                onChange={(event) => setEdited(event.target.value)}
                onCompositionStart={ime.onCompositionStart}
                onCompositionEnd={ime.onCompositionEnd}
                onKeyDown={event => {
                    const action = resolveComposerEnter(event, { guarded: ime.isGuarded(event), enterToSend, softKeyboard: isSoftKeyboardDevice() });
                    if (action === 'send') { event.preventDefault(); submitEdit(); }
                    else if (action === 'newline') { event.preventDefault(); insertComposerNewline(event.currentTarget); }
                }}
            />
            {error && <p role="alert" className="msg-edit-error">{error}</p>}
            <div className="msg-edit-footer">
                {/* B-722: the save is visible where it happens; the new prompt then shows its own send state. */}
                <p id={hintId} className="msg-edit-hint" aria-live="polite" data-save-state={busy ? 'saving' : undefined}>{busy ? t('session.chat.saveState.saving') : copy.editHint}</p>
                <Button size="sm" onClick={() => close('edit')} disabled={busy}>{copy.cancel}</Button>
                <Button size="sm" variant="primary" loading={busy} disabled={!edited.trim()} onClick={submitEdit}>{copy.submit}</Button>
            </div>
        </section>;
    }

    return <>
        {children}
        {mode === 'delete' && userMessage
            ? <div className="msg-delete-confirm" role="group" aria-label={copy.deleteTitle} onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); close('delete'); }
            }}>
                <p className="msg-delete-text"><strong>{copy.deleteTitle}</strong> {copy.deleteHint}</p>
                {error && <p role="alert" className="msg-edit-error">{error}</p>}
                <div className="msg-edit-footer">
                    <Button size="sm" onClick={() => close('delete')} disabled={busy} autoFocus>{copy.cancel}</Button>
                    <Button size="sm" variant="danger" loading={busy} onClick={() => void run({ action: 'delete' })}>{copy.delete}</Button>
                </div>
            </div>
            : <div ref={actionsRef} className="msg-actions" role={text ? 'group' : undefined} aria-label={text ? copy.actions : undefined}>
                {text && <div className="msg-actions-items">
                    <CopyButton text={text} size={14} label={t('message.copyMessage')} />
                    {!send && <button type="button" className="msg-action" aria-label={copy.quote} title={copy.quote} onClick={() => quoteMessage(sessionId, text)}><Quote size={14} aria-hidden /></button>}
                    {!send && selectionQuote && <button
                        type="button"
                        className="msg-action msg-action--selection"
                        // Keep the system selection while the tap lands.
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => {
                            const offer = getTouchQuoteOffer();
                            quoteMessage(sessionId, offer?.text ?? selectionQuote, 'cursor');
                            setTouchQuoteOffer(null);
                        }}
                    ><TextQuote size={14} aria-hidden /><span>{t('session.chat.readingAids.quoteSelectionLong')}</span></button>}
                    {canFork && <ForkFromHereButton session={session} message={userMessage} hasAttachments={hasAttachments} onNote={setForkNote} />}
                    {canRewind && <button ref={editButton} type="button" className="msg-action" aria-label={copy.edit} title={copy.edit} onClick={openEditor}><Pencil size={14} aria-hidden /></button>}
                    {canRewind && <button ref={deleteButton} type="button" className="msg-action" aria-label={copy.delete} title={copy.delete} onClick={() => { setError(null); setMode('delete'); }}><Trash2 size={14} aria-hidden /></button>}
                </div>}
                {send?.state === 'failed'
                    ? <SendFailedActions sessionId={sessionId} status={send} />
                    : <>
                        {send?.state === 'sending' && <SendingIndicator localId={userMessage?.localId ?? send.localId} />}
                        {!send && userMessage && <SentFlash localId={userMessage.localId} />}
                        {!send && userMessage && <DeliverOnResumeHint sessionId={sessionId} messageId={userMessage.id} />}
                        {!send && status}
                        <MessageTime createdAt={createdAt} />
                    </>}
            </div>}
        {forkNote && mode === 'idle' && <p role="alert" className="msg-edit-error msg-fork-note">{forkNote}</p>}
    </>;
}

/** B-851: 「从这里分叉」 — a blocked or failed fork explains itself under the row (`onNote`). */
function ForkFromHereButton({ session, message, hasAttachments, onNote }: {
    session: Session; message: UserTextMessage; hasAttachments: boolean; onNote: (note: string | null) => void;
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [forking, setForking] = useState(false);
    const start = () => {
        if (forking) return;
        const target = messageForkTarget(session, message, hasAttachments);
        if (typeof target === 'string') { onNote(forkReasonText(t, target)); return; }
        onNote(null);
        setForking(true);
        forkFromMessage(session, target, message.text)
            .then((id) => navigate(`/session/${encodeURIComponent(id)}`))
            .catch((cause) => {
                const failure = cause instanceof ForkFailure ? cause : new ForkFailure('failed', String(cause));
                onNote(forkReasonText(t, failure.kind, failure.message));
            })
            .finally(() => setForking(false));
    };
    return <button type="button" className="msg-action" aria-label={t('session.forkFromHere')} title={t('session.forkFromHere')} aria-busy={forking} disabled={forking} onClick={start}>
        {forking ? <Spinner size={14} /> : <GitFork size={14} aria-hidden />}
    </button>;
}
