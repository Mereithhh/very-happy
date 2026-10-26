/**
 * Owner 10-27: the once-per-load `scope=unarchived` read (sync.ts
 * fetchUnarchivedSessions) overlaps the first list by the window's unarchived
 * rows; those the store already holds at the same versions are not decoded
 * again (the Owner: 38 of 381). The rest is decoded in chunks with a yield
 * between them and merged ONCE: decoding ~340 rows is ~1s of main thread on a
 * phone (CPU ×4), and in one piece it held back the window's first render
 * past the ready budget; merging per chunk instead re-rendered the whole
 * sidebar each time (whole at 8.9s, production build).
 */

/** Rows decoded between two yields. */
export const UNARCHIVED_DECODE_CHUNK = 50;

interface VersionedRow {
    id: string;
    updatedAt: number;
    metadataVersion: number;
    agentStateVersion: number;
}

/** The rows worth decoding: not in the store yet, or newer than its copy. */
export function rowsToDecode<T extends VersionedRow>(
    rows: readonly T[],
    current: Readonly<Record<string, VersionedRow | undefined>>,
): T[] {
    return rows.filter((row) => {
        const have = current[row.id];
        if (!have) return true;
        return row.updatedAt > have.updatedAt
            || row.metadataVersion > have.metadataVersion
            || row.agentStateVersion > have.agentStateVersion;
    });
}

/** Yield to the browser (an idle callback when there is one, bounded so a busy or hidden tab still moves on). */
export function idleYield(timeoutMs = 50): Promise<void> {
    return new Promise<void>((resolve) => {
        const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
        if (typeof ric === 'function') ric(() => resolve(), { timeout: timeoutMs });
        else setTimeout(resolve, 0);
    });
}

/** `decode` every row in chunks, yielding before every chunk after the first; one array back, in order. */
export async function decodeInChunks<T, R>(
    rows: readonly T[],
    decode: (chunk: T[]) => Promise<R[]>,
    opts: { size?: number; yieldFn?: () => Promise<void> } = {},
): Promise<R[]> {
    const size = opts.size ?? UNARCHIVED_DECODE_CHUNK;
    const yieldFn = opts.yieldFn ?? (() => idleYield());
    const out: R[] = [];
    for (let i = 0; i < rows.length; i += size) {
        if (i > 0) await yieldFn();
        out.push(...await decode(rows.slice(i, i + size)));
    }
    return out;
}
