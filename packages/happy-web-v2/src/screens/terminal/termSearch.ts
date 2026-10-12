/**
 * Find-in-terminal (B-557) — the pure half. See specs/2026-10-terminal-search.md.
 *
 * WHY self-implemented: the repo does not lock `@xterm/addon-search`, and the
 * job is small enough on xterm's public buffer API that adding a dependency
 * (package.json + lockfile churn) isn't worth it. Everything here takes a
 * duck-typed buffer so it runs under node against fakes; the component
 * (TermSearchBar.tsx) is the only place that touches a live Terminal.
 *
 * Coordinates: `row` is an ABSOLUTE buffer line (0 = oldest scrollback line,
 * the same space as `buffer.active.getLine(y)` / `viewportY`), `col` is a cell
 * column. A hit that crosses a soft wrap is split into one segment per row,
 * which is what xterm decorations need (a decoration is one row tall).
 */

export interface SearchCellLike {
    getChars(): string;
    getWidth(): number;
}
export interface SearchLineLike {
    readonly isWrapped: boolean;
    readonly length: number;
    translateToString(trimRight?: boolean): string;
    getCell(x: number): SearchCellLike | undefined;
}
export interface SearchBufferLike {
    readonly length: number;
    getLine(y: number): SearchLineLike | undefined;
}

export interface TermMatchSegment {
    row: number;
    col: number;
    /** Width in CELLS (a CJK char is 2). */
    width: number;
}
export interface TermMatch {
    segments: TermMatchSegment[];
}
export interface TermSearchResult {
    matches: TermMatch[];
    /** More hits existed than `limit`; the count is shown as `N+`. */
    truncated: boolean;
}

/** Hard cap on counted matches — a 1-char query over 5000 wide rows would otherwise build ~1M objects. */
export const TERM_SEARCH_MATCH_LIMIT = 2000;
/** Max decorated (highlighted) matches; the rest are counted but not painted. */
export const TERM_SEARCH_DECORATION_LIMIT = 1000;

const SURROGATE_RE = /[\uD800-\uDFFF]/;

/**
 * Case folding that NEVER changes string length: `toLowerCase()` can (e.g.
 * 'İ' → 'i̇'), which would desynchronize string indices from the cell map.
 * Such characters are left as-is; everything else folds normally.
 */
export function foldCaseStable(s: string): string {
    const lower = s.toLowerCase();
    if (lower.length === s.length) return lower;
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const l = s[i].toLowerCase();
        out += l.length === 1 ? l : s[i];
    }
    return out;
}

interface RowText {
    row: number;
    text: string;
    /** text index i ↔ column i (no wide chars, no surrogate pairs). */
    identity: boolean;
}

function rowText(line: SearchLineLike, row: number, isLast: boolean): RowText {
    const full = line.translateToString(false);
    const identity = full.length === line.length && !SURROGATE_RE.test(full);
    // Only the LAST row of a logical line is right-trimmed: inner rows of a
    // soft-wrapped line are full by definition, and their trailing cells are
    // real content continuing on the next row.
    const text = isLast ? full.replace(/ +$/, '') : full;
    return { row, text, identity };
}

/** Per-code-unit cell map for one logical line (built only when it has a hit). */
function buildCellMap(buffer: SearchBufferLike, rows: RowText[]): { row: number[]; col: number[]; end: number[] } {
    const rowOf: number[] = [];
    const colOf: number[] = [];
    const endOf: number[] = [];
    for (const r of rows) {
        if (r.identity) {
            for (let i = 0; i < r.text.length; i++) { rowOf.push(r.row); colOf.push(i); endOf.push(i + 1); }
            continue;
        }
        const line = buffer.getLine(r.row);
        if (!line) continue;
        // Rebuild exactly the string translateToString produced: width-0 cells
        // (right half of a wide char) contribute nothing, empty cells a space.
        let produced = 0;
        for (let x = 0; x < line.length && produced < r.text.length; x++) {
            const cell = line.getCell(x);
            if (!cell) break;
            const w = cell.getWidth();
            if (w === 0) continue;
            const chars = cell.getChars() || ' ';
            for (let k = 0; k < chars.length && produced < r.text.length; k++) {
                rowOf.push(r.row); colOf.push(x); endOf.push(x + w);
                produced++;
            }
        }
        // Defensive: keep the map exactly as long as the text even if the line
        // changed under us (never index past the arrays).
        while (produced < r.text.length) {
            const last = colOf.length ? endOf[endOf.length - 1] : 0;
            rowOf.push(r.row); colOf.push(last); endOf.push(last + 1);
            produced++;
        }
    }
    return { row: rowOf, col: colOf, end: endOf };
}

function segmentsFor(map: { row: number[]; col: number[]; end: number[] }, start: number, len: number): TermMatchSegment[] {
    const segs: TermMatchSegment[] = [];
    for (let i = start; i < start + len; i++) {
        const row = map.row[i];
        const last = segs[segs.length - 1];
        if (last && last.row === row) {
            last.width = Math.max(last.width, map.end[i] - last.col);
        } else {
            segs.push({ row, col: map.col[i], width: map.end[i] - map.col[i] });
        }
    }
    return segs;
}

/**
 * Plain-substring search over the whole buffer, soft wraps joined (a URL that
 * wrapped across two rows is still found). Non-overlapping, top to bottom.
 */
export function findTermMatches(
    buffer: SearchBufferLike,
    query: string,
    opts: { caseSensitive: boolean; limit?: number },
): TermSearchResult {
    const limit = opts.limit ?? TERM_SEARCH_MATCH_LIMIT;
    const matches: TermMatch[] = [];
    if (!query) return { matches, truncated: false };
    const needle = opts.caseSensitive ? query : foldCaseStable(query);
    const total = buffer.length;
    let y = 0;
    while (y < total) {
        let end = y + 1;
        while (end < total && buffer.getLine(end)?.isWrapped) end++;
        const rows: RowText[] = [];
        for (let r = y; r < end; r++) {
            const line = buffer.getLine(r);
            if (line) rows.push(rowText(line, r, r === end - 1));
        }
        y = end;
        const joined = rows.map((r) => r.text).join('');
        if (joined.length < needle.length) continue;
        const hay = opts.caseSensitive ? joined : foldCaseStable(joined);
        let at = hay.indexOf(needle);
        if (at < 0) continue;
        const map = buildCellMap(buffer, rows);
        while (at >= 0) {
            if (matches.length >= limit) return { matches, truncated: true };
            matches.push({ segments: segmentsFor(map, at, needle.length) });
            at = hay.indexOf(needle, at + needle.length);
        }
    }
    return { matches, truncated: false };
}

/**
 * Which match to show first: the LAST one starting at or above the viewport's
 * bottom row — new output lands at the bottom, so "nearest above what I'm
 * looking at" is the most recent relevant hit. None above → the first match.
 */
export function pickInitialIndex(matches: TermMatch[], anchorRow: number): number {
    if (matches.length === 0) return -1;
    for (let i = matches.length - 1; i >= 0; i--) {
        if (matches[i].segments[0].row <= anchorRow) return i;
    }
    return 0;
}

/** Find a match by its first cell (used to keep the active hit across a re-search). */
export function indexOfMatchAt(matches: TermMatch[], row: number, col: number): number {
    for (let i = 0; i < matches.length; i++) {
        const s = matches[i].segments[0];
        if (s.row === row && s.col === col) return i;
        if (s.row > row) break;
    }
    return -1;
}

/** dir -1 = previous (up / older), +1 = next (down / newer); wraps around. */
export function stepIndex(index: number, total: number, dir: 1 | -1): number {
    if (total <= 0) return -1;
    if (index < 0) return dir > 0 ? 0 : total - 1;
    return (index + dir + total) % total;
}

/**
 * Viewport line to scroll to so `row` is visible, or null when it already is.
 * Lands the hit about a third down the viewport (context above, room below).
 */
export function scrollTargetFor(row: number, viewportY: number, rows: number): number | null {
    if (row >= viewportY && row < viewportY + rows) return null;
    return Math.max(0, row - Math.floor(rows / 3));
}

/** Indices of the (at most `limit`) matches to decorate: all, or the window nearest the active one. */
export function decorationWindow(total: number, active: number, limit = TERM_SEARCH_DECORATION_LIMIT): [number, number] {
    if (total <= limit) return [0, total];
    const center = active < 0 ? total - 1 : active;
    let start = Math.max(0, center - Math.floor(limit / 2));
    if (start + limit > total) start = total - limit;
    return [start, start + limit];
}

/** "3/17", "0/0", "3/2000+". */
export function formatMatchCount(active: number, total: number, truncated: boolean): string {
    const shown = active >= 0 && total > 0 ? active + 1 : 0;
    return `${shown}/${total}${truncated ? '+' : ''}`;
}

/**
 * Open-search chord. macOS: ⌘F only (meta chords are never forwarded to the
 * pty, so this steals nothing). Elsewhere: Ctrl+Shift+F — plain Ctrl+F is a
 * real terminal key (readline forward-char, vim/less page-down) and must keep
 * reaching the pty. `e.code`, not `e.key`: CJK/AZERTY layouts change `key`.
 */
export function matchTermSearchChord(
    e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string },
    isMac: boolean,
): boolean {
    if (e.code !== 'KeyF' || e.altKey) return false;
    if (isMac) return e.metaKey && !e.ctrlKey && !e.shiftKey;
    return e.ctrlKey && e.shiftKey && !e.metaKey;
}
