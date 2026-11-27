/**
 * B-980: 👍 / 👎 under a turn's final answer (`specs/2026-11-model-feedback.md` §Web).
 * Shown only when the operator turned model feedback on, and — with the default
 * `tagged` scope — only on turns whose model requests the CLI tagged, so every
 * rating can be joined to the gateway's request log. 👎 opens a one-line note.
 * Tapping the chosen thumb again takes the rating back.
 */
import { useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import type { Session } from '@/sync/storageTypes';
import type { AgentTextMessage } from '@/sync/typesMessage';
import { clearModelAnswerRating, rateModelAnswer, useInstanceConfig, useModelFeedbackRating, type ModelFeedbackRating } from '@/sync/apiModelFeedback';
import { modelFeedbackBody, showsModelFeedback } from './modelFeedbackPolicy';
import { useTranslation } from '@/i18n/useTranslation';
import { Button } from '@/ui/Button';
import { toast } from '@/ui';
import { modelFeedbackCopy } from './modelFeedbackCopy';
import './modelFeedback.css';

export function ModelFeedbackButtons({ session, sessionId, message }: { session: Session | null | undefined; sessionId: string; message: AgentTextMessage }) {
    const config = useInstanceConfig();
    const visible = showsModelFeedback(config, message);
    const current = useModelFeedbackRating(sessionId, message.turnId, visible);
    const { lang } = useTranslation();
    const copy = modelFeedbackCopy(lang);
    const [busy, setBusy] = useState(false);
    const [noteOpen, setNoteOpen] = useState(false);
    const [note, setNote] = useState('');
    if (!visible) return null;

    const submit = async (rating: ModelFeedbackRating, comment?: string) => {
        if (busy) return;
        setBusy(true);
        try {
            if (current?.rating === rating && comment === undefined) {
                await clearModelAnswerRating(sessionId, message.turnId!);
                setNoteOpen(false);
            } else {
                await rateModelAnswer(modelFeedbackBody(session, message, sessionId, rating, comment));
                if (rating === 'down' && comment === undefined) { setNote(current?.comment ?? ''); setNoteOpen(true); }
                else setNoteOpen(false);
                if (comment !== undefined) toast.success(copy.thanks);
            }
        } catch {
            toast.error(copy.failed);
        } finally {
            setBusy(false);
        }
    };

    return <>
        <button type="button" className="msg-action mf-thumb" aria-pressed={current?.rating === 'up'} aria-label={copy.up} title={copy.up} disabled={busy} onClick={() => void submit('up')}>
            <ThumbsUp size={14} aria-hidden />
        </button>
        <button type="button" className="msg-action mf-thumb" aria-pressed={current?.rating === 'down'} aria-label={copy.down} title={copy.down} disabled={busy} onClick={() => void submit('down')}>
            <ThumbsDown size={14} aria-hidden />
        </button>
        {noteOpen && <form className="mf-note" onSubmit={(e) => { e.preventDefault(); void submit('down', note); }}>
            <input className="mf-note-input" value={note} maxLength={2000} autoFocus placeholder={copy.notePlaceholder} aria-label={copy.notePlaceholder} onChange={(e) => setNote(e.target.value)} />
            <Button size="sm" type="submit" loading={busy}>{copy.send}</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setNoteOpen(false)}>{copy.skip}</Button>
        </form>}
    </>;
}
