/**
 * B-891: per-session transcript comment drafts, device-local — the same
 * carrier as diffCommentsStore (own MMKV namespace, one key per session,
 * read-back writes, snapshot cache for useSyncExternalStore). Logout and
 * session deletion clear the namespace (sync/persistence.ts
 * clearDiffCommentDrafts).
 *
 * Also holds two in-memory bits the UI shares: which comments the
 * transcript could not find any more (stale), and which comment editor is open.
 */
import { useSyncExternalStore } from 'react';
import { MMKV } from '@/storage/mmkv-web';
import { CHAT_ANNOTATIONS_MMKV_ID, diffCommentsKey } from '@/sync/persistence';
import {
    CHAT_ANNOTATIONS_MAX_PER_SESSION,
    clampBody,
    parseChatAnnotations,
    type ChatAnnotation,
    type ChatAnnotationAnchor,
} from './chatAnnotations';

const store = new MMKV({ id: CHAT_ANNOTATIONS_MMKV_ID });
const keyOf = diffCommentsKey;
/** Whole-namespace budget (chars) — localStorage is ~5MB and shared with everything else. */
export const CHAT_ANNOTATIONS_TOTAL_MAX_CHARS = 500_000;

/** 'quota' = count or namespace budget exceeded; 'failed' = storage refused the write. */
export type WriteResult = 'ok' | 'quota' | 'failed';

const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | undefined; list: ChatAnnotation[] }>();
const EMPTY: ChatAnnotation[] = [];

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

function emit() {
    for (const l of [...listeners]) l();
}

export function getChatAnnotations(sessionId: string): ChatAnnotation[] {
    let raw: string | undefined;
    try {
        raw = store.getString(keyOf(sessionId));
    } catch {
        raw = undefined;
    }
    const hit = cache.get(sessionId);
    if (hit && hit.raw === raw) return hit.list;
    const list = raw ? parseChatAnnotations(raw) : EMPTY;
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

/** Persist and READ BACK: the MMKV web shim swallows quota errors with a warn. */
function write(sessionId: string, list: ChatAnnotation[]): WriteResult {
    const key = keyOf(sessionId);
    let result: WriteResult = 'ok';
    try {
        if (list.length === 0) {
            store.delete(key);
            if (store.getString(key) !== undefined) result = 'failed';
        } else {
            const json = JSON.stringify(list.slice(0, CHAT_ANNOTATIONS_MAX_PER_SESSION));
            if (usedByOthers(sessionId) + json.length > CHAT_ANNOTATIONS_TOTAL_MAX_CHARS) result = 'quota';
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
const newId = () => `ca-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function addChatAnnotation(sessionId: string, anchor: ChatAnnotationAnchor, body: string, now = Date.now()): WriteResult {
    const list = getChatAnnotations(sessionId);
    if (list.length >= CHAT_ANNOTATIONS_MAX_PER_SESSION) return 'quota';
    return write(sessionId, [...list, { id: newId(), ...anchor, body: clampBody(body), createdAt: now, updatedAt: now }]);
}

export function updateChatAnnotation(sessionId: string, id: string, body: string, now = Date.now()): WriteResult {
    return write(sessionId, getChatAnnotations(sessionId).map((c) => (c.id === id ? { ...c, body: clampBody(body), updatedAt: now } : c)));
}

export function deleteChatAnnotation(sessionId: string, id: string): WriteResult {
    return write(sessionId, getChatAnnotations(sessionId).filter((c) => c.id !== id));
}

/** After a send: drop exactly the comments that went out (ones added meanwhile stay). */
export function removeChatAnnotations(sessionId: string, ids: readonly string[]): WriteResult {
    if (ids.length === 0) return 'ok';
    const sent = new Set(ids);
    return write(sessionId, getChatAnnotations(sessionId).filter((c) => !sent.has(c.id)));
}

export function clearChatAnnotations(sessionId: string): WriteResult {
    return write(sessionId, []);
}

export function useChatAnnotations(sessionId: string): ChatAnnotation[] {
    return useSyncExternalStore(subscribe, () => getChatAnnotations(sessionId), () => EMPTY);
}

// ── stale ids (reported by the transcript layer, read by the composer tray) ──

const staleBySession = new Map<string, ReadonlySet<string>>();
const NO_STALE: ReadonlySet<string> = new Set();

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

/** `found` ids were located, `stale` ids were looked for and are gone; others keep their last state. */
export function reportAnchorState(sessionId: string, found: readonly string[], stale: readonly string[]) {
    const prev = staleBySession.get(sessionId) ?? NO_STALE;
    const next = new Set(prev);
    for (const id of found) next.delete(id);
    for (const id of stale) next.add(id);
    if (sameSet(prev, next)) return;
    staleBySession.set(sessionId, next);
    emit();
}

export function getStaleAnnotationIds(sessionId: string): ReadonlySet<string> {
    return staleBySession.get(sessionId) ?? NO_STALE;
}

export function useStaleAnnotationIds(sessionId: string): ReadonlySet<string> {
    return useSyncExternalStore(subscribe, () => getStaleAnnotationIds(sessionId), () => NO_STALE);
}

// ── the one open editor ──

export type EditorPlace = { left: number; top: number; bottom: number };
export type AnnotationEditorState =
    | { sessionId: string; kind: 'new'; anchor: ChatAnnotationAnchor; place: EditorPlace | null }
    | { sessionId: string; kind: 'edit'; id: string; place: EditorPlace | null };

let editor: AnnotationEditorState | null = null;

export function openAnnotationEditor(next: AnnotationEditorState | null) {
    if (editor === next) return;
    editor = next;
    emit();
}

export function getAnnotationEditor(): AnnotationEditorState | null {
    return editor;
}

export function useAnnotationEditor(): AnnotationEditorState | null {
    return useSyncExternalStore(subscribe, getAnnotationEditor, () => null);
}

// Another tab editing the same session's comments.
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
        if (event.key === null || event.key.startsWith(`mmkv:${CHAT_ANNOTATIONS_MMKV_ID}:`)) emit();
    });
}
