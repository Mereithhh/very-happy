/**
 * B-572: "viewed" marks of the review-all tab, device-local (own MMKV
 * namespace, one key per session — same carrier as diffCommentsStore).
 * Cleared with the comment drafts on logout / session delete
 * (sync/persistence.ts clearDiffCommentDrafts).
 */
import { useSyncExternalStore } from 'react';
import { MMKV } from '@/storage/mmkv-web';
import { REVIEW_VIEWED_MMKV_ID, diffCommentsKey } from '@/sync/persistence';
import { parseViewedMap, type ViewedEntry, type ViewedMap } from './reviewAllModel';

const store = new MMKV({ id: REVIEW_VIEWED_MMKV_ID });
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | undefined; map: ViewedMap }>();
const EMPTY: ViewedMap = {};

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}
const emit = () => { for (const l of [...listeners]) l(); };

export function getViewedMap(sessionId: string): ViewedMap {
    let raw: string | undefined;
    try { raw = store.getString(diffCommentsKey(sessionId)); } catch { raw = undefined; }
    const hit = cache.get(sessionId);
    if (hit && hit.raw === raw) return hit.map;
    const map = raw ? parseViewedMap(raw) : EMPTY;
    cache.set(sessionId, { raw, map });
    return map;
}

/** Returns false when the browser refused the write (read back, the shim swallows quota errors). */
export function writeViewedMap(sessionId: string, map: ViewedMap): boolean {
    const key = diffCommentsKey(sessionId);
    let ok = true;
    try {
        if (Object.keys(map).length === 0) store.delete(key);
        else {
            const json = JSON.stringify(parseViewedMap(JSON.stringify(map)));
            store.set(key, json);
            ok = store.getString(key) === json;
        }
    } catch {
        ok = false;
    }
    emit();
    return ok;
}

export function setViewed(sessionId: string, path: string, entry: ViewedEntry | null): boolean {
    const next = { ...getViewedMap(sessionId) };
    if (entry) next[path] = entry;
    else delete next[path];
    return writeViewedMap(sessionId, next);
}

export function useViewedMap(sessionId: string): ViewedMap {
    return useSyncExternalStore(subscribe, () => getViewedMap(sessionId), () => EMPTY);
}

if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
        if (event.key === null || event.key.startsWith(`mmkv:${REVIEW_VIEWED_MMKV_ID}:`)) emit();
    });
}
