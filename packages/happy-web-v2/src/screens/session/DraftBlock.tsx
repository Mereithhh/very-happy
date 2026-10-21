/**
 * DraftBlock (B-642) — a ```draft fence in the agent's reply, rendered as an
 * editable box. Edits persist in account KV (editableDraftsStore) and ride
 * along with the user's next message. See specs/2026-10-editable-drafts.md.
 *
 * Only the conversation's own agent text provides a DraftScope (session + seq);
 * every other Markdown surface (thinking, subagent detail, tool output, file
 * previews) has none and keeps the plain read-only code block.
 */
import React, { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { AlertCircle, Check, PenLine, RotateCcw } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { CopyButton } from '@/ui/CopyButton';
import { draftKeyFor, draftKvKey, DRAFT_FENCE_LANG, DRAFT_TEXT_MAX_CHARS } from '@/sync/editableDrafts';
import { editDraft, ensureDraftsLoaded, retryDraftSave, useEditableDrafts } from '@/sync/editableDraftsStore';
import { Spinner } from '@/ui/Spinner';
import { CodeView } from './CodeView';
import './draftBlock.css';

export interface DraftScope {
    sessionId: string;
    /** server seq of the message — the cross-device identity (agent-text ids are per client) */
    seq: number;
}

export const DraftScopeContext = React.createContext<DraftScope | null>(null);

/** Enables editable drafts for one agent message; no seq (never persisted) = read-only. */
export function DraftScopeProvider({ sessionId, seq, children }: { sessionId: string; seq: number | null | undefined; children: React.ReactNode }) {
    const value = React.useMemo(() => (typeof seq === 'number' ? { sessionId, seq } : null), [sessionId, seq]);
    return <DraftScopeContext.Provider value={value}>{children}</DraftScopeContext.Provider>;
}

export function DraftBlock({ code, title }: { code: string; title?: string }) {
    const scope = useContext(DraftScopeContext);
    if (!scope) return <CodeView code={code} lang={DRAFT_FENCE_LANG} />;
    return <EditableDraft scope={scope} original={code} title={title} />;
}

function EditableDraft({ scope, original, title }: { scope: DraftScope; original: string; title?: string }) {
    const { t } = useTranslation();
    const key = draftKeyFor(scope.seq, original);
    const kvKey = draftKvKey(scope.sessionId, key);
    const rec = useEditableDrafts((s) => s.drafts[kvKey]);
    const save = useEditableDrafts((s) => s.saves[kvKey]);
    const text = rec?.text ?? original;
    const edited = text !== original;
    const taRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => { ensureDraftsLoaded(scope.sessionId); }, [scope.sessionId]);

    // Grow with the content: a draft is read as a whole, never in a nested scroller.
    useLayoutEffect(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = `${ta.scrollHeight}px`;
    }, [text]);

    const setText = (next: string) => editDraft({ sessionId: scope.sessionId, key, original, title, text: next });

    return (
        <div className={`dft${edited ? ' dft--edited' : ''}`} data-draft-key={key}>
            <div className="dft-bar">
                <span className="dft-label">
                    <PenLine size={13} aria-hidden />
                    <span className="dft-title">{title || t('session.chat.draft.label')}</span>
                    {edited && <span className="dft-badge">{t('session.chat.draft.edited')}</span>}
                    {/* B-722: 保存中… → 已保存 (fades), or 未保存 · 重试 — in place, read out politely. */}
                    <span className="dft-save" role="status" aria-live="polite" data-save-state={save}>
                        {save === 'saving' && <><Spinner size={11} /><span>{t('session.chat.saveState.saving')}</span></>}
                        {save === 'saved' && <><Check size={12} aria-hidden /><span>{t('session.chat.saveState.saved')}</span></>}
                        {save === 'failed' && <>
                            <AlertCircle size={12} aria-hidden />
                            <span>{t('session.chat.saveState.failed')}</span>
                            <button type="button" className="dft-save-retry" onClick={() => retryDraftSave(kvKey)}>{t('session.chat.sendRetry')}</button>
                        </>}
                    </span>
                </span>
                <span className="dft-actions">
                    {edited && (
                        <button
                            type="button"
                            className="dft-restore"
                            onClick={() => setText(original)}
                            title={t('session.chat.draft.restore')}
                            aria-label={t('session.chat.draft.restore')}
                        >
                            <RotateCcw size={13} aria-hidden />
                            <span>{t('session.chat.draft.restore')}</span>
                        </button>
                    )}
                    <CopyButton text={() => taRef.current?.value ?? text} showLabel className="dft-copy" />
                </span>
            </div>
            <textarea
                ref={taRef}
                className="dft-text"
                value={text}
                maxLength={DRAFT_TEXT_MAX_CHARS}
                spellCheck
                rows={1}
                aria-label={title ? t('session.chat.draft.editNamed', { title }) : t('session.chat.draft.edit')}
                onChange={(event) => setText(event.target.value)}
            />
        </div>
    );
}
