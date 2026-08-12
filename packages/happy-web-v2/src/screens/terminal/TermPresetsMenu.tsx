/**
 * TermPresetsMenu — prompt-presets picker for the web terminal. Same synced
 * data (useSettings().promptPresets) and interaction shape as the chat
 * composer's PresetsMenu (Radix dropdown, pm-* list styling), reskinned for
 * the terminal chrome:
 *   - variant "header": desktop — sb-icon-btn in the terminal header toolbar,
 *     menu drops down (align end, like the quick-commands menu next to it);
 *   - variant "keybar": mobile — a key on the assistive key bar, menu pops up.
 * Hidden entirely when there are no presets (mirrors PresetsMenu).
 *
 * onPick pastes the preset text into the pty (bracketed paste — never
 * auto-executes; the user presses Enter). Focus handoff: onPick runs inside
 * the Radix onSelect click (iOS only opens the soft keyboard for focus()
 * calls inside the user-gesture stack) and moves focus to xterm via the
 * screen's focus policy; onCloseAutoFocus is prevented so Radix's default
 * "return focus to the trigger on close" can't steal it back from the
 * terminal right after the paste.
 *
 * Keyboard path (header variant, desktop): ⌘./Ctrl+. toggles the menu — the
 * shortcut hook listens in the CAPTURE phase, so the chord is intercepted
 * before xterm's helper textarea can swallow it — then digits 1-9 pick the
 * numbered preset via the same paste+focus path as a click. The keybar
 * variant only exists on coarse-pointer devices, where the hook is inert.
 * See ../../app/presetsShortcut.ts.
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
import '@/screens/session/presets.css';

export function TermPresetsMenu({
    variant,
    onPick,
    onCancel,
}: {
    variant: 'header' | 'keybar';
    onPick: (text: string) => void;
    /** Keyboard cancel (Esc / ⌘. while open) — refocus the terminal, since
     *  onCloseAutoFocus below suppresses Radix's trigger refocus and a cancel
     *  has no onPick to route focus (keyboard-only flow must not strand it). */
    onCancel?: () => void;
}) {
    const { t } = useTranslation();
    const settings = useSettings();
    const presets = settings.promptPresets ?? [];
    const keybar = variant === 'keybar';
    // True while the pending close is a KEYBOARD cancel (Esc / ⌘. toggle) —
    // consumed (and reset) in onCloseAutoFocus.
    const kbCancelRef = useRef(false);
    // The keybar variant is only rendered on coarse-pointer devices, where the
    // hook is inert anyway; gating on the variant keeps the invariant explicit.
    const [open, setOpen] = usePresetsMenuShortcut(!keybar && presets.length > 0, () => {
        kbCancelRef.current = true;
    });
    if (presets.length === 0) return null;

    // Digit direct-select while open — identical to clicking the item
    // (bracketed paste, no Enter; focus returns to the terminal inside onPick,
    // and onCloseAutoFocus below keeps Radix from stealing it back).
    // preventDefault also stops Radix's title typeahead from shadowing digits.
    const onMenuKeyDown = (e: React.KeyboardEvent) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const idx = presetDigitIndex(e.key, presets.length);
        if (idx == null) return;
        e.preventDefault();
        e.stopPropagation();
        onPick(presets[idx].text);
        setOpen(false);
    };

    const showHints = !keybar && PRESETS_SHORTCUT_ACTIVE;
    const label = showHints
        ? `${t('terminal.presets')} (${PRESETS_SHORTCUT_HINT})`
        : t('terminal.presets');

    return (
        <DropdownMenu.Root open={open} onOpenChange={setOpen}>
            <DropdownMenu.Trigger asChild>
                <button
                    type="button"
                    className={keybar ? 'term-keybar-key term-keybar-sys' : 'sb-icon-btn'}
                    aria-label={t('terminal.presets')}
                    title={label}
                >
                    <BookMarked size={keybar ? 16 : 18} />
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    className="pm-content"
                    sideOffset={6}
                    side={keybar ? 'top' : 'bottom'}
                    align={keybar ? 'start' : 'end'}
                    collisionPadding={8}
                    onEscapeKeyDown={() => { kbCancelRef.current = true; }}
                    onCloseAutoFocus={(e) => {
                        // Always suppress Radix's "refocus the trigger" (the
                        // pick path routes focus to xterm inside onPick); on a
                        // keyboard cancel, hand focus back to the terminal.
                        e.preventDefault();
                        if (kbCancelRef.current) {
                            kbCancelRef.current = false;
                            onCancel?.();
                        }
                    }}
                    onKeyDown={onMenuKeyDown}
                >
                    <div className="pm-head">
                        {t('terminal.presetsTitle')}
                        {showHints && (
                            <span className="pm-head-hint">{t('terminal.presetsDigitHint')}</span>
                        )}
                    </div>
                    {presets.map((p, i) => (
                        <DropdownMenu.Item key={p.id} className="pm-item" onSelect={() => onPick(p.text)}>
                            <span className="pm-item-title">
                                {showHints && i < 9 && (
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
