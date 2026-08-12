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
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { BookMarked } from 'lucide-react';
import { useSettings } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import '@/screens/session/presets.css';

export function TermPresetsMenu({
    variant,
    onPick,
}: {
    variant: 'header' | 'keybar';
    onPick: (text: string) => void;
}) {
    const { t } = useTranslation();
    const settings = useSettings();
    const presets = settings.promptPresets ?? [];
    if (presets.length === 0) return null;
    const keybar = variant === 'keybar';

    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <button
                    type="button"
                    className={keybar ? 'term-keybar-key term-keybar-sys' : 'sb-icon-btn'}
                    aria-label={t('terminal.presets')}
                    title={t('terminal.presets')}
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
                    onCloseAutoFocus={(e) => e.preventDefault()}
                >
                    <div className="pm-head">{t('terminal.presetsTitle')}</div>
                    {presets.map((p) => (
                        <DropdownMenu.Item key={p.id} className="pm-item" onSelect={() => onPick(p.text)}>
                            <span className="pm-item-title">{p.title}</span>
                            <span className="pm-item-text">{p.text}</span>
                        </DropdownMenu.Item>
                    ))}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
