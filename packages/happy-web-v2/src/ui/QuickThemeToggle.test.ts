import { describe, expect, it } from 'vitest';
import { nextThemePreference } from './QuickThemeToggle';

describe('nextThemePreference', () => {
  it('switches the resolved theme in either direction', () => {
    expect(nextThemePreference('dark')).toBe('light');
    expect(nextThemePreference('light')).toBe('dark');
  });
});
