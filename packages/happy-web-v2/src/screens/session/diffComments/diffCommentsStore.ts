/**
 * B-554: per-session diff comment drafts, device-local.
 *
 * Same carrier as clipboardHistoryStore (own MMKV namespace on localStorage,
 * snapshot cache for useSyncExternalStore). NOT synced settings and NOT
 * localSettings: these are drafts of a message, scoped to this browser, one
 * key per session so editing one session never rewrites another's blob.
 */
import { useSyncExternalStore } from 'react';
import { MMKV } from '@/storage/mmkv-web';
import { DIFF_COMMENTS_MMKV_ID, diffCommentsKey } from '@/sync/persistence';
import {
    DIFF_COMMENTS_MAX_PER_SESSION,
    clampBody,
    parseDiffComments,
    type AnchorTarget,
    type DiffComment,
} from './diffComments';

const store = new MMKV({ id: DIFF_COMMENTS_MMKV_ID });
const keyOf = diffCommentsKey;
/** Whole-namespace budget (chars) — localStorage is ~5MB and shared with everything else. */
export const DIFF_COMMENTS_TOTAL_MAX_CHARS = 1_000_000;

/** 'quota' = namespace budget exceeded (ask the user to send/clear); 'failed' = storage refused the write. */
export type WriteResult = 'ok' | 'quota' | 'failed';

const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | undefined; list: DiffComment[] }>();
const EMPTY: DiffComment[] = [];

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

function emit() {
    for (const l of [...listeners]) l();
}

export function getDiffComments(sessionId: string): DiffComment[] {
    let raw: string | undefined;
    try {
        raw = store.getString(keyOf(sessionId));
    } catch {
        raw = undefined;
    }
    const hit = cache.get(sessionId);
    if (hit && hit.raw === raw) return hit.list;
    const list = raw ? parseDiffComments(raw) : EMPTY;
    cache.set(sessionId, { raw, list });
    return list;
}

function usedByOthers(sessionId: string): number {
    let used = 0;
    const own = keyOf(sessionId);
    for (const key of store.getAllKeys()) {
        if (key !== own) used += store.getString(key)?.length ?? 0;
    }
    return used;
}

/**
 * Persist and READ BACK: MMKV's web shim swallows quota errors with a warn,
 * so a write that did not land must be detected here, not assumed.
 */
function write(sessionId: string, list: DiffComment[]): WriteResult {
    const key = keyOf(sessionId);
    let result: WriteResult = 'ok';
    try {
        if (list.length === 0) {
            store.delete(key);
            if (store.getString(key) !== undefined) result = 'failed';
        } else {
            const json = JSON.stringify(list.slice(0, DIFF_COMMENTS_MAX_PER_SESSION));
            if (usedByOthers(sessionId) + json.length > DIFF_COMMENTS_TOTAL_MAX_CHARS) result = 'quota';
            else {
                store.set(key, json);
                if (store.getString(key) !== json) result = 'failed';
            }
        }
    } catch {
        result = 'failed';
    }
    emit();
    return result;
}

let seq = 0;
const newId = () => `dc-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** The per-session count cap reports as 'quota' too. */
export function addDiffComment(sessionId: string, filePath: string, anchor: AnchorTarget, body: string, now = Date.now()): WriteResult {
    const list = getDiffComments(sessionId);
    if (list.length >= DIFF_COMMENTS_MAX_PER_SESSION) return 'quota';
    return write(sessionId, [...list, { id: newId(), filePath, ...anchor, body: clampBody(body), stale: false, createdAt: now, updatedAt: now }]);
}

export function updateDiffComment(sessionId: string, id: string, patch: Partial<Pick<DiffComment, 'body'> & AnchorTarget>, now = Date.now()): WriteResult {
    const list = getDiffComments(sessionId);
    return write(sessionId, list.map((c) => (c.id === id
        ? { ...c, ...patch, ...(patch.body !== undefined ? { body: clampBody(patch.body) } : {}), ...(patch.hash ? { stale: false } : {}), updatedAt: now }
        : c)));
}

/** Persist re-anchoring results (positions/stale only; updatedAt untouched). */
export function applyReanchored(sessionId: string, changed: readonly DiffComment[]) {
    if (changed.length === 0) return;
    const byId = new Map(changed.map((c) => [c.id, c]));
    write(sessionId, getDiffComments(sessionId).map((c) => byId.get(c.id) ?? c));
}

export function deleteDiffComment(sessionId: string, id: string): WriteResult {
    return write(sessionId, getDiffComments(sessionId).filter((c) => c.id !== id));
}

export function clearDiffComments(sessionId: string): WriteResult {
    return write(sessionId, []);
}

export function useDiffComments(sessionId: string): DiffComment[] {
    return useSyncExternalStore(subscribe, () => getDiffComments(sessionId), () => EMPTY);
}

// Another tab editing the same session's comments.
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
        if (event.key === null || event.key.startsWith('mmkv:diff-comments:')) emit();
    });
}
