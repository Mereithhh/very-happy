/**
 * Clickable file paths in the web terminal (B-574①) — the pure half.
 * Spec: specs/2026-10-terminal-paths-and-quick-open.md D2.
 * Approach borrowed from Orca `mobile/src/terminal/terminal-path-tap.ts` (MIT):
 * propose candidates generously, let the daemon's existence check reject
 * non-files. Rules here are our own and deliberately narrower (no spaced
 * paths, no drive letters).
 *
 * Everything takes plain strings or the duck-typed buffer from termSearch, so
 * it runs under node; `useTermPathLinks` is the only place touching xterm.
 */
import { buildCellMap, rowText, type RowText, type SearchBufferLike } from './termSearch';

export interface PathCandidate {
    /** [start, end) code-unit span inside the logical line text. */
    start: number;
    end: number;
    /** The path without its `:line:col` suffix. */
    pathText: string;
    line: number | null;
    col: number | null;
}

/** Any `scheme://…` run — those belong to WebLinksAddon (except file://). */
const URL_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>`()[\]{}]+/g;
const TOKEN_RE = /[\p{L}\p{N}_.~\-/+@%]+(?::\d+(?::\d+)?)?/gu;
const LINE_SUFFIX_RE = /:(\d+)(?::(\d+))?$/;
const BARE_FILE_RE = /^\.?[\p{L}\p{N}_\-+@][\p{L}\p{N}_.\-+@]*\.[A-Za-z][A-Za-z0-9]{0,9}$/u;
const DOT_FILE_RE = /^\.[A-Za-z][\w.-]*$/;
const HAS_LETTER_RE = /\p{L}/u;
/** Prose abbreviations that look like `name.ext`. */
const STOPWORDS = new Set(['e.g', 'i.e', 'a.m', 'p.m', 'etc', 'vs', 'no', 'cf', 'n.b']);

function splitLineSuffix(token: string): { pathText: string; line: number | null; col: number | null } {
    const m = LINE_SUFFIX_RE.exec(token);
    if (!m) return { pathText: token, line: null, col: null };
    const line = Number.parseInt(m[1], 10);
    const col = m[2] ? Number.parseInt(m[2], 10) : null;
    return {
        pathText: token.slice(0, m.index),
        line: line >= 1 ? line : null,
        col: col !== null && col >= 1 ? col : null,
    };
}

/** Is this (suffix-free) token plausibly a file path? */
export function isPathLike(p: string): boolean {
    if (!p || !HAS_LETTER_RE.test(p)) return false;
    if (p.includes('/')) {
        if (p.endsWith('/') || p.includes('//')) return false; // directory / URL-ish
        if (p === '~' || p === '.' || p === '..') return false;
        return true;
    }
    if (STOPWORDS.has(p.toLowerCase())) return false;
    if (p.includes('@') && /@[^@]+\.[A-Za-z]{2,}$/.test(p)) return false; // a@b.com
    return BARE_FILE_RE.test(p) || DOT_FILE_RE.test(p);
}

function fileUrlCandidate(url: string, start: number): PathCandidate | null {
    if (!/^file:\/\//i.test(url)) return null;
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.hostname && !['localhost', '127.0.0.1'].includes(parsed.hostname.toLowerCase())) return null;
    let path: string;
    try { path = decodeURIComponent(parsed.pathname); } catch { return null; }
    let line: number | null = null;
    let col: number | null = null;
    const hash = /^#L(\d+)(?:C(\d+))?$/i.exec(parsed.hash);
    if (hash) {
        line = Number.parseInt(hash[1], 10) || null;
        col = hash[2] ? Number.parseInt(hash[2], 10) || null : null;
    } else {
        const split = splitLineSuffix(path);
        if (split.line !== null) ({ pathText: path, line, col } = split);
    }
    if (!path.startsWith('/') || path.endsWith('/')) return null;
    return { start, end: start + url.length, pathText: path, line, col };
}

/** Every path candidate in one logical line, left to right, non-overlapping. */
export function findPathCandidates(text: string): PathCandidate[] {
    const out: PathCandidate[] = [];
    const urls: Array<[number, number]> = [];
    URL_RE.lastIndex = 0;
    for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
        const url = m[0].replace(/[.,;:!?]+$/, '');
        urls.push([m.index, m.index + url.length]);
        const file = fileUrlCandidate(url, m.index);
        if (file) out.push(file);
    }
    const insideUrl = (s: number, e: number) => urls.some(([us, ue]) => s < ue && e > us);
    TOKEN_RE.lastIndex = 0;
    for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
        let token = m[0];
        const start = m.index;
        // Sentence-final dot ("see src/a.ts.") is punctuation, not part of the path.
        if (!LINE_SUFFIX_RE.test(token)) token = token.replace(/\.+$/, '');
        if (!token) continue;
        const end = start + token.length;
        if (insideUrl(start, end)) continue;
        const { pathText, line, col } = splitLineSuffix(token);
        if (!isPathLike(pathText)) continue;
        out.push({ start, end, pathText, line, col });
    }
    return out.sort((a, b) => a.start - b.start);
}

/** The candidate covering string index `i`, if any. */
export function candidateAt(candidates: readonly PathCandidate[], i: number): PathCandidate | null {
    for (const c of candidates) if (i >= c.start && i < c.end) return c;
    return null;
}

function normalizeSegments(path: string): string {
    const abs = path.startsWith('/');
    const out: string[] = [];
    for (const seg of path.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') { if (out.length) out.pop(); continue; }
        out.push(seg);
    }
    return (abs ? '/' : '') + out.join('/');
}

/**
 * Absolute (or `~/`) path to hand the daemon. Relative paths are resolved
 * against the terminal's cwd HERE: the daemon resolves relative paths
 * against HOME, which would silently open the wrong file. No cwd → null.
 */
export function resolveTerminalPath(pathText: string, cwd: string | null | undefined): string | null {
    const p = pathText.trim();
    if (!p) return null;
    if (p.startsWith('/')) return normalizeSegments(p);
    if (p === '~' || p.startsWith('~/')) return `~/${normalizeSegments(p.slice(2)).replace(/^\//, '')}`;
    if (!cwd) return null;
    if (cwd === '~' || cwd.startsWith('~/')) {
        return `~/${normalizeSegments(`${cwd.slice(2)}/${p}`).replace(/^\//, '')}`;
    }
    if (!cwd.startsWith('/')) return null;
    return normalizeSegments(`${cwd}/${p}`);
}

// ── buffer side ──────────────────────────────────────────────────────────────

/** A wrapped logical line longer than this many rows is clipped around the row. */
const MAX_WRAP_ROWS = 24;

export interface LogicalLine {
    text: string;
    map: { row: number[]; col: number[]; end: number[] };
}

/** The soft-wrapped logical line containing absolute buffer row `row`. */
export function logicalLineAt(buffer: SearchBufferLike, row: number): LogicalLine | null {
    if (row < 0 || row >= buffer.length || !buffer.getLine(row)) return null;
    let start = row;
    while (start > 0 && row - start < MAX_WRAP_ROWS && buffer.getLine(start)?.isWrapped) start--;
    let end = row;
    while (end + 1 < buffer.length && end - row < MAX_WRAP_ROWS && buffer.getLine(end + 1)?.isWrapped) end++;
    const rows: RowText[] = [];
    for (let r = start; r <= end; r++) {
        const line = buffer.getLine(r);
        if (line) rows.push(rowText(line, r, r === end));
    }
    const text = rows.map((r) => r.text).join('');
    return { text, map: buildCellMap(buffer, rows) };
}

/** xterm IBufferRange (1-based, inclusive end) for a candidate's span. */
export function bufferRangeOf(map: LogicalLine['map'], c: PathCandidate): { start: { x: number; y: number }; end: { x: number; y: number } } | null {
    if (c.end <= c.start || c.end > map.row.length) return null;
    const last = c.end - 1;
    return {
        start: { x: map.col[c.start] + 1, y: map.row[c.start] + 1 },
        end: { x: map.end[last], y: map.row[last] + 1 },
    };
}

/** String index of the cell (row, col), or -1 (e.g. past the line's end). */
export function indexAtCell(map: LogicalLine['map'], row: number, col: number): number {
    for (let i = 0; i < map.row.length; i++) {
        if (map.row[i] === row && col >= map.col[i] && col < map.end[i]) return i;
    }
    return -1;
}

/** Path candidate under an absolute buffer cell — the touch-tap entry point. */
export function pathAtCell(buffer: SearchBufferLike, row: number, col: number): PathCandidate | null {
    const line = logicalLineAt(buffer, row);
    if (!line) return null;
    const i = indexAtCell(line.map, row, col);
    if (i < 0) return null;
    return candidateAt(findPathCandidates(line.text), i);
}

/** Candidates (with ranges) intersecting absolute row `row` — the link-provider entry point. */
export function pathLinksOnRow(buffer: SearchBufferLike, row: number): Array<{ candidate: PathCandidate; range: NonNullable<ReturnType<typeof bufferRangeOf>> }> {
    const line = logicalLineAt(buffer, row);
    if (!line) return [];
    const y = row + 1;
    const out: Array<{ candidate: PathCandidate; range: NonNullable<ReturnType<typeof bufferRangeOf>> }> = [];
    for (const candidate of findPathCandidates(line.text)) {
        const range = bufferRangeOf(line.map, candidate);
        if (range && range.start.y <= y && range.end.y >= y) out.push({ candidate, range });
    }
    return out;
}

/** Desktop open gesture: ⌘-click on macOS, Ctrl-click elsewhere. */
export function isPathOpenClick(e: { metaKey: boolean; ctrlKey: boolean }, isMac: boolean): boolean {
    return isMac ? e.metaKey : e.ctrlKey;
}

/**
 * Touch: is this touchend a plain tap that may open a path? Long presses
 * (native selection), drags, scrolls (incl. a tap that only stopped a fling),
 * multi-touch (pinch lift), select mode and live selections never are.
 */
export function isPathTapGesture(g: {
    selectMode: boolean;
    distanceSquared: number;
    durationMs: number;
    hasDomSelection: boolean;
    hasTermSelection: boolean;
    /** The gesture was classified as a scroll (screen's gestureScrolled). */
    scrolled: boolean;
    /** A momentum scroll was running when the finger went down (the tap stops it). */
    flingAtStart: boolean;
    /** More than one finger touched during the gesture. */
    multiTouch: boolean;
}): boolean {
    return !g.selectMode
        && !g.scrolled
        && !g.flingAtStart
        && !g.multiTouch
        && g.distanceSquared <= 12 * 12
        && g.durationMs >= 0 && g.durationMs < 500
        && !g.hasDomSelection
        && !g.hasTermSelection;
}

const EMAIL_RE = /^[^@\s/]+@[^@\s/]+\.[A-Za-z]{2,}$/;
const LAST_SEGMENT_EXT_RE = /\/[^/]*\.[A-Za-z][A-Za-z0-9]{0,9}$/;

/**
 * Touch only: is this candidate strong enough to take the tap away from
 * "tap = summon the keyboard"? A false positive there costs the keyboard, so
 * only unmistakable paths qualify:
 *  - explicit roots (`/`, `~/`, `./`, `../`), a `:line` suffix, or
 *  - a relative path whose LAST segment has an extension (`src/a.ts`, not `and/or`);
 *  - a bare name (`README.md`, `Node.js`, `www.example.com`) only when it is a
 *    known project file (`knownFile`, from the cached project list).
 * Desktop needs ⌘/Ctrl anyway and keeps the generous rules.
 */
export function isStrongTouchPath(c: PathCandidate, knownFile: (name: string) => boolean): boolean {
    const p = c.pathText;
    if (EMAIL_RE.test(p)) return false;
    if (c.line !== null) return true;
    if (p.startsWith('/') || p.startsWith('~/') || p.startsWith('./') || p.startsWith('../')) return true;
    if (p.includes('/')) return LAST_SEGMENT_EXT_RE.test(p);
    return knownFile(p);
}
