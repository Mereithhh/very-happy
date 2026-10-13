/**
 * ⌘P quick open (B-576) — fuzzy scoring, pure.
 * Spec: specs/2026-10-terminal-paths-and-quick-open.md D4.
 * Ranking shape (recent first, then fuzzy) borrowed from Orca
 * `quick-open-history-ranking.ts` (MIT); the scorer itself is ours.
 *
 * Rules:
 *  - every query char must appear in order (subsequence), case-insensitive;
 *  - a match inside the FILE NAME beats one that needs the directories;
 *  - consecutive chars, word starts (after / _ - . or a camelCase hump) and a
 *    name prefix earn bonuses; shallower / shorter paths win ties.
 *  - a query containing `/` is matched against the whole path.
 */

export interface QuickOpenMatch {
    path: string;
    score: number;
    /** Matched character indices into `path` (for highlighting). */
    positions: number[];
}

const NAME_BASE = 1000;
const CONSECUTIVE = 6;
const BOUNDARY = 8;
const NAME_PREFIX = 12;
const IN_NAME = 2;
/** History: rank 0 (most recent) gets the most, fading over HISTORY_LIMIT entries. */
const RECENCY_STEP = 3;
export const QUICK_OPEN_RESULT_LIMIT = 50;

function isBoundary(text: string, i: number): boolean {
    if (i === 0) return true;
    const prev = text[i - 1];
    if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') return true;
    const cur = text[i];
    return prev >= 'a' && prev <= 'z' && cur >= 'A' && cur <= 'Z';
}

/**
 * Tightest in-order match of `q` (lower-case) in `text` from `from`:
 * greedy forward to find the earliest end, then backward to pull the start
 * as late as possible — so "ab" in "a_xab" lands on the contiguous "ab".
 */
function subsequence(q: string, lower: string, from: number): number[] | null {
    let qi = 0;
    let end = -1;
    for (let i = from; i < lower.length && qi < q.length; i++) {
        if (lower[i] === q[qi]) { qi++; if (qi === q.length) end = i; }
    }
    if (end < 0) return null;
    const positions: number[] = new Array(q.length);
    qi = q.length - 1;
    for (let i = end; i >= from && qi >= 0; i--) {
        if (lower[i] === q[qi]) { positions[qi] = i; qi--; }
    }
    return positions;
}

function scorePositions(text: string, positions: number[], nameStart: number): number {
    let score = 0;
    for (let k = 0; k < positions.length; k++) {
        const i = positions[k];
        score += 1;
        if (k > 0 && positions[k - 1] === i - 1) score += CONSECUTIVE;
        if (isBoundary(text, i)) score += BOUNDARY;
        if (i >= nameStart) score += IN_NAME;
    }
    if (positions[0] === nameStart) score += NAME_PREFIX;
    return score;
}

/** Score one path, or null when the query is not a subsequence of it. */
export function scoreQuickOpen(query: string, path: string): QuickOpenMatch | null {
    const q = query.replace(/\s+/g, '').toLowerCase();
    if (!q) return { path, score: 0, positions: [] };
    const lower = path.toLowerCase();
    const nameStart = path.lastIndexOf('/') + 1;
    const depth = path.split('/').length - 1;
    const tie = -depth * 0.5 - path.length * 0.01;
    if (!q.includes('/')) {
        const inName = subsequence(q, lower, nameStart);
        if (inName) return { path, score: NAME_BASE + scorePositions(path, inName, nameStart) + tie, positions: inName };
    }
    const anywhere = subsequence(q, lower, 0);
    if (!anywhere) return null;
    return { path, score: scorePositions(path, anywhere, nameStart) + tie, positions: anywhere };
}

/**
 * Rank `files` for `query`. Empty query: recent files (still in the list)
 * first, most recent first, then the list order. Otherwise fuzzy score plus
 * a recency bonus for files opened before.
 */
export function rankQuickOpen(
    query: string,
    files: readonly string[],
    history: readonly string[],
    limit = QUICK_OPEN_RESULT_LIMIT,
): QuickOpenMatch[] {
    const recency = new Map<string, number>();
    history.forEach((p, i) => { if (!recency.has(p)) recency.set(p, i); });
    if (!query.trim()) {
        const available = new Set(files);
        const recent = history.filter((p, i) => available.has(p) && recency.get(p) === i);
        const recentSet = new Set(recent);
        const out: QuickOpenMatch[] = recent.map((path) => ({ path, score: 0, positions: [] }));
        for (const path of files) {
            if (out.length >= limit) break;
            if (!recentSet.has(path)) out.push({ path, score: 0, positions: [] });
        }
        return out.slice(0, limit);
    }
    const scored: QuickOpenMatch[] = [];
    for (const path of files) {
        const m = scoreQuickOpen(query, path);
        if (!m) continue;
        const r = recency.get(path);
        if (r !== undefined) m.score += Math.max(1, history.length - r) * RECENCY_STEP;
        scored.push(m);
    }
    scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return scored.slice(0, limit);
}

/** Split `text` into [plain, matched] runs for rendering highlights. */
export function highlightRuns(text: string, positions: readonly number[], offset = 0): Array<{ text: string; hit: boolean }> {
    const hits = new Set(positions.map((p) => p - offset));
    const runs: Array<{ text: string; hit: boolean }> = [];
    for (let i = 0; i < text.length; i++) {
        const hit = hits.has(i);
        const last = runs[runs.length - 1];
        if (last && last.hit === hit) last.text += text[i];
        else runs.push({ text: text[i], hit });
    }
    return runs;
}
