/**
 * PresetsMenu — shortcuts picker for the chat composer (Radix dropdown).
 * Reads useSettings().promptPresets ({ id, title, text, run? }) and inserts
 * the chosen entry's text into the composer via onPick. The run flag is a
 * TERMINAL-only semantic (auto-execute on select, see TermPresetsMenu);
 * here every entry — run or not — inserts without sending, so the same text
 * can be reused in chat. Mirrors v1's composer affordance.
 *
 * Keyboard path (desktop): ⌘./Ctrl+. toggles the menu (controlled open via
 * usePresetsMenuShortcut), then digits 1-9 insert the numbered preset
 * directly — same code path as clicking the item. See ../../app/presetsShortcut.ts.
 */
import { useRef, useState, useEffect } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Plus, Paperclip, Maximize2, Minimize2, BookMarked, ChevronRight, ArrowLeft } from 'lucide-react';
import { useSettings } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import {
    usePresetsMenuShortcut,
    presetDigitIndex,
    PRESETS_SHORTCUT_ACTIVE,
    PRESETS_SHORTCUT_HINT,
} from '@/app/presetsShortcut';
import './presets.css';

export function PresetsMenu({
    onPick,
    onCancel,
    onAttach, onExpand, expanded,
}: {
    onPick: (text: string) => void;
    /** Keyboard cancel (Esc / ⌘. while open) — refocus the composer textarea
     *  so the keyboard-only flow never strands focus on the trigger button. */
    onCancel?: () => void;
    onAttach?: () => void;
    onExpand?: () => void;
    expanded?: boolean;
}) {
    const { t } = useTranslation();
    const settings = useSettings();
    const presets = settings.promptPresets ?? [];
    // True while the pending close is a KEYBOARD cancel (Esc / ⌘. toggle) —
    // consumed (and reset) in onCloseAutoFocus. Pointer closes (click outside,
    // item click) keep Radix's default focus handling.
    const kbCancelRef = useRef(false);
    const contentRef = useRef<HTMLDivElement>(null);
    const [page, setPage] = useState<'tools' | 'presets'>('tools');
    const hasTools = presets.length > 0 || !!onAttach || !!onExpand;
    const [open, setOpen] = usePresetsMenuShortcut(hasTools, () => {
        kbCancelRef.current = true;
    }, () => setPage(presets.length ? 'presets' : 'tools'));
    useEffect(() => { if (!open) setPage('tools'); }, [open]);
    if (!hasTools) return null;

    const pick = (text: string) => onPick(text);
    const changePage = (next: 'tools' | 'presets') => {
        setPage(next);
        requestAnimationFrame(() => contentRef.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus());
    };

    // Digit direct-select while open. preventDefault also stops Radix's
    // typeahead (composed handlers bail on defaultPrevented) so a preset
    // titled "2 things" can't shadow the numeric selection.
    const onMenuKeyDown = (e: React.KeyboardEvent) => {
        if (page !== 'presets' || e.metaKey || e.ctrlKey || e.altKey) return;
        const idx = presetDigitIndex(e.key, presets.length);
        if (idx == null) return;
        e.preventDefault();
        e.stopPropagation();
        pick(presets[idx].text);
        setOpen(false);
    };

    const label = PRESETS_SHORTCUT_ACTIVE
        ? `${t('session.chat.composerTools')} (${PRESETS_SHORTCUT_HINT})`
        : t('session.chat.composerTools');

    return (
        <DropdownMenu.Root open={open} onOpenChange={setOpen}>
            <DropdownMenu.Trigger asChild>
                <button
                    type="button"
                    className="ci-icon-btn"
                    aria-label={t('session.chat.composerTools')}
                    title={label}
                >
                    <Plus size={20} />
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    ref={contentRef}
                    className="pm-content"
                    collisionPadding={12}
                    sideOffset={6}
                    align="start"
                    side="top"
                    onKeyDown={onMenuKeyDown}
                    onEscapeKeyDown={() => { kbCancelRef.current = true; }}
                    onCloseAutoFocus={(e) => {
                        // Keyboard cancel → back to the textarea. Everything
                        // else (pick, pointer-outside) keeps Radix's default;
                        // after a pick, insertPreset's rAF refocus wins anyway.
                        if (kbCancelRef.current) {
                            kbCancelRef.current = false;
                            e.preventDefault();
                            onCancel?.();
                        }
                    }}
                >
                    {page === 'tools' && onAttach && <DropdownMenu.Item className="pm-item pm-tool" onSelect={onAttach}><Paperclip size={16} aria-hidden /><span>{t('session.chat.attach')}</span></DropdownMenu.Item>}
                    {page === 'tools' && onExpand && <DropdownMenu.Item className="pm-item pm-tool" onSelect={onExpand}>{expanded ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}<span>{expanded ? t('session.input.collapse') : t('session.input.expand')}</span></DropdownMenu.Item>}
                    {page === 'tools' && presets.length > 0 && <DropdownMenu.Item className="pm-item pm-tool" onSelect={event => { event.preventDefault(); changePage('presets'); }}><BookMarked size={16} aria-hidden /><span>{t('session.chat.presets')}</span><ChevronRight size={14} aria-hidden /></DropdownMenu.Item>}
                    {page === 'presets' && <DropdownMenu.Item className="pm-item pm-tool" onSelect={event => { event.preventDefault(); changePage('tools'); }}><ArrowLeft size={16} aria-hidden /><span>{t('common.back')}</span></DropdownMenu.Item>}
                    {page === 'presets' && <div className="pm-head">
                        {t('session.chat.presetsTitle')}
                        {PRESETS_SHORTCUT_ACTIVE && (
                            <span className="pm-head-hint">{t('session.chat.presetsDigitHint')}</span>
                        )}
                    </div>}
                    {page === 'presets' && presets.map((p, i) => (
                        <DropdownMenu.Item key={p.id} className="pm-item" onSelect={() => pick(p.text)}>
                            <span className="pm-item-title">
                                {PRESETS_SHORTCUT_ACTIVE && i < 9 && (
                                    <span className="pm-item-num">{i + 1}.</span>
                                )}
                                {p.title}
                            </span>
                            <span className="pm-item-text">{p.text}</span>
                        </DropdownMenu.Item>
                    ))}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
