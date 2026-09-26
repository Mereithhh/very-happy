/**
 * AutomationAttentionBanner (B-508) — strip under the chat header of a session
 * some automation run is waiting on (the run's own session, or one its payload
 * named). Says which automation and why, offers 「知道了」 (ack), a link to the
 * automation, and a dismiss for this visit. The server clears the flag on its
 * own when the owner replies here (`ackedBy = owner-replied`) once the wrapper
 * stamps relay-delivered messages (CLI ≥ 0.2.158); until then the banner does
 * it from the decrypted side — a new owner-authored user message hides it at
 * once and acks the runs — so it never lingers after a reply.
 *
 * Token discipline as the other strips (mirror.css): bg ladder + --danger for
 * the decision signal (same meaning as the board's 「需要我决策」), no --accent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, X, Zap } from 'lucide-react';
import { storage } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner, toast } from '@/ui';
import { AUTOMATIONS_BOARD_POLL_MS, useAutomations, useAutomationsPoll } from '@/sync/automationsStore';
import { attentionRunsForSession, isOwnerAuthoredUserMessage } from '@/screens/automations/automationPresentation';
import { reportAutomationError, useAttentionReason } from '@/screens/automations/AutomationShared';
import './mirror.css';

/** Newest owner-authored user message time in the session (0 when none). Pure over the message list. */
export function latestOwnerReplyAt(messages: ReadonlyArray<{ kind: string; createdAt: number; meta?: { sentFrom?: string } | null }> | undefined): number {
    let latest = 0;
    if (!messages) return latest;
    for (const message of messages) {
        if (isOwnerAuthoredUserMessage(message) && message.createdAt > latest) latest = message.createdAt;
    }
    return latest;
}

/** Mount with `key={sessionId}`: the reply baseline and the dismissed set are per visit. */
export function AutomationAttentionBanner({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const enabled = useAutomations((s) => s.enabled);
    const attention = useAutomations((s) => s.attention);
    const refreshOverview = useAutomations((s) => s.refreshOverview);
    const ack = useAutomations((s) => s.ack);
    const reason = useAttentionReason();
    useAutomationsPoll(refreshOverview, AUTOMATIONS_BOARD_POLL_MS);
    const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
    const [busy, setBusy] = useState(false);

    const runs = useMemo(() => attentionRunsForSession(attention, sessionId).filter((run) => !hidden.has(run.id)), [attention, sessionId, hidden]);

    // The owner replied here → the server is clearing the flag; hide now, confirm shortly.
    const messageCount = storage((s) => s.sessionMessages[sessionId]?.messages.length ?? 0);
    const replyBaseline = useRef<number | null>(null);
    useEffect(() => {
        const latest = latestOwnerReplyAt(storage.getState().sessionMessages[sessionId]?.messages);
        if (replyBaseline.current === null) { replyBaseline.current = latest; return; }
        if (latest <= replyBaseline.current || runs.length === 0) return;
        replyBaseline.current = latest;
        const replied = runs.map((run) => run.id);
        setHidden((prev) => new Set([...prev, ...replied]));
        // The web's message reaches the server through the wrapper (relay path); an older wrapper does not mark
        // it as the client's, so the web resolves the runs itself — idempotent when the server already did.
        void (async () => {
            for (const id of replied) await ack(id, 'owner-replied').catch(() => undefined);
            await refreshOverview();
        })();
    }, [messageCount, sessionId, runs, refreshOverview, ack]);

    const acknowledge = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        try {
            for (const run of runs) await ack(run.id, 'owner');
            toast.success(t('automations.acked') as string);
        } catch (error) {
            reportAutomationError(error, t);
        } finally {
            setBusy(false);
        }
    }, [ack, busy, runs, t]);

    if (enabled !== true || runs.length === 0) return null;
    const first = runs[0];
    return (
        <div className="mrb" data-testid="automation-attention-banner" data-kind="automation-attention">
            <div className="mrb-note mrb-note--decision" role="status">
                <Zap size={13} />
                <span className="mrb-note-text">
                    <button type="button" className="mrb-inline-link mono" onClick={() => navigate(`/automations/${encodeURIComponent(first.automationId)}`)}>
                        {first.automationName}
                    </button>
                    <span className="mrb-note-sep" aria-hidden> · </span>
                    <span>{reason(first)}</span>
                    {runs.length > 1 && <span className="mrb-note-more mono">{t('automations.bannerMore', { count: runs.length - 1 })}</span>}
                    <span className="mrb-note-hint">{t('automations.bannerHint')}</span>
                </span>
                <button type="button" className="mrb-term-btn mono" onClick={() => void acknowledge()} disabled={busy} aria-busy={busy}>
                    {busy ? <Spinner size={13} /> : <Check size={13} />}
                    <span>{t('automations.ack')}</span>
                </button>
                <button
                    type="button"
                    className="mrb-dismiss"
                    onClick={() => setHidden((prev) => new Set([...prev, ...runs.map((run) => run.id)]))}
                    aria-label={t('automations.bannerDismiss') as string}
                    title={t('automations.bannerDismiss') as string}
                >
                    <X size={13} />
                </button>
            </div>
        </div>
    );
}
