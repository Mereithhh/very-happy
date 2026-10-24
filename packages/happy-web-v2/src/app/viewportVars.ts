/**
 * B-797: the app height and the visible (keyboard-free) area, measured in JS
 * and written as CSS variables on <html>.
 *
 * 1. `--app-h` — base.css sets 100lvh for standalone WebKit (B-542: iOS 26
 *    black-translucent home-screen apps report innerHeight / 100dvh short by
 *    the TOP safe-area inset, and only 100lvh reaches the screen edge). The
 *    iPhone Duo cover display (iOS 27, status-bar-style default) breaks that
 *    rule the other way: 100lvh = 678 but the web view is 657 tall (top inset
 *    0), so the document scrolled by 21px (scrollY=21) — a blank band to drag
 *    up and iOS's scroll-edge blur over the header. The real visible height is
 *    innerHeight + the top inset; 100lvh is only kept when it does not exceed
 *    that (`appHeightOverride`).
 *
 * 2. The soft keyboard — iOS overlays it (no interactive-widget support) and
 *    pans the layout viewport to reveal the field. While it is up we publish
 *    `--vv-h` / `--vv-top` (visualViewport height / offsetTop), set `--app-h`
 *    to the visible height and mark `<html data-keyboard-open>`; base.css then
 *    pins #root (on root-locked pages) to the visual viewport, so the composer
 *    sits on the keyboard and the page cannot be dragged into blank space.
 *    Only CSS variables follow the pan — no scrollTo, which fights iOS's own
 *    pan in a feedback loop. Everything is cleared when the keyboard closes.
 *
 * 3. Root lock — app shells never scroll the document (inner containers do);
 *    `useRootScrollLock` sets `<html data-root-lock>` (overflow hidden) while
 *    such a screen is mounted. Public pages (landing / docs) keep page scroll.
 */
import { useEffect } from 'react';

/** Keyboard heuristic shared with useKeyboardViewportPin's history: a smaller drop is UA chrome. */
export const KEYBOARD_MIN_PX = 50;

/**
 * The px `--app-h` must take instead of the CSS value, or null to keep CSS.
 * Only standalone WebKit uses 100lvh; elsewhere 100dvh already tracks the
 * visible area.
 */
export function appHeightOverride(s: { standaloneWebKit: boolean; lvh: number; innerHeight: number; safeTop: number }): number | null {
    if (!s.standaloneWebKit || !(s.innerHeight > 0) || !(s.lvh > 0)) return null;
    const visible = s.innerHeight + Math.max(0, s.safeTop);
    // ≤1px: 793.33 + 59 vs 852 on a black-translucent iPhone — CSS is right.
    return s.lvh > visible + 1 ? Math.round(visible) : null;
}

export interface KeyboardViewport {
    open: boolean;
    /** visible height / offset in the layout viewport (CSS px). */
    height: number;
    top: number;
}

/** Is the iOS overlay keyboard up, and where is the visible area? */
export function keyboardViewport(s: {
    coarse: boolean;
    vvHeight: number | null;
    vvOffsetTop: number;
    vvScale: number;
    layoutHeight: number;
}): KeyboardViewport {
    const closed = { open: false, height: s.layoutHeight, top: 0 };
    if (!s.coarse || s.vvHeight === null || !(s.vvHeight > 0)) return closed;
    if (s.vvScale > 1.001) return closed; // pinch zoom, not a keyboard
    if (s.vvHeight >= s.layoutHeight - KEYBOARD_MIN_PX) return closed; // Android resizes-content lands here too
    const top = Math.max(0, Math.min(s.vvOffsetTop, s.layoutHeight - s.vvHeight));
    return { open: true, height: Math.round(s.vvHeight), top: Math.round(top) };
}

/** The CSS variables / attribute the state above maps to (null = remove). */
export function viewportVars(appH: number | null, kb: KeyboardViewport): Record<'--app-h' | '--vv-h' | '--vv-top', string | null> & { keyboardOpen: boolean } {
    if (kb.open) {
        return { '--app-h': `${kb.height}px`, '--vv-h': `${kb.height}px`, '--vv-top': `${kb.top}px`, keyboardOpen: true };
    }
    return { '--app-h': appH === null ? null : `${appH}px`, '--vv-h': null, '--vv-top': null, keyboardOpen: false };
}

type Listener = (kb: KeyboardViewport) => void;
const listeners = new Set<Listener>();
let current: KeyboardViewport = { open: false, height: 0, top: 0 };
let installed = false;

export function getKeyboardViewport(): KeyboardViewport {
    return current;
}

export function subscribeKeyboardViewport(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Probe for what CSS resolves but JS cannot read: 100lvh and the top inset. */
function measureCss(): { lvh: number; safeTop: number } {
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, { position: 'absolute', top: '0', left: '0', width: '0', visibility: 'hidden', pointerEvents: 'none', height: '100lvh', paddingTop: 'var(--sa-t)', boxSizing: 'content-box' });
    document.body.appendChild(el);
    const safeTop = parseFloat(getComputedStyle(el).paddingTop) || 0;
    const lvh = el.getBoundingClientRect().height - safeTop;
    el.remove();
    return { lvh, safeTop };
}

/** Once, at boot (main.tsx). Safe to call before React mounts. */
export function installViewportVars(): void {
    if (installed || typeof window === 'undefined' || !document.body) return;
    installed = true;
    const root = document.documentElement;
    const mq = (q: string) => window.matchMedia?.(q).matches === true;
    const standaloneWebKit = mq('(display-mode: standalone)') && typeof CSS !== 'undefined' && CSS.supports?.('-webkit-touch-callout', 'none') === true;
    let appH: number | null = null;
    let frame = 0;

    const update = () => {
        frame = 0;
        const vv = window.visualViewport;
        // The ICB height: unaffected by iOS's overlay keyboard (unlike vv).
        const layoutHeight = Math.max(window.innerHeight, root.clientHeight);
        const kb = keyboardViewport({
            coarse: mq('(pointer: coarse)'),
            vvHeight: vv ? vv.height : null,
            vvOffsetTop: vv?.offsetTop ?? 0,
            vvScale: vv?.scale ?? 1,
            layoutHeight,
        });
        // Re-measure the base height only with the keyboard down (rotation, Duo fold/unfold).
        if (!kb.open) {
            root.style.removeProperty('--app-h');
            const { lvh, safeTop } = measureCss();
            appH = appHeightOverride({ standaloneWebKit, lvh, innerHeight: window.innerHeight, safeTop });
        }
        const vars = viewportVars(appH, kb);
        for (const name of ['--app-h', '--vv-h', '--vv-top'] as const) {
            const value = vars[name];
            if (value === null) root.style.removeProperty(name);
            else root.style.setProperty(name, value);
        }
        if (vars.keyboardOpen) root.dataset.keyboardOpen = 'true';
        else delete root.dataset.keyboardOpen;
        const changed = kb.open !== current.open || kb.height !== current.height || kb.top !== current.top;
        current = kb;
        if (changed) listeners.forEach((fn) => fn(kb));
    };
    const schedule = () => {
        if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    update();
}

let lockCount = 0;
/** While mounted, the document itself never scrolls (app shells). Ref-counted. */
export function useRootScrollLock(): void {
    useEffect(() => {
        const root = document.documentElement;
        lockCount++;
        root.dataset.rootLock = 'true';
        // A scroll offset left from before the lock (or an iOS pan) would stay frozen in place.
        if (window.scrollY) window.scrollTo(0, 0);
        return () => {
            lockCount--;
            if (lockCount <= 0) {
                lockCount = 0;
                delete root.dataset.rootLock;
            }
        };
    }, []);
}
