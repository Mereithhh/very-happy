import { en, type Translations, type PartialTranslationStructure } from './_default';
import { loadSettings } from '@/sync/persistence';
import { type SupportedLanguage, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_CODES } from './_all';
import { brandText } from '@/app/brand';
import { announceLanguageChange, browserLanguageTags, LANGUAGE_CHANGE_EVENT, resolveLanguageFromTags, setDocumentLanguage } from '@/i18n/localeCore';

/**
 * Extract all possible dot-notation keys from the nested translation object
 * E.g., 'common.cancel', 'settings.title', 'time.minutesAgo'
 */
type NestedKeys<T, Path extends string = ''> = T extends object
    ? {
        [K in keyof T]: K extends string
        ? T[K] extends string | ((...args: any[]) => string)
        ? Path extends ''
        ? K
        : `${Path}.${K}`
        : NestedKeys<T[K], Path extends '' ? K : `${Path}.${K}`>
        : never
    }[keyof T]
    : never;

/**
 * Get the value type at a specific dot-notation path
 */
type GetValue<T, Path> = Path extends `${infer Key}.${infer Rest}`
    ? Key extends keyof T
    ? GetValue<T[Key], Rest>
    : never
    : Path extends keyof T
    ? T[Path]
    : never;

/**
 * Extract parameter type from a translation value
 * - If it's a function: extract the first parameter type
 * - If it's a string: return void (no parameters needed)
 */
type GetParams<V> =
    V extends (params: infer P) => string
    ? P
    : V extends string
    ? void
    : never;

/**
 * All valid translation keys
 */
export type TranslationKey = NestedKeys<Translations>;

/**
 * Get the parameter type for a specific translation key
 */
export type TranslationParams<K extends TranslationKey> = GetParams<GetValue<Translations, K>>;

/**
 * Keys whose value is a plain string (no interpolation params). A union of
 * these keys can be passed to t() without a second argument, so this is the
 * right constraint for generic "translate(key)" callbacks.
 */
export type SimpleTranslationKey = {
    [K in TranslationKey]: GetValue<Translations, K> extends string ? K : never
}[TranslationKey];

/**
 * Re-export language types and configuration
 */
export type { SupportedLanguage } from './_all';
export { SUPPORTED_LANGUAGES, SUPPORTED_LANGUAGE_CODES, DEFAULT_LANGUAGE, getLanguageNativeName, getLanguageEnglishName } from './_all';

/**
 * Translation objects for all supported languages.
 *
 * en (source of truth) and zh-Hans (primary translation) are complete
 * (TranslationStructure, enforced in their own files). Minor languages are
 * PartialTranslationStructure: they only carry real translations, and any
 * missing key falls back to English inside t(). Adding a new key only
 * requires touching _default.ts and zh-Hans.ts.
 *
 * B-823: only English ships in the entry chunk. Every other language is its
 * own chunk, loaded on demand (≈450KB of the startup path was nine languages
 * nobody reads at once). main.tsx renders after `languageReady`, so the first
 * frame is already in the viewer's language; until a chunk lands t() answers
 * in English rather than a raw key.
 */
type LazyLanguage = Exclude<SupportedLanguage, 'en'>;
const languageLoaders: Record<LazyLanguage, () => Promise<PartialTranslationStructure>> = {
    ru: () => import('./translations/ru').then((m) => m.ru),
    pl: () => import('./translations/pl').then((m) => m.pl),
    es: () => import('./translations/es').then((m) => m.es),
    it: () => import('./translations/it').then((m) => m.it),
    pt: () => import('./translations/pt').then((m) => m.pt),
    ca: () => import('./translations/ca').then((m) => m.ca),
    'zh-Hans': () => import('./translations/zh-Hans').then((m) => m.zhHans),
    'zh-Hant': () => import('./translations/zh-Hant').then((m) => m.zhHant),
    ja: () => import('./translations/ja').then((m) => m.ja),
};
const translations: Partial<Record<SupportedLanguage, PartialTranslationStructure>> = { en };
const pendingLoads = new Map<SupportedLanguage, Promise<void>>();

function isSupportedLanguage(language: string): language is SupportedLanguage {
    return (SUPPORTED_LANGUAGE_CODES as readonly string[]).includes(language);
}

/**
 * Fetch a language's strings (once). A failed chunk is forgotten so the next
 * call retries; the caller keeps answering in English meanwhile.
 */
export function loadLanguage(language: SupportedLanguage): Promise<void> {
    if (translations[language]) return Promise.resolve();
    let pending = pendingLoads.get(language);
    if (!pending) {
        pending = languageLoaders[language as LazyLanguage]().then((strings) => {
            translations[language] = strings;
        }).finally(() => {
            pendingLoads.delete(language);
        });
        pendingLoads.set(language, pending);
    }
    return pending;
}

//
// Resolve language
//

let currentLanguage: SupportedLanguage = DEFAULT_LANGUAGE;

// Read from settings
let settings = loadSettings();
let found = false;
if (settings.settings.preferredLanguage && isSupportedLanguage(settings.settings.preferredLanguage)) {
    currentLanguage = settings.settings.preferredLanguage as SupportedLanguage;
    found = true;
    console.log(`[i18n] Using preferred language: ${currentLanguage}`);
}

// Read from device
if (!found) {
    const tags = browserLanguageTags();
    console.log(`[i18n] Device locales:`, tags);
    currentLanguage = resolveLanguageFromTags(tags, SUPPORTED_LANGUAGE_CODES, DEFAULT_LANGUAGE);
    console.log(`[i18n] Using device locale: ${currentLanguage}`);
}

console.log(`[i18n] Final language: ${currentLanguage}`);
setDocumentLanguage(currentLanguage);

/**
 * B-823: the boot language's strings. Never rejects — a chunk that failed to
 * load leaves the first render in English instead of blocking it.
 */
export const languageReady: Promise<void> = loadLanguage(currentLanguage).catch((error) => {
    console.warn(`[i18n] Failed to load ${currentLanguage}, showing English`, error);
});

/**
 * Main translation function with strict typing
 * 
 * @param key - Dot-notation key for the translation (e.g., 'common.cancel', 'time.minutesAgo')
 * @param params - Object parameters required by the translation function (if any)
 * @returns Translated string
 * 
 * @example
 * // Simple constants (no parameters)
 * t('common.cancel')                    // "Cancel" or "Отмена"
 * t('settings.title')                   // "Settings" or "Настройки"
 * 
 * // Functions with required object parameters
 * t('common.welcome', { name: 'Steve' })           // "Welcome, Steve!" or "Добро пожаловать, Steve!"
 * t('errors.fieldError', { field: 'Email', reason: 'Invalid' })
 * 
 * // Complex parameters
 * t('sessionInfo.agentState')           // "Agent State" or "Состояние агента"
 */
export function t<K extends TranslationKey>(
    key: K,
    ...args: GetParams<GetValue<Translations, K>> extends void
        ? []
        : [GetParams<GetValue<Translations, K>>]
): string {
    try {
        // Get current language translations
        const currentTranslations = translations[currentLanguage] ?? en;

        // Navigate to the value using dot notation
        const keys = key.split('.');
        const resolve = (root: any): any => {
            let v: any = root;
            for (const k of keys) {
                if (v == null) return undefined;
                v = v[k];
            }
            return v;
        };

        // Resolve in the current language; fall back to English (the source of
        // truth) when a key is missing — so a not-yet-translated key shows real
        // English text instead of the raw dotted key. Only the raw key remains
        // as a last resort if English is missing it too.
        let value: any = resolve(currentTranslations);
        if (value === undefined && currentLanguage !== 'en') {
            value = resolve(en);
        }
        if (value === undefined) {
            console.warn(`Translation missing: ${key}`);
            return key;
        }

        // If it's a function, call it with the provided parameters.
        // B-637: a white-labelled relay (B-624) renames the product in every
        // string the app shows, not only in the auth cards.
        if (typeof value === 'function') {
            const params = args[0];
            return brandText(value(params));
        }

        // If it's a string constant, return it directly
        if (typeof value === 'string') {
            return brandText(value);
        }

        // Fallback for unexpected types
        console.warn(`Invalid translation value type for key: ${key}`);
        return key;
    } catch (error) {
        console.error(`Translation error for key: ${key}`, error);
        return key;
    }
}

/**
 * Get the currently active language
 * Useful for debugging and language-aware components
 */
export function getCurrentLanguage(): SupportedLanguage {
    return currentLanguage;
}

//
// Reactive language switching (web v2). t() reads module-level currentLanguage;
// setLanguage updates it and notifies subscribers so React can re-render.
//
const languageListeners = new Set<() => void>();
/** The latest switch wins: a slow chunk must not override a later choice. */
let languageRequest = 0;

function switchLanguage(lang: SupportedLanguage, announce: boolean): Promise<void> {
    const request = ++languageRequest;
    const apply = () => {
        if (request !== languageRequest) return;
        currentLanguage = lang;
        if (announce) announceLanguageChange(lang);
        else setDocumentLanguage(lang);
        languageListeners.forEach((l) => l());
    };
    if (translations[lang]) {
        apply();
        return Promise.resolve();
    }
    return loadLanguage(lang).catch(() => {}).then(apply);
}

if (typeof window !== 'undefined') {
    window.addEventListener(LANGUAGE_CHANGE_EVENT, (event) => {
        const language = (event as CustomEvent<string>).detail;
        if (!isSupportedLanguage(language) || language === currentLanguage) return;
        void switchLanguage(language, false);
    });
}

/**
 * Switch the UI language. Resolves once the new strings are in place: an
 * already-loaded language switches synchronously, any other when its chunk
 * lands (or to the English fallback if it cannot be loaded).
 */
export function setLanguage(lang: SupportedLanguage): Promise<void> {
    if (!isSupportedLanguage(lang)) return Promise.resolve();
    return switchLanguage(lang, true);
}

export function getDeviceLanguage(): SupportedLanguage {
    return resolveLanguageFromTags(
        browserLanguageTags(),
        SUPPORTED_LANGUAGE_CODES,
        DEFAULT_LANGUAGE,
    );
}

export function subscribeLanguage(listener: () => void): () => void {
    languageListeners.add(listener);
    return () => languageListeners.delete(listener);
}
