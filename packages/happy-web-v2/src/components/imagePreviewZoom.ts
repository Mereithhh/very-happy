/**
 * B-608 image preview zoom/pan math. Pure so the gesture rules are unit-tested
 * without a browser; ImagePreview only maps events onto these functions.
 *
 * Coordinates are canvas-local CSS px. The image is drawn at its natural size
 * with `transform-origin: 0 0; transform: translate(x, y) scale(scale)`, so an
 * image point (ix, iy) lands on canvas point (x + ix * scale, y + iy * scale).
 */

export type ZoomView = { scale: number; x: number; y: number };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/** Canvas padding on every side; fit and pan clamps both keep it clear. */
export const IMAGE_PREVIEW_PAD = 16;
/** Largest scale gestures (wheel, pinch, double-click) may reach. */
export const GESTURE_MAX_SCALE = 8;
/** Largest scale the + button may reach (pre-B-608 semantics). */
export const BUTTON_MAX_SCALE = 4;
/** Button zoom step (pre-B-608 semantics). */
export const BUTTON_STEP = 1.25;
/** Pointer travel before a press becomes a pan, so clicks still click. */
export const PAN_DEAD_ZONE = 4;

/** Fit-to-canvas scale, never upscaling a small image past 100%. */
export function fitScale(image: Size, canvas: Size, pad = IMAGE_PREVIEW_PAD): number {
    if (image.width <= 0 || image.height <= 0 || canvas.width <= 0 || canvas.height <= 0) return 1;
    return Math.min(1, Math.max(1, canvas.width - pad * 2) / image.width, Math.max(1, canvas.height - pad * 2) / image.height);
}

/** One axis of the pan clamp: centred when it fits, edge-limited when it overflows. */
function clampAxis(offset: number, content: number, canvas: number, pad: number): number {
    if (content <= canvas - pad * 2) return (canvas - content) / 2;
    return Math.min(pad, Math.max(canvas - pad - content, offset));
}

/**
 * Keep the image findable: an axis that fits is centred, an axis that
 * overflows may not leave a gap wider than the padding on either side.
 */
export function clampView(view: ZoomView, image: Size, canvas: Size, pad = IMAGE_PREVIEW_PAD): ZoomView {
    return {
        scale: view.scale,
        x: clampAxis(view.x, image.width * view.scale, canvas.width, pad),
        y: clampAxis(view.y, image.height * view.scale, canvas.height, pad),
    };
}

/** Whether the scaled image overflows the padded canvas on either axis (something to pan). */
export function hasPanRoom(image: Size, scale: number, canvas: Size, pad = IMAGE_PREVIEW_PAD): boolean {
    return image.width * scale > canvas.width - pad * 2 + 0.5 || image.height * scale > canvas.height - pad * 2 + 0.5;
}

/** The centred fit view. */
export function fitView(image: Size, canvas: Size, pad = IMAGE_PREVIEW_PAD): ZoomView {
    return clampView({ scale: fitScale(image, canvas, pad), x: 0, y: 0 }, image, canvas, pad);
}

/**
 * Change scale while keeping the image point under `anchor` fixed on screen
 * (before the pan clamp; callers clamp afterwards).
 */
export function zoomAt(view: ZoomView, nextScale: number, anchor: Point): ZoomView {
    const ratio = nextScale / view.scale;
    return { scale: nextScale, x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio };
}

/**
 * Two-finger pinch: the image point that was under the starting midpoint
 * follows the current midpoint, scaled by the finger-distance ratio.
 */
export function pinchView(start: ZoomView, startMid: Point, startDistance: number, mid: Point, distance: number, minScale: number, maxScale = GESTURE_MAX_SCALE): ZoomView {
    const scale = clampScale(start.scale * (distance / Math.max(1, startDistance)), minScale, maxScale);
    const ix = (startMid.x - start.x) / start.scale;
    const iy = (startMid.y - start.y) / start.scale;
    return { scale, x: mid.x - ix * scale, y: mid.y - iy * scale };
}

export function clampScale(scale: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, scale));
}

/** Normalise a wheel delta to CSS px (line = 16px, page = 400px). */
export function wheelPixels(delta: number, deltaMode: number): number {
    return deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * 400 : delta;
}

/**
 * Wheel delta → multiplicative zoom factor. Trackpad pinch arrives as a
 * ctrlKey wheel with small pixel deltas and gets the steeper curve; a mouse
 * notch (~100px, or 3 lines) is ≈ ×1.22.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
    const pixels = wheelPixels(deltaY, deltaMode);
    const k = ctrlKey ? 0.01 : 0.002;
    // Cap a single event so a page-mode wheel cannot jump straight to a bound.
    return Math.exp(-Math.max(-100, Math.min(100, pixels)) * k);
}

export type WheelInput = { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };
export type WheelAction = { kind: 'zoom'; factor: number } | { kind: 'pan'; dx: number; dy: number };

/**
 * Platform convention (macOS Preview/Figma): pinch = zoom, scroll = pan.
 * - ctrlKey wheel (trackpad pinch; Ctrl+wheel) or metaKey wheel (Cmd+mouse
 *   wheel) → anchored zoom.
 * - plain wheel → pan by the scroll delta while the image is larger than
 *   the canvas (Shift+vertical wheel pans horizontally);
 * - plain wheel with nothing to pan (image fits) → anchored zoom, so a mouse
 *   wheel can still zoom in from fit.
 */
export function wheelAction(input: WheelInput, pannable: boolean): WheelAction {
    if (input.ctrlKey || input.metaKey || !pannable) {
        // Only a ctrlKey wheel is a pinch with small deltas; Cmd/plain wheels are mouse notches.
        return { kind: 'zoom', factor: wheelZoomFactor(input.deltaY, input.deltaMode, input.ctrlKey) };
    }
    let dx = wheelPixels(input.deltaX, input.deltaMode);
    let dy = wheelPixels(input.deltaY, input.deltaMode);
    // Browsers that do not swap Shift+wheel themselves still pan horizontally.
    if (input.shiftKey && dx === 0) { dx = dy; dy = 0; }
    // Scrolling down moves the content up, like a scrolled page.
    return { kind: 'pan', dx: -dx || 0, dy: -dy || 0 };
}

/**
 * Lower bound for gestures: they never shrink below fit, but a view the user
 * already took below fit with the − button is not snapped back up.
 */
export function gestureMinScale(fit: number, current: number): number {
    return Math.min(fit, current);
}

/** Double-click / double-tap target: twice the fit, but never below 100%. */
export function doubleTapScale(fit: number): number {
    return Math.min(GESTURE_MAX_SCALE, Math.max(1, fit * 2));
}

/** Whether the double-click / double-tap should zoom in (true) or return to fit. */
export function isNearFit(scale: number, fit: number): boolean {
    return Math.abs(scale - fit) < 0.005 * Math.max(fit, 0.01) + 1e-6;
}

export function pastDeadZone(start: Point, current: Point, threshold = PAN_DEAD_ZONE): boolean {
    return Math.hypot(current.x - start.x, current.y - start.y) > threshold;
}

export function distance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
