/**
 * codeCollapse — pure collapse-threshold logic shared by CodeView (code
 * blocks, B-097) and the user bubble in MessageView (B-102).
 *
 * Line counts are the stable signal: pixel heights depend on fonts/zoom and
 * on when shiki finishes highlighting, newline counts don't. The visible-line
 * constants mirror the CSS caps (420px code clamp ≈ 23 lines at fs-12 × 1.5;
 * bubble clamp = 10 lines) — keep them in sync with code.css / message.css.
 */

/** Number of newline-separated lines; empty string counts as 0. */
export function countLines(text: string): number {
    if (!text) return 0;
    return text.split('\n').length;
}

/**
 * Estimated RENDERED lines for wrapped text (user bubbles are pre-wrap, so a
 * single 2000-char paragraph is many visual lines despite one '\n'-line).
 * Each source line contributes ceil(len / charsPerLine), minimum 1.
 */
export function estimateWrappedLines(text: string, charsPerLine = 80): number {
    if (!text) return 0;
    let total = 0;
    for (const line of text.split('\n')) {
        total += Math.max(1, Math.ceil(line.length / charsPerLine));
    }
    return total;
}

/**
 * Collapse only when clearly worth it: the content must exceed the visible
 * threshold by `slack` lines, so we never hide 1–2 lines behind an expand
 * button (strictly worse than just showing them).
 */
export function shouldCollapse(lineCount: number, threshold: number, slack = 4): boolean {
    return lineCount > threshold + slack;
}

/** Code block clamp: 420px ≈ 23 lines at fs-12 × 1.5 line-height. */
export const CODE_VISIBLE_LINES = 23;

export function shouldCollapseCode(lineCount: number): boolean {
    return shouldCollapse(lineCount, CODE_VISIBLE_LINES, 5);
}

/**
 * Table clamp (B-356). The gate is DATA ROWS; the visible height is CSS
 * (`min(60vh, 480px)`) so a phone and a desktop each get a sensible cap without
 * a second constant — same two-stage shape as code blocks (23-line gate, 420px cap).
 *
 * 12 + slack 4 means collapsing actually starts at **17 rows**. Measured over
 * 1,726 real tables in local transcripts: p50 4, p90 9, p95 11, p99 18, max 67
 * — so this leaves 98.7% of tables untouched and only folds the 22 tail cases.
 * A lower gate would fold tables people want to read whole.
 */
export const TABLE_VISIBLE_ROWS = 12;

export function shouldCollapseTable(rowCount: number): boolean {
    return shouldCollapse(rowCount, TABLE_VISIBLE_ROWS, 4);
}

/** User bubble clamp: ~10 visible lines (B-102). */
export const BUBBLE_VISIBLE_LINES = 10;

export function shouldCollapseBubble(estimatedLines: number): boolean {
    return shouldCollapse(estimatedLines, BUBBLE_VISIBLE_LINES, 4);
}
