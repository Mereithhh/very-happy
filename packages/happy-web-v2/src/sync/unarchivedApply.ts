/**
 * Owner 10-27: the once-per-load `scope=unarchived` read (sync.ts
 * fetchUnarchivedSessions) overlaps the first list by the window's unarchived
 * rows; those the store already holds at the same versions are not decoded
 * again (the Owner: 38 of 381).
 */

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
