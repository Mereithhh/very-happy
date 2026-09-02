// Multi-device width re-assertion (P1, 2026-09).
//
// The bug: two devices (phone + desktop) view the SAME tmux pane. tmux has one
// window size (`window-size latest`), so whoever resized LAST owns the width.
// When the user opens on a phone (~45 cols) and then looks back at the desktop,
// the desktop's browser tab never fired a visibility/resize/resume edge (its tab
// was "visible" the whole time — the user was just looking at another physical
// device), so nothing re-proposed the desktop width. The pane stays narrow until
// an unrelated event (a conversation switch that remounts + reopens) re-captures.
//
// The fix is not to reflow history (impossible — the app hard-wrapped it; see
// specs/2026-09-terminal-render-integrity.md and ink#883) but to RE-ASSERT this
// viewport's width the moment the user is demonstrably active on this device
// (pointerdown / keypress / window focus), plus an explicit "refit width" button.
// This function is the pure decision: given the viewport's proposed size and the
// pane's current size, should we send a resize?
//
// Kept as a pure module so the decision is unit-testable in isolation (the repo
// prefers pure fns for AI-parallel test stability — termWriteHold / boardTaskOps
// precedent).

export interface TermDims {
    cols: number;
    rows: number;
}

export interface ReassertInput {
    /** document.hidden — a hidden tab must never drive the shared width (else a
     *  backgrounded phone re-narrows the desktop the user is now looking at). */
    hidden: boolean;
    /** renderer.proposeFit() — what THIS viewport wants. null/too-small ⇒ skip. */
    want: TermDims | null | undefined;
    /** The pane's current geometry as this client last adopted it (term.cols/rows). */
    current: TermDims;
    /** Explicit user action (the header button): re-send even if already matching,
     *  so the user gets a definite effect and a wedged pane still heals. */
    force?: boolean;
}

/** True ⇒ send a terminal-resize with `want`. */
export function shouldReassertGeometry(input: ReassertInput): boolean {
    const { hidden, want, current, force } = input;
    if (hidden) return false;
    if (!want || want.cols < 2 || want.rows < 2) return false;
    if (force) return true;
    return want.cols !== current.cols || want.rows !== current.rows;
}
