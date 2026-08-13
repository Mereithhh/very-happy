/**
 * notificationSeen — PURE logic for the CROSS-DEVICE notification read model.
 * No stores, no MMKV, no DOM, no network (notificationSeen.test.ts covers all
 * of it). The store half lives in notificationSeenStore.ts.
 *
 * ## Truth model
 *
 * The synced read truth is NOT a per-entry flag — it's one timestamp per
 * TARGET: `lastSeenAt[key]`, where `key` is the board/inbox target key
 * (a session id, or `t:<terminalId>` for terminals — same key space as
 * notificationInbox's InboxEntry.key).
 *
 *     entry is unread  ⟺  entry.createdAt > lastSeenAt[entry.key]
 *
 * Opening a session/terminal writes `lastSeenAt[key] = now`, which retires
 * EVERY notification for that target that predates the visit — on every
 * device, because the map is synced (account KV, see the store).
 *
 * Why a timestamp map and not a set of read ids:
 *  - it is O(#targets), not O(#notifications), so it stays small enough to
 *    ship in one KV blob;
 *  - the merge is `max` per key, which is commutative, associative and
 *    idempotent — two devices writing concurrently converge to the same map
 *    regardless of order or of how many times an update is replayed. That is
 *    what makes an integrated last-writer-wins carrier safe (we still do
 *    read-merge-write with a version CAS, but the merge, not the ordering, is
 *    what guarantees convergence).
 *
 * ## Degradation
 *
 * An ABSENT key means "nothing known" — never "read". Callers AND the legacy
 * per-device state (notificationReadState watermark + id overlay,
 * localNotificationStore read flags): an empty map therefore reproduces the
 * pre-feature behavior exactly, which is what old clients / first run / a KV
 * fetch failure all fall back to.
 */

/** target key (session id | `t:<terminalId>`) → last-seen wall clock ms */
export type SeenMap = Readonly<Record<string, number>>;

/**
 * Age cutoff for pruning. MUST stay strictly greater than the largest
 * notification retention window (localNotificationStore's
 * RETENTION_DAY_OPTIONS max = 30 days) — that is what makes pruning unable to
 * resurrect anything: a key we drop was last seen ≥45 days ago, so any entry
 * still inside the retention window is NEWER than the dropped timestamp and
 * was already unread by the rule above. See the test
 * "pruning an aged-out key cannot resurrect a visible entry".
 */
export const SEEN_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;

/**
 * Hard cap on tracked targets (newest lastSeenAt kept). Only reachable with
 * >800 distinct sessions/terminals touched inside the age window; evicting the
 * oldest of those CAN make a still-visible old entry read→unread again (the one
 * documented hole — bounded, cosmetic, and it self-heals on the next visit).
 */
export const SEEN_MAX_KEYS = 800;

/** Tolerant parse of a decoded KV/MMKV blob — junk keys/values are dropped. */
export function parseSeenMap(input: unknown): SeenMap {
    if (!input || typeof input !== 'object') return {};
    const src = (input as { seen?: unknown }).seen ?? input;
    if (!src || typeof src !== 'object' || Array.isArray(src)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(src as Record<string, unknown>)) {
        if (!key) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
        out[key] = value;
    }
    return out;
}

/**
 * Merge two seen maps by taking the LATER timestamp per key (union of keys).
 * Commutative / associative / idempotent — the whole convergence argument.
 */
export function mergeSeenMaps(a: SeenMap, b: SeenMap): SeenMap {
    const out: Record<string, number> = { ...a };
    for (const [key, at] of Object.entries(b)) {
        const cur = out[key];
        if (cur === undefined || at > cur) out[key] = at;
    }
    return out;
}

/** Same keys, same timestamps? (used to decide whether a push is needed) */
export function seenMapsEqual(a: SeenMap, b: SeenMap): boolean {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    for (const key of aKeys) if (a[key] !== b[key]) return false;
    return true;
}

/** Has this target been seen at or after `at`? (absent key ⇒ false) */
export function isSeenAt(seen: SeenMap, key: string, at: number): boolean {
    const last = seen[key];
    return last !== undefined && last >= at;
}

/**
 * The unread verdict for one entry. `true` = still unread.
 * Callers AND this with the legacy per-device flag, so an empty map is a no-op.
 */
export function isUnreadBySeen(entry: { key: string; createdAt: number }, seen: SeenMap): boolean {
    return !isSeenAt(seen, entry.key, entry.createdAt);
}

/**
 * The FULL unread verdict for one inbox entry: the per-device legacy flag
 * (feed watermark + read-id overlay, or a local entry's own `read`) ANDed with
 * the synced per-target rule. Either side can retire an entry; neither side can
 * resurrect what the other retired.
 *
 * The AND is the degradation contract: an empty/unavailable seen map leaves
 * `legacyUnread` untouched (pre-feature behavior), and a device that has never
 * seen the legacy flags still honors the synced timestamps.
 */
export function isEntryUnread(
    legacyUnread: boolean,
    entry: { key: string; createdAt: number },
    seen: SeenMap,
): boolean {
    return legacyUnread && isUnreadBySeen(entry, seen);
}

/**
 * Drop stale/overflowing keys. Age first (safe by construction, see
 * SEEN_MAX_AGE_MS), then the cap keeping the most recently seen targets.
 */
export function pruneSeenMap(
    seen: SeenMap,
    now: number,
    maxAgeMs: number = SEEN_MAX_AGE_MS,
    maxKeys: number = SEEN_MAX_KEYS,
): SeenMap {
    const horizon = now - maxAgeMs;
    let entries = Object.entries(seen).filter(([, at]) => at > horizon);
    if (entries.length > maxKeys) {
        // newest first, id as a deterministic tiebreak, then keep the head
        entries.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
        entries = entries.slice(0, maxKeys);
    }
    const out: Record<string, number> = {};
    for (const [key, at] of entries) out[key] = at;
    return out;
}

/**
 * Monotonic write plan: returns the map with `keys` stamped at `at`, or `null`
 * when nothing would actually move forward (so callers can skip a KV push).
 * Never moves a timestamp backwards — a device with a lagging clock, or a
 * replayed "mark seen", can't un-read anything.
 */
export function planSeenWrites(seen: SeenMap, keys: readonly string[], at: number): SeenMap | null {
    let next: Record<string, number> | null = null;
    for (const key of keys) {
        if (!key) continue;
        const cur = seen[key];
        if (cur !== undefined && cur >= at) continue;
        if (!next) next = { ...seen };
        next[key] = at;
    }
    return next;
}

/**
 * Route → target key. `/session/<id>` → `<id>`; `/terminal/<machineId>?tid=<t>`
 * → `t:<t>` (one terminal screen hosts many tabs, so the machine alone is not a
 * target). Anything else has no notification target.
 */
export function targetKeyOfPath(pathname: string, search: string = ''): string | null {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    if (parts[0] === 'session') {
        try {
            return decodeURIComponent(parts[1]) || null;
        } catch {
            return parts[1] || null;
        }
    }
    if (parts[0] === 'terminal') {
        const tid = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('tid');
        return tid ? `t:${tid}` : null;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Read-merge-write with a version CAS (carrier-agnostic, hence testable here)
// ---------------------------------------------------------------------------

export type CasWriteResult =
    | { ok: true; version: number }
    /** someone else wrote first — their value + version */
    | { ok: false; version: number; remote: SeenMap };

export interface CasPushDeps {
    /** the map to publish, re-read on every attempt (absorb may change it) */
    read(): SeenMap;
    /** the version we believe the blob is at, re-read on every attempt */
    version(): number;
    /** attempt the write; may throw for transport failures */
    write(value: SeenMap, version: number): Promise<CasWriteResult>;
    /** fold a remote map into local state and adopt its version */
    absorb(remote: SeenMap, version: number): void;
}

export type CasPushOutcome =
    | { status: 'written'; version: number }
    | { status: 'exhausted' }
    | { status: 'error'; error: unknown };

/**
 * Publish the local map under a version CAS, merging the winner's value in on
 * every conflict instead of overwriting it. This is what makes an
 * integrated-LWW blob behave like a per-key max CRDT: the loser of a race
 * ADOPTS the winner (absorb → merge by max) and retries, so no device can ever
 * erase another device's reads.
 *
 * `error` (transport) is not retried here — apiKv already backs off on network
 * failures, and the local cache stays authoritative until the next write.
 */
export async function pushSeenWithCas(
    deps: CasPushDeps,
    maxAttempts: number,
): Promise<CasPushOutcome> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let result: CasWriteResult;
        try {
            result = await deps.write(deps.read(), deps.version());
        } catch (error) {
            return { status: 'error', error };
        }
        if (result.ok) return { status: 'written', version: result.version };
        deps.absorb(result.remote, result.version);
    }
    return { status: 'exhausted' };
}

/**
 * Does a live system notification belong to `key`? Foreground notifications
 * (webNotifications.ts) are tagged with the session id; Web Push ones
 * (public/push-sw.js) carry only `data.url` — an app path like `/session/<id>`
 * or `/terminal/<machineId>?tid=<id>`. Match either.
 */
export function systemNotificationMatchesKey(
    notif: { tag?: string; data?: unknown },
    key: string,
): boolean {
    if (notif.tag && notif.tag === key) return true;
    const url = (notif.data as { url?: unknown } | null | undefined)?.url;
    if (typeof url !== 'string' || url.length === 0) return false;
    const [path, query = ''] = url.split('?');
    return targetKeyOfPath(path, query) === key;
}
