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
import {
    DIFF_COMMENTS_MAX_PER_SESSION,
    clampBody,
    parseDiffComments,
    type AnchorTarget,
    type DiffComment,
} from './diffComments';

const store = new MMKV({ id: 'diff-comments' });
const keyOf = (sessionId: string) => `s.${sessionId}`;

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

function write(sessionId: string, list: DiffComment[]) {
    try {
        if (list.length === 0) store.delete(keyOf(sessionId));
        else store.set(keyOf(sessionId), JSON.stringify(list.slice(0, DIFF_COMMENTS_MAX_PER_SESSION)));
    } catch {
        // storage disabled: keep the in-memory list for this page
        cache.set(sessionId, { raw: undefined, list });
    }
    emit();
}

let seq = 0;
const newId = () => `dc-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** False when the per-session cap is reached. */
export function addDiffComment(sessionId: string, filePath: string, anchor: AnchorTarget, body: string, now = Date.now()): boolean {
    const list = getDiffComments(sessionId);
    if (list.length >= DIFF_COMMENTS_MAX_PER_SESSION) return false;
    write(sessionId, [...list, { id: newId(), filePath, ...anchor, body: clampBody(body), stale: false, createdAt: now, updatedAt: now }]);
    return true;
}

export function updateDiffComment(sessionId: string, id: string, patch: Partial<Pick<DiffComment, 'body'> & AnchorTarget>, now = Date.now()) {
    const list = getDiffComments(sessionId);
    write(sessionId, list.map((c) => (c.id === id
        ? { ...c, ...patch, ...(patch.body !== undefined ? { body: clampBody(patch.body) } : {}), ...(patch.hash ? { stale: false } : {}), updatedAt: now }
        : c)));
}

/** Persist re-anchoring results (positions/stale only; updatedAt untouched). */
export function applyReanchored(sessionId: string, changed: readonly DiffComment[]) {
    if (changed.length === 0) return;
    const byId = new Map(changed.map((c) => [c.id, c]));
    write(sessionId, getDiffComments(sessionId).map((c) => byId.get(c.id) ?? c));
}

export function deleteDiffComment(sessionId: string, id: string) {
    write(sessionId, getDiffComments(sessionId).filter((c) => c.id !== id));
}

export function clearDiffComments(sessionId: string) {
    write(sessionId, []);
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
