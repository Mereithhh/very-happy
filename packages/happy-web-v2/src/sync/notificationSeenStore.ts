/**
 * notificationSeenStore — the SYNCED notification read state: one lastSeenAt
 * timestamp per target (session id / `t:<terminalId>`). Truth model, unread
 * rule and merge/prune semantics live in notificationSeen.ts (pure, tested);
 * this file is only the carrier.
 *
 * ## Carrier: the account KV store, key `vh.notif-seen.v1`
 *
 * Same shape and the same reasons as `vh.board-tasks.v1` (boardTasks.ts): a
 * base64 JSON blob with an optimistic version, plus an MMKV mirror as the
 * instant/offline cache. Chosen over the two alternatives:
 *
 *  - synced settings would be wrong: settings sync is FIELD-level LWW, so a
 *    whole-map field means two devices each clobber the other's reads (and
 *    CLAUDE.md rule 1 forbids the `.default()` that a new field wants);
 *  - a new server endpoint would be more code for less: KV already gives us
 *    per-key versioning AND returns the winning value inside the 409 body,
 *    which is exactly the read-merge-write primitive we need. Zero server
 *    change also means zero deploy-order coupling.
 *
 * Convergence: every write is `merge(local, remote)` by per-key max (never a
 * blind overwrite) behind a version CAS with bounded retries. Live updates
 * arrive on the socket (`kv-batch-update` → kvUpdates.ts); `refresh()` covers
 * socket gaps (tab wake-up).
 *
 * Degradation: no KV blob / fetch failure / not logged in ⇒ an empty map,
 * which the unread rule treats as "nothing known" and callers AND with the
 * legacy per-device state — i.e. exactly the pre-feature behavior.
 */

import { create } from 'zustand';
import { getCurrentAuth } from '@/auth/AuthContext';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { MMKV } from '@/storage/mmkv-web';
import { accountFingerprint } from '@/sync/accountFingerprint';
import { kvGet, kvMutate } from '@/sync/apiKv';
import { onKvChanges } from '@/sync/kvUpdates';
import {
    mergeSeenMaps,
    parseSeenMap,
    planSeenWrites,
    pruneSeenMap,
    pushSeenWithCas,
    seenMapsEqual,
    type SeenMap,
} from '@/sync/notificationSeen';

const mmkv = new MMKV({ id: 'notification-seen' });
const CACHE_KEY = 'seen-cache-v1';
export const SEEN_KV_KEY = 'vh.notif-seen.v1';

/** debounce for the KV push — a dwell + a heartbeat can land back to back */
const PUSH_DEBOUNCE_MS = 500;
/** CAS retries before we give up (local cache still holds the truth) */
const PUSH_MAX_ATTEMPTS = 4;
/** floor between refetches, so a flurry of wake-ups is one request */
const REFRESH_MIN_INTERVAL_MS = 30_000;

interface CacheBlob {
    /** fingerprint of the account that wrote this cache (cross-account guard) */
    account?: string | null;
    seen: Record<string, number>;
}

let cachedAccount: string | null | undefined;

/**
 * Credentials as seen by React (useSeenTracker pushes them in).
 *
 * We can't rely on `getCurrentAuth()` alone: AuthProvider publishes that global
 * from an EFFECT, and React runs child effects before parent ones — so on the
 * very first commit the layout's mount effect sees `null` and the initial KV
 * load would silently never happen. The tracker hook reads context (available
 * during render) and hands it over here, including the `null` on logout, so
 * this stays authoritative rather than a stale mirror.
 */
let activeCreds: AuthCredentials | null = null;
let credsAdopted = false;

export function setSeenCredentials(creds: AuthCredentials | null): void {
    activeCreds = creds;
    credsAdopted = true;
}

function currentCreds(): AuthCredentials | null {
    return credsAdopted ? activeCreds : (getCurrentAuth()?.credentials ?? null);
}

function loadCache(): SeenMap {
    try {
        const raw = mmkv.getString(CACHE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as CacheBlob;
        cachedAccount = parsed.account ?? null;
        return parseSeenMap(parsed.seen);
    } catch {
        return {};
    }
}

function persistLocal(seen: SeenMap) {
    try {
        const creds = currentCreds();
        const account = creds ? accountFingerprint(creds.token) : (cachedAccount ?? null);
        cachedAccount = account;
        mmkv.set(CACHE_KEY, JSON.stringify({ account, seen } satisfies CacheBlob));
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

function parseKvValue(valueB64: string): SeenMap {
    try {
        return parseSeenMap(JSON.parse(fromB64(valueB64)));
    } catch {
        return {};
    }
}

function encodeKvValue(seen: SeenMap): string {
    return toB64(JSON.stringify({ seen }));
}

/** last version we know for the blob; -1 = "does not exist yet" */
let kvVersion: number | undefined;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let lastRefreshAt = 0;
let kvSubscribed = false;

/** Adopt a remote map (merge, never overwrite) and mirror it locally. */
function absorbRemote(remote: SeenMap, version: number | undefined) {
    const merged = mergeSeenMaps(useNotificationSeen.getState().seen, remote);
    if (version !== undefined) kvVersion = version;
    persistLocal(merged);
    useNotificationSeen.setState({ seen: merged });
    return merged;
}

/**
 * Push the CURRENT map to KV (debounced). Conflict handling is the shared
 * read-merge-write CAS loop (pushSeenWithCas — pure and tested): the 409 body
 * carries the winning value, we merge it in and retry. A blind re-push would
 * drop the other device's reads.
 */
function scheduleKvPush() {
    const creds = currentCreds();
    if (!creds) return; // not logged in → local cache only
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
        pushTimer = null;
        const outcome = await pushSeenWithCas(
            {
                read: () => useNotificationSeen.getState().seen,
                version: () => kvVersion ?? -1,
                write: async (value, version) => {
                    const result = await kvMutate(creds, [
                        { key: SEEN_KV_KEY, value: encodeKvValue(value), version },
                    ]);
                    if (result.success) return { ok: true, version: result.results[0].version };
                    const conflict = result.errors[0];
                    return {
                        ok: false,
                        version: conflict.version,
                        remote: conflict.value ? parseKvValue(conflict.value) : {},
                    };
                },
                absorb: (remote, version) => absorbRemote(remote, version),
            },
            PUSH_MAX_ATTEMPTS,
        );
        if (outcome.status === 'written') kvVersion = outcome.version;
        else if (outcome.status === 'exhausted') {
            console.warn('[notificationSeen] KV push gave up after CAS retries');
        } else {
            // Transport failure — the local cache keeps the truth and the next
            // markSeen (or the next refresh) republishes.
            console.warn('[notificationSeen] KV push failed', (outcome.error as any)?.message);
        }
    }, PUSH_DEBOUNCE_MS);
}

/** Live cross-device updates: another device wrote the blob. */
function subscribeToKvPushes() {
    if (kvSubscribed) return;
    kvSubscribed = true;
    onKvChanges((changes) => {
        for (const change of changes) {
            if (change.key !== SEEN_KV_KEY) continue;
            // Our own echo lands here too; merge is idempotent so it's a no-op.
            absorbRemote(change.value ? parseKvValue(change.value) : {}, change.version);
        }
    });
}

interface NotificationSeenState {
    seen: SeenMap;
    /** true once a KV load attempt has completed (success or not) */
    loaded: boolean;
    /** Load the server-backed map + subscribe to live updates (idempotent). */
    initialize(): Promise<void>;
    /** Refetch the blob — covers socket gaps (throttled). */
    refresh(force?: boolean): Promise<void>;
    /** Stamp targets as seen at `at` (default now). Optimistic + pushes to KV. */
    markSeen(keys: readonly string[], at?: number): void;
}

export const useNotificationSeen = create<NotificationSeenState>((set, get) => ({
    seen: loadCache(),
    loaded: false,
    initialize: async () => {
        const creds = currentCreds();
        if (!creds) return;
        // Defense in depth (same as boardTasks): a cache that outlived a logout
        // must not merge a stranger's read state into THIS account's blob.
        const fp = accountFingerprint(creds.token);
        if (cachedAccount !== fp) {
            cachedAccount = fp;
            if (Object.keys(get().seen).length > 0) {
                set({ seen: {} });
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
            const item = await kvGet(creds, SEEN_KV_KEY);
            if (item) {
                const remote = parseKvValue(item.value);
                const merged = absorbRemote(remote, item.version);
                set({ loaded: true });
                // We knew something the server didn't (offline reads) — publish it.
                if (!seenMapsEqual(merged, remote)) scheduleKvPush();
            } else {
                // No blob yet (first device / fresh account): keep whatever the
                // local MMKV mirror had and seed the server with it. `null` also
                // covers a TOMBSTONED record (server kvGet hides value=null), so
                // version -1 may be a lie — the CAS loop absorbs the real version
                // on the first conflict and lands on the retry.
                kvVersion = -1;
                set({ loaded: true });
                if (Object.keys(get().seen).length > 0) scheduleKvPush();
            }
        } catch (e: any) {
            // Graceful degradation: local cache (possibly empty) stays in force.
            console.warn('[notificationSeen] KV load failed; using local cache', e?.message);
            set({ loaded: true });
        }
    },
    markSeen: (keys, at) => {
        if (keys.length === 0) return;
        const now = at ?? Date.now();
        const planned = planSeenWrites(get().seen, keys, now);
        if (!planned) return; // nothing moved forward → no write, no push
        const next = pruneSeenMap(planned, now);
        persistLocal(next);
        set({ seen: next });
        scheduleKvPush();
    },
}));

/** The synced map for render paths (unread computation). */
export function useSeenMap(): SeenMap {
    return useNotificationSeen((s) => s.seen);
}
