/**
 * B-891: above the composer — 「N 条批注」 instead of a wall of `> quote`
 * text. Expands into the list (excerpt + note, edit / delete, click to jump
 * back to the passage). The comments themselves are composed into the message
 * at send time (AgentInput / SharedComposer → composeAnnotatedMessage).
 */
import { useState } from 'react';
import { ChevronDown, MessageSquareText, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { toast } from '@/ui';
import { requestChatJump } from '@/screens/search/chatJump';
import { excerptPreview } from './chatAnnotations';
import {
    clearChatAnnotations,
    deleteChatAnnotation,
    openAnnotationEditor,
    useChatAnnotations,
    useStaleAnnotationIds,
} from './chatAnnotationsStore';
import './chatAnnotations.css';

export function ChatAnnotationsTray({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const annotations = useChatAnnotations(sessionId);
    const stale = useStaleAnnotationIds(sessionId);
    const [open, setOpen] = useState(false);
    if (annotations.length === 0) return null;
    const staleCount = annotations.filter((a) => stale.has(a.id)).length;
    const listId = `can-tray-${sessionId}`;

    const jump = (id: string, messageId: string) => {
        requestChatJump(sessionId, { terms: [], messageId, flash: true });
        // once landed, point at the passage itself
        window.setTimeout(() => {
            document.querySelector(`.can-marker[data-annotation-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 400);
    };
    const remove = (id: string) => {
        if (deleteChatAnnotation(sessionId, id) !== 'ok') toast.show(t('session.chat.annotations.saveFailed'), 'error');
    };

    return (
        <section className="can-tray" aria-label={t('session.chat.annotations.trayLabel')}>
            <div className="can-tray-head">
                <button type="button" className="can-tray-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
                    <MessageSquareText size={13} aria-hidden />
                    <span>{t('session.chat.annotations.count', { count: annotations.length })}</span>
                    {staleCount > 0 && <span className="can-tray-stale">· {t('session.chat.annotations.staleCount', { count: staleCount })}</span>}
                    <ChevronDown size={13} aria-hidden className={`can-tray-chevron${open ? ' can-tray-chevron--open' : ''}`} />
                </button>
                <span className="can-tray-note">{t('session.chat.annotations.sendsWith')}</span>
                {open && (
                    <button type="button" className="can-icon" onClick={() => { if (clearChatAnnotations(sessionId) !== 'ok') toast.show(t('session.chat.annotations.saveFailed'), 'error'); }} aria-label={t('session.chat.annotations.clear')} title={t('session.chat.annotations.clear')}>
                        <Trash2 size={13} aria-hidden />
                    </button>
                )}
            </div>
            {open && (
                <ol id={listId} className="can-tray-list">
                    {annotations.map((a, i) => (
                        <li key={a.id} className="can-tray-item">
                            <button type="button" className="can-tray-jump" onClick={() => jump(a.id, a.messageId)} title={t('session.chat.annotations.jump')}>
                                <span className="can-tray-num" aria-hidden>{i + 1}</span>
                                <span className="can-tray-text">
                                    <span className="can-tray-excerpt">{excerptPreview(a.excerpt)}</span>
                                    <span className="can-tray-body">{a.body}</span>
                                    {stale.has(a.id) && <span className="can-tray-stale">{t('session.chat.annotations.stale')}</span>}
                                </span>
                            </button>
                            <span className="can-tray-actions">
                                <button
                                    type="button"
                                    className="can-icon"
                                    aria-label={t('session.chat.annotations.edit', { n: i + 1 })}
                                    title={t('session.chat.annotations.edit', { n: i + 1 })}
                                    onClick={(event) => {
                                        const r = event.currentTarget.getBoundingClientRect();
                                        openAnnotationEditor({ sessionId, kind: 'edit', id: a.id, place: { left: r.left, top: r.top, bottom: r.bottom } });
                                    }}
                                ><Pencil size={13} aria-hidden /></button>
                                <button type="button" className="can-icon" aria-label={t('session.chat.annotations.deleteN', { n: i + 1 })} title={t('session.chat.annotations.deleteN', { n: i + 1 })} onClick={() => remove(a.id)}>
                                    <Trash2 size={13} aria-hidden />
                                </button>
                            </span>
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
}
