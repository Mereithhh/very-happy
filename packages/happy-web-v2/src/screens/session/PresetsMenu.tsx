/**
 * PresetsMenu — quick prompt-presets picker (Radix dropdown). Reads
 * useSettings().promptPresets ({ id, title, text }) and inserts the chosen
 * preset's text into the composer via onPick. Mirrors v1's composer affordance.
 *
 * Keyboard path (desktop): ⌘./Ctrl+. toggles the menu (controlled open via
 * usePresetsMenuShortcut), then digits 1-9 insert the numbered preset
 * directly — same code path as clicking the item. See ../../app/presetsShortcut.ts.
 */
import { useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { BookMarked } from 'lucide-react';
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
}: {
    onPick: (text: string) => void;
    /** Keyboard cancel (Esc / ⌘. while open) — refocus the composer textarea
     *  so the keyboard-only flow never strands focus on the trigger button. */
    onCancel?: () => void;
}) {
    const { t } = useTranslation();
    const settings = useSettings();
    const presets = settings.promptPresets ?? [];
    // True while the pending close is a KEYBOARD cancel (Esc / ⌘. toggle) —
    // consumed (and reset) in onCloseAutoFocus. Pointer closes (click outside,
    // item click) keep Radix's default focus handling.
    const kbCancelRef = useRef(false);
    const [open, setOpen] = usePresetsMenuShortcut(presets.length > 0, () => {
        kbCancelRef.current = true;
    });
    if (presets.length === 0) return null;

    const pick = (text: string) => onPick(text);

    // Digit direct-select while open. preventDefault also stops Radix's
    // typeahead (composed handlers bail on defaultPrevented) so a preset
    // titled "2 things" can't shadow the numeric selection.
    const onMenuKeyDown = (e: React.KeyboardEvent) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const idx = presetDigitIndex(e.key, presets.length);
        if (idx == null) return;
        e.preventDefault();
        e.stopPropagation();
        pick(presets[idx].text);
        setOpen(false);
    };

    const label = PRESETS_SHORTCUT_ACTIVE
        ? `${t('session.chat.presets')} (${PRESETS_SHORTCUT_HINT})`
        : t('session.chat.presets');

    return (
        <DropdownMenu.Root open={open} onOpenChange={setOpen}>
            <DropdownMenu.Trigger asChild>
                <button
                    type="button"
                    className="ci-icon-btn"
                    aria-label={t('session.chat.presets')}
                    title={label}
                >
                    <BookMarked size={18} />
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    className="pm-content"
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
                    <div className="pm-head">
                        {t('session.chat.presetsTitle')}
                        {PRESETS_SHORTCUT_ACTIVE && (
                            <span className="pm-head-hint">{t('session.chat.presetsDigitHint')}</span>
                        )}
                    </div>
                    {presets.map((p, i) => (
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
