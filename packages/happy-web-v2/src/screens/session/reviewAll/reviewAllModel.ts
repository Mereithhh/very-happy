/**
 * B-572: the workspace "review all changes" tab — pure parts (file list,
 * viewed-state validity, layout estimates). Spec:
 * specs/2026-10-change-review-surfaces.md
 */
import type { GitFileStatus, GitStatusFiles } from '@/sync/gitStatusFiles';
import type { ReviewRow } from '../diffComments/gitDiff';
import { hashLines } from '../diffComments/diffComments';

/** URL flag (`?panel=changes&review=1`) that asks FilesPanel to open the tab; consumed and removed. */
export const REVIEW_ALL_PARAM = 'review';
/** One fixed tab id → `openWorkspaceTab` re-activates instead of duplicating. */
export const REVIEW_TAB_ID = 'review:all';

export type ReviewFile = {
    path: string;
    status: GitFileStatus['status'];
    /** numstat summed over staged + unstaged (the diff shown is against HEAD = both). */
    added: number;
    removed: number;
    /** Cheap "did it change" signature available WITHOUT loading the diff. */
    sig: string;
};

/** Same order and de-duplication as the Changes list (unstaged first). */
export function reviewFileList(status: GitStatusFiles | null | undefined): ReviewFile[] {
    if (!status) return [];
    const byPath = new Map<string, ReviewFile>();
    for (const f of [...status.unstagedFiles, ...status.stagedFiles]) {
        const prev = byPath.get(f.fullPath);
        if (prev) {
            prev.added += f.linesAdded;
            prev.removed += f.linesRemoved;
        } else {
            byPath.set(f.fullPath, { path: f.fullPath, status: f.status, added: f.linesAdded, removed: f.linesRemoved, sig: '' });
        }
    }
    const files = [...byPath.values()];
    for (const f of files) f.sig = `${f.status}:${f.added}:${f.removed}`;
    return files;
}

/** Content hash of a loaded diff (row kinds + text): any edit to the change flips it. */
export function diffRowsHash(rows: readonly ReviewRow[]): string {
    return hashLines(rows.map((r) => `${r.type[0]}${r.text}`));
}

export type ViewedEntry = { sig: string; hash: string | null; at: number };
export type ViewedMap = Record<string, ViewedEntry>;
export const REVIEW_VIEWED_MAX_PER_SESSION = 500;

/**
 * A "viewed" mark holds while the change is the one that was viewed:
 * status/numstat signature equal, and — once the diff is loaded — the
 * content hash equal too. A collapsed viewed file is not fetched just to
 * re-verify; its signature is the check until it is opened.
 */
export function isViewedCurrent(entry: ViewedEntry | undefined, sig: string, loadedHash: string | null): boolean {
    if (!entry || entry.sig !== sig) return false;
    if (loadedHash !== null && entry.hash !== null && entry.hash !== loadedHash) return false;
    return true;
}

function isEntry(v: unknown): v is ViewedEntry {
    if (!v || typeof v !== 'object') return false;
    const e = v as Record<string, unknown>;
    return typeof e.sig === 'string' && (e.hash === null || typeof e.hash === 'string') && typeof e.at === 'number' && Number.isFinite(e.at);
}

/** Parse a stored map, dropping malformed entries and keeping the newest N. */
export function parseViewedMap(raw: string | null | undefined): ViewedMap {
    if (!raw) return {};
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return {}; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>)
        .filter((kv): kv is [string, ViewedEntry] => kv[0].length > 0 && isEntry(kv[1]))
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, REVIEW_VIEWED_MAX_PER_SESSION);
    return Object.fromEntries(entries);
}

/** Drop marks for files no longer changed (keeps the stored map bounded to the live list). */
export function pruneViewed(map: ViewedMap, files: readonly ReviewFile[]): ViewedMap {
    const live = new Set(files.map((f) => f.path));
    const out: ViewedMap = {};
    for (const [path, entry] of Object.entries(map)) if (live.has(path)) out[path] = entry;
    return out;
}

/** Placeholder height of a not-yet-mounted section body, so the scrollbar does not jump. */
export const REVIEW_ROW_PX = 20;
export function estimateSectionBodyPx(file: Pick<ReviewFile, 'added' | 'removed'>): number {
    // context lines roughly double a short change; cap so a huge file does not reserve a mile
    const rows = Math.max(4, Math.min(file.added + file.removed + 8, 30));
    return rows * REVIEW_ROW_PX;
}
