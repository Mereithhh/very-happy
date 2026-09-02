/**
 * B-289: the terminal's monospace face (`IBM Plex Mono`, @fontsource, weight
 * 400) is an async web font. xterm measures its cell advance from whatever font
 * is resolved when it first paints; if the real face has not loaded, it measures
 * a FALLBACK (system mono) whose advance differs, computes the wrong column
 * count, and the first size we send the daemon is wrong. On a fresh create the
 * daemon boots the tmux session and Claude prints its banner/tables at that
 * wrong width, which then freezes into scrollback (terminal rows are hard lines;
 * xterm never re-wraps them) — the "first render is narrow, later output is
 * wide, refresh doesn't help" report. So the FIRST size must be measured with
 * the real face.
 *
 * This module is the single place that waits for that face. Pure enough to unit
 * test: it only touches `document.fonts`, guards every branch, and never throws.
 */

/** The terminal's monospace family primary name (must match TERM_FONT's first
 *  entry and the @fontsource face actually loaded). */
export const TERMINAL_FONT_FAMILY = 'IBM Plex Mono';

/**
 * Resolve once the terminal's monospace face is loaded, or after `timeoutMs`,
 * whichever comes first. Never rejects: an unsupported `document.fonts`, a
 * blocked/offline font, or a browser that resolves late all fall through to the
 * timeout so the open is never blocked indefinitely. `weight 400` is queried
 * because xterm's cell advance is measured from the normal face.
 */
export function awaitTerminalFont(fontSizePx: number, timeoutMs: number): Promise<void> {
    const fonts = typeof document !== 'undefined' ? (document as unknown as { fonts?: FontFaceSet }).fonts : undefined;
    if (!fonts || typeof fonts.load !== 'function') return Promise.resolve();
    const query = `${Math.max(1, Math.floor(fontSizePx))}px '${TERMINAL_FONT_FAMILY}'`;
    let load: Promise<unknown>;
    try {
        load = Promise.resolve(fonts.load(query)).catch(() => undefined);
    } catch {
        return Promise.resolve();
    }
    const timeout = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(0, timeoutMs));
        // Node/jsdom timers may lack unref; guard it.
        (t as unknown as { unref?: () => void }).unref?.();
    });
    return Promise.race([load.then(() => undefined), timeout]);
}

/** Wait budgets (ms). A fresh create's wrong width is PERMANENT (frozen into
 *  scrollback), so it waits generously — a once-in-a-session cost. A
 *  reattach/resub adopts the daemon's authoritative width anyway, so it barely
 *  matters; keep it short. */
export const FONT_WAIT_FRESH_MS = 3000;
export const FONT_WAIT_ATTACH_MS = 300;
