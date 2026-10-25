import { useEffect, useReducer, useState } from 'react';
import { AlertCircle, Check, Clock3, CloudOff, ListEnd, Trash2, Undo2 } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui/Spinner';
import { sync } from '@/sync/sync';
import { useJustSent } from '@/sync/sendConfirmations';
import type { PendingPrompt } from '@/sync/promptQueue';
import { stripEditedDrafts } from '@/sync/editableDrafts';
import { hasComposer, restoreToComposer, useHasComposer } from './composerRestore';
import { clearSendSpinner, sendSpinnerRemaining, undeliveredPromptId, type TurnSendStatus } from './sendStatusModel';
import { storage } from '@/sync/storage';
import { useReconnectingHint } from './useReconnectingHint';

/** B-722: `navigator.onLine`, live. */
export function useBrowserOnline(): boolean {
    const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
    useEffect(() => {
        const update = () => setOnline(navigator.onLine !== false);
        window.addEventListener('online', update);
        window.addEventListener('offline', update);
        return () => {
            window.removeEventListener('online', update);
            window.removeEventListener('offline', update);
        };
    }, []);
    return online;
}

/** B-722: a send cannot leave right now — the device is offline or the connection is being re-established. */
export function useSendWaitsForNetwork(): boolean {
    const online = useBrowserOnline();
    const reconnecting = useReconnectingHint();
    return !online || reconnecting;
}

/**
 * 「发送中」 for a `sending` item. B-722: a quiet clock from the first frame (a
 * static icon cannot flash on a fast ack); after 150ms it turns into a spinner.
 * Offline / reconnecting it says where the message is: 「连接恢复后发送」.
 */
export function SendingIndicator({ localId }: { localId: string }) {
    const { t } = useTranslation();
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    const waiting = useSendWaitsForNetwork();
    const remaining = sendSpinnerRemaining(localId, Date.now());
    useEffect(() => {
        if (remaining <= 0) return;
        const timer = setTimeout(rerender, remaining);
        return () => clearTimeout(timer);
    }, [localId, remaining]);
    const label = waiting ? t('session.chat.sendingOffline') : t('session.chat.sending');
    return <span className={`msg-sending${waiting ? ' msg-sending--waiting' : ''}`} role="status" aria-live="polite" aria-label={label} data-send-state={waiting ? 'waiting' : 'sending'}>
        {waiting
            ? <><CloudOff size={12} aria-hidden /><span>{label}</span></>
            : remaining <= 0 ? <Spinner size={12} /> : <Clock3 size={12} aria-hidden />}
    </span>;
}

/** B-722: 「已发送」 — a check that fades out right after the server confirmed; nothing stays. */
export function SentFlash({ localId }: { localId: string | null | undefined }) {
    const { t } = useTranslation();
    const justSent = useJustSent(localId);
    if (!justSent) return null;
    return <span className="msg-sent" role="status" aria-live="polite" aria-label={t('session.chat.sent')} data-send-state="sent">
        <Check size={12} aria-hidden />
    </span>;
}

/** Forget the spinner start when this item stops sending (a retry starts a fresh delay). */
export function useSendSpinnerReset(status: TurnSendStatus | null, localId: string | null) {
    const sending = status?.state === 'sending';
    useEffect(() => {
        if (!sending && localId) clearSendSpinner(localId);
    }, [sending, localId]);
}

/**
 * The queue dock renders rows in a loop, so it cannot call the per-row hook:
 * forget the spinner start of every listed item that is not sending (review
 * B-513 — otherwise a retried row shows its spinner at once, and entries leak).
 */
export function useSendSpinnerResetAll(items: readonly { localId?: string | null; sendState?: string }[]) {
    useEffect(() => {
        for (const item of items) {
            if (item.localId && item.sendState !== 'sending') clearSendSpinner(item.localId);
        }
    }, [items]);
}

/**
 * B-722: 「已保存 · 会话恢复后送达」 under the newest unanswered prompt of an
 * offline session — the server has it, the agent does not yet.
 */
export function DeliverOnResumeHint({ sessionId, messageId }: { sessionId: string; messageId: string }) {
    const { t } = useTranslation();
    const waiting = storage((state) => undeliveredPromptId(
        state.sessionMessages[sessionId]?.messages,
        state.sessions[sessionId]?.presence === 'online',
    ) === messageId);
    if (!waiting) return null;
    return <span className="msg-deliver-later" role="status" aria-live="polite" data-send-state="deliver-on-resume">
        <CloudOff size={12} aria-hidden />
        <span>{t('session.chat.deliverOnResume')}</span>
    </span>;
}

/** 「发送失败 · 重试 · 放回输入框 · 删除」 — replaces the message time on a failed turn. */
export function SendFailedActions({ sessionId, status }: { sessionId: string; status: TurnSendStatus }) {
    const { t } = useTranslation();
    const composerMounted = useHasComposer(sessionId);
    const canRestore = status.restorable && composerMounted;
    const takeBack = () => {
        // Withdraw only when the text has somewhere to go.
        if (!hasComposer(sessionId)) return;
        const text = sync.takeBackFailedMessage(sessionId, status.localId);
        if (text !== null) restoreToComposer(sessionId, text);
    };
    // B-722: drop it outright — only when no attempt could have stored it.
    const discard = () => { sync.takeBackFailedMessage(sessionId, status.localId); };
    if (status.stale) {
        // B-814: from an earlier page load, past the 10-minute window — the user decides.
        return <span className="msg-send-failed" role="status" aria-live="polite" data-send-state="stale">
            <AlertCircle size={13} aria-hidden />
            <span>{t('session.chat.sendNotSent')}</span>
            <span className="msg-send-sep" aria-hidden>·</span>
            <button type="button" className="msg-send-action" onClick={() => sync.retrySend(sessionId, status.localId)}>
                {t('session.chat.sendResend')}
            </button>
            <span className="msg-send-sep" aria-hidden>·</span>
            <button type="button" className="msg-send-action" onClick={() => sync.discardStaleMessage(sessionId, status.localId)}>
                {t('session.chat.sendDiscard')}
            </button>
        </span>;
    }
    return <span className="msg-send-failed" role="status" aria-live="polite" data-send-state="failed">
        <AlertCircle size={13} aria-hidden />
        <span>{t('session.chat.sendFailed')}</span>
        <span className="msg-send-sep" aria-hidden>·</span>
        <button type="button" className="msg-send-action" onClick={() => sync.retrySend(sessionId, status.localId)}>
            {t('session.chat.sendRetry')}
        </button>
        {canRestore && <>
            <span className="msg-send-sep" aria-hidden>·</span>
            <button type="button" className="msg-send-action" onClick={takeBack}>
                {t('session.chat.sendRestore')}
            </button>
        </>}
        {status.restorable && <>
            <span className="msg-send-sep" aria-hidden>·</span>
            <button type="button" className="msg-send-action" onClick={discard}>
                {t('session.chat.sendDelete')}
            </button>
        </>}
    </span>;
}

/**
 * B-722: a prompt submitted to the server queue that the server has not
 * confirmed yet — shown at once instead of after the POST answered.
 */
export function PendingQueueRow({ text, state, onRetry, onRestore, onDelete }: {
    text: string;
    state: PendingPrompt['state'];
    onRetry: () => void;
    onRestore: () => void;
    onDelete: () => void;
}) {
    const { t } = useTranslation();
    const status = state === 'sending' ? t('session.chat.queueAdding')
        : state === 'waiting' ? t('session.chat.queueWaitingNetwork')
        : t('session.chat.queueAddFailed');
    return (
        <div className={`ci-queue-item ci-queue-item--pending ci-queue-item--${state}`} data-queue-item-source="pending" aria-busy={state === 'sending'}>
            <ListEnd className="ci-queue-index" size={17} aria-hidden />
            <div className="ci-queue-body">
                <span className="ci-queue-text">{stripEditedDrafts(text) || t('session.chat.attachmentOnly')}</span>
                <span className={`ci-queue-status ci-queue-status--${state}`} role="status" aria-live="polite" data-send-state={state}>
                    {state === 'sending' ? <Clock3 size={12} aria-hidden /> : state === 'waiting' ? <CloudOff size={12} aria-hidden /> : <AlertCircle size={12} aria-hidden />}
                    <span>{status}</span>
                </span>
            </div>
            <div className="ci-queue-actions">
                {state !== 'sending' && <>
                    <button type="button" className="ci-queue-action ci-queue-action--retry" onClick={onRetry}>{t('session.chat.sendRetry')}</button>
                    <button type="button" className="ci-queue-action" onClick={onRestore} aria-label={t('session.chat.sendRestore')} title={t('session.chat.sendRestore')}><Undo2 size={15} aria-hidden /></button>
                    <button type="button" className="ci-queue-action" onClick={onDelete} aria-label={t('session.chat.queueDelete')} title={t('session.chat.queueDelete')}><Trash2 size={15} aria-hidden /></button>
                </>}
            </div>
        </div>
    );
}

/**
 * B-804: a queued prompt the wrapper already took — off the server queue, not
 * in the transcript yet. It stays in the dock as 「执行中」 until its message
 * shows up there, so it is never visible in neither place.
 */
export function DispatchedQueueRow({ text }: { text: string }) {
    const { t } = useTranslation();
    return (
        <div className="ci-queue-item ci-queue-item--pending ci-queue-item--running" data-queue-item-source="dispatched" aria-busy>
            <ListEnd className="ci-queue-index" size={17} aria-hidden />
            <div className="ci-queue-body">
                <span className="ci-queue-text">{stripEditedDrafts(text) || t('session.chat.attachmentOnly')}</span>
                <span className="ci-queue-status ci-queue-status--running" role="status" aria-live="polite" data-send-state="running">
                    <Spinner size={12} />
                    <span>{t('session.chat.queueRunning')}</span>
                </span>
            </div>
        </div>
    );
}
