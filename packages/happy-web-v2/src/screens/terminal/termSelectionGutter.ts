/**
 * Copy without the agent CLI's left gutter (B-574②).
 * Spec: specs/2026-10-terminal-paths-and-quick-open.md D1.
 *
 * Adapted from Orca `src/shared/terminal-selection-gutter.ts` (MIT).
 *
 * WHY: a terminal selection is a rectangle of cells, not logical text. Claude
 * Code / Codex paint their replies behind a fixed left gutter, so every copied
 * line carried that gutter and pasted text came out indented.
 *
 * Only the run of SPACES that every non-blank line shares is removed, so
 * relative indentation (nested bullets, fenced code, YAML) survives. A
 * selection that starts mid-line, or that covers any column-0 line, shares a
 * run of zero and comes back untouched. Tabs are not spaces: a tab-led line
 * has zero leading spaces, so it pins the gutter at 0 (nothing is stripped).
 *
 * The DOM renderer draws spaces as NBSP; a NATIVE (mobile long-press) copy of
 * `.xterm-rows` therefore yields NBSPs — `normalizeTerminalDomText` folds them
 * first. xterm's own `getSelection()` already does that fold.
 */

const LEADING_SPACES = /^ */;

interface SelectionLine { indent: number; text: string; terminator: string }

// xterm joins rows with CRLF on Windows; the CR travels with its line so a
// blank CRLF row still reads as blank (otherwise it would pin the gutter at 0).
function parseLine(raw: string): SelectionLine {
    const cr = raw.endsWith('\r');
    const text = cr ? raw.slice(0, -1) : raw;
    return { indent: LEADING_SPACES.exec(text)?.[0].length ?? 0, text, terminator: cr ? '\r' : '' };
}

/** Width of the space gutter shared by every non-blank line (0 = none). */
export function measureSelectionGutter(selection: string): number {
    let gutter = Number.POSITIVE_INFINITY;
    for (const { indent, text } of selection.split('\n').map(parseLine)) {
        if (text.trim().length === 0) continue; // blank / whitespace-only: no evidence
        gutter = Math.min(gutter, indent);
        if (gutter === 0) return 0;
    }
    return Number.isFinite(gutter) ? gutter : 0;
}

export function stripTerminalSelectionGutter(selection: string): string {
    const gutter = measureSelectionGutter(selection);
    if (gutter === 0) return selection;
    return selection
        .split('\n')
        .map(parseLine)
        .map(({ indent, text, terminator }) => text.slice(Math.min(indent, gutter)) + terminator)
        .join('\n');
}

/** NBSP → space (DOM renderer cells); everything else untouched. */
export function normalizeTerminalDomText(text: string): string {
    return text.replace(/ /g, ' ');
}

/**
 * What a `copy` event should put on the clipboard, or null = leave it alone.
 * Inputs are plain facts gathered by the hook (useTermPathLinks):
 *  - `foreignEditable`: the event target is an input/textarea other than
 *    xterm's own helper textarea (own-input overlay, search bar, composer);
 *    its own selection always wins and a leftover terminal selection must not
 *    replace it;
 *  - `targetInTerminal`: the target sits inside the xterm element;
 *  - `termSelection`: xterm's selection (null when none);
 *  - `domSelection`: a native selection fully inside this terminal's rows.
 */
export function terminalCopyDecision(f: {
    foreignEditable: boolean;
    targetInTerminal: boolean;
    termSelection: string | null;
    domSelection: string | null;
}): string | null {
    if (f.foreignEditable) return null;
    if (f.termSelection && f.targetInTerminal) {
        const stripped = stripTerminalSelectionGutter(f.termSelection);
        return stripped === f.termSelection ? null : stripped; // unchanged → xterm's own handler
    }
    if (f.domSelection) {
        const cleaned = stripTerminalSelectionGutter(normalizeTerminalDomText(f.domSelection));
        return cleaned === f.domSelection ? null : cleaned;
    }
    return null;
}
