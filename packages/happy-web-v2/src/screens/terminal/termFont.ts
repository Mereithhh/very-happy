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

/**
 * B-316: the families xterm can measure its cell from, in stack order — and the
 * single source of the terminal's `fontFamily`, so the wait and the render can
 * no longer disagree.
 *
 * They did disagree: this module waited for `IBM Plex Mono` while the terminal
 * had moved to `'Maple Mono CN', 'IBM Plex Mono', …`. Plex is bundled via
 * @fontsource and warmed at boot, so the wait resolved almost immediately while
 * Maple — the family actually first in the stack, fetched lazily from a CDN and
 * sliced by unicode-range — was still in flight. xterm then measured the cell
 * from Plex, Maple arrived with a different advance, and the grid was wrong.
 * On a fresh create that wrong width is permanent: it is baked into the tmux
 * session and Claude's first paint, and terminal rows never re-wrap.
 *
 * The old comment here said the constant "must match TERM_FONT's first entry".
 * Nothing checked, so the Maple switch silently broke it. Deriving both from one
 * constant is what makes that class of drift impossible rather than merely
 * discouraged.
 */
export const TERM_FONT_STACK = [
    'Maple Mono CN',
    'IBM Plex Mono',
    'SF Mono',
    'JetBrains Mono',
    'ui-monospace',
    'Menlo',
    'Consolas',
    'monospace',
] as const;

/** The CSS value handed to xterm. Generic families must stay unquoted. */
export const TERM_FONT = TERM_FONT_STACK
    .map((family) => (family === 'ui-monospace' || family === 'monospace' ? family : `'${family}'`))
    .join(', ');

/**
 * Terminal cell typography — ONE source for every place that sets or restores
 * the renderer's `fontSize` / `lineHeight` (renderer open, keyboard-state
 * typography, font re-measure). T-006 (2026-09): these numbers used to live in
 * three files and drifted twice:
 *
 *  - `lineHeight`: the renderer opened at 1.0 (#161 — the only value at which
 *    the Claude logo's block glyphs tile seamlessly, spec
 *    2026-09-terminal-font-and-seamless-rendering.md L1) while the mobile
 *    keyboard restore path wrote 1.3/1.25 back into `term.options`. The first
 *    keyboard cycle on a phone silently reopened the seam #161 had closed.
 *  - `fontSize`: the keyboard-open path dropped 12px → 11px to buy 2-3 rows.
 *    That also changes the CELL WIDTH (Maple Mono CN advance = 0.6em: 7.2px →
 *    6.6px), i.e. the COLUMN COUNT (57 → 62 on a 430px iPhone). Columns are
 *    part of the CONTENT on the classic-renderer track the daemon runs claude
 *    on (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`): every column change makes
 * claude reprint its header AND makes tmux hard-wrap every history line
 * that no longer fits — the startup logo row "Opus 5 (1M context) with high
 *    effort" breaks onto a second line and the logo shows up twice. Verified
 *    with real claude 2.1.263 in an isolated tmux socket: 62x37 → 57x42
 *  reproduces it; 62x37 → 62x42 (rows only) does not.
 *
 * Rule: the soft keyboard may only ever change ROWS. Cell width (fontSize) is
 * fixed per pointer class for the life of the mount; lineHeight is fixed at
 * the seamless value everywhere.
 */
export const TERM_FONT_SIZE_FINE = 13;
export const TERM_FONT_SIZE_COARSE = 12;
/** Seamless block/box tiling in the DOM renderer requires exactly 1.0 (#161). */
export const TERM_LINE_HEIGHT = 1.0;

/** The families that are real web fonts, i.e. the ones a measurement can wait
 *  for. The rest of the stack is system-resident and always ready. */
export const TERMINAL_WEB_FONT_FAMILIES = ['Maple Mono CN', 'IBM Plex Mono'] as const;

/** @deprecated kept for callers that only need the bundled Latin face name. */
export const TERMINAL_FONT_FAMILY = 'IBM Plex Mono';

/**
 * Resolve once the terminal's monospace face is loaded, or after `timeoutMs`,
 * whichever comes first. Never rejects: an unsupported `document.fonts`, a
 * blocked/offline font, or a browser that resolves late all fall through to the
 * timeout so the open is never blocked indefinitely. `weight 400` is queried
 * because xterm's cell advance is measured from the normal face.
 */
export function awaitTerminalFont(
    fontSizePx: number,
    timeoutMs: number,
    families: readonly string[] = TERMINAL_WEB_FONT_FAMILIES,
): Promise<void> {
    const fonts = typeof document !== 'undefined' ? (document as unknown as { fonts?: FontFaceSet }).fonts : undefined;
    if (!fonts || typeof fonts.load !== 'function') return Promise.resolve();
    const size = Math.max(1, Math.floor(fontSizePx));
    let load: Promise<unknown>;
    try {
        // Every web font in the stack, not just the bundled one: whichever
        // resolves first is what xterm measures, so the measurement is only
        // stable once they have all settled (or the budget runs out).
        load = Promise.all(families.map((family) =>
            Promise.resolve(fonts.load(`${size}px '${family}'`)).catch(() => undefined),
        ));
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
