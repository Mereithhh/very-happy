import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appHeightOverride, keyboardViewport, viewportVars } from './viewportVars';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('appHeightOverride (B-797)', () => {
    it('iPhone Duo cover PWA: 100lvh 678 > web view 657 (top inset 0) → clamp to 657', () => {
        expect(appHeightOverride({ standaloneWebKit: true, lvh: 678, innerHeight: 657, safeTop: 0 })).toBe(657);
    });

    it('B-542 black-translucent iPhone: innerHeight short by the top inset → keep 100lvh (fills the screen)', () => {
        expect(appHeightOverride({ standaloneWebKit: true, lvh: 852, innerHeight: 793.33, safeTop: 59 })).toBeNull();
        expect(appHeightOverride({ standaloneWebKit: true, lvh: 932, innerHeight: 873, safeTop: 59 })).toBeNull();
    });

    it('status-bar-style default iPhone: 100lvh equals the web view → keep CSS', () => {
        expect(appHeightOverride({ standaloneWebKit: true, lvh: 797, innerHeight: 797, safeTop: 0 })).toBeNull();
    });

    it('never applies outside standalone WebKit (CSS is 100dvh there) or on bogus measurements', () => {
        expect(appHeightOverride({ standaloneWebKit: false, lvh: 678, innerHeight: 657, safeTop: 0 })).toBeNull();
        expect(appHeightOverride({ standaloneWebKit: true, lvh: 0, innerHeight: 657, safeTop: 0 })).toBeNull();
        expect(appHeightOverride({ standaloneWebKit: true, lvh: 678, innerHeight: 0, safeTop: 0 })).toBeNull();
    });
});

describe('keyboardViewport (B-797)', () => {
    const base = { coarse: true, vvOffsetTop: 0, vvScale: 1, layoutHeight: 657 };

    it('iOS overlay keyboard: visible height and pan offset', () => {
        expect(keyboardViewport({ ...base, vvHeight: 380.4, vvOffsetTop: 120.2 })).toEqual({ open: true, height: 380, top: 120 });
    });

    it('offset is clamped into the layout viewport', () => {
        expect(keyboardViewport({ ...base, vvHeight: 380, vvOffsetTop: 500 }).top).toBe(277);
        expect(keyboardViewport({ ...base, vvHeight: 380, vvOffsetTop: -10 }).top).toBe(0);
    });

    it('no keyboard: small UA-chrome drop, pinch zoom, desktop, Android resizes-content', () => {
        expect(keyboardViewport({ ...base, vvHeight: 620 }).open).toBe(false);
        expect(keyboardViewport({ ...base, vvHeight: 300, vvScale: 2 }).open).toBe(false);
        expect(keyboardViewport({ ...base, coarse: false, vvHeight: 300 }).open).toBe(false);
        expect(keyboardViewport({ ...base, vvHeight: 400, layoutHeight: 400 }).open).toBe(false);
        expect(keyboardViewport({ ...base, vvHeight: null }).open).toBe(false);
    });
});

describe('viewportVars (B-797)', () => {
    it('keyboard up: the app is the visible area', () => {
        expect(viewportVars(657, { open: true, height: 380, top: 120 })).toEqual({
            '--app-h': '380px', '--vv-h': '380px', '--vv-top': '120px', keyboardOpen: true,
        });
    });

    it('keyboard down: the clamp (or the CSS value) and nothing else — fully restored', () => {
        expect(viewportVars(657, { open: false, height: 657, top: 0 })).toEqual({
            '--app-h': '657px', '--vv-h': null, '--vv-top': null, keyboardOpen: false,
        });
        expect(viewportVars(null, { open: false, height: 852, top: 0 })).toEqual({
            '--app-h': null, '--vv-h': null, '--vv-top': null, keyboardOpen: false,
        });
    });
});

describe('root document never scrolls on app screens (B-797)', () => {
    const baseCss = read('../styles/base.css');
    const dialogCss = read('../styles/dialog.css');

    it('the root lock hides html/body overflow; the keyboard pins #root to the visual viewport', () => {
        expect(baseCss).toMatch(/html\[data-root-lock\],\s*html\[data-root-lock\] body \{\s*overflow: hidden;/);
        expect(baseCss).toMatch(/html\[data-root-lock\]\[data-keyboard-open\] #root \{\s*position: fixed;\s*top: var\(--vv-top, 0px\);[\s\S]*?height: var\(--vv-h, var\(--app-h\)\);/);
        expect(baseCss).toMatch(/html\[data-keyboard-open\] \{\s*--sa-b: 0px;/);
        expect(baseCss).toMatch(/html,\s*body \{\s*overscroll-behavior: none;/);
    });

    it('dialog backdrops cover only the visible area while the keyboard is up', () => {
        expect(dialogCss).toMatch(/html\[data-keyboard-open\] :is\(\.vh-dialog-overlay, \.vh-modal-layer\) \{\s*top: var\(--vv-top, 0px\);\s*bottom: auto;\s*height: var\(--vv-h, 100dvh\);/);
    });

    it('the shell, the keyboard-pinned screens and the boot install it', () => {
        expect(read('../screens/AppLayout.tsx')).toContain('useRootScrollLock();');
        expect(read('./useKeyboardViewportPin.ts')).toContain('useRootScrollLock();');
        expect(read('../main.tsx')).toMatch(/installViewportVars\(\);/);
        // The old pin undid iOS's pan with scrollTo on every resize (fought the pan, left a draggable band).
        expect(read('./useKeyboardViewportPin.ts')).not.toMatch(/requestAnimationFrame|style\.height/);
    });
});
