import { describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

// B-682: the toggle now reads its label through i18n (MMKV at import).
installBrowserTestGlobals();
const { nextThemePreference } = await import('./QuickThemeToggle');

describe('nextThemePreference', () => {
  it('switches the resolved theme in either direction', () => {
    expect(nextThemePreference('dark')).toBe('light');
    expect(nextThemePreference('light')).toBe('dark');
  });
});
