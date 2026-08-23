/**
 * i18n fallback contract.
 *
 * Minor-language files are PartialTranslationStructure: they only carry real
 * translations. Any key they omit (including former English placeholder
 * sections that were pruned) must resolve to the English text via t()'s
 * fallback — never to the raw dotted key.
 */
import { describe, it, expect, afterEach } from 'vitest';

// The text module reads persisted settings (localStorage-backed mmkv shim) at
// import time; vitest runs in a node environment, so stub it first.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const { t, setLanguage, getCurrentLanguage } = await import('./index');
const { en } = await import('./_default');
const { ja } = await import('./translations/ja');
const { ru } = await import('./translations/ru');
const { zhHans } = await import('./translations/zh-Hans');

afterEach(() => setLanguage('en'));

describe('t() English fallback for partial languages', () => {
  it('falls back to the English string for a key a minor language omits', () => {
    // machine.noMachines exists in en and zh-Hans, and is intentionally absent
    // from the partial minor-language files.
    expect((ja as any).machine?.noMachines).toBeUndefined();
    setLanguage('ja');
    expect(t('machine.noMachines')).toBe(en.machine.noMachines);
    expect(t('machine.noMachines')).toBe('No machines connected');
  });

  it('serves the real translation when the language has one', () => {
    expect((zhHans as any).machine?.noMachines).toBe('没有已连接的机器');
    setLanguage('zh-Hans');
    expect(t('machine.noMachines')).toBe('没有已连接的机器');
  });

  it('every en string key resolves to a non-key string in every partial language', () => {
    // Walk all en leaves; for string keys, t() must return real text (either
    // the language's own translation or the English fallback), never the raw
    // dotted key. This covers all pruned placeholder sections at once.
    const keys: string[] = [];
    (function walk(obj: any, prefix: string) {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'string') keys.push(key);
        else if (v && typeof v === 'object') walk(v, key);
      }
    })(en, '');
    expect(keys.length).toBeGreaterThan(500);

    for (const lang of ['ru', 'pl', 'es', 'it', 'pt', 'ca', 'ja', 'zh-Hant'] as const) {
      setLanguage(lang);
      expect(getCurrentLanguage()).toBe(lang);
      for (const key of keys) {
        const value = (t as any)(key);
        expect(value, `${lang}: ${key}`).not.toBe(key);
        expect(typeof value).toBe('string');
      }
    }
  });

  it('falls back for parameterized (function) keys too', () => {
    // tmuxHelp was an all-English section in ru and got pruned entirely.
    expect((ru as any).tmuxHelp).toBeUndefined();
    setLanguage('ru');
    expect(t('tmuxHelp.title')).toBe(en.tmuxHelp.title);
    // Function key present in en, absent in ja's partial file.
    if ((ja as any).machine?.activeSessions === undefined) {
      setLanguage('ja');
      expect(t('machine.activeSessions', { count: 3 })).toBe(en.machine.activeSessions({ count: 3 }));
    }
  });

  it('never exposes the retired E2E trust claim or old CLI package in any locale', () => {
    for (const lang of ['en', 'ru', 'pl', 'es', 'it', 'pt', 'ca', 'ja', 'zh-Hans', 'zh-Hant'] as const) {
      setLanguage(lang);
      const copy = [
        t('settings.aboutFooter'),
        t('terminal.endToEndEncrypted'),
        t('terminal.securityFooter'),
        t('welcome.subtitle'),
        t('machine.offlineHelp'),
        t('sessionInfo.updateCliInstructions'),
      ].join('\n');
      expect(copy, lang).not.toContain('npm install -g happy@latest');
      expect(copy, lang).not.toContain('`happy daemon status`');
      expect(copy, lang).not.toMatch(/only you can decrypt|only on your device|never sent to any server/i);
      expect(copy, lang).toContain('very-happy');
    }
  });
});
