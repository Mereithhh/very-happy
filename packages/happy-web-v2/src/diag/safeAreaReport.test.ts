import { describe, expect, it } from 'vitest';
import { formatSafeAreaReport } from './safeAreaReport';
import type { ViewportSnapshot } from './viewportReport';

// iPhone Duo cover display, portrait, home-screen app (third-party measurements: right 84 · bottom 34).
const snap: ViewportSnapshot = {
    at: '2026-10-23T00:00:00.000Z',
    build: 'test',
    userAgent: 'UA',
    displayMode: { standalone: true, fullscreen: false, 'minimal-ui': false, browser: false },
    navigatorStandalone: true,
    devicePixelRatio: 3,
    orientation: 'portrait-primary',
    screen: { width: 466, height: 678, availHeight: 678 },
    window: { innerWidth: 466, innerHeight: 678, outerHeight: 678, scrollY: 0 },
    clientHeight: 678,
    visualViewport: null,
    units: {},
    safeArea: { top: 0, right: 84, bottom: 34, left: 0 },
    meta: { viewport: 'width=device-width, viewport-fit=cover', statusBarStyle: 'default' },
};

describe('safe-area diag report', () => {
    it('prints all four sides, the mirrors and the context needed to read them', () => {
        const text = formatSafeAreaReport(snap, snap.safeArea);
        expect(text).toContain('env(safe-area-inset-*): top=0 right=84 bottom=34 left=0');
        expect(text).toContain('--sa-*: top=0 right=84 bottom=34 left=0\n');
        expect(text).toContain('window: 466×678  screen: 466×678  dpr=3');
        expect(text).toContain('display-mode: standalone');
        expect(text).toContain('status-bar-style: default');
    });

    it('flags mirrors that differ from env()', () => {
        expect(formatSafeAreaReport(snap, { top: 0, right: 30, bottom: 34, left: 0 })).toContain('≠ env (injected?)');
    });
});
