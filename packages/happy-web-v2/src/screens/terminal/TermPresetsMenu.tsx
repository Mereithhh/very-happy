/**
 * TermPresetsMenu — unified shortcuts picker for the web terminal (B-052).
 * Reads the same synced list as the chat composer's PresetsMenu
 * (useSettings().promptPresets), reskinned for the terminal chrome:
 *   - variant "header": desktop — sb-icon-btn in the terminal header toolbar,
 *     menu drops down (align end);
 *   - variant "keybar": mobile — a key on the assistive key bar, menu pops up.
 *
 * Two kinds of entries (one list, classified per item — see shortcutPresets):
 *   - insert (default): onPick pastes the text into the pty (bracketed paste —
 *     never auto-executes; the user presses Enter);
 *   - run (run: true): onRun executes on select (paste + Enter). Marked with
 *     a mono "$" prefix so the eye can tell "types for me" from "runs for me".
 *
 * This menu absorbed the old separate quick-commands (ListPlus) menu: with no
 * entries at all, the header variant shows a single "manage" item (onManage →
 * settings) instead of hiding — the affordance the commands menu used to
 * provide. The keybar variant still hides when empty (key bar space is scarce).
 *
 * Focus handoff (two passes, both needed): onPick/onRun runs inside the Radix
 * onSelect click and focuses xterm there because iOS only opens the soft
 * keyboard for focus() calls inside the user-gesture stack — but that pass
 * does NOT survive, since Radix's FocusScope is still mounted and pulls focus
 * back into the menu. So onCloseAutoFocus prevents Radix's "return focus to
 * the trigger" AND refocuses the terminal itself once the menu is unmounted.
 * Without that second pass focus ends on <body> and Enter does nothing.
 *
 * Keyboard path (header variant, desktop): ⌘./Ctrl+. toggles the menu — the
 * shortcut hook listens in the CAPTURE phase, so the chord is intercepted
 * before xterm's helper textarea can swallow it — then digits 1-9 pick the
 * numbered entry via the same path as a click (run entries execute). The
 * keybar variant only exists on coarse-pointer devices, where the hook is
 * inert. See ../../app/presetsShortcut.ts.
 */
import { useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { BookMarked } from 'lucide-react';
import { useSettings } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { presetRuns } from '@/sync/shortcutPresets';
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
    onRun,
    onManage,
    onCancel,
}: {
    variant: 'header' | 'keybar';
    /** Insert entry picked — paste without Enter. */
    onPick: (text: string) => void;
    /** Run entry picked — paste AND execute (Enter). */
    onRun: (text: string) => void;
    /** Empty-state "manage shortcuts" item (header variant only). */
    onManage?: () => void;
    /** Refocus the terminal after the menu closes — used for BOTH a keyboard
     *  cancel (Esc / ⌘.) and a pick, because onCloseAutoFocus suppresses
     *  Radix's trigger refocus and the pick's own focus() is overridden by the
     *  still-mounted FocusScope. Not called for click-outside dismissals. */
    onCancel?: () => void;
}) {
    const { t } = useTranslation();
    const settings = useSettings();
    const presets = settings.promptPresets ?? [];
    const keybar = variant === 'keybar';
    // True while the pending close is a KEYBOARD cancel (Esc / ⌘. toggle) —
    // consumed (and reset) in onCloseAutoFocus.
    const kbCancelRef = useRef(false);
    // True while the pending close follows a PICK. The focus() that onPick /
    // onRun perform runs while Radix's FocusScope is still mounted, so the
    // scope pulls focus back inside the menu; onCloseAutoFocus then suppresses
    // Radix's "return focus to the trigger" and focus lands on <body> — the
    // terminal looked focused but Enter went nowhere (field report). Refocus
    // once the menu is actually gone. Gated on the pick so a click-OUTSIDE
    // dismissal never steals focus from whatever the user clicked.
    const pickedRef = useRef(false);
    // The keybar variant is only rendered on coarse-pointer devices, where the
    // hook is inert anyway; gating on the variant keeps the invariant explicit.
    // The header variant stays registered even with zero entries — the menu
    // then shows the manage item, which ⌘. may legitimately open.
    const [open, setOpen] = usePresetsMenuShortcut(!keybar, () => {
        kbCancelRef.current = true;
    });
    // Keybar hides when empty; header keeps a manage-entry menu (it replaced
    // the old always-visible quick-commands menu).
    if (presets.length === 0 && keybar) return null;

    const pick = (p: { text: string; run?: boolean }) => {
        pickedRef.current = true;
        if (presetRuns(p)) onRun(p.text);
        else onPick(p.text);
    };

    // Digit direct-select while open — identical to clicking the item (run
    // entries execute; insert entries paste without Enter; the caller decides
    // whether focus should return after Radix closes).
    // preventDefault also stops Radix's title typeahead from shadowing digits.
    const onMenuKeyDown = (e: React.KeyboardEvent) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const idx = presetDigitIndex(e.key, presets.length);
        if (idx == null) return;
        e.preventDefault();
        e.stopPropagation();
        pick(presets[idx]);
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
                        // Always suppress Radix's "refocus the trigger", then
                        // let the caller apply its platform focus policy.
                        e.preventDefault();
                        const wanted = kbCancelRef.current || pickedRef.current;
                        kbCancelRef.current = false;
                        pickedRef.current = false;
                        if (wanted) onCancel?.();
                    }}
                    onKeyDown={onMenuKeyDown}
                >
                    <div className="pm-head">
                        {t('terminal.presetsTitle')}
                        {showHints && presets.length > 0 && (
                            <span className="pm-head-hint">{t('terminal.presetsDigitHint')}</span>
                        )}
                    </div>
                    {presets.map((p, i) => (
                        <DropdownMenu.Item key={p.id} className="pm-item" onSelect={() => pick(p)}>
                            <span className="pm-item-title">
                                {showHints && i < 9 && (
                                    <span className="pm-item-num">{i + 1}.</span>
                                )}
                                {presetRuns(p) && (
                                    <span className="pm-item-run" aria-label={t('terminal.presetsRunBadge')} title={t('terminal.presetsRunBadge')}>$</span>
                                )}
                                {p.title}
                            </span>
                            <span className="pm-item-text">{p.text}</span>
                        </DropdownMenu.Item>
                    ))}
                    {presets.length === 0 && (
                        <DropdownMenu.Item className="pm-item" onSelect={() => onManage?.()}>
                            <span className="pm-item-title">{t('terminal.presetsManage')}</span>
                        </DropdownMenu.Item>
                    )}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
