/**
 * PresetsMenu — quick prompt-presets picker (Radix dropdown). Reads
 * useSettings().promptPresets ({ id, title, text }) and inserts the chosen
 * preset's text into the composer via onPick. Mirrors v1's composer affordance.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { BookMarked } from 'lucide-react';
import { useSettings } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import './presets.css';

export function PresetsMenu({ onPick }: { onPick: (text: string) => void }) {
    const { t } = useTranslation();
    const settings = useSettings();
    const presets = settings.promptPresets ?? [];
    if (presets.length === 0) return null;

    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <button
                    type="button"
                    className="ci-icon-btn"
                    aria-label={t('session.chat.presets' as any)}
                    title={t('session.chat.presets' as any)}
                >
                    <BookMarked size={18} />
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content className="pm-content" sideOffset={6} align="start" side="top">
                    <div className="pm-head">{t('session.chat.presetsTitle' as any)}</div>
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
