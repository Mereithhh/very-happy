import { Globe2 } from 'lucide-react';
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

export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { copy } = usePublicI18n();
  const preference = readStoredPreferredLanguage(SUPPORTED_LANGUAGE_CODES);

  const selectLanguage = (value: string) => {
    const next = value === 'auto' ? null : value as PublicLanguage;
    writeStoredPreferredLanguage(next);
    const active = next ?? resolveLanguageFromTags(browserLanguageTags(), SUPPORTED_LANGUAGE_CODES, 'en');
    announceLanguageChange(active);
  };

  return <label className={`language-switcher${className ? ` ${className}` : ''}`}>
    <Globe2 size={14} aria-hidden="true" />
    <span className="sr-only">{copy.shell.language}</span>
    <select aria-label={copy.shell.language} value={preference && PUBLIC_LANGUAGES.includes(preference as PublicLanguage) ? preference : 'auto'} onChange={(event) => selectLanguage(event.target.value)}>
      <option value="auto">{copy.shell.automatic}</option>
      <option value="en">English</option>
      <option value="zh-Hans">简体中文</option>
    </select>
  </label>;
}
