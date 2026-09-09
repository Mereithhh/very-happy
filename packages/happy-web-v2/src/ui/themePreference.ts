export type ThemePreference = 'system' | 'dark' | 'light';

/** Self-contained so Vite can inline the same reader before first paint. */
export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem('vh-theme-preference');
    return value === 'dark' || value === 'light' ? value : 'system';
  } catch { return 'system'; }
}
