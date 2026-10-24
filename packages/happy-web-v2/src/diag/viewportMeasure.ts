/**
 * B-599: viewport diagnostics — DOM half. Reads what the browser resolves for
 * each viewport unit / safe-area inset by sizing hidden probe elements, since
 * none of 100lvh, env(), or the resolved --app-h are exposed to JS directly.
 */
import type { ElementSnapshot, KeyboardSnapshot, ViewportSnapshot } from './viewportReport';

const UNIT_PROBES: Array<[label: string, height: string]> = [
    ['100vh', '100vh'],
    ['100svh', '100svh'],
    ['100lvh', '100lvh'],
    ['100dvh', '100dvh'],
    ['100%', '100%'],
    ['--app-h', 'var(--app-h)'],
];

const DISPLAY_MODES = ['standalone', 'fullscreen', 'minimal-ui', 'browser'];

/** The session layout chain from the shell down to the context meter. */
export const LAYOUT_SELECTORS = ['html', 'body', '#root', '.app-shell', '.app-detail', '.sd', '.sd-foot', '.ci', '.ci-status'];

function probe(style: Partial<CSSStyleDeclaration>): HTMLDivElement {
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '0',
        visibility: 'hidden',
        pointerEvents: 'none',
        ...style,
    });
    document.body.appendChild(el);
    return el;
}

function measureUnits(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const [label, height] of UNIT_PROBES) {
        const el = probe({ height });
        // An unsupported unit leaves height at `auto` → 0, report that as n/a.
        const h = el.getBoundingClientRect().height;
        out[label] = el.style.height ? h : null;
        el.remove();
    }
    return out;
}

export function measureSafeArea(): ViewportSnapshot['safeArea'] {
    const el = probe({
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
    });
    const cs = getComputedStyle(el);
    const result = {
        top: parseFloat(cs.paddingTop) || 0,
        right: parseFloat(cs.paddingRight) || 0,
        bottom: parseFloat(cs.paddingBottom) || 0,
        left: parseFloat(cs.paddingLeft) || 0,
    };
    el.remove();
    return result;
}

function metaContent(selector: string): string | null {
    return document.querySelector<HTMLMetaElement>(selector)?.content ?? null;
}

export function collectViewportSnapshot(): ViewportSnapshot {
    const vv = window.visualViewport;
    const displayMode: Record<string, boolean> = {};
    for (const mode of DISPLAY_MODES) {
        displayMode[mode] = window.matchMedia?.(`(display-mode: ${mode})`).matches === true;
    }
    const nav = navigator as Navigator & { standalone?: boolean };
    return {
        at: new Date().toISOString(),
        build: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
        userAgent: navigator.userAgent,
        displayMode,
        navigatorStandalone: typeof nav.standalone === 'boolean' ? nav.standalone : null,
        devicePixelRatio: window.devicePixelRatio,
        orientation: screen.orientation?.type ?? null,
        screen: { width: screen.width, height: screen.height, availHeight: screen.availHeight },
        window: {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            outerHeight: window.outerHeight,
            scrollY: window.scrollY,
        },
        clientHeight: document.documentElement.clientHeight,
        visualViewport: vv
            ? { width: vv.width, height: vv.height, offsetTop: vv.offsetTop, pageTop: vv.pageTop, scale: vv.scale }
            : null,
        units: measureUnits(),
        safeArea: measureSafeArea(),
        meta: {
            viewport: metaContent('meta[name="viewport"]'),
            statusBarStyle: metaContent('meta[name="apple-mobile-web-app-status-bar-style"]'),
        },
    };
}

export function collectKeyboardSnapshot(): KeyboardSnapshot {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const el = probe({ height: 'var(--app-h)' });
    const appH = el.getBoundingClientRect().height;
    el.remove();
    return {
        vvHeight: vv ? vv.height : null,
        vvOffsetTop: vv ? vv.offsetTop : null,
        scrollY: window.scrollY,
        innerHeight: window.innerHeight,
        appH: appH > 0 ? appH : null,
        appHOverride: root.style.getPropertyValue('--app-h').trim(),
        keyboardOpen: root.dataset.keyboardOpen === 'true',
        rootLock: root.dataset.rootLock === 'true',
    };
}

export function collectElementSnapshots(selectors: string[] = LAYOUT_SELECTORS): ElementSnapshot[] {
    return selectors.map((selector) => {
        const el = document.querySelector<HTMLElement>(selector);
        if (!el) return { selector, found: false };
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
            selector,
            found: true,
            top: rect.top,
            left: rect.left,
            width: rect.width,
            bottom: rect.bottom,
            height: rect.height,
            paddingBottom: cs.paddingBottom,
            marginBottom: cs.marginBottom,
            inlineHeight: el.style.height || undefined,
            inlinePaddingBottom: el.style.paddingBottom || undefined,
            keyboardOpen: el.dataset.keyboardOpen === 'true' || undefined,
        };
    });
}

/** Clipboard with a selection fallback (iOS standalone may reject the async API). */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        Object.assign(ta.style, { position: 'fixed', top: '0', left: '0', opacity: '0' });
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        let ok = false;
        try {
            ok = document.execCommand('copy');
        } catch {
            ok = false;
        }
        ta.remove();
        return ok;
    }
}

/** Calls `fn` (rAF-coalesced) on every viewport change plus a 1s heartbeat
 *  (layout shifts like the composer growing fire no viewport event). */
export function subscribeViewportChanges(fn: () => void): () => void {
    let frame = 0;
    const schedule = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            fn();
        });
    };
    const vv = window.visualViewport;
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    window.addEventListener('scroll', schedule, true);
    vv?.addEventListener('resize', schedule);
    vv?.addEventListener('scroll', schedule);
    const timer = window.setInterval(schedule, 1000);
    schedule();
    return () => {
        if (frame) cancelAnimationFrame(frame);
        window.removeEventListener('resize', schedule);
        window.removeEventListener('orientationchange', schedule);
        window.removeEventListener('scroll', schedule, true);
        vv?.removeEventListener('resize', schedule);
        vv?.removeEventListener('scroll', schedule);
        window.clearInterval(timer);
    };
}
