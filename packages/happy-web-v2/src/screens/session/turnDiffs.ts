/**
 * B-571: which files one turn changed, from the write tools it RECORDED —
 * pure, client-side, no RPC. Spec: specs/2026-10-change-review-surfaces.md.
 *
 * Shape idea from Orca `native-chat-turn-diffs.ts` (MIT): group recorded
 * edits by the transcript's own turn boundaries, sum per path. Everything
 * below (tool shapes, unknown counts, sub-agent attribution) is ours.
 *
 * Counts are LINES, the same unit the Edit tool cards' DiffView shows. A
 * count that cannot be known (replace_all without a patch, an overwrite of
 * an existing file, a notebook edit, a patch with no diff text) is `null` and
 * renders as 「已改」 — never as a guessed number.
 */
import type { Message, ToolCall } from '@/sync/typesMessage';
import { normalizePiToolCall } from '@/components/tools/piToolMapping';
import { lineDiff } from './diff';

/** What the rollup can show for one edit when the file row is expanded. */
export type EditRender = { oldText: string; newText: string };

export type FileEdit = {
    path: string;
    added: number | null;
    removed: number | null;
    renders: EditRender[];
};

export type TurnDiffFile = {
    path: string;
    /** null = at least one edit of this file could not be counted. */
    added: number | null;
    removed: number | null;
    renders: EditRender[];
    edits: number;
};

export type TurnDiff = {
    files: TurnDiffFile[];
    /** Sums over the files whose counts are known. */
    added: number;
    removed: number;
    /** Some file's count is unknown — the totals cover only part of the turn. */
    partial: boolean;
};

/** Beyond this many LCS cells (after trimming common lines) the count is reported unknown. */
export const EDIT_DIFF_MAX_CELLS = 250_000;

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const record = (v: unknown): Record<string, unknown> | null =>
    (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Lines of a file body: a trailing newline does not open another line. */
export function countLines(text: string): number {
    if (text === '') return 0;
    const parts = text.split('\n');
    return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

/** +/- lines of an old→new replacement; null when too large to diff on the main thread. */
export function countReplacement(oldText: string, newText: string): { added: number; removed: number } | null {
    const a = oldText === '' ? [] : oldText.split('\n');
    const b = newText === '' ? [] : newText.split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const restA = a.slice(start, endA);
    const restB = b.slice(start, endB);
    if (restA.length === 0 || restB.length === 0) return { added: restB.length, removed: restA.length };
    if (restA.length * restB.length > EDIT_DIFF_MAX_CELLS) return null;
    let added = 0;
    let removed = 0;
    for (const row of lineDiff(restA.join('\n'), restB.join('\n'))) {
        if (row.type === 'add') added++;
        else if (row.type === 'del') removed++;
    }
    return { added, removed };
}

/** Count hunk body lines of a unified diff (file headers `+++`/`---` skipped). */
export function countUnifiedDiff(diff: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    let inHunk = false;
    for (const line of diff.split('\n')) {
        if (line.startsWith('@@')) { inHunk = true; continue; }
        if (!inHunk && (line.startsWith('+++') || line.startsWith('---'))) continue;
        if (line.startsWith('diff --git')) { inHunk = false; continue; }
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
    }
    return { added, removed };
}

/** Rebuild old/new snippets from a unified diff's hunks, for DiffView. */
export function unifiedDiffRender(diff: string): EditRender | null {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let inHunk = false;
    for (const line of diff.split('\n')) {
        if (line.startsWith('@@')) {
            if (inHunk) { oldLines.push('⋯'); newLines.push('⋯'); }
            inHunk = true;
            continue;
        }
        if (!inHunk) continue;
        if (line.startsWith('\\')) continue;
        const sign = line[0];
        const body = line.slice(1);
        if (sign === '+') newLines.push(body);
        else if (sign === '-') oldLines.push(body);
        else if (sign === ' ' || line === '') { oldLines.push(body); newLines.push(body); }
    }
    if (!inHunk) return null;
    return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

/** Claude `toolUseResult.structuredPatch` → +/- counts; null when absent. */
function structuredPatchCounts(result: unknown): { added: number; removed: number } | null {
    const patch = record(result)?.structuredPatch;
    if (!Array.isArray(patch)) return null;
    let added = 0;
    let removed = 0;
    for (const hunk of patch) {
        const lines = record(hunk)?.lines;
        if (!Array.isArray(lines)) return null;
        for (const line of lines) {
            if (typeof line !== 'string') continue;
            if (line.startsWith('+')) added++;
            else if (line.startsWith('-')) removed++;
        }
    }
    return { added, removed };
}

/**
 * Claude `structuredPatch` → old/new snippets for DiffView, so an expanded
 * file shows the SAME change its numbers count (review 低2).
 */
function structuredPatchRender(result: unknown): EditRender | null {
    const patch = record(result)?.structuredPatch;
    if (!Array.isArray(patch) || patch.length === 0) return null;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const [i, hunk] of patch.entries()) {
        const lines = record(hunk)?.lines;
        if (!Array.isArray(lines)) return null;
        if (i > 0) { oldLines.push('⋯'); newLines.push('⋯'); }
        for (const line of lines) {
            if (typeof line !== 'string') continue;
            const body = line.slice(1);
            if (line.startsWith('+')) newLines.push(body);
            else if (line.startsWith('-')) oldLines.push(body);
            else if (!line.startsWith('\\')) { oldLines.push(body); newLines.push(body); }
        }
    }
    return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

function codexPatchEdits(input: Record<string, unknown>): FileEdit[] {
    const changes = record(input.changes) ?? record(input.fileChanges);
    if (!changes) return [];
    const edits: FileEdit[] = [];
    for (const [rawPath, rawChange] of Object.entries(changes)) {
        if (!rawPath.trim()) continue;
        const change = record(rawChange) ?? {};
        const kind = record(change.kind);
        const type = asString(kind?.type) ?? asString(change.type);
        const update = record(change.update);
        const movePath = asString(kind?.move_path) ?? asString(update?.move_path) ?? asString(change.move_path);
        const path = movePath && movePath.trim() ? movePath : rawPath;
        const addContent = asString(record(change.add)?.content) ?? (type === 'add' ? asString(change.content) : null);
        const delContent = asString(record(change.delete)?.content) ?? (type === 'delete' ? asString(change.content) : null);
        const diff = asString(change.diff) ?? asString(change.unified_diff) ?? asString(update?.unified_diff);
        const modify = record(change.modify);
        if (diff !== null && diff.trim() !== '') {
            const counts = countUnifiedDiff(diff);
            const render = unifiedDiffRender(diff);
            // `add` changes from the app-server carry the new file as a diff too.
            edits.push({ path, ...counts, renders: render ? [render] : addContent !== null ? [{ oldText: '', newText: addContent }] : [] });
        } else if (addContent !== null) {
            edits.push({ path, added: countLines(addContent), removed: 0, renders: [{ oldText: '', newText: addContent }] });
        } else if (delContent !== null) {
            edits.push({ path, added: 0, removed: countLines(delContent), renders: [{ oldText: delContent, newText: '' }] });
        } else if (modify && typeof modify.old_content === 'string' && typeof modify.new_content === 'string') {
            const counts = countReplacement(modify.old_content, modify.new_content);
            edits.push({ path, added: counts?.added ?? null, removed: counts?.removed ?? null, renders: [{ oldText: modify.old_content, newText: modify.new_content }] });
        } else {
            edits.push({ path, added: null, removed: null, renders: [] });
        }
    }
    return edits;
}

/**
 * Write-tool calls → the files they changed. Only COMPLETED calls count: a
 * failed, denied or still-running edit changed nothing (yet).
 */
export function toolFileEdits(rawTool: ToolCall): FileEdit[] {
    if (rawTool.state !== 'completed') return [];
    const tool = normalizePiToolCall(rawTool);
    const input = record(tool.input) ?? {};
    switch (tool.name) {
        case 'Edit': {
            const path = asString(input.file_path);
            if (!path) return [];
            const oldText = asString(input.old_string) ?? '';
            const newText = asString(input.new_string) ?? '';
            const exact = structuredPatchCounts(tool.result);
            const counts = exact ?? (input.replace_all === true ? null : countReplacement(oldText, newText));
            const patched = exact ? structuredPatchRender(tool.result) : null;
            return [{ path, added: counts?.added ?? null, removed: counts?.removed ?? null, renders: [patched ?? { oldText, newText }] }];
        }
        case 'MultiEdit': {
            const path = asString(input.file_path);
            if (!path) return [];
            const list = Array.isArray(input.edits) ? input.edits.map(record).filter((e): e is Record<string, unknown> => e !== null) : [];
            const renders = list.map((e) => ({ oldText: asString(e.old_string) ?? '', newText: asString(e.new_string) ?? '' }));
            const exact = structuredPatchCounts(tool.result);
            if (exact) { const patched = structuredPatchRender(tool.result); return [{ path, ...exact, renders: patched ? [patched] : renders }]; }
            let added: number | null = 0;
            let removed: number | null = 0;
            for (const [i, e] of list.entries()) {
                const counts = e.replace_all === true ? null : countReplacement(renders[i].oldText, renders[i].newText);
                if (!counts || added === null || removed === null) { added = null; removed = null; break; }
                added += counts.added;
                removed += counts.removed;
            }
            return [{ path, added, removed, renders }];
        }
        case 'Write': {
            const path = asString(input.file_path);
            if (!path) return [];
            const content = asString(input.content) ?? '';
            const result = record(tool.result);
            const type = asString(result?.type);
            // Only the runner's own result says whether the file existed. No
            // type (pi, the session-protocol channel) → 「已改」, never a guess
            // (review 低1). Counts and the expanded diff come from one source
            // (review 低2).
            if (type === 'create') return [{ path, added: countLines(content), removed: 0, renders: [{ oldText: '', newText: content }] }];
            const exact = type === 'update' ? structuredPatchCounts(result) : null;
            const patched = exact ? structuredPatchRender(result) : null;
            if (exact && patched) return [{ path, ...exact, renders: [patched] }];
            return [{ path, added: null, removed: null, renders: [] }];
        }
        case 'NotebookEdit': {
            const path = asString(input.notebook_path) ?? asString(input.file_path);
            return path ? [{ path, added: null, removed: null, renders: [] }] : [];
        }
        case 'CodexPatch':
            return codexPatchEdits(input);
        default:
            return [];
    }
}

/** Light, cwd-free normalization so `./a.ts`, `a.ts` and `a//b` compare equal. */
export function normalizeToolPath(path: string): string {
    let p = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    while (p.startsWith('./')) p = p.slice(2);
    return p.replace(/\/\.\//g, '/').replace(/(.)\/$/, '$1');
}

const editCache = new WeakMap<ToolCall, FileEdit[]>();

/** Cached per ToolCall object — long transcripts rebuild rows often. */
function cachedEdits(tool: ToolCall): FileEdit[] {
    let edits = editCache.get(tool);
    if (!edits) { edits = toolFileEdits(tool); editCache.set(tool, edits); }
    return edits;
}

const isSubagentCard = (message: Message) => message.kind === 'tool-call' && (message.tool.name === 'Task' || message.tool.name === 'Agent');

/**
 * Every tool call in `messages`, sub-agent children included (depth-first, in
 * order). Sub-agent work is attributed to the turn holding its card: the
 * turn sent it out, and a background one finishing later still updates that
 * turn's rollup when its messages arrive.
 */
export function* walkToolCalls(messages: readonly Message[]): Generator<ToolCall> {
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        yield message.tool;
        if (isSubagentCard(message) && message.children.length > 0) yield* walkToolCalls(message.children);
    }
}

/** One turn's recorded file changes, or null when it wrote nothing. */
export function turnDiffSummary(turnMessages: readonly Message[]): TurnDiff | null {
    const byPath = new Map<string, TurnDiffFile>();
    for (const tool of walkToolCalls(turnMessages)) {
        for (const edit of cachedEdits(tool)) {
            const key = normalizeToolPath(edit.path);
            const prev = byPath.get(key);
            if (!prev) {
                byPath.set(key, { path: edit.path, added: edit.added, removed: edit.removed, renders: [...edit.renders], edits: 1 });
            } else {
                const known = prev.added !== null && prev.removed !== null && edit.added !== null && edit.removed !== null;
                prev.added = known ? prev.added! + edit.added! : null;
                prev.removed = known ? prev.removed! + edit.removed! : null;
                prev.renders.push(...edit.renders);
                prev.edits++;
            }
        }
    }
    if (byPath.size === 0) return null;
    const files = [...byPath.values()];
    let added = 0;
    let removed = 0;
    let partial = false;
    for (const file of files) {
        if (file.added === null || file.removed === null) { partial = true; continue; }
        added += file.added;
        removed += file.removed;
    }
    return { files, added, removed, partial };
}

/** Show a path relative to the session cwd when it lives under it. */
export function displayPath(path: string, cwd: string | null | undefined): string {
    const p = normalizeToolPath(path);
    if (!cwd) return p;
    const root = normalizeToolPath(cwd).replace(/\/$/, '');
    return root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
}

/**
 * B-573: the paths a COMPLETED write tool wrote (no line counting — cheap
 * enough to run over a whole session on every message).
 */
export function writtenPathsOf(rawTool: ToolCall): string[] {
    if (rawTool.state !== 'completed') return [];
    const tool = normalizePiToolCall(rawTool);
    const input = record(tool.input) ?? {};
    switch (tool.name) {
        case 'Edit':
        case 'MultiEdit':
        case 'Write': {
            const path = asString(input.file_path);
            return path ? [path] : [];
        }
        case 'NotebookEdit': {
            const path = asString(input.notebook_path) ?? asString(input.file_path);
            return path ? [path] : [];
        }
        case 'CodexPatch': {
            const changes = record(input.changes) ?? record(input.fileChanges);
            if (!changes) return [];
            const out: string[] = [];
            for (const [path, raw] of Object.entries(changes)) {
                const change = record(raw);
                const move = asString(record(change?.kind)?.move_path) ?? asString(record(change?.update)?.move_path) ?? asString(change?.move_path);
                if (path.trim()) out.push(path);
                if (move && move.trim()) out.push(move);
            }
            return out;
        }
        default:
            return [];
    }
}
