export const LANGUAGE_CHANGE_EVENT = 'vh:language-change';
const SETTINGS_STORAGE_KEY = 'mmkv:default:settings';

export function browserLanguageTags(): string[] {
  if (typeof navigator === 'undefined') return ['en'];
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  return tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
}

export function resolveLanguageFromTags<T extends string>(
  tags: readonly string[],
  supported: readonly T[],
  fallback: T,
): T {
  const available = new Set<string>(supported);
  for (const rawTag of tags) {
    const tag = rawTag.replace('_', '-');
    const canonical = (() => {
      try { return Intl.getCanonicalLocales(tag)[0] ?? tag; }
      catch { return tag; }
    })();
    const parts = canonical.split('-');
    const language = parts[0]?.toLowerCase();
    if (!language) continue;

    if (language === 'zh') {
      const region = parts.find((part) => /^[A-Z]{2}$/.test(part));
      const traditional = /-Hant\b/i.test(canonical) || !!region && ['TW', 'HK', 'MO'].includes(region);
      const chinese = traditional ? 'zh-Hant' : 'zh-Hans';
      if (available.has(chinese)) return chinese as T;
    }

    const exact = supported.find((candidate) => candidate.toLowerCase() === canonical.toLowerCase());
    if (exact) return exact;
    const base = supported.find((candidate) => candidate.toLowerCase() === language);
    if (base) return base;
  }
  return fallback;
}

export function readStoredPreferredLanguage<T extends string>(supported: readonly T[]): T | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { settings?: { preferredLanguage?: unknown } };
    const stored = parsed.settings?.preferredLanguage === 'zh'
      ? 'zh-Hans'
      : parsed.settings?.preferredLanguage;
    return typeof stored === 'string' && supported.includes(stored as T) ? stored as T : null;
  } catch {
    return null;
  }
}

export function writeStoredPreferredLanguage(language: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as { settings?: Record<string, unknown>; version?: unknown } : {};
    const settings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...parsed, settings: { ...settings, preferredLanguage: language } }));

    const pendingKey = 'mmkv:default:pending-settings';
    const pendingRaw = localStorage.getItem(pendingKey);
    const pending = pendingRaw ? JSON.parse(pendingRaw) as Record<string, unknown> : {};
    localStorage.setItem(pendingKey, JSON.stringify({ ...pending, preferredLanguage: language }));
  } catch {
    // A malformed or unavailable store must not make the language control unusable.
  }
}

export function setDocumentLanguage(language: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
}

export function announceLanguageChange(language: string): void {
  setDocumentLanguage(language);
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(LANGUAGE_CHANGE_EVENT, { detail: language }));
}
