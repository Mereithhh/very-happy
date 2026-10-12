/**
 * B-551: incremental, rewrite-aware reading of a Claude transcript JSONL,
 * plus the hook-supplied transcript path hints the scanner prefers.
 *
 * A cursor remembers the byte offset already consumed, the file identity
 * (dev/ino) and the last ≤64 bytes before the offset (the "boundary"). Each
 * read appends from the offset — unless the file was replaced (identity
 * changed), truncated (size < offset) or rewritten in place (boundary bytes
 * differ), in which case it starts over from byte 0. Starting over is safe:
 * the scanner dedupes by message uuid, exactly as the old whole-file re-read
 * did on every pass. Only complete ('\n'-terminated) lines are consumed; a
 * line Claude is still writing stays on disk for the next read.
 *
 * Idea after Orca's transcript-incremental-reader (offset + boundary).
 */

import { open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

export const TRANSCRIPT_BOUNDARY_BYTES = 64;

export interface TranscriptCursor {
    offset: number;
    dev: number;
    ino: number;
    boundary: Buffer;
}

export interface TranscriptStat {
    dev: number;
    ino: number;
    size: number;
}

export type TranscriptResetReason = 'replaced' | 'truncated' | 'rewritten';

/** Pure: where to start reading, and whether the file changed under us. */
export function planTranscriptRead(cursor: TranscriptCursor | null, stat: TranscriptStat): {
    start: number;
    reset: TranscriptResetReason | null;
    /** Offset at which the boundary must be re-read and compared, or null. */
    verifyAt: number | null;
} {
    if (!cursor) return { start: 0, reset: null, verifyAt: null };
    if (cursor.dev !== stat.dev || cursor.ino !== stat.ino) return { start: 0, reset: 'replaced', verifyAt: null };
    if (stat.size < cursor.offset) return { start: 0, reset: 'truncated', verifyAt: null };
    if (cursor.boundary.length === 0) return { start: cursor.offset, reset: null, verifyAt: null };
    return { start: cursor.offset, reset: null, verifyAt: cursor.offset - cursor.boundary.length };
}

/** Pure: split the bytes read at `start` into complete lines and advance. */
export function advanceTranscriptCursor(
    previous: TranscriptCursor | null,
    stat: TranscriptStat,
    start: number,
    bytes: Buffer,
): { lines: string[]; cursor: TranscriptCursor } {
    const lastNewline = bytes.lastIndexOf(0x0a);
    const consumed = lastNewline === -1 ? 0 : lastNewline + 1;
    const lines = consumed === 0
        ? []
        : bytes.subarray(0, consumed).toString('utf-8').split('\n').filter((line) => line.trim().length > 0);
    const carried = previous && start === previous.offset ? previous.boundary : Buffer.alloc(0);
    const tail = Buffer.concat([carried, bytes.subarray(0, consumed)]);
    return {
        lines,
        cursor: {
            offset: start + consumed,
            dev: stat.dev,
            ino: stat.ino,
            boundary: Buffer.from(tail.subarray(Math.max(0, tail.length - TRANSCRIPT_BOUNDARY_BYTES))),
        },
    };
}

/**
 * Read whatever is new in `path` since `cursor`. Returns null when the file
 * does not exist (yet). `reset` reports a detected rewrite (the returned
 * lines then start from byte 0).
 */
export async function readTranscriptIncrement(path: string, cursor: TranscriptCursor | null, opts: {
    /** Read no further than this byte (complete lines only). */
    limit?: number;
} = {}): Promise<{
    lines: string[];
    cursor: TranscriptCursor;
    reset: TranscriptResetReason | null;
} | null> {
    let handle;
    try {
        handle = await open(path, 'r');
    } catch {
        return null;
    }
    try {
        const st = await handle.stat();
        const stat: TranscriptStat = { dev: st.dev, ino: st.ino, size: st.size };
        let { start, reset, verifyAt } = planTranscriptRead(cursor, stat);
        if (verifyAt !== null && cursor) {
            const probe = Buffer.alloc(cursor.boundary.length);
            const { bytesRead } = await handle.read(probe, 0, probe.length, verifyAt);
            if (bytesRead !== probe.length || !probe.equals(cursor.boundary)) {
                start = 0;
                reset = 'rewritten';
            }
        }
        const base = reset ? null : cursor;
        const end = opts.limit === undefined ? stat.size : Math.min(stat.size, Math.max(0, opts.limit));
        const length = Math.max(0, end - start);
        if (length === 0) {
            return { lines: [], cursor: base ? { ...base, dev: stat.dev, ino: stat.ino } : advanceTranscriptCursor(null, stat, 0, Buffer.alloc(0)).cursor, reset };
        }
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        const { lines, cursor: next } = advanceTranscriptCursor(base, stat, start, buffer.subarray(0, bytesRead));
        return { lines, cursor: next, reset };
    } finally {
        await handle.close().catch(() => undefined);
    }
}

/**
 * A hook-reported transcript path is accepted only if it is absolute and
 * names exactly this session's file — never a path the scanner would read
 * for a different conversation.
 */
export function isValidTranscriptHint(sessionId: string, path: unknown): path is string {
    return typeof path === 'string'
        && path.length > 0
        && path.length <= 4096
        && isAbsolute(path)
        && basename(path) === `${sessionId}.jsonl`;
}

/** sessionId → transcript_path from SessionStart hooks (bounded). */
export class TranscriptPathHints {
    private paths = new Map<string, string>();
    private listeners = new Set<(sessionId: string, path: string) => void>();

    constructor(private readonly max = 64) {}

    /** Called synchronously whenever a session's hinted path is set/changed. */
    subscribe(listener: (sessionId: string, path: string) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    note(sessionId: string, path: unknown): boolean {
        if (!isValidTranscriptHint(sessionId, path)) return false;
        const changed = this.paths.get(sessionId) !== path;
        this.paths.delete(sessionId);
        this.paths.set(sessionId, path);
        if (changed) {
            for (const listener of this.listeners) {
                try { listener(sessionId, path); } catch { /* a scanner must not break the hook path */ }
            }
        }
        while (this.paths.size > this.max) {
            const oldest = this.paths.keys().next().value;
            if (oldest === undefined) break;
            this.paths.delete(oldest);
        }
        return true;
    }

    get(sessionId: string): string | undefined {
        return this.paths.get(sessionId);
    }
}
