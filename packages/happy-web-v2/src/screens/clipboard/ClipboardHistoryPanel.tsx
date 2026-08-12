/**
 * ClipboardHistoryPanel — review/re-copy surface for received clipboard
 * pushes (the copy_to_clipboard tool; producer in sync/clipboardPush.ts).
 *
 * Singleton mounted in AppLayout, opened programmatically (window event, same
 * pattern as CommandPalette) from ⌘K and Settings → Channels. Form factor
 * follows the notification-center panel: desktop = floating panel over a
 * scrim; mobile (<980px, the AppLayout breakpoint) = fullscreen via CSS.
 *
 * Row interactions:
 *  - click row  → copy the stored text (CopyButton/toast semantics);
 *  - expand (chevron) → full text in an editor: tweak, copy the edited value
 *    (this is where the old edit-before-copy modal's ability moved), delete;
 *  - header carries the prominent clear-all (content may be sensitive) and a
 *    gear to Settings → Channels (auto-copy toggle lives there).
 */

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
    ChevronDown,
    ChevronRight,
    ClipboardList,
    Copy,
    Settings,
    Trash2,
    X,
} from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Modal } from '@/modal';
import { CopyButton } from '@/ui/CopyButton';
import { toast } from '@/ui/Toast';
import {
    useClipboardHistory,
    updateClipboardHistoryText,
    deleteClipboardHistoryEntry,
    clearClipboardHistory,
} from '@/sync/clipboardHistoryStore';
import { clipboardPreview, type ClipboardHistoryEntry } from '@/sync/clipboardHistory';
import './clipboard.css';

/** Programmatic open — same singleton/window-event pattern as CommandPalette. */
const OPEN_EVENT = 'vh:clipboard-history-open';
export function openClipboardHistory() {
    window.dispatchEvent(new Event(OPEN_EVENT));
}

/** compact mono age — machine-layer identity, deliberately not localized
 *  (same rendering as the notification center's) */
function ago(at: number, now: number): string {
    const s = Math.max(0, Math.floor((now - at) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}

function Row({
    entry,
    now,
    expanded,
    onToggle,
}: {
    entry: ClipboardHistoryEntry;
    now: number;
    expanded: boolean;
    onToggle: () => void;
}) {
    const { t } = useTranslation();
    // Editor draft — seeded from the entry, persisted on blur so a re-copy
    // after editing survives panel close/reopen.
    const [draft, setDraft] = useState(entry.text);
    useEffect(() => {
        if (expanded) setDraft(entry.text);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [expanded]);

    const copyStored = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(entry.text);
            toast.success(t('clipboard.copiedPreview', { preview: clipboardPreview(entry.text) }));
        } catch {
            toast.error(t('markdown.copyFailed'));
        }
    }, [entry.text, t]);

    const sourceLabel =
        entry.sourceLabel ??
        (entry.sourceType === 'machine'
            ? t('clipboard.sourceMachine')
            : entry.sourceType === 'session'
                ? t('clipboard.sourceSession')
                : undefined);

    const Chevron = expanded ? ChevronDown : ChevronRight;

    return (
        <div className={`ch-row${expanded ? ' is-expanded' : ''}`}>
            <div
                className="ch-row-main"
                role="button"
                tabIndex={0}
                title={t('common.copy')}
                onClick={copyStored}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        void copyStored();
                    }
                }}
            >
                <span className="ch-row-icon">
                    <Copy size={14} />
                </span>
                <span className="ch-row-text">
                    <span className="ch-row-preview">{clipboardPreview(entry.text, 80)}</span>
                    <span className="ch-row-meta">
                        {sourceLabel && <span className="ch-row-source">{sourceLabel}</span>}
                        <span className="ch-row-time mono">{ago(entry.createdAt, now)}</span>
                    </span>
                </span>
                <button
                    type="button"
                    className="ch-row-btn"
                    title={expanded ? t('clipboard.collapse') : t('clipboard.expand')}
                    aria-label={expanded ? t('clipboard.collapse') : t('clipboard.expand')}
                    aria-expanded={expanded}
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggle();
                    }}
                >
                    <Chevron size={15} />
                </button>
            </div>
            {expanded && (
                <div className="ch-row-editor">
                    <textarea
                        className="ch-row-textarea mono"
                        value={draft}
                        rows={Math.min(10, Math.max(3, draft.split('\n').length))}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => {
                            if (draft !== entry.text) updateClipboardHistoryText(entry.id, draft);
                        }}
                        spellCheck={false}
                    />
                    <div className="ch-row-editor-actions">
                        <CopyButton text={() => draft} showLabel />
                        <button
                            type="button"
                            className="ch-row-delete"
                            onClick={() => deleteClipboardHistoryEntry(entry.id)}
                        >
                            <Trash2 size={13} />
                            <span>{t('common.delete')}</span>
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

export function ClipboardHistoryPanel() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const entries = useClipboardHistory();
    const [open, setOpen] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    const close = useCallback(() => {
        setOpen(false);
        setExpandedId(null);
    }, []);

    useEffect(() => {
        const onOpen = () => setOpen(true);
        window.addEventListener(OPEN_EVENT, onOpen);
        return () => window.removeEventListener(OPEN_EVENT, onOpen);
    }, []);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [open, close]);

    const clearAll = useCallback(async () => {
        const ok = await Modal.confirm(
            t('clipboard.clearAll'),
            t('clipboard.clearAllConfirm'),
            { confirmText: t('clipboard.clearAll'), destructive: true },
        );
        if (ok) clearClipboardHistory();
    }, [t]);

    if (!open || typeof document === 'undefined') return null;

    const now = Date.now();

    return createPortal(
        <div className="ch-layer">
            <div className="ch-backdrop" onClick={close} />
            <div className="ch-panel" role="dialog" aria-label={t('clipboard.historyTitle')}>
                <header className="ch-head">
                    <span className="ch-head-title">
                        <ClipboardList size={15} />
                        {t('clipboard.historyTitle')}
                    </span>
                    <span className="ch-head-actions">
                        {entries.length > 0 && (
                            <button className="ch-head-btn ch-head-btn--danger" onClick={clearAll}>
                                <Trash2 size={14} />
                                <span>{t('clipboard.clearAll')}</span>
                            </button>
                        )}
                        <button
                            className="ch-head-btn ch-head-btn--icon"
                            title={t('clipboard.autoCopyTitle')}
                            aria-label={t('clipboard.autoCopyTitle')}
                            onClick={() => {
                                close();
                                navigate('/settings/channels');
                            }}
                        >
                            <Settings size={15} />
                        </button>
                        <button className="ch-head-btn ch-head-btn--icon" onClick={close} aria-label={t('common.back')}>
                            <X size={16} />
                        </button>
                    </span>
                </header>
                <div className="ch-list">
                    {entries.length === 0 ? (
                        <div className="ch-empty">{t('clipboard.historyEmpty')}</div>
                    ) : (
                        entries.map((e) => (
                            <Row
                                key={e.id}
                                entry={e}
                                now={now}
                                expanded={expandedId === e.id}
                                onToggle={() => setExpandedId((cur) => (cur === e.id ? null : e.id))}
                            />
                        ))
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}
