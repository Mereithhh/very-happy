/**
 * termKbViewport — pure logic for the mobile soft-keyboard viewport dance.
 *
 * The "first keyboard open judders" bug (2026-08-13): an iOS keyboard open is
 * an ANIMATION, and visualViewport fires `resize` on many frames of it. Each
 * frame used to run the FULL resize chain — cap .term-host maxHeight → the
 * ResizeObserver sees the host shrink → FitAddon refit → rows change →
 * `terminal-resize` RPC → tmux reflows and repaints — so one keyboard
 * animation stacked 5-8 complete terminal reflows on top of each other, each
 * repainting mid-animation. The fix: during the animation only the CHEAP part
 * runs per frame (the CSS maxHeight follows the keyboard so the key bar stays
 * visible above it), and the expensive part (fit + RPC) runs ONCE, when the
 * viewport height has been quiet for `quietMs`.
 *
 * This module owns the decisions; WebTerminalScreen wires them to the DOM:
 *  - createViewportStabilizer: change-triggered quiet-period detector with a
 *    hard `maxWaitMs` cap (a pathological event stream must not defer the fit
 *    forever). Timer functions are injectable for tests.
 *  - computeKbAvail: the maxHeight arithmetic (visible viewport minus header
 *    offset minus the bottom bars).
 *  - pickTermTypography: small-height adaptive type — when the keyboard
 *    leaves very little room, drop 12px/1.3 → 11px/1.25 to buy 2-3 rows.
 */

export interface TermTypography {
    fontSize: number;
    lineHeight: number;
}

/** Mobile terminal type at full height (matches the renderer's coarse default). */
export const MOBILE_TYPO_BASE: TermTypography = Object.freeze({ fontSize: 12, lineHeight: 1.3 });
/** Compact type for keyboard-open small viewports (~14px cells vs ~16px). */
export const MOBILE_TYPO_COMPACT: TermTypography = Object.freeze({ fontSize: 11, lineHeight: 1.25 });
/** Keyboard-open visual viewport height below which compact type kicks in. */
export const COMPACT_VV_HEIGHT_PX = 420;

/**
 * Type choice for the KEYBOARD-OPEN state (the restore path unconditionally
 * returns to MOBILE_TYPO_BASE — this is never consulted with the keyboard
 * closed, so a short landscape viewport without a keyboard keeps base type).
 */
export function pickTermTypography(vvHeight: number): TermTypography {
    return vvHeight < COMPACT_VV_HEIGHT_PX ? MOBILE_TYPO_COMPACT : MOBILE_TYPO_BASE;
}

/**
 * Pixels of .term-host height that keep the host + bottom bars above the
 * keyboard: visible viewport bottom (offsetTop + height — iOS pans the layout
 * viewport, so offsetTop matters) minus the host's top edge, minus the bars,
 * minus a small breathing margin.
 */
export function computeKbAvail(i: {
    vvHeight: number;
    vvOffsetTop: number;
    hostTop: number;
    barsHeight: number;
    marginPx?: number;
}): number {
    return Math.round(i.vvOffsetTop + i.vvHeight - i.hostTop - i.barsHeight - (i.marginPx ?? 8));
}

export interface ViewportStabilizer {
    /** Feed one viewport height sample (every vv resize/scroll event). */
    sample(height: number): void;
    /** A burst is in flight — expensive refits should wait for onStable. */
    pending(): boolean;
    /** Drop the burst without firing (restore path owns the layout now). */
    cancel(): void;
}

export function createViewportStabilizer(opts: {
    /** Fired once per burst, with the last sampled height. */
    onStable: (height: number) => void;
    /** Quiet period: no height CHANGE for this long → stable. */
    quietMs?: number;
    /** Hard cap from burst start — fire even if the height never goes quiet. */
    maxWaitMs?: number;
    setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeoutFn?: (t: ReturnType<typeof setTimeout>) => void;
    nowFn?: () => number;
}): ViewportStabilizer {
    const quietMs = opts.quietMs ?? 120;
    const maxWaitMs = opts.maxWaitMs ?? 600;
    const setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    const clearT = opts.clearTimeoutFn ?? ((t) => clearTimeout(t));
    const now = opts.nowFn ?? (() => Date.now());

    let timer: ReturnType<typeof setTimeout> | null = null;
    let inBurst = false;
    let burstStart = 0;
    let lastHeight = Number.NaN;

    const fire = () => {
        timer = null;
        inBurst = false;
        opts.onStable(lastHeight);
    };

    return {
        sample(height: number) {
            // Unchanged height mid-burst: the quiet timer keeps running — only
            // a CHANGE restarts it (vv `scroll` events commonly repeat the
            // same height and must not defer the fit).
            if (inBurst && height === lastHeight) return;
            lastHeight = height;
            const t = now();
            if (!inBurst) {
                inBurst = true;
                burstStart = t;
            }
            if (timer != null) clearT(timer);
            // Next deadline: quiet period, clamped so the burst never outlives
            // the hard cap.
            const capIn = burstStart + maxWaitMs - t;
            timer = setT(fire, Math.max(0, Math.min(quietMs, capIn)));
        },
        pending: () => inBurst,
        cancel() {
            if (timer != null) clearT(timer);
            timer = null;
            inBurst = false;
        },
    };
}
