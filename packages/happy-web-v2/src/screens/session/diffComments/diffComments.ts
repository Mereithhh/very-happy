/**
 * B-554: line comments on a git diff — anchor model, re-anchoring after the
 * diff changes, record validation and the agent message. Pure (no I/O); the
 * persistence lives in diffCommentsStore.ts. Spec: specs/2026-10-diff-line-comments.md
 *
 * Anchor = the commented lines' own text (hashed) plus the line right above
 * and below on the same side. Line numbers are only a hint: when the diff is
 * refreshed the text is searched again, neighbours break ties between
 * duplicates, distance to the old position breaks the rest. Not found ⇒
 * `stale`, kept at its last position and still sendable.
 */
import type { ReviewRow } from './gitDiff';

export type CommentSide = 'new' | 'old';

export interface DiffComment {
    id: string;
    /** as `git status` reports it: relative to the session cwd */
    filePath: string;
    side: CommentSide;
    startLine: number;
    endLine: number;
    lines: string[];
    before: string | null;
    after: string | null;
    hash: string;
    body: string;
    stale: boolean;
    createdAt: number;
    updatedAt: number;
}

export const DIFF_COMMENTS_MAX_PER_SESSION = 200;
export const DIFF_COMMENT_BODY_MAX = 4000;
export const DIFF_COMMENT_MAX_LINES = 40;
export const DIFF_COMMENT_LINE_MAX = 400;

/** FNV-1a 32-bit over the joined lines — stable, tiny, good enough for equality. */
export function hashLines(lines: readonly string[]): string {
    let h = 0x811c9dc5;
    const s = lines.join('\n');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

type SideLine = { no: number; text: string; row: number };

/** The numbered lines of one side, in diff order (hunk gaps included). */
export function sideLines(rows: readonly ReviewRow[], side: CommentSide): SideLine[] {
    const out: SideLine[] = [];
    rows.forEach((r, row) => {
        const no = side === 'new' ? r.newNo : r.oldNo;
        if (no != null) out.push({ no, text: r.text, row });
    });
    return out;
}

/** Which side a row is commented on: deletions only exist on the old side. */
export function sideOfRow(row: ReviewRow): CommentSide | null {
    if (row.type === 'hunk') return null;
    return row.type === 'del' ? 'old' : 'new';
}

function clipLine(text: string): string {
    return text.length > DIFF_COMMENT_LINE_MAX ? `${text.slice(0, DIFF_COMMENT_LINE_MAX)}…` : text;
}

/** Index in `seq` of a contiguous run startLine..endLine, or -1. */
function runIndex(seq: readonly SideLine[], startLine: number, endLine: number): number {
    const i = seq.findIndex((l) => l.no === startLine);
    if (i < 0) return -1;
    const j = i + (endLine - startLine);
    if (j >= seq.length || seq[j].no !== endLine) return -1;
    return i;
}

function neighbours(seq: readonly SideLine[], i: number, n: number): { before: string | null; after: string | null } {
    const prev = seq[i - 1];
    const next = seq[i + n];
    return {
        before: prev && prev.no === seq[i].no - 1 ? clipLine(prev.text) : null,
        after: next && next.no === seq[i + n - 1].no + 1 ? clipLine(next.text) : null,
    };
}

export type AnchorTarget = Pick<DiffComment, 'side' | 'startLine' | 'endLine' | 'lines' | 'before' | 'after' | 'hash'>;

/**
 * Anchor for lines startLine..endLine of `side`. Null when the range is not a
 * contiguous run on that side (spans a hunk gap / wrong side) or too long.
 */
export function buildAnchor(rows: readonly ReviewRow[], side: CommentSide, a: number, b: number): AnchorTarget | null {
    const startLine = Math.min(a, b);
    const endLine = Math.max(a, b);
    const n = endLine - startLine + 1;
    if (n > DIFF_COMMENT_MAX_LINES) return null;
    const seq = sideLines(rows, side);
    const i = runIndex(seq, startLine, endLine);
    if (i < 0) return null;
    const lines = seq.slice(i, i + n).map((l) => clipLine(l.text));
    return { side, startLine, endLine, lines, hash: hashLines(lines), ...neighbours(seq, i, n) };
}

export type Reanchored = Pick<DiffComment, 'startLine' | 'endLine' | 'before' | 'after' | 'stale'>;

export function reanchorComment(comment: DiffComment, rows: readonly ReviewRow[]): Reanchored {
    const seq = sideLines(rows, comment.side);
    const n = comment.endLine - comment.startLine + 1;
    const windowHash = (i: number): string | null => {
        if (i + n > seq.length) return null;
        if (seq[i + n - 1].no - seq[i].no !== n - 1) return null; // crosses a hunk gap
        return hashLines(seq.slice(i, i + n).map((l) => clipLine(l.text)));
    };
    const at = (i: number): Reanchored => ({
        startLine: seq[i].no,
        endLine: seq[i + n - 1].no,
        ...neighbours(seq, i, n),
        stale: false,
    });

    const original = runIndex(seq, comment.startLine, comment.endLine);
    if (original >= 0 && windowHash(original) === comment.hash) return at(original);

    let best = -1;
    let bestScore = -1;
    let bestDistance = Infinity;
    for (let i = 0; i + n <= seq.length; i++) {
        if (windowHash(i) !== comment.hash) continue;
        const near = neighbours(seq, i, n);
        const score = (comment.before !== null && near.before === comment.before ? 1 : 0)
            + (comment.after !== null && near.after === comment.after ? 1 : 0);
        const distance = Math.abs(seq[i].no - comment.startLine);
        if (score > bestScore || (score === bestScore && distance < bestDistance)) {
            best = i;
            bestScore = score;
            bestDistance = distance;
        }
    }
    if (best >= 0) return at(best);
    return { startLine: comment.startLine, endLine: comment.endLine, before: comment.before, after: comment.after, stale: true };
}

/** Re-anchor every comment of `filePath`; returns only the ones that changed. */
export function reanchorFile(comments: readonly DiffComment[], filePath: string, rows: readonly ReviewRow[]): DiffComment[] {
    const changed: DiffComment[] = [];
    for (const c of comments) {
        if (c.filePath !== filePath) continue;
        const r = reanchorComment(c, rows);
        if (r.startLine !== c.startLine || r.endLine !== c.endLine || r.stale !== c.stale || r.before !== c.before || r.after !== c.after) {
            changed.push({ ...c, ...r });
        }
    }
    return changed;
}

/** Row index a comment card is rendered under (its last line), or null when absent. */
export function commentRowIndex(comment: Pick<DiffComment, 'side' | 'endLine'>, rows: readonly ReviewRow[]): number | null {
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const no = comment.side === 'new' ? r.newNo : r.oldNo;
        if (no === comment.endLine) return i;
    }
    return null;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNullableStr = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isLine = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** Validate one persisted record; anything malformed is dropped by the caller. */
export function isDiffComment(v: unknown): v is DiffComment {
    if (!v || typeof v !== 'object') return false;
    const c = v as Record<string, unknown>;
    return isStr(c.id) && isStr(c.filePath) && (c.side === 'new' || c.side === 'old')
        && isLine(c.startLine) && isLine(c.endLine) && (c.endLine as number) >= (c.startLine as number)
        && Array.isArray(c.lines) && c.lines.every(isStr)
        && isNullableStr(c.before) && isNullableStr(c.after) && isStr(c.hash) && isStr(c.body)
        && typeof c.stale === 'boolean' && typeof c.createdAt === 'number' && typeof c.updatedAt === 'number';
}

export function parseDiffComments(raw: string | undefined | null): DiffComment[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(isDiffComment).slice(0, DIFF_COMMENTS_MAX_PER_SESSION) : [];
    } catch {
        return [];
    }
}

export function clampBody(body: string): string {
    return body.length > DIFF_COMMENT_BODY_MAX ? body.slice(0, DIFF_COMMENT_BODY_MAX) : body;
}

export function formatLineRange(c: Pick<DiffComment, 'startLine' | 'endLine'>): string {
    return c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}-${c.endLine}`;
}

function fenceFor(lines: readonly string[]): string {
    let longest = 0;
    for (const line of lines) {
        for (const m of line.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
    }
    return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The single message sent to the agent: grouped by file (path order), each
 * comment with its location, the code it is anchored to and the note.
 */
export function composeDiffCommentsMessage(comments: readonly DiffComment[], lang: 'zh' | 'en'): string {
    const zh = lang === 'zh';
    const byFile = new Map<string, DiffComment[]>();
    for (const c of comments) {
        if (!c.body.trim()) continue;
        const list = byFile.get(c.filePath) ?? [];
        list.push(c);
        byFile.set(c.filePath, list);
    }
    const files = [...byFile.keys()].sort((a, b) => a.localeCompare(b));
    const total = files.reduce((n, f) => n + byFile.get(f)!.length, 0);
    if (total === 0) return '';
    const out: string[] = [
        zh
            ? `请根据下面的代码审阅批注修改（共 ${total} 条，涉及 ${files.length} 个文件；行号按当前工作区 diff）：`
            : `Please address these review comments on the current diff (${total} comment${total === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}):`,
    ];
    for (const file of files) {
        out.push('', `## ${file}`);
        const list = byFile.get(file)!.slice().sort((a, b) =>
            a.side === b.side ? a.startLine - b.startLine : a.side === 'new' ? -1 : 1);
        list.forEach((c, i) => {
            let where = formatLineRange(c);
            if (c.side === 'old') where = zh ? `${where}（已删除的行，HEAD 中的行号）` : `${where} (deleted lines, HEAD numbering)`;
            if (c.stale) where += zh ? ' ⚠ 已过期：这段代码已变化，下面是批注时的内容' : ' ⚠ stale: this code has changed; snippet is from when the comment was written';
            const fence = fenceFor(c.lines);
            out.push('', `${i + 1}. ${where}`, fence, ...c.lines, fence, `${zh ? '批注' : 'Comment'}: ${c.body.trim()}`);
        });
    }
    return out.join('\n');
}
