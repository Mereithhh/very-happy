/**
 * editableDraftsStore — KV carrier + React store for editable drafts (B-642).
 * Pure rules (key, record, pending, diff, block) live in editableDrafts.ts.
 *
 * Same carrier as notesStore: ONE KV KEY PER DRAFT, per-key CAS version, LWW
 * by updatedAt on conflict (the 409 carries the winner), live updates via
 * `kv-batch-update` (kvUpdates.ts) and a throttled prefix refetch for socket
 * gaps. Only edited drafts are ever written. Loaded per session on demand.
 */

import { create } from 'zustand';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { isAuthLatched } from '@/auth/authLatch';
import { onKvChanges } from '@/sync/kvUpdates';
import {
    DRAFT_TEXT_MAX_CHARS,
    draftKvKey,
    draftSessionPrefix,
    isDraftPending,
    newDraftRecord,
    parseDraftKvKey,
    parseDraftRecord,
    pickDraftWinner,
    type DraftRecord,
} from '@/sync/editableDrafts';

const PUSH_DEBOUNCE_MS = 600;
const PUSH_MAX_ATTEMPTS = 4;
const REFRESH_MIN_INTERVAL_MS = 30_000;
const LIST_LIMIT = 1000;

/**
 * The I/O modules are loaded on first use, never at import time: Markdown
 * imports DraftBlock imports this store, and `@/auth/AuthContext` pulls in the
 * whole sync engine — statically that put `sync/sync` behind every Markdown
 * import (render tests went from ~7s to the 10s hook limit). Effects and user
 * edits are the only callers, so by then the app has these modules loaded.
 */
type Io = { getCurrentAuth: typeof import('@/auth/AuthContext').getCurrentAuth } & Pick<typeof import('@/sync/apiKv'), 'kvMutate' | 'kvGetByPrefix'>;
let io: Io | null = null;
let ioLoading: Promise<Io> | null = null;
function loadIo(): Promise<Io> {
    ioLoading ??= Promise.all([import('@/auth/AuthContext'), import('@/sync/apiKv')]).then(([auth, kv]) => {
        io = { getCurrentAuth: auth.getCurrentAuth, kvMutate: kv.kvMutate, kvGetByPrefix: kv.kvGetByPrefix };
        return io;
    });
    return ioLoading;
}

function currentCreds(): AuthCredentials | null {
    return io?.getCurrentAuth()?.credentials ?? null;
}

function toB64(json: string): string {
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
function fromB64(b64: string): string {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}
function decodeDraft(valueB64: string): DraftRecord | null {
    try {
        return parseDraftRecord(JSON.parse(fromB64(valueB64)));
    } catch {
        return null;
    }
}

/** kvKey → last known server version */
const versions: Record<string, number> = {};
const pushTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const lastRefreshAt: Record<string, number> = {};
let kvSubscribed = false;

interface DraftsState {
    /** kvKey → record */
    drafts: Record<string, DraftRecord>;
    /** sessions whose prefix has been loaded at least once */
    loaded: Record<string, true>;
    /**
     * B-722: save state of a draft the user edited on this device — saving
     * (debounce + in flight) → saved (shown briefly, then dropped) or failed.
     */
    saves: Record<string, DraftSaveState>;
}

export type DraftSaveState = 'saving' | 'saved' | 'failed';
/** How long 「已保存」 stays after a successful save. */
export const DRAFT_SAVED_VISIBLE_MS = 1600;

export const useEditableDrafts = create<DraftsState>(() => ({ drafts: {}, loaded: {}, saves: {} }));

const savedTimers: Record<string, ReturnType<typeof setTimeout>> = {};
function setSave(kvKey: string, state: DraftSaveState | null) {
    // Every keystroke reports 'saving' — don't publish a state that did not change.
    if (state === 'saving' && useEditableDrafts.getState().saves[kvKey] === 'saving') return;
    if (savedTimers[kvKey]) {
        clearTimeout(savedTimers[kvKey]);
        delete savedTimers[kvKey];
    }
    const saves = { ...useEditableDrafts.getState().saves };
    if (state) saves[kvKey] = state;
    else delete saves[kvKey];
    useEditableDrafts.setState({ saves });
    if (state === 'saved') savedTimers[kvKey] = setTimeout(() => setSave(kvKey, null), DRAFT_SAVED_VISIBLE_MS);
}
/** Only a save the user is watching (an edit on this device) reports its outcome. */
function settleSave(kvKey: string, state: 'saved' | 'failed') {
    if (useEditableDrafts.getState().saves[kvKey]) setSave(kvKey, state);
}

function putLocal(kvKey: string, rec: DraftRecord) {
    const state = useEditableDrafts.getState();
    useEditableDrafts.setState({ drafts: { ...state.drafts, [kvKey]: rec } });
}

function absorbRemote(kvKey: string, remote: DraftRecord, version: number) {
    const local = useEditableDrafts.getState().drafts[kvKey];
    versions[kvKey] = version;
    if (!local) {
        putLocal(kvKey, remote);
        return;
    }
    const winner = pickDraftWinner(local, remote);
    if (winner === remote) {
        if (pushTimers[kvKey]) {
            clearTimeout(pushTimers[kvKey]);
            delete pushTimers[kvKey];
        }
        putLocal(kvKey, remote);
        settleSave(kvKey, 'saved');
    } else if (local.updatedAt > remote.updatedAt) {
        schedulePush(kvKey); // our newer edit has not landed yet
    }
}

function schedulePush(kvKey: string) {
    if (!io) {
        void loadIo().then(() => schedulePush(kvKey));
        return;
    }
    if (!currentCreds() || isAuthLatched()) {
        settleSave(kvKey, 'failed');
        return;
    }
    if (pushTimers[kvKey]) clearTimeout(pushTimers[kvKey]);
    pushTimers[kvKey] = setTimeout(() => {
        delete pushTimers[kvKey];
        void pushNow(kvKey);
    }, PUSH_DEBOUNCE_MS);
}

async function pushNow(kvKey: string) {
    for (let attempt = 0; attempt < PUSH_MAX_ATTEMPTS; attempt++) {
        const creds = currentCreds();
        if (!io || !creds || isAuthLatched()) {
            settleSave(kvKey, 'failed');
            return;
        }
        const rec = useEditableDrafts.getState().drafts[kvKey];
        if (!rec) {
            setSave(kvKey, null);
            return;
        }
        try {
            const result = await io.kvMutate(creds, [
                { key: kvKey, value: toB64(JSON.stringify(rec)), version: versions[kvKey] ?? -1 },
            ]);
            if (result.success) {
                versions[kvKey] = result.results[0].version;
                settleSave(kvKey, 'saved');
                return;
            }
            const conflict = result.errors[0];
            versions[kvKey] = conflict.version;
            const remote = conflict.value ? decodeDraft(conflict.value) : null;
            if (remote && pickDraftWinner(rec, remote) === remote) {
                putLocal(kvKey, remote);
                settleSave(kvKey, 'saved');
                return;
            }
        } catch (e) {
            console.warn('[drafts] KV push failed', (e as Error)?.message);
            settleSave(kvKey, 'failed');
            return;
        }
    }
    settleSave(kvKey, 'failed');
}

/** B-722: retry a draft save that failed. */
export function retryDraftSave(kvKey: string): void {
    if (!useEditableDrafts.getState().drafts[kvKey]) return;
    setSave(kvKey, 'saving');
    schedulePush(kvKey);
}

function flushAllPending() {
    for (const kvKey of Object.keys(pushTimers)) {
        clearTimeout(pushTimers[kvKey]);
        delete pushTimers[kvKey];
        void pushNow(kvKey);
    }
}

function subscribe() {
    if (kvSubscribed) return;
    kvSubscribed = true;
    onKvChanges((changes) => {
        for (const change of changes) {
            const parsed = parseDraftKvKey(change.key);
            if (!parsed) continue;
            const known = versions[change.key];
            if (known !== undefined && change.version <= known) continue; // stale / own echo
            if (change.value === null) {
                versions[change.key] = change.version;
                continue;
            }
            const remote = decodeDraft(change.value);
            if (remote) absorbRemote(change.key, remote, change.version);
        }
    });
    if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', flushAllPending);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushAllPending();
            else for (const sessionId of Object.keys(useEditableDrafts.getState().loaded)) void refreshDrafts(sessionId);
        });
    }
}

/** Load (or refetch) one session's drafts. Throttled unless forced. */
export async function refreshDrafts(sessionId: string, force = false): Promise<void> {
    const { kvGetByPrefix } = await loadIo();
    const creds = currentCreds();
    if (!creds) return;
    subscribe();
    const now = Date.now();
    if (!force && now - (lastRefreshAt[sessionId] ?? 0) < REFRESH_MIN_INTERVAL_MS) return;
    lastRefreshAt[sessionId] = now;
    try {
        const items = await kvGetByPrefix(creds, draftSessionPrefix(sessionId), LIST_LIMIT);
        for (const item of items) {
            if (!parseDraftKvKey(item.key)) continue;
            const remote = decodeDraft(item.value);
            if (remote) absorbRemote(item.key, remote, item.version);
        }
        const state = useEditableDrafts.getState();
        if (!state.loaded[sessionId]) useEditableDrafts.setState({ loaded: { ...state.loaded, [sessionId]: true } });
    } catch (e) {
        lastRefreshAt[sessionId] = 0;
        console.warn('[drafts] KV load failed', (e as Error)?.message);
    }
}

/** Idempotent: first call per session loads it. */
export function ensureDraftsLoaded(sessionId: string): void {
    if (useEditableDrafts.getState().loaded[sessionId] || lastRefreshAt[sessionId]) return;
    void refreshDrafts(sessionId, true);
}

/** Record an edit of a fence (creates the record on the first edit). */
export function editDraft(input: { sessionId: string; key: string; original: string; title?: string; text: string }): void {
    const kvKey = draftKvKey(input.sessionId, input.key);
    const text = input.text.slice(0, DRAFT_TEXT_MAX_CHARS);
    const now = Date.now();
    const current = useEditableDrafts.getState().drafts[kvKey];
    if (!current) {
        if (text === input.original) return; // nothing edited — nothing stored
        putLocal(kvKey, newDraftRecord({ ...input, text, now }));
    } else {
        if (current.text === text) return;
        putLocal(kvKey, { ...current, text, updatedAt: Math.max(now, current.updatedAt + 1) });
    }
    setSave(kvKey, 'saving');
    schedulePush(kvKey);
}

/** Chip ✕: stop attaching this draft until its text changes again. */
export function dismissDraft(kvKey: string): void {
    const current = useEditableDrafts.getState().drafts[kvKey];
    if (!current) return;
    putLocal(kvKey, { ...current, skip: current.text, updatedAt: Math.max(Date.now(), current.updatedAt + 1) });
    schedulePush(kvKey);
}

/** After a send carried these drafts: the model has now seen exactly `text`. */
export function markDraftsAttached(attached: ReadonlyArray<{ kvKey: string; text: string }>): void {
    for (const { kvKey, text } of attached) {
        const current = useEditableDrafts.getState().drafts[kvKey];
        if (!current) continue;
        const next: DraftRecord = { ...current, base: text, updatedAt: Math.max(Date.now(), current.updatedAt + 1) };
        delete next.skip;
        putLocal(kvKey, next);
        schedulePush(kvKey);
    }
}

/** Pending drafts of one session, oldest message first. */
export function selectPendingDrafts(drafts: Record<string, DraftRecord>, sessionId: string): Array<{ kvKey: string; rec: DraftRecord }> {
    const out: Array<{ kvKey: string; rec: DraftRecord }> = [];
    for (const [kvKey, rec] of Object.entries(drafts)) {
        if (rec.sessionId === sessionId && isDraftPending(rec)) out.push({ kvKey, rec });
    }
    return out.sort((a, b) => Number(a.rec.key.split('.')[0]) - Number(b.rec.key.split('.')[0]) || a.kvKey.localeCompare(b.kvKey));
}

/** Test seam. */
export async function __loadIoForTests(): Promise<void> {
    await loadIo();
}

export function __resetEditableDraftsForTests(): void {
    for (const k of Object.keys(versions)) delete versions[k];
    for (const k of Object.keys(pushTimers)) {
        clearTimeout(pushTimers[k]);
        delete pushTimers[k];
    }
    for (const k of Object.keys(lastRefreshAt)) delete lastRefreshAt[k];
    for (const k of Object.keys(savedTimers)) {
        clearTimeout(savedTimers[k]);
        delete savedTimers[k];
    }
    useEditableDrafts.setState({ drafts: {}, loaded: {}, saves: {} });
}
