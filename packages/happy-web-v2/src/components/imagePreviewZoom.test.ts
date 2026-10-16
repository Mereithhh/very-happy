import { describe, expect, it } from 'vitest';
import {
    GESTURE_MAX_SCALE, clampView, doubleTapScale, fitScale, fitView, gestureMinScale, hasPanRoom, isNearFit, pastDeadZone,
    pinchView, wheelAction, wheelZoomFactor, zoomAt, type ZoomView,
} from './imagePreviewZoom';

const image = { width: 1600, height: 800 };
const canvas = { width: 640, height: 480 };
/** Canvas point where image point (ix, iy) is drawn. */
const project = (view: ZoomView, ix: number, iy: number) => ({ x: view.x + ix * view.scale, y: view.y + iy * view.scale });
/** Image point drawn under canvas point (px, py). */
const unproject = (view: ZoomView, px: number, py: number) => ({ x: (px - view.x) / view.scale, y: (py - view.y) / view.scale });

describe('B-608 fit', () => {
    it('fits inside the 16px padding and never upscales small images', () => {
        expect(fitScale(image, canvas)).toBe(0.38);
        expect(fitScale({ width: 100, height: 50 }, canvas)).toBe(1);
        expect(fitScale(image, { width: 0, height: 0 })).toBe(1);
    });
    it('centres the fitted image on both axes', () => {
        const view = fitView(image, canvas);
        expect(view).toEqual({ scale: 0.38, x: 16, y: (480 - 304) / 2 });
    });
});

describe('B-608 anchor zoom', () => {
    it('keeps the image point under the anchor fixed', () => {
        const start = { scale: 2, x: -500, y: -300 };
        const anchor = { x: 210, y: 333 };
        const before = unproject(start, anchor.x, anchor.y);
        for (const next of [2.5, 3.7, 8, 1.1]) {
            const after = project(zoomAt(start, next, anchor), before.x, before.y);
            expect(after.x).toBeCloseTo(anchor.x, 9);
            expect(after.y).toBeCloseTo(anchor.y, 9);
        }
    });
    it('stays anchored after the pan clamp when the zoomed image still overflows', () => {
        const start = clampView({ scale: 2, x: -800, y: -400 }, image, canvas);
        const anchor = { x: 320, y: 240 };
        const before = unproject(start, anchor.x, anchor.y);
        const after = clampView(zoomAt(start, 3, anchor), image, canvas);
        expect(project(after, before.x, before.y).x).toBeCloseTo(anchor.x, 9);
        expect(project(after, before.x, before.y).y).toBeCloseTo(anchor.y, 9);
    });
});

describe('B-608 pan clamp', () => {
    it('centres an axis that fits and edge-limits one that overflows', () => {
        const wide = clampView({ scale: 1, x: 999, y: 999 }, image, canvas);
        expect(wide.x).toBe(16); // left edge cannot leave more than the padding
        expect(wide.y).toBe(16);
        const farLeft = clampView({ scale: 1, x: -99_999, y: -99_999 }, image, canvas);
        expect(farLeft.x).toBe(640 - 16 - 1600); // right edge stays on screen
        expect(farLeft.y).toBe(480 - 16 - 800);
        const narrow = clampView({ scale: 0.2, x: -999, y: 999 }, image, canvas);
        expect(narrow).toEqual({ scale: 0.2, x: (640 - 320) / 2, y: (480 - 160) / 2 });
    });
    it('never lets any part of the canvas lose the whole image', () => {
        for (const scale of [0.1, 0.38, 1, 4, 8]) for (const x of [-1e6, -300, 0, 300, 1e6]) {
            const v = clampView({ scale, x, y: x }, image, canvas);
            const right = v.x + image.width * scale;
            const bottom = v.y + image.height * scale;
            // the image always overlaps the padded canvas interior
            expect(v.x).toBeLessThan(640 - 16);
            expect(right).toBeGreaterThan(16);
            expect(v.y).toBeLessThan(480 - 16);
            expect(bottom).toBeGreaterThan(16);
        }
    });
});

describe('B-608 pinch', () => {
    it('scales by the finger-distance ratio around the midpoint and follows it', () => {
        const start = { scale: 1, x: -100, y: -50 };
        const mid0 = { x: 300, y: 200 };
        const under = unproject(start, mid0.x, mid0.y);
        const mid1 = { x: 340, y: 180 };
        const next = pinchView(start, mid0, 100, mid1, 250, 0.38);
        expect(next.scale).toBe(2.5);
        expect(project(next, under.x, under.y).x).toBeCloseTo(mid1.x, 9);
        expect(project(next, under.x, under.y).y).toBeCloseTo(mid1.y, 9);
    });
    it('clamps to [min, 8×]', () => {
        expect(pinchView({ scale: 4, x: 0, y: 0 }, { x: 0, y: 0 }, 10, { x: 0, y: 0 }, 1000, 0.38).scale).toBe(GESTURE_MAX_SCALE);
        expect(pinchView({ scale: 1, x: 0, y: 0 }, { x: 0, y: 0 }, 1000, { x: 0, y: 0 }, 1, 0.38).scale).toBe(0.38);
    });
});

describe('B-608 wheel semantics: pinch = zoom, scroll = pan', () => {
    const wheel = (over: Partial<Parameters<typeof wheelAction>[0]>) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...over });
    it('trackpad pinch (ctrlKey) zooms with the steep curve, even when there is room to pan', () => {
        expect(wheelAction(wheel({ deltaY: -10, ctrlKey: true }), true)).toEqual({ kind: 'zoom', factor: Math.exp(0.1) });
    });
    it('Cmd + mouse wheel zooms with the notch curve', () => {
        expect(wheelAction(wheel({ deltaY: -100, metaKey: true }), true)).toEqual({ kind: 'zoom', factor: Math.exp(0.2) });
    });
    it('plain wheel / two-finger scroll pans by the delta when the image overflows', () => {
        expect(wheelAction(wheel({ deltaX: 12, deltaY: 30 }), true)).toEqual({ kind: 'pan', dx: -12, dy: -30 });
        expect(wheelAction(wheel({ deltaY: 3, deltaMode: 1 }), true)).toEqual({ kind: 'pan', dx: 0, dy: -48 });
    });
    it('Shift + vertical wheel pans horizontally unless the browser already swapped it', () => {
        expect(wheelAction(wheel({ deltaY: 40, shiftKey: true }), true)).toEqual({ kind: 'pan', dx: -40, dy: 0 });
        expect(wheelAction(wheel({ deltaX: 40, shiftKey: true }), true)).toEqual({ kind: 'pan', dx: -40, dy: 0 });
    });
    it('plain wheel zooms when the image fits, so a mouse can still zoom in from fit', () => {
        expect(wheelAction(wheel({ deltaY: -100 }), false)).toEqual({ kind: 'zoom', factor: Math.exp(0.2) });
    });
    it('pan room means overflowing the padded canvas on either axis', () => {
        expect(hasPanRoom(image, 0.38, canvas)).toBe(false); // exactly fit
        expect(hasPanRoom(image, 0.4, canvas)).toBe(true); // 640 wide > 608
        expect(hasPanRoom({ width: 100, height: 100 }, 1, canvas)).toBe(false);
    });
});

describe('B-608 wheel and taps', () => {
    it('zooms in on negative deltas with the steeper curve for trackpad pinch', () => {
        expect(wheelZoomFactor(-10, 0, true)).toBeCloseTo(Math.exp(0.1), 12);
        expect(wheelZoomFactor(100, 0, false)).toBeCloseTo(Math.exp(-0.2), 12);
        expect(wheelZoomFactor(-3, 1, false)).toBeCloseTo(Math.exp(0.096), 12); // 3 lines ≈ 48px
        expect(wheelZoomFactor(-5000, 0, false)).toBeCloseTo(Math.exp(0.2), 12); // capped per event
        expect(wheelZoomFactor(0, 0, true)).toBe(1);
    });
    it('does not let gestures shrink below fit, but keeps an already smaller button zoom', () => {
        expect(gestureMinScale(0.38, 2)).toBe(0.38);
        expect(gestureMinScale(0.38, 0.2)).toBe(0.2);
    });
    it('double-tap goes to twice the fit, never below 100%', () => {
        expect(doubleTapScale(0.38)).toBe(1);
        expect(doubleTapScale(0.7)).toBe(1.4);
        expect(doubleTapScale(1)).toBe(2);
        expect(isNearFit(0.38, 0.38)).toBe(true);
        expect(isNearFit(0.4, 0.38)).toBe(false);
    });
    it('needs more than 4px of travel before a press pans', () => {
        expect(pastDeadZone({ x: 0, y: 0 }, { x: 3, y: 2 })).toBe(false);
        expect(pastDeadZone({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(false);
        expect(pastDeadZone({ x: 0, y: 0 }, { x: 4, y: 1 })).toBe(true);
    });
});
