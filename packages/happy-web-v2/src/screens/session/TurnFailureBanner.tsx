/**
 * B-913: "this turn stopped on a model API error" — the strip above the
 * composer, with 「重试」 (sends the last user message again) and 「隐藏」.
 *
 * Before this a 400 / an exhausted 529 left one grey line in the transcript
 * and an idle sidebar row; the Owner found a 400 two hours later. The wrapper
 * (turn-failure-v1) records the failure in agentState and clears it when the
 * next turn starts or succeeds; this strip only reads it (`sessionTurnFailure`).
 * Process crashes keep their own lines / the B-901 card — the CLI never
 * records them as turn failures, so the two never show for one event.
 */
import { useState } from 'react';
import { RotateCcw, TriangleAlert, X } from 'lucide-react';
import { useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { useSession, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { lastUserMessage, sessionTurnFailure } from '@/sync/turnFailure';
import './mirror.css';

export function TurnFailureBanner({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const toast = useToast();
    const session = useSession(sessionId);
    const { messages } = useSessionMessages(sessionId);
    // Keyed by the failure's own time: a NEW failure shows again.
    const [hiddenAt, setHiddenAt] = useState<number | null>(null);
    const [retrying, setRetrying] = useState(false);
    const failure = sessionTurnFailure(session);
    if (!failure || failure.at === hiddenAt) return null;
    const last = lastUserMessage(messages, 'newest-first');
    const retry = async () => {
        if (!last || retrying) return;
        setRetrying(true);
        try {
            await sync.sendMessage(sessionId, last.text, { source: 'chat', ...(last.displayText ? { displayText: last.displayText } : {}) });
            // The wrapper clears the failure when it takes the message; until
            // then this tab already knows the retry went out.
            setHiddenAt(failure.at);
        } catch (e) {
            toast.error(t('session.chat.turnFailedRetryFailed', { error: e instanceof Error ? e.message : String(e) }));
        } finally {
            setRetrying(false);
        }
    };
    return (
        <div className="mrb" data-testid="turn-failure-banner" data-kind="turn-failure">
            <div className="mrb-note mrb-note--decision" role="alert">
                <TriangleAlert size={13} />
                <span className="mrb-note-text" title={failure.summary}>
                    <strong>{t('session.chat.turnFailedTitle')}</strong>
                    <span className="mrb-note-sep" aria-hidden> · </span>
                    <span className="mrb-turn-error" data-testid="turn-failure-summary">{failure.summary}</span>
                </span>
                <span className="mrb-note-actions">
                    {last && (
                        <button type="button" className="mrb-term-btn" onClick={() => void retry()} disabled={retrying}
                            title={t('session.chat.turnFailedRetryTitle') as string}>
                            <RotateCcw size={13} />
                            <span>{t('session.chat.turnFailedRetry')}</span>
                        </button>
                    )}
                    <button type="button" className="mrb-dismiss" onClick={() => setHiddenAt(failure.at)}
                        aria-label={t('session.chat.turnFailedDismiss') as string} title={t('session.chat.turnFailedDismiss') as string}>
                        <X size={13} />
                    </button>
                </span>
            </div>
        </div>
    );
}
