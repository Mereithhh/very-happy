/**
 * B-891: the one comment editor — new (from a selection) or existing (from a
 * marker / the composer tray). Desktop: a popover beside the passage, like
 * Codex. Touch / phone width: the shared dialog shell, which lays out as a
 * bottom sheet at ≤600px (styles/dialog.css). ⌘/Ctrl+Enter saves, Esc cancels.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from 'lucide-react';
import { Button, toast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { useImeGuard } from '@/utils/ime';
import { FOCUSABLE_SELECTOR, trapFocusTarget } from '../diffComments/focusTrap';
import { excerptPreview } from './chatAnnotations';
import {
    addChatAnnotation,
    deleteChatAnnotation,
    openAnnotationEditor,
    updateChatAnnotation,
    useAnnotationEditor,
    useChatAnnotations,
    useStaleAnnotationIds,
    type WriteResult,
} from './chatAnnotationsStore';
import './chatAnnotations.css';

const POPOVER_WIDTH = 340;
const GAP = 6;

function useSheetLayout(): boolean {
    const query = '(pointer: coarse), (max-width: 600px)';
    const [sheet, setSheet] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true);
    useEffect(() => {
        const mq = window.matchMedia?.(query);
        if (!mq) return;
        const on = () => setSheet(mq.matches);
        mq.addEventListener?.('change', on);
        return () => mq.removeEventListener?.('change', on);
    }, []);
    return sheet;
}

export function ChatAnnotationEditor({ sessionId }: { sessionId: string }) {
    const state = useAnnotationEditor();
    if (!state || state.sessionId !== sessionId) return null;
    // keyed: switching to another comment starts a fresh draft
    return <EditorCard key={state.kind === 'edit' ? state.id : `new:${state.anchor.seq}:${state.anchor.start}`} sessionId={sessionId} />;
}

function EditorCard({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const state = useAnnotationEditor()!;
    const annotations = useChatAnnotations(sessionId);
    const stale = useStaleAnnotationIds(sessionId);
    const sheet = useSheetLayout();
    const ime = useImeGuard();
    const titleId = useId();
    const cardRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const index = state.kind === 'edit' ? annotations.findIndex((a) => a.id === state.id) : -1;
    const existing = index >= 0 ? annotations[index] : null;
    const initial = existing?.body ?? '';
    const [body, setBody] = useState(initial);
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    const excerpt = state.kind === 'new' ? state.anchor.excerpt : existing?.excerpt ?? '';
    const number = state.kind === 'new' ? annotations.length + 1 : index + 1;

    // The comment was deleted elsewhere (tray, another tab): nothing to edit.
    useEffect(() => {
        if (state.kind === 'edit' && !existing) openAnnotationEditor(null);
    }, [state.kind, existing]);


    // Desktop popover: below the passage, flipped above when it would leave the window.
    useLayoutEffect(() => {
        if (sheet) return;
        const card = cardRef.current;
        const place = state.place;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const width = Math.min(POPOVER_WIDTH, vw - 16);
        const height = card?.offsetHeight ?? 180;
        const anchorLeft = place ? place.left : (vw - width) / 2;
        const left = Math.min(Math.max(8, anchorLeft - 12), vw - width - 8);
        let top = place ? place.bottom + GAP : (vh - height) / 2;
        if (place && top + height > vh - 8) top = Math.max(8, place.top - GAP - height);
        setPos({ left, top });
    }, [sheet, state.place]);

    // Focus once visible: the popover is `visibility: hidden` until placed, and a hidden field refuses focus.
    const focusedRef = useRef(false);
    useLayoutEffect(() => {
        const el = textareaRef.current;
        if (focusedRef.current || !el || (!sheet && !pos)) return;
        focusedRef.current = true;
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
    }, [sheet, pos]);

    const close = () => openAnnotationEditor(null);
    const report = (result: WriteResult): boolean => {
        if (result === 'ok') return true;
        toast.show(result === 'quota' ? t('session.chat.annotations.quota') : t('session.chat.annotations.saveFailed'), 'error');
        return false;
    };
    const save = () => {
        const text = body.trim();
        if (!text) return;
        if (state.kind === 'new') {
            if (!report(addChatAnnotation(sessionId, state.anchor, text))) return;
            window.getSelection()?.removeAllRanges();
        } else if (existing && text !== existing.body) {
            if (!report(updateChatAnnotation(sessionId, existing.id, text))) return;
        }
        close();
    };
    const remove = () => {
        if (existing) report(deleteChatAnnotation(sessionId, existing.id));
        close();
    };

    // Desktop: a click elsewhere dismisses an untouched editor; a written one stays.
    useEffect(() => {
        if (sheet) return;
        const onDown = (event: PointerEvent) => {
            if (cardRef.current?.contains(event.target as Node)) return;
            if ((event.target as Element | null)?.closest?.('.can-marker, .cl-selquote, .can-tray')) return;
            if (body.trim() === initial.trim()) close();
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
    }, [sheet, body, initial]);

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (ime.isGuarded(event)) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); return; }
        if (sheet && event.key === 'Tab' && cardRef.current) {
            const items = [...cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
            const target = trapFocusTarget(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey);
            if (target !== null) { event.preventDefault(); items[target]?.focus(); }
        }
    };

    const title = state.kind === 'new' ? t('session.chat.annotations.newTitle') : t('session.chat.annotations.editTitle', { n: number });
    const card = (
        <div
            ref={cardRef}
            className={sheet ? 'vh-dialog can-editor can-editor--sheet' : 'can-editor can-editor--popover'}
            role="dialog"
            aria-modal={sheet ? true : undefined}
            aria-labelledby={titleId}
            style={sheet ? undefined : pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden', left: 0, top: 0 }}
            onKeyDown={onKeyDown}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
        >
            <div className="can-editor-head">
                <span className="can-editor-num" aria-hidden>{number}</span>
                <h2 id={titleId} className="can-editor-title">{title}</h2>
                {sheet && <button type="button" className="vh-dialog-close" onClick={close} aria-label={t('common.cancel')}><X size={16} /></button>}
            </div>
            {excerpt && <blockquote className="can-editor-quote">{excerptPreview(excerpt, 240)}</blockquote>}
            {existing && stale.has(existing.id) && <p className="can-editor-stale">{t('session.chat.annotations.staleHint')}</p>}
            <textarea
                ref={textareaRef}
                className="can-editor-input"
                rows={3}
                value={body}
                placeholder={t('session.chat.annotations.placeholder')}
                aria-label={title}
                maxLength={4000}
                onChange={(event) => setBody(event.target.value)}
            />
            <div className="can-editor-foot">
                {existing && (
                    <button type="button" className="can-icon can-editor-delete" onClick={remove} aria-label={t('session.chat.annotations.delete')} title={t('session.chat.annotations.delete')}>
                        <Trash2 size={14} aria-hidden />
                    </button>
                )}
                {!sheet && <span className="can-editor-hint">{t('session.chat.annotations.saveHint')}</span>}
                <Button size="sm" onClick={close}>{t('common.cancel')}</Button>
                <Button size="sm" variant="primary" disabled={!body.trim()} onClick={save}>{t('common.save')}</Button>
            </div>
        </div>
    );
    if (typeof document === 'undefined') return null;
    return createPortal(
        sheet
            ? <div className="vh-dialog-overlay can-sheet-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}>{card}</div>
            : card,
        document.body,
    );
}
