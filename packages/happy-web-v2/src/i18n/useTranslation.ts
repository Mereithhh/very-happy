import { useSyncExternalStore } from 'react';
import {
  t,
  getCurrentLanguage,
  setLanguage,
  subscribeLanguage,
  type SupportedLanguage,
  type TranslationKey,
} from '@/text';

/**
 * Reactive i18n hook. Returns the typed `t()` plus current language and a setter.
 * Re-renders the calling component whenever the language changes.
 */
export function useTranslation() {
  const lang = useSyncExternalStore(subscribeLanguage, getCurrentLanguage, getCurrentLanguage);
  return {
    t,
    lang,
    setLanguage: (l: SupportedLanguage) => setLanguage(l),
  };
}

export type { TranslationKey, SupportedLanguage };
export { t };
