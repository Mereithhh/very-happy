/**
 * ⌘P recently-opened files (B-576), per project (`machineId:path`), device-local.
 * Browser storage can be missing or throw (private mode, blocked site data):
 * every access is wrapped and a failure reads as "no history".
 */

export const QUICK_OPEN_HISTORY_KEY = 'vh.quickOpen.history.v1';
export const QUICK_OPEN_HISTORY_LIMIT = 20;
/** Keep the stored map bounded across many projects. */
const MAX_PROJECTS = 50;

type HistoryMap = Record<string, string[]>;

interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
    try {
        return typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
        return null;
    }
}

function readMap(storage: StorageLike | null): HistoryMap {
    if (!storage) return {};
    try {
        const raw = storage.getItem(QUICK_OPEN_HISTORY_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: HistoryMap = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (Array.isArray(v)) out[k] = v.filter((p): p is string => typeof p === 'string');
        }
        return out;
    } catch {
        return {};
    }
}

export function readQuickOpenHistory(project: string, storage: StorageLike | null = defaultStorage()): string[] {
    return readMap(storage)[project] ?? [];
}

/** Move `path` to the front of the project's history (deduped, capped). */
export function recordQuickOpen(project: string, path: string, storage: StorageLike | null = defaultStorage()): string[] {
    const map = readMap(storage);
    const next = [path, ...(map[project] ?? []).filter((p) => p !== path)].slice(0, QUICK_OPEN_HISTORY_LIMIT);
    // Re-insert so the most recently used project sorts last, then trim the oldest projects.
    delete map[project];
    map[project] = next;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PROJECTS))) delete map[k];
    if (storage) {
        try {
            storage.setItem(QUICK_OPEN_HISTORY_KEY, JSON.stringify(map));
        } catch {
            /* quota / blocked storage: history is a convenience */
        }
    }
    return next;
}
