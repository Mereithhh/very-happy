/**
 * B-643: the home-screen app's status bar is painted with `meta[name=theme-color]`
 * (status-bar-style `default`, see index.html), so its colour must be the session
 * header's `--bg-0` for the active theme — otherwise a seam shows above the header.
 * The media-query metas only follow the system scheme; an explicit in-app theme
 * overrides every meta. Self-contained (literals inline) so build/startupSplash.ts
 * can inline it before first paint, like readThemePreference.
 */
export function syncThemeColorMeta(preference: string): void {
  const colors: Record<string, string> = { dark: '#151515', light: '#fcfcfb' };
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    const media = meta.getAttribute('media') || '';
    const scheme = preference === 'dark' || preference === 'light'
      ? preference
      : media.includes('light') ? 'light' : 'dark';
    meta.setAttribute('content', colors[scheme]);
  });
}
