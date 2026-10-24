import { describe, expect, it } from 'vitest';
import { formatElementLine, formatKeyboardLine, formatViewportReport, gapToScreenBottom, parseVhDiagParam, px, type ViewportSnapshot } from './viewportReport';

const snap: ViewportSnapshot = {
    at: '2026-10-14T00:00:00.000Z',
    build: 'test',
    userAgent: 'UA',
    displayMode: { standalone: true, fullscreen: false, 'minimal-ui': false, browser: false },
    navigatorStandalone: true,
    devicePixelRatio: 3,
    orientation: 'portrait-primary',
    screen: { width: 393, height: 852, availHeight: 852 },
    window: { innerWidth: 393, innerHeight: 793, outerHeight: 852, scrollY: 0 },
    clientHeight: 793,
    visualViewport: { width: 393, height: 793, offsetTop: 0, pageTop: 0, scale: 1 },
    units: { '100vh': 852, '100lvh': 852, '100dvh': 793.33, '--app-h': 852, '100svh': null },
    safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
    meta: { viewport: 'width=device-width, viewport-fit=cover', statusBarStyle: 'black-translucent' },
};

describe('viewport diag report', () => {
    it('px rounds to one decimal and marks missing values', () => {
        expect(px(793.333)).toBe('793.3');
        expect(px(852)).toBe('852');
        expect(px(-0.01)).toBe('0');
        expect(px(null)).toBe('n/a');
        expect(px(Number.NaN)).toBe('n/a');
    });

    it('gap to screen bottom is screen.height minus the bottom edge', () => {
        expect(gapToScreenBottom(852, 775)).toBe(77);
        expect(gapToScreenBottom(852, undefined)).toBeNull();
        expect(gapToScreenBottom(0, 10)).toBeNull();
    });

    it('report lists modes, units, safe areas and the --app-h shortfall', () => {
        const text = formatViewportReport(snap);
        expect(text).toContain('display-mode: standalone | navigator.standalone=true');
        expect(text).toContain('100dvh=793.3');
        expect(text).toContain('100svh=n/a');
        expect(text).toContain('safe-area: top=59 right=0 bottom=34 left=0');
        expect(text).toContain('app-h vs screen: 0 short');
        expect(text).toContain('meta status-bar-style: black-translucent');
        expect(text).not.toContain('elements');
    });

    it('element lines carry rect bottom, gap, computed and inline padding', () => {
        expect(formatElementLine({ selector: '.ci', found: false }, 852)).toBe('.ci: (not on this page)');
        const line = formatElementLine({
            selector: '.ci',
            found: true,
            top: 700,
            bottom: 818,
            height: 118,
            paddingBottom: '34px',
            marginBottom: '0px',
            inlinePaddingBottom: 'max(var(--sp-3), env(safe-area-inset-bottom))',
        }, 852);
        expect(line).toBe('.ci: top=700 bottom=818 h=118 gapToScreen=34 pb=34px style.pb=max(var(--sp-3), env(safe-area-inset-bottom))');
        const text = formatViewportReport(snap, [{ selector: '.sd', found: true, top: 0, bottom: 500, height: 500, paddingBottom: '0px', inlineHeight: '500px', keyboardOpen: true }]);
        expect(text).toContain('  .sd: top=0 bottom=500 h=500 gapToScreen=352 pb=0px style.height=500px keyboard-open');
    });

    it('?vhdiag parses on/off/absent', () => {
        expect(parseVhDiagParam('?vhdiag=1')).toBe(true);
        expect(parseVhDiagParam('?a=b&vhdiag=on')).toBe(true);
        expect(parseVhDiagParam('?vhdiag=0')).toBe(false);
        expect(parseVhDiagParam('?other=1')).toBeNull();
        expect(parseVhDiagParam('')).toBeNull();
    });

    it('B-797 keyboard line: visual viewport, scroll and where --app-h comes from', () => {
        expect(formatKeyboardLine({ vvHeight: 380.4, vvOffsetTop: 120, scrollY: 0, innerHeight: 657, appH: 380, appHOverride: '380px', keyboardOpen: true, rootLock: true }))
            .toBe('keyboard: vv.h=380.4 vv.top=120 scrollY=0 inner=657 · --app-h=380 (js 380px) open=yes root-lock=yes');
        expect(formatKeyboardLine({ vvHeight: null, vvOffsetTop: null, scrollY: 21, innerHeight: 657, appH: 678, appHOverride: '', keyboardOpen: false, rootLock: false }))
            .toContain('vv.h=n/a vv.top=n/a scrollY=21 inner=657 · --app-h=678 (css) open=no root-lock=no');
    });
});
