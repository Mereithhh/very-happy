import { useEffect, useReducer } from 'react';
import { AlertCircle } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui/Spinner';
import { sync } from '@/sync/sync';
import { hasComposer, restoreToComposer, useHasComposer } from './composerRestore';
import { clearSendSpinner, sendSpinnerRemaining, type TurnSendStatus } from './sendStatusModel';

/** Spinner for a `sending` item — only after it has been sending for 150ms. */
export function SendingIndicator({ localId }: { localId: string }) {
    const { t } = useTranslation();
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    const remaining = sendSpinnerRemaining(localId, Date.now());
    useEffect(() => {
        if (remaining <= 0) return;
        const timer = setTimeout(rerender, remaining);
        return () => clearTimeout(timer);
    }, [localId, remaining]);
    return <span className="msg-sending" role="status" aria-label={t('session.chat.sending')}>
        {remaining <= 0 && <Spinner size={12} />}
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

/** 「发送失败 · 重试 · 放回输入框」 — replaces the message time on a failed turn. */
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
    return <span className="msg-send-failed" role="status">
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
    </span>;
}
