/** B-796: the /dev/safe-area text report (pure, unit-tested). */
import type { ViewportSnapshot } from './viewportReport';

type Insets = ViewportSnapshot['safeArea'];

const sides = (i: Insets) => `top=${i.top} right=${i.right} bottom=${i.bottom} left=${i.left}`;

export function formatSafeAreaReport(snap: ViewportSnapshot, mirrors: Insets): string {
    const mode = Object.entries(snap.displayMode).filter(([, on]) => on).map(([m]) => m).join(',') || 'none';
    const sameAsEnv = (['top', 'right', 'bottom', 'left'] as const).every((s) => mirrors[s] === snap.safeArea[s]);
    return [
        `env(safe-area-inset-*): ${sides(snap.safeArea)}`,
        `--sa-*: ${sides(mirrors)}${sameAsEnv ? '' : '  ≠ env (injected?)'}`,
        `window: ${snap.window.innerWidth}×${snap.window.innerHeight}  screen: ${snap.screen.width}×${snap.screen.height}  dpr=${snap.devicePixelRatio}`,
        `orientation: ${snap.orientation ?? 'n/a'}  display-mode: ${mode}  navigator.standalone=${snap.navigatorStandalone ?? 'n/a'}`,
        `status-bar-style: ${snap.meta.statusBarStyle ?? 'n/a'}`,
        `viewport: ${snap.meta.viewport ?? 'n/a'}`,
        `build: ${snap.build}  at: ${snap.at}`,
        `ua: ${snap.userAgent}`,
    ].join('\n');
}
