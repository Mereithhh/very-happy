/**
 * Test stand-in for `@/text` that resolves keys against the English source of
 * truth WITHOUT touching `localStorage` (the real module reads settings while it
 * initialises, see `browserTestGlobals.ts`). Pure-function tests that pull in a
 * module using `t()` at call time can do:
 *
 *     vi.mock('@/text', async () => await import('@/testing/englishText'));
 *
 * and assert on real English strings instead of dotted keys.
 */
import { en } from '@/text/_default';

export function t(key: string, params?: unknown): string {
    let value: unknown = en;
    for (const part of key.split('.')) {
        if (value == null || typeof value !== 'object') return key;
        value = (value as Record<string, unknown>)[part];
    }
    if (typeof value === 'function') return String((value as (p: unknown) => string)(params));
    return typeof value === 'string' ? value : key;
}

export function getCurrentLanguage(): 'en' {
    return 'en';
}
