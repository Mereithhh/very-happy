import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Globe2 } from 'lucide-react';
import { SUPPORTED_LANGUAGE_CODES, type SupportedLanguage } from '@/text/_all';
import {
  announceLanguageChange,
  browserLanguageTags,
  readStoredPreferredLanguage,
  resolveLanguageFromTags,
  writeStoredPreferredLanguage,
} from './localeCore';
import { usePublicI18n } from './publicI18n';
import './languageSwitcher.css';

type PublicLanguage = Extract<SupportedLanguage, 'en' | 'zh-Hans'>;
const PUBLIC_LANGUAGES: readonly PublicLanguage[] = ['en', 'zh-Hans'];
type PublicLanguagePreference = PublicLanguage | 'auto';

export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { copy } = usePublicI18n();
  const preference = readStoredPreferredLanguage(SUPPORTED_LANGUAGE_CODES);
  const selected: PublicLanguagePreference = preference && PUBLIC_LANGUAGES.includes(preference as PublicLanguage)
    ? preference as PublicLanguage
    : 'auto';
  const options: readonly { value: PublicLanguagePreference; label: string }[] = [
    { value: 'auto', label: copy.shell.automatic },
    { value: 'en', label: 'English' },
    { value: 'zh-Hans', label: '简体中文' },
  ];
  const selectedLabel = options.find((option) => option.value === selected)?.label ?? copy.shell.automatic;

  const selectLanguage = (value: string) => {
    const next = value === 'auto' ? null : value as PublicLanguage;
    writeStoredPreferredLanguage(next);
    const active = next ?? resolveLanguageFromTags(browserLanguageTags(), SUPPORTED_LANGUAGE_CODES, 'en');
    announceLanguageChange(active);
  };

  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button
        type="button"
        className={`language-switcher${className ? ` ${className}` : ''}`}
        aria-label={`${copy.shell.language}: ${selectedLabel}`}
      >
        <Globe2 className="language-switcher-globe" size={14} aria-hidden="true" />
        <span className="language-switcher-value">{selectedLabel}</span>
        <ChevronDown className="language-switcher-chevron" size={13} aria-hidden="true" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        className="language-switcher-menu"
        align="end"
        sideOffset={6}
        collisionPadding={12}
        aria-label={copy.shell.language}
      >
        <div className="language-switcher-heading" aria-hidden="true">{copy.shell.language}</div>
        <DropdownMenu.RadioGroup value={selected} onValueChange={selectLanguage}>
          {options.map((option) => <DropdownMenu.RadioItem
            key={option.value}
            className="language-switcher-option"
            value={option.value}
          >
            <span className="language-switcher-indicator" aria-hidden="true">
              <DropdownMenu.ItemIndicator><Check size={14} strokeWidth={2.25} /></DropdownMenu.ItemIndicator>
            </span>
            <span>{option.label}</span>
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
