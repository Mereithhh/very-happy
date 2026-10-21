import { expect, it, vi } from 'vitest';
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (k: string) => k, lang: 'en' }) }));
const { labelColon } = await import('./TeamTaskDetail');

it('B-728 (UI-P1-15): CJK labels use the full-width colon, everything else ": "', () => {
  expect(labelColon('zh-Hans')).toBe('：');
  expect(labelColon('zh-Hant')).toBe('：');
  expect(labelColon('ja')).toBe('：');
  expect(labelColon('en')).toBe(': ');
  expect(labelColon('ru')).toBe(': ');
});
