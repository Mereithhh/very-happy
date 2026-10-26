/**
 * B-823: only English ships in the entry; the viewer's language is its own
 * chunk, loaded at boot (languageReady) or on a switch.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
};
// The boot language is the stored preference.
store.set('mmkv:default:settings', JSON.stringify({ settings: { preferredLanguage: 'ja' }, version: 1 }));

const text = await import('./index');

describe('B-823 languages load on demand', () => {
    it('until its chunk lands, the boot language answers in English — never a raw key', async () => {
        vi.resetModules();
        store.set('mmkv:default:settings', JSON.stringify({ settings: { preferredLanguage: 'pl' }, version: 1 }));
        const fresh = await import('./index');
        expect(fresh.getCurrentLanguage()).toBe('pl');
        expect(fresh.t('common.cancel')).toBe('Cancel');
        await fresh.languageReady;
        expect(fresh.t('common.cancel')).toBe('Anuluj');
        store.set('mmkv:default:settings', JSON.stringify({ settings: { preferredLanguage: 'ja' }, version: 1 }));
    });

    it('the boot language is ready once languageReady resolves', async () => {
        expect(text.getCurrentLanguage()).toBe('ja');
        await text.languageReady;
        expect(text.t('common.cancel')).toBe('キャンセル');
    });

    it('a switch to a language not loaded yet answers in it once it resolves; a later switch wins over a slower one', async () => {
        const first = text.setLanguage('ru');
        const second = text.setLanguage('zh-Hans');
        await Promise.all([first, second]);
        expect(text.getCurrentLanguage()).toBe('zh-Hans');
        expect(text.t('common.cancel')).toBe('取消');
        // Back to a loaded one: synchronous.
        void text.setLanguage('ru');
        expect(text.getCurrentLanguage()).toBe('ru');
        void text.setLanguage('en');
        expect(text.t('common.cancel')).toBe('Cancel');
    });

    it('subscribers hear the switch only once the strings are in', async () => {
        const listener = vi.fn(() => text.t('common.cancel'));
        const off = text.subscribeLanguage(listener);
        await text.setLanguage('zh-Hant');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.results[0].value).not.toBe('Cancel');
        off();
        await text.setLanguage('en');
    });
});

describe('B-823 wiring', () => {
    const index = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
    const main = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8');

    it('no translation file is imported statically by the text module', () => {
        expect(index).not.toMatch(/^import .* from '\.\/translations\//m);
        expect(index).toContain("'zh-Hans': () => import('./translations/zh-Hans').then((m) => m.zhHans),");
    });

    it('the first render waits for the language and the root together', () => {
        expect(main).toContain('void Promise.all([rootModule, languageReady]).then(([RootComponent]) => {');
    });
});
