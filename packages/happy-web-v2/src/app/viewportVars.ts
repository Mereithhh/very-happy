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
 *
 * 4. B-855 (iPad, a user 11-01): overflow hidden does not stop iOS from
 *    scrolling the document — its keyboard reveal-pan, focus() and
 *    scrollIntoView all do, and the offset can outlive the keyboard: the whole
 *    app sat ~300px up with a blank band below until iOS re-laid out. Two gaps
 *    let it stick: the keyboard path keyed on `pointer: coarse`, which an iPad
 *    with a Magic Keyboard / trackpad reports as fine (with a Macintosh UA), so
 *    nothing was pinned or cleaned up; and the lock only reset the scroll once,
 *    at mount. Now any touch screen counts (`hasTouchScreen`), and while
 *    locked every window scroll / viewport / rotation / page-show / visibility
 *    event re-checks `shouldResetRootScroll` and returns the document to 0 —
 *    except while the keyboard is up or something still overlays the visual
 *    viewport, where iOS's pan is followed through `--vv-top`, never fought.
 *
 * 5. B-936 (iPad landscape, Owner 11-14): with the sidebar pinned beside the
 *    content (AppShell mode `expanded`), shrinking `--app-h` / #root to the
 *    visible area shrank and moved the sidebar too — even for the ~70pt
 *    shortcut bar iPadOS shows over a hardware keyboard, which also counts as
 *    a keyboard (> KEYBOARD_MIN_PX; the composer under it has to be revealed).
 *    In the split layout (`<html data-split-pane>`, set by AppShell) only the
 *    content pane avoids the keyboard: `--app-h` keeps the full height, #root
 *    is still pinned to the visual viewport's top (iOS's pan followed through
 *    `--vv-top`, as before), and base.css sizes `.app-main-row` to `--vv-h`
 *    (`<html data-keyboard-pane="detail">`). The single pane (phones, a
 *    collapsed sidebar, the drawer) keeps the whole-root behaviour above
 *    (`data-keyboard-pane="root"`).
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

/**
 * B-855: a touch screen, not only a coarse primary pointer. iPadOS with a
 * Magic Keyboard / trackpad reports `pointer: fine` and a Macintosh UA, yet its
 * soft keyboard still overlays the page and iOS still pans it.
 */
export function hasTouchScreen(s: { coarse: boolean; anyCoarse: boolean; maxTouchPoints: number }): boolean {
    return s.coarse || s.anyCoarse || s.maxTouchPoints > 1;
}

/** Is the iOS overlay keyboard up, and where is the visible area? */
export function keyboardViewport(s: {
    touch: boolean;
    vvHeight: number | null;
    vvOffsetTop: number;
    vvScale: number;
    layoutHeight: number;
}): KeyboardViewport {
    const closed = { open: false, height: s.layoutHeight, top: 0 };
    if (!s.touch || s.vvHeight === null || !(s.vvHeight > 0)) return closed;
    if (s.vvScale > 1.001) return closed; // pinch zoom, not a keyboard
    if (s.vvHeight >= s.layoutHeight - KEYBOARD_MIN_PX) return closed; // Android resizes-content lands here too
    const top = Math.max(0, Math.min(s.vvOffsetTop, s.layoutHeight - s.vvHeight));
    return { open: true, height: Math.round(s.vvHeight), top: Math.round(top) };
}

/** Which box avoids the keyboard: the whole app (single pane) or only the content pane (B-936). */
export type KeyboardPane = 'root' | 'detail';

/**
 * The CSS variables / attributes the state above maps to (null = remove).
 * `split` = the sidebar is pinned beside the content (AppShell `expanded`):
 * then `--app-h` keeps the full height and only the content pane takes `--vv-h`.
 */
export function viewportVars(appH: number | null, kb: KeyboardViewport, split = false): Record<'--app-h' | '--vv-h' | '--vv-top', string | null> & { keyboardOpen: boolean; keyboardPane: KeyboardPane | null } {
    const base = appH === null ? null : `${appH}px`;
    if (kb.open) {
        const keyboardPane: KeyboardPane = split ? 'detail' : 'root';
        return { '--app-h': split ? base : `${kb.height}px`, '--vv-h': `${kb.height}px`, '--vv-top': `${kb.top}px`, keyboardOpen: true, keyboardPane };
    }
    return { '--app-h': base, '--vv-h': null, '--vv-top': null, keyboardOpen: false, keyboardPane: null };
}

/** Visual-viewport shortfall (px) still treated as "nothing overlays the page". */
const VV_FULL_SLACK_PX = 8;

/**
 * B-855: must a locked document's scroll offset be undone now? Only when the
 * visual viewport covers the whole layout viewport — then iOS has nothing to
 * reveal and any offset is residue. While the keyboard (or a smaller overlay
 * such as the iPad shortcut bar) is up, or the page is pinch-zoomed, iOS's pan
 * is legitimate and a scrollTo would fight it (B-797's feedback loop).
 */
export function shouldResetRootScroll(s: {
    rootLocked: boolean;
    keyboardOpen: boolean;
    scrollX: number;
    scrollY: number;
    vvHeight: number | null;
    vvScale: number;
    layoutHeight: number;
}): boolean {
    if (!s.rootLocked || s.keyboardOpen) return false;
    if (!s.scrollX && !s.scrollY) return false;
    if (s.vvScale > 1.001) return false;
    if (s.vvHeight !== null && s.vvHeight < s.layoutHeight - VV_FULL_SLACK_PX) return false;
    return true;
}

/** Events after which a locked document is re-checked (window / document / visualViewport). */
export const ROOT_SCROLL_GUARD_EVENTS = {
    window: ['scroll', 'resize', 'orientationchange', 'pageshow', 'focusout'],
    document: ['visibilitychange'],
    visualViewport: ['resize', 'scroll'],
} as const;

let rootScrollResets = 0;
/** How often the guard has undone a document scroll (Viewport 诊断). */
export function getRootScrollResets(): number {
    return rootScrollResets;
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
            touch: hasTouchScreen({ coarse: mq('(pointer: coarse)'), anyCoarse: mq('(any-pointer: coarse)'), maxTouchPoints: navigator.maxTouchPoints ?? 0 }),
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
        const vars = viewportVars(appH, kb, root.dataset.splitPane === 'true');
        for (const name of ['--app-h', '--vv-h', '--vv-top'] as const) {
            const value = vars[name];
            if (value === null) root.style.removeProperty(name);
            else root.style.setProperty(name, value);
        }
        if (vars.keyboardOpen) root.dataset.keyboardOpen = 'true';
        else delete root.dataset.keyboardOpen;
        if (vars.keyboardPane) root.dataset.keyboardPane = vars.keyboardPane;
        else delete root.dataset.keyboardPane;
        const reset = shouldResetRootScroll({
            rootLocked: root.dataset.rootLock === 'true',
            keyboardOpen: kb.open,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            vvHeight: vv ? vv.height : null,
            vvScale: vv?.scale ?? 1,
            layoutHeight,
        });
        if (reset) {
            rootScrollResets++;
            window.scrollTo(0, 0);
        }
        const changed = kb.open !== current.open || kb.height !== current.height || kb.top !== current.top;
        current = kb;
        if (changed) listeners.forEach((fn) => fn(kb));
    };
    const schedule = () => {
        if (!frame) frame = requestAnimationFrame(update);
    };
    refresh = schedule;
    for (const type of ROOT_SCROLL_GUARD_EVENTS.window) window.addEventListener(type, schedule, { passive: true });
    for (const type of ROOT_SCROLL_GUARD_EVENTS.document) document.addEventListener(type, schedule);
    for (const type of ROOT_SCROLL_GUARD_EVENTS.visualViewport) window.visualViewport?.addEventListener(type, schedule);
    update();
}

let refresh: () => void = () => {};

/**
 * B-936: AppShell marks the split layout (sidebar pinned beside the content)
 * on <html> while it is mounted, and re-runs the measurement so an open
 * keyboard switches between whole-root and content-pane avoidance at once
 * (rotation / collapsing the sidebar with the keyboard up).
 */
export function useSplitPaneMark(split: boolean): void {
    useEffect(() => {
        const root = document.documentElement;
        if (split) root.dataset.splitPane = 'true';
        else delete root.dataset.splitPane;
        refresh();
        return () => {
            delete root.dataset.splitPane;
            refresh();
        };
    }, [split]);
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
