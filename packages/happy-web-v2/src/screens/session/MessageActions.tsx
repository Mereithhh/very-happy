import { useId, useRef, useState, type ReactNode } from 'react';
import { Pencil, Quote, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { CopyButton } from '@/ui/CopyButton';
import { Button } from '@/ui/Button';
import { toast } from '@/ui/Toast';
import { sync } from '@/sync/sync';
import type { UserTextMessage } from '@/sync/typesMessage';
import { quoteMessage } from './messageQuote';
import { messageActionsCopy } from './messageActionsCopy';
import { MessageTime } from './MessageTime';
import './messageActions.css';

/**
 * MessageActions — copy / quote / edit row under a message, plus the inline
 * editor the Edit button opens.
 *
 * Edit is a plain in-place resend: prefill the editor with the message, and on
 * submit send the edited text as a NEW message in THIS session — the same path
 * as typing in the composer. No branch/fork, no rewind-point selection, no
 * navigation. (The earlier flow forked a new session at a rewind point; the
 * owner asked for the simple resend instead.)
 */
export function MessageActions({ text, sessionId, userMessage, createdAt = userMessage?.createdAt, children }: {
    text: string; sessionId: string; userMessage?: UserTextMessage; createdAt?: number; hasAttachments?: boolean; children?: ReactNode;
}) {
    const { t, lang } = useTranslation();
    const copy = messageActionsCopy(lang);
    const editId = useId();
    const editButton = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [edited, setEdited] = useState(text);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const [error, setError] = useState<string | null>(null);

    const closeEditor = () => {
        if (busyRef.current) return;
        setOpen(false);
        setError(null);
        requestAnimationFrame(() => editButton.current?.focus());
    };
    const openEditor = () => {
        setEdited(text);
        setError(null);
        setOpen(true);
    };
    const submit = async () => {
        if (busyRef.current || !edited.trim()) return;
        busyRef.current = true;
        setBusy(true);
        setError(null);
        try {
            const receipt = await sync.sendMessage(sessionId, edited, { source: 'chat' });
            if (!receipt) throw new Error(copy.failed);
            toast.success(copy.queued);
            setOpen(false);
            requestAnimationFrame(() => editButton.current?.focus());
        } catch (cause) {
            setError(cause instanceof Error && cause.message ? cause.message : copy.failed);
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };

    return <>
        {!open && children}
        {!open && <div className="msg-actions" role={text ? 'group' : undefined} aria-label={text ? copy.actions : undefined}>
            {text && <div className="msg-actions-items">
                <CopyButton text={text} size={14} label={t('message.copyMessage')} />
                <button type="button" className="msg-action" aria-label={copy.quote} title={copy.quote} onClick={() => quoteMessage(sessionId, text)}><Quote size={14} aria-hidden /></button>
                {userMessage && <button ref={editButton} type="button" className="msg-action" aria-label={copy.edit} title={copy.edit} onClick={openEditor}><Pencil size={14} aria-hidden /></button>}
            </div>}
            <MessageTime createdAt={createdAt} />
        </div>}
        {userMessage && open && <section className="msg-edit-inline" aria-labelledby={editId} onKeyDown={event => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); closeEditor(); }
        }}>
            <div className="msg-edit-head">
                <h2 id={editId}>{copy.title}</h2>
                <button className="msg-action" type="button" disabled={busy} aria-label={copy.cancel} onClick={closeEditor}><X size={18} /></button>
            </div>
            <label className="msg-edit-label">
                <span className="sr-only">{copy.text}</span>
                <textarea
                    autoFocus
                    value={edited}
                    disabled={busy}
                    onChange={(event) => setEdited(event.target.value)}
                    onKeyDown={event => {
                        // ⌘/Ctrl+Enter resends; plain Enter keeps a newline so
                        // multi-line edits are not cut off mid-thought.
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            void submit();
                        }
                    }}
                />
            </label>
            <p className="msg-edit-description">{copy.description}</p>
            {error && <p role="alert" className="msg-edit-error">{error}</p>}
            <div className="msg-edit-footer">
                <Button onClick={closeEditor} disabled={busy}>{copy.cancel}</Button>
                <Button variant="primary" loading={busy} disabled={!edited.trim()} onClick={() => void submit()}>{busy ? copy.busy : copy.submit}</Button>
            </div>
        </section>}
    </>;
}
