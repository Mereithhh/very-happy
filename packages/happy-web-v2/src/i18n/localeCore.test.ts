import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStoredPreferredLanguage, resolveLanguageFromTags, setDocumentLanguage, writeStoredPreferredLanguage } from './localeCore';

const supported = ['en', 'ru', 'zh-Hans', 'zh-Hant', 'ja'] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('localeCore', () => {
  it('resolves exact, base, and Chinese script/region tags', () => {
    expect(resolveLanguageFromTags(['ja-JP'], supported, 'en')).toBe('ja');
    expect(resolveLanguageFromTags(['zh-CN'], supported, 'en')).toBe('zh-Hans');
    expect(resolveLanguageFromTags(['zh-Hant-TW'], supported, 'en')).toBe('zh-Hant');
    expect(resolveLanguageFromTags(['zh-HK'], supported, 'en')).toBe('zh-Hant');
    expect(resolveLanguageFromTags(['de-DE', 'ru-RU'], supported, 'en')).toBe('ru');
    expect(resolveLanguageFromTags(['de-DE'], supported, 'en')).toBe('en');
  });

  it('reads the lightweight public preference without importing sync', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
    });
    values.set('mmkv:default:settings', JSON.stringify({ settings: { preferredLanguage: 'zh' } }));
    expect(readStoredPreferredLanguage(supported)).toBe('zh-Hans');
    values.set('mmkv:default:settings', JSON.stringify({ settings: { preferredLanguage: 'de' } }));
    expect(readStoredPreferredLanguage(supported)).toBeNull();
  });

  it('keeps the document language in sync', () => {
    const root = { lang: 'en' };
    vi.stubGlobal('document', { documentElement: root });
    setDocumentLanguage('zh-Hans');
    expect(root.lang).toBe('zh-Hans');
  });

  it('persists public language choices without discarding settings and queues sync', () => {
    const values = new Map<string, string>([[
      'mmkv:default:settings',
      JSON.stringify({ settings: { theme: 'dark', preferredLanguage: null }, version: 7 }),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    writeStoredPreferredLanguage('zh-Hans');
    expect(JSON.parse(values.get('mmkv:default:settings')!)).toEqual({
      settings: { theme: 'dark', preferredLanguage: 'zh-Hans' }, version: 7,
    });
    expect(JSON.parse(values.get('mmkv:default:pending-settings')!)).toEqual({ preferredLanguage: 'zh-Hans' });
  });
});
