/**
 * B-549 — the on-disk / in-memory shape of the history search index, the
 * incremental cursor rules, and the size cap.
 *
 * One record per transcript file. `offset` is the byte position just after the
 * last COMPLETE line that was fed to the extractor: a line still being written
 * is never committed, so the next pass re-reads it from its start (a torn line
 * committed as "done" would lose that message forever).
 *
 * Persisted as JSONL under `<HAPPY_HOME>/history-search/` — a header line,
 * then one line per record — written to a temp file and renamed, mode 0600.
 * A version mismatch or unreadable file reads as an empty index (rebuilt on
 * the next search), never as an error.
 */
import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { DocMeta, HistorySearchAgent, IndexedMessage } from './extract';

export const INDEX_VERSION = 1;
export const INDEX_FILE_NAME = `index.v${INDEX_VERSION}.jsonl`;
/** Default cap on indexed text across all sessions (chars ≈ bytes for ASCII). */
export const DEFAULT_MAX_TEXT_CHARS = 32_000_000;

export type FileRecord = {
    path: string;
    agent: HistorySearchAgent;
    /** Conversation id: Claude session UUID / Codex thread UUID (lower-case). */
    id: string;
    ino: number;
    size: number;
    mtimeMs: number;
    /** Byte offset after the last complete line consumed. */
    offset: number;
    meta: DocMeta;
    msgs: IndexedMessage[];
    chars: number;
    full?: boolean;
    /** Text dropped by the size cap; metadata (title, cwd) still searchable. */
    evicted?: boolean;
};

export type FileStat = { path: string; agent: HistorySearchAgent; id: string; ino: number; size: number; mtimeMs: number };

export type FilePlan = 'skip' | 'append' | 'reread';

/**
 * What to do with one transcript given what the index holds for it. Pure.
 * Transcripts are append-only; anything that is not a clean append (a new
 * inode, a shrink, a same-size rewrite) is re-read from the start.
 */
export function planFile(prev: Pick<FileRecord, 'ino' | 'size' | 'mtimeMs' | 'offset' | 'evicted'> | undefined, cur: Pick<FileStat, 'ino' | 'size' | 'mtimeMs'>): FilePlan {
    if (!prev) return 'reread';
    if (prev.ino !== cur.ino) return 'reread';
    if (cur.size === prev.size && cur.mtimeMs === prev.mtimeMs) return 'skip';
    if (cur.size < prev.offset || cur.size < prev.size) return 'reread';
    if (cur.size === prev.size) return 'reread'; // rewritten in place
    // Grew. An evicted record has no text to append to: it is the newest
    // activity now, so read it whole.
    return prev.evicted ? 'reread' : 'append';
}

export function totalChars(records: Iterable<FileRecord>): number {
    let sum = 0;
    for (const r of records) sum += r.chars;
    return sum;
}

/**
 * Enforce the text cap by dropping the text of the least recently updated
 * sessions (metadata and cursor stay, so they are not re-read until they
 * change, and their title/cwd still match). Returns how many records were
 * evicted by this call. Mutates.
 */
export function enforceTextCap(records: Map<string, FileRecord>, maxChars: number): number {
    let total = totalChars(records.values());
    if (total <= maxChars) return 0;
    const byAge = [...records.values()].filter((r) => r.chars > 0).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let evicted = 0;
    for (const r of byAge) {
        if (total <= maxChars) break;
        total -= r.chars;
        r.msgs = [];
        r.chars = 0;
        r.evicted = true;
        evicted += 1;
    }
    return evicted;
}

export type IndexHeader = { v: number; savedAt: number };

export function serializeIndex(records: Iterable<FileRecord>, savedAt: number): string {
    const lines = [JSON.stringify({ v: INDEX_VERSION, savedAt } satisfies IndexHeader)];
    for (const r of records) lines.push(JSON.stringify(r));
    return lines.join('\n') + '\n';
}

function isRecord(value: any): value is FileRecord {
    return !!value && typeof value === 'object'
        && typeof value.path === 'string'
        && (value.agent === 'claude' || value.agent === 'codex')
        && typeof value.id === 'string'
        && typeof value.ino === 'number'
        && typeof value.size === 'number'
        && typeof value.mtimeMs === 'number'
        && typeof value.offset === 'number'
        && !!value.meta && typeof value.meta === 'object'
        && Array.isArray(value.msgs)
        && typeof value.chars === 'number';
}

/** Parse a persisted index. Wrong version / garbage → null (rebuild). */
export function parseIndex(text: string): { savedAt: number; records: Map<string, FileRecord> } | null {
    const lines = text.split('\n');
    let header: any;
    try { header = JSON.parse(lines[0] ?? ''); } catch { return null; }
    if (!header || header.v !== INDEX_VERSION || typeof header.savedAt !== 'number') return null;
    const records = new Map<string, FileRecord>();
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (isRecord(parsed)) records.set(parsed.path, parsed);
    }
    return { savedAt: header.savedAt, records };
}

export function indexFilePath(indexDir: string): string {
    return join(indexDir, INDEX_FILE_NAME);
}

export async function loadIndex(indexDir: string): Promise<{ savedAt: number; records: Map<string, FileRecord> } | null> {
    let text: string;
    try {
        text = await readFile(indexFilePath(indexDir), 'utf-8');
    } catch {
        return null;
    }
    return parseIndex(text);
}

/** Atomic write: temp file (0600) + rename. The directory is 0700 — the index
 *  holds conversation text. */
export async function saveIndex(indexDir: string, records: Iterable<FileRecord>, savedAt: number): Promise<void> {
    await mkdir(indexDir, { recursive: true, mode: 0o700 });
    try { await chmod(indexDir, 0o700); } catch { /* best effort (Windows) */ }
    const target = indexFilePath(indexDir);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, serializeIndex(records, savedAt), { mode: 0o600 });
    await rename(tmp, target);
}

export async function clearIndexDir(indexDir: string): Promise<void> {
    await rm(indexDir, { recursive: true, force: true });
}
