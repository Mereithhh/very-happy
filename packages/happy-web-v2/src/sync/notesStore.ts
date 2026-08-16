/**
 * notesStore — KV carrier + React store for prompt notes (B-094). Pure data
 * rules (record shape, LWW, caps) live in notes.ts; this file owns I/O.
 *
 * Carrier: ONE KV KEY PER NOTE (`vh.note.v1.<id>`) — see notes.ts for why.
 * Each key has its own optimistic version, so the CAS conflict surface is a
 * single note, and the 409 body carries the winning value (read-merge-write
 * primitive, same as notificationSeenStore). Deletion = tombstone
 * (value:null) — server kvGet/list then hide the key, version keeps counting.
 *
 * Live updates arrive on the socket (`kv-batch-update` → kvUpdates.ts);
 * `refresh()` covers socket gaps. MMKV mirrors the full set for instant
 * render/offline reads, guarded by an account fingerprint.
 */

import { create } from 'zustand';
import { getCurrentAuth } from '@/auth/AuthContext';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { MMKV } from '@/storage/mmkv-web';
import { accountFingerprint } from '@/sync/accountFingerprint';
import { kvGetByPrefix, kvMutate } from '@/sync/apiKv';
import { onKvChanges } from '@/sync/kvUpdates';
import {
    NOTE_EXPLICIT_TITLE_MAX_CHARS,
    NOTE_TAGS_MAX,
    NOTE_TAG_MAX_CHARS,
    NOTE_CONTENT_MAX_CHARS,
    NOTE_KV_PREFIX,
    NOTES_MAX_COUNT,
    newNoteId,
    noteIdFromKvKey,
    noteKvKey,
    parseNoteRecord,
    pickNoteWinner,
    type NoteBinding,
    type NoteRecord,
} from '@/sync/notes';

const mmkv = new MMKV({ id: 'prompt-notes' });
const CACHE_KEY = 'notes-cache-v1';

/** debounce per note — keystrokes must not each become a KV write */
const PUSH_DEBOUNCE_MS = 600;
/** CAS retries per push before giving up (local cache still holds the truth) */
const PUSH_MAX_ATTEMPTS = 4;
/** floor between refetches, so a flurry of wake-ups is one request */
const REFRESH_MIN_INTERVAL_MS = 30_000;
/** prefix-list page size — comfortably above NOTES_MAX_COUNT */
const LIST_LIMIT = 500;

interface CacheBlob {
    account?: string | null;
    notes: NoteRecord[];
}

let cachedAccount: string | null | undefined;

/**
 * Credentials as seen by React (the dock hook pushes them in). Same rationale
 * as notificationSeenStore: `getCurrentAuth()` is published from AuthProvider's
 * EFFECT and child effects run first, so the first mount would see null.
 */
let activeCreds: AuthCredentials | null = null;
let credsAdopted = false;

export function setNotesCredentials(creds: AuthCredentials | null): void {
    activeCreds = creds;
    credsAdopted = true;
}

function currentCreds(): AuthCredentials | null {
    return credsAdopted ? activeCreds : (getCurrentAuth()?.credentials ?? null);
}

function loadCache(): Record<string, NoteRecord> {
    try {
        const raw = mmkv.getString(CACHE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as CacheBlob;
        cachedAccount = parsed.account ?? null;
        const out: Record<string, NoteRecord> = {};
        if (Array.isArray(parsed.notes)) {
            for (const entry of parsed.notes) {
                const rec = parseNoteRecord(entry);
                if (rec) out[rec.id] = rec;
            }
        }
        return out;
    } catch {
        return {};
    }
}

function persistLocal(notes: Record<string, NoteRecord>) {
    try {
        const creds = currentCreds();
        const account = creds ? accountFingerprint(creds.token) : (cachedAccount ?? null);
        cachedAccount = account;
        mmkv.set(CACHE_KEY, JSON.stringify({ account, notes: Object.values(notes) } satisfies CacheBlob));
    } catch {
        /* best-effort */
    }
}

function toB64(json: string): string {
    return btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}
function fromB64(b64: string): string {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

function decodeNote(valueB64: string): NoteRecord | null {
    try {
        return parseNoteRecord(JSON.parse(fromB64(valueB64)));
    } catch {
        return null;
    }
}

function encodeNote(note: NoteRecord): string {
    return toB64(JSON.stringify(note));
}

/**
 * Per-note KV versions. undefined = never seen on the server (a local create
 * pushes with -1); after a tombstone the version keeps counting, so deletes
 * absorb the real version from the 409 and retry.
 */
const versions: Record<string, number> = {};
const pushTimers: Record<string, ReturnType<typeof setTimeout>> = {};
/** notes whose latest local edit has not landed on the server yet */
const dirty = new Set<string>();

let lastRefreshAt = 0;
let kvSubscribed = false;

function setNotesState(notes: Record<string, NoteRecord>) {
    persistLocal(notes);
    useNotes.setState({ notes });
}

/** Adopt one remote record (LWW against local; local edits may out-win it). */
function absorbRemote(remote: NoteRecord, version: number) {
    const state = useNotes.getState().notes;
    const local = state[remote.id];
    versions[remote.id] = version;
    const winner = local ? pickNoteWinner(local, remote) : remote;
    if (winner !== local) {
        dirty.delete(remote.id);
        setNotesState({ ...state, [remote.id]: winner });
    } else if (local && winner === local && local.updatedAt > remote.updatedAt) {
        // Local is newer than what the server has (offline edit) — republish.
        schedulePush(remote.id);
    }
}

function removeLocal(id: string) {
    const state = useNotes.getState().notes;
    if (!(id in state)) return;
    const next = { ...state };
    delete next[id];
    dirty.delete(id);
    setNotesState(next);
}

/**
 * Push one note (or its deletion) behind a per-note CAS loop. On conflict the
 * 409 body carries the winner: edits resolve by updatedAt (LWW), deletes
 * always win (an explicit user action beats a concurrent edit).
 */
function schedulePush(id: string) {
    const creds = currentCreds();
    if (!creds) return; // not logged in → local cache only
    dirty.add(id);
    if (pushTimers[id]) clearTimeout(pushTimers[id]);
    pushTimers[id] = setTimeout(() => {
        delete pushTimers[id];
        void pushNow(id, creds);
    }, PUSH_DEBOUNCE_MS);
}

async function pushNow(id: string, creds: AuthCredentials) {
    for (let attempt = 0; attempt < PUSH_MAX_ATTEMPTS; attempt++) {
        const note = useNotes.getState().notes[id] as NoteRecord | undefined;
        const deleting = note === undefined;
        const version = versions[id] ?? -1;
        if (deleting && version === -1) return; // never reached the server — nothing to delete
        try {
            const result = await kvMutate(creds, [
                { key: noteKvKey(id), value: deleting ? null : encodeNote(note), version },
            ]);
            if (result.success) {
                versions[id] = result.results[0].version;
                if (deleting) delete versions[id];
                dirty.delete(id);
                return;
            }
            const conflict = result.errors[0];
            versions[id] = conflict.version;
            if (deleting) continue; // delete wins — retry with the real version
            const remote = conflict.value ? decodeNote(conflict.value) : null;
            if (remote && pickNoteWinner(note, remote) === remote) {
                // The other device's edit is newer — adopt it, drop ours.
                dirty.delete(id);
                setNotesState({ ...useNotes.getState().notes, [id]: remote });
                return;
            }
            // Remote was deleted or older — retry our write with the real version.
        } catch (e: any) {
            // Transport failure — the local cache keeps the truth; the next
            // edit (or refresh) republishes.
            console.warn('[notes] KV push failed', e?.message);
            return;
        }
    }
    console.warn('[notes] KV push gave up after CAS retries');
}

function flushAllPending() {
    const creds = currentCreds();
    if (!creds) return;
    for (const id of Object.keys(pushTimers)) {
        clearTimeout(pushTimers[id]);
        delete pushTimers[id];
        void pushNow(id, creds);
    }
}

/** Live cross-device updates (our own echoes land here too — absorb is LWW). */
function subscribeToKvPushes() {
    if (kvSubscribed) return;
    kvSubscribed = true;
    onKvChanges((changes) => {
        for (const change of changes) {
            const id = noteIdFromKvKey(change.key);
            if (!id) continue;
            const known = versions[id];
            if (known !== undefined && change.version <= known) continue; // stale/own echo
            if (change.value === null) {
                versions[id] = change.version;
                if (!dirty.has(id)) removeLocal(id);
                continue;
            }
            const remote = decodeNote(change.value);
            if (remote) absorbRemote(remote, change.version);
        }
    });
    // A tab being killed mid-debounce must not lose the last keystrokes.
    if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', flushAllPending);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushAllPending();
            else void useNotes.getState().refresh();
        });
    }
}

interface NotesState {
    notes: Record<string, NoteRecord>;
    /** true once a KV load attempt has completed (success or not) */
    loaded: boolean;
    /** Load the server-backed set + subscribe to live updates (idempotent). */
    initialize(): Promise<void>;
    /** Refetch the full prefix — covers socket gaps (throttled). */
    refresh(force?: boolean): Promise<void>;
    /** Create a note (optionally bound + pre-filled); returns its id, or null at the cap. */
    createNote(init?: { content?: string; boundTo?: NoteBinding | null }): string | null;
    /** Replace a note's content (clamped); bumps updatedAt and syncs. */
    updateContent(id: string, content: string): void;
    /** Re-bind (or unbind) a note. */
    updateBinding(id: string, boundTo: NoteBinding | null): void;
    /** B-118/119: patch title / tags / archived (empty title clears it). */
    updateMeta(id: string, patch: { title?: string | null; tags?: string[]; archived?: boolean }): void;
    /** Delete a note everywhere (tombstone on the server). */
    deleteNote(id: string): void;
}

export const useNotes = create<NotesState>((set, get) => ({
    notes: loadCache(),
    loaded: false,
    initialize: async () => {
        const creds = currentCreds();
        if (!creds) return;
        // A cache that outlived a logout must not leak into another account.
        const fp = accountFingerprint(creds.token);
        if (cachedAccount !== fp) {
            cachedAccount = fp;
            if (Object.keys(get().notes).length > 0) {
                set({ notes: {} });
                persistLocal({});
            }
        }
        subscribeToKvPushes();
        await get().refresh(true);
    },
    refresh: async (force = false) => {
        const creds = currentCreds();
        if (!creds) return;
        const now = Date.now();
        if (!force && now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return;
        lastRefreshAt = now;
        try {
            const items = await kvGetByPrefix(creds, NOTE_KV_PREFIX, LIST_LIMIT);
            const remoteIds = new Set<string>();
            for (const item of items) {
                const id = noteIdFromKvKey(item.key);
                if (!id) continue;
                remoteIds.add(id);
                const remote = decodeNote(item.value);
                if (remote) absorbRemote(remote, item.version);
            }
            // Locally known but absent from the server: either deleted on
            // another device (version known → drop) or never pushed (keep+push).
            const state = get().notes;
            const next = { ...state };
            let changed = false;
            for (const id of Object.keys(state)) {
                if (remoteIds.has(id)) continue;
                if (versions[id] !== undefined && !dirty.has(id)) {
                    delete next[id];
                    delete versions[id];
                    changed = true;
                } else {
                    schedulePush(id);
                }
            }
            if (changed) setNotesState(next);
            set({ loaded: true });
        } catch (e: any) {
            console.warn('[notes] KV load failed; using local cache', e?.message);
            set({ loaded: true });
        }
    },
    createNote: (init) => {
        const state = get().notes;
        if (Object.keys(state).length >= NOTES_MAX_COUNT) return null;
        const id = newNoteId();
        const now = Date.now();
        const note: NoteRecord = {
            id,
            content: (init?.content ?? '').slice(0, NOTE_CONTENT_MAX_CHARS),
            boundTo: init?.boundTo ?? null,
            createdAt: now,
            updatedAt: now,
        };
        setNotesState({ ...state, [id]: note });
        schedulePush(id);
        return id;
    },
    updateContent: (id, content) => {
        const state = get().notes;
        const note = state[id];
        if (!note) return;
        const clamped = content.slice(0, NOTE_CONTENT_MAX_CHARS);
        if (clamped === note.content) return;
        setNotesState({ ...state, [id]: { ...note, content: clamped, updatedAt: Date.now() } });
        schedulePush(id);
    },
    updateBinding: (id, boundTo) => {
        const state = get().notes;
        const note = state[id];
        if (!note) return;
        setNotesState({ ...state, [id]: { ...note, boundTo, updatedAt: Date.now() } });
        schedulePush(id);
    },
    updateMeta: (id, patch) => {
        const state = get().notes;
        const note = state[id];
        if (!note) return;
        const next = { ...note, updatedAt: Date.now() };
        if (patch.title !== undefined) {
            const clean = patch.title?.trim() ?? '';
            if (clean) next.title = clean.slice(0, NOTE_EXPLICIT_TITLE_MAX_CHARS);
            else delete next.title;
        }
        if (patch.tags !== undefined) {
            const tags = patch.tags
                .filter((x) => x.trim().length > 0)
                .map((x) => x.slice(0, NOTE_TAG_MAX_CHARS))
                .slice(0, NOTE_TAGS_MAX);
            if (tags.length > 0) next.tags = tags;
            else delete next.tags;
        }
        if (patch.archived !== undefined) {
            if (patch.archived) next.archived = true;
            else delete next.archived;
        }
        setNotesState({ ...state, [id]: next });
        schedulePush(id);
    },
    deleteNote: (id) => {
        removeLocal(id);
        schedulePush(id);
    },
}));
