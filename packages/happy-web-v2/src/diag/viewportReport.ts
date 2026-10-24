/**
 * B-599: viewport diagnostics — pure half (formatting + flag parsing).
 *
 * The iOS 26 home-screen bottom band (B-542) can't be reproduced without a
 * device, so a user screenshots/copies this report from inside the PWA. The
 * DOM measuring lives in viewportMeasure.ts; everything here is plain data in,
 * text out, so it is unit-testable.
 */

export interface ViewportSnapshot {
    at: string;
    build: string;
    userAgent: string;
    displayMode: Record<string, boolean>;
    navigatorStandalone: boolean | null;
    devicePixelRatio: number;
    orientation: string | null;
    screen: { width: number; height: number; availHeight: number };
    window: { innerWidth: number; innerHeight: number; outerHeight: number; scrollY: number };
    clientHeight: number;
    visualViewport: { width: number; height: number; offsetTop: number; pageTop: number; scale: number } | null;
    /** px heights of probe elements sized `height: <unit>` (100vh, 100lvh, var(--app-h), …). */
    units: Record<string, number | null>;
    /** env(safe-area-inset-*) in px. */
    safeArea: { top: number; right: number; bottom: number; left: number };
    meta: { viewport: string | null; statusBarStyle: string | null };
}

export interface ElementSnapshot {
    selector: string;
    found: boolean;
    top?: number;
    left?: number;
    width?: number;
    bottom?: number;
    height?: number;
    paddingBottom?: string;
    marginBottom?: string;
    inlineHeight?: string;
    inlinePaddingBottom?: string;
    keyboardOpen?: boolean;
}

/** Number → short px string: 1 decimal, trailing `.0` dropped; null → `n/a`. */
export function px(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
    const rounded = Math.round(value * 10) / 10;
    return `${Object.is(rounded, -0) ? 0 : rounded}`;
}

/** Distance from an element's bottom edge up from the physical screen bottom. */
export function gapToScreenBottom(screenHeight: number, bottom: number | undefined): number | null {
    if (bottom === undefined || !Number.isFinite(bottom) || !(screenHeight > 0)) return null;
    return screenHeight - bottom;
}

export function formatElementLine(el: ElementSnapshot, screenHeight: number): string {
    if (!el.found) return `${el.selector}: (not on this page)`;
    const parts = [
        `top=${px(el.top)}`,
        `bottom=${px(el.bottom)}`,
        `h=${px(el.height)}`,
        `gapToScreen=${px(gapToScreenBottom(screenHeight, el.bottom))}`,
        `pb=${el.paddingBottom ?? 'n/a'}`,
    ];
    if (el.marginBottom && el.marginBottom !== '0px') parts.push(`mb=${el.marginBottom}`);
    if (el.inlineHeight) parts.push(`style.height=${el.inlineHeight}`);
    if (el.inlinePaddingBottom) parts.push(`style.pb=${el.inlinePaddingBottom}`);
    if (el.keyboardOpen) parts.push('keyboard-open');
    return `${el.selector}: ${parts.join(' ')}`;
}

export function formatViewportReport(snap: ViewportSnapshot, elements: ElementSnapshot[] = []): string {
    const modes = Object.entries(snap.displayMode)
        .filter(([, on]) => on)
        .map(([mode]) => mode);
    const units = Object.entries(snap.units).map(([unit, value]) => `${unit}=${px(value)}`);
    const vv = snap.visualViewport;
    const lines = [
        `# viewport diag ${snap.at} build ${snap.build}`,
        `ua: ${snap.userAgent}`,
        `display-mode: ${modes.length ? modes.join(',') : 'none'} | navigator.standalone=${snap.navigatorStandalone ?? 'n/a'}`,
        `dpr=${px(snap.devicePixelRatio)} orientation=${snap.orientation ?? 'n/a'}`,
        `screen: ${px(snap.screen.width)}x${px(snap.screen.height)} availH=${px(snap.screen.availHeight)}`,
        `window: inner=${px(snap.window.innerWidth)}x${px(snap.window.innerHeight)} outerH=${px(snap.window.outerHeight)} scrollY=${px(snap.window.scrollY)}`,
        `docEl.clientHeight=${px(snap.clientHeight)}`,
        vv
            ? `visualViewport: ${px(vv.width)}x${px(vv.height)} offsetTop=${px(vv.offsetTop)} pageTop=${px(vv.pageTop)} scale=${px(vv.scale)}`
            : 'visualViewport: n/a',
        `units: ${units.join(' ')}`,
        `safe-area: top=${px(snap.safeArea.top)} right=${px(snap.safeArea.right)} bottom=${px(snap.safeArea.bottom)} left=${px(snap.safeArea.left)}`,
        `app-h vs screen: ${px(gapToScreenBottom(snap.screen.height, snap.units['--app-h'] ?? undefined))} short`,
        `meta viewport: ${snap.meta.viewport ?? 'n/a'}`,
        `meta status-bar-style: ${snap.meta.statusBarStyle ?? 'n/a'}`,
    ];
    if (elements.length) {
        lines.push('elements (px from top of layout viewport):');
        for (const el of elements) lines.push(`  ${formatElementLine(el, snap.screen.height)}`);
    }
    return lines.join('\n');
}

/** `?vhdiag=1` turns the in-app overlay on (persisted), `?vhdiag=0` off. */
export function parseVhDiagParam(search: string): boolean | null {
    const raw = new URLSearchParams(search).get('vhdiag');
    if (raw === null) return null;
    return raw === '1' || raw === 'true' || raw === 'on';
}

/** B-797: the live keyboard numbers (Viewport 诊断 → 键盘测试). */
export interface KeyboardSnapshot {
    vvHeight: number | null;
    vvOffsetTop: number | null;
    scrollY: number;
    innerHeight: number;
    /** what `var(--app-h)` resolves to, in px. */
    appH: number | null;
    /** the inline override viewportVars.ts wrote (empty = CSS value). */
    appHOverride: string;
    keyboardOpen: boolean;
    rootLock: boolean;
}

export function formatKeyboardLine(k: KeyboardSnapshot): string {
    return [
        `keyboard: vv.h=${px(k.vvHeight)} vv.top=${px(k.vvOffsetTop)} scrollY=${px(k.scrollY)} inner=${px(k.innerHeight)}`,
        `--app-h=${px(k.appH)} (${k.appHOverride ? `js ${k.appHOverride}` : 'css'}) open=${k.keyboardOpen ? 'yes' : 'no'} root-lock=${k.rootLock ? 'yes' : 'no'}`,
    ].join(' · ');
}
