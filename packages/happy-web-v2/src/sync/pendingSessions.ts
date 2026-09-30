/**
 * B-516 — optimistic new-session open: the pending-session store.
 *
 * Clicking "new chat" creates a PENDING record and the UI navigates to
 * `/session/<pendingId>` at once; this store (plain module state, NOT tied to
 * any React tree, persisted to localStorage) then owns the spawn RPC, the
 * directory-approval round trip, and delivering whatever the user typed in the
 * meantime (the outbox) to the real session in order.
 *
 *   spawning ──success──▶ landing ──outbox flushed──▶ landed
 *      │  ▲                  (never fails: a session that does not show up,
 *      │  └─approve─┐         or a send without receipt, turns the remaining
 *      ├──dir?──▶ needs-approval   outbox into the real session's draft)
 *      └──error──▶ failed ──retry──▶ spawning
 *                     └──adopt(lost ack only)──▶ landing
 *
 * Invariants (each has a test in pendingSessions.test.ts):
 *  - one spawn in flight per pendingId; a discarded record ignores its result,
 *    and a session its in-flight spawn still created is killed (tombstone);
 *  - the permission mode chosen on the pending page (not the spawn-time one)
 *    is written to the real id BEFORE any outbox send — never onto an adopted
 *    session, which may not be ours;
 *  - after a successful spawn the record never becomes `failed`;
 *  - outbox items are sent in order, each needs a receipt before the next;
 *  - the store never navigates. Only the pending page itself redirects, and
 *    only while it is still showing that pending id (see landingRedirect).
 *
 * Multi-tab (B-516 review): every record has an OWNER tab. Only the owner runs
 * its spawn / delivery and accepts user actions on it; other tabs render it
 * read-only. A record whose owner tab is gone (reload, closed tab) is
 * reclaimed under a cross-tab lock, so exactly one tab resumes it. Saves are a
 * per-record read-modify-write merge, never a whole-table overwrite, and other
 * tabs' writes are picked up through `refresh()` (storage events).
 */
import type { SpawnSessionOptions, SpawnSessionResult } from './ops';

export type PendingAgent = NonNullable<SpawnSessionOptions['agent']>;
export type PendingState = 'spawning' | 'needs-approval' | 'failed' | 'landing' | 'landed';
/**
 * `lost-ack`: the RPC itself failed (timeout / relay) — the daemon may still
 * have created the session. `spawn-error`: the daemon answered with an error.
 */
export type PendingFailure = 'spawn-error' | 'lost-ack' | 'interrupted' | 'directory-declined';

export interface PendingOutboxItem {
    id: string;
    text: string;
}

export interface PendingSessionRecord {
    pendingId: string;
    /** The tab that runs this record (spawn, delivery, user actions). */
    ownerTab?: string;
    machineId: string;
    path: string;
    agent: PendingAgent;
    /** The permission mode the real session will get — last pending-page choice wins. */
    permissionMode: string | null;
    /** undefined = not chosen on the pending page (the agent default applies). */
    modelMode?: string | null;
    effortLevel?: string | null;
    /** Task Board dispatch: attach the new session to this task on success. */
    onSpawnedTask?: { taskId: string };
    source: string;
    createdAt: number;
    /** Client time the latest spawn RPC was sent (lost-ack adoption window). */
    spawnDispatchedAt?: number;
    state: PendingState;
    realId?: string;
    /** realId came from lost-ack adoption, not from our own spawn reply. */
    adopted?: boolean;
    outbox: PendingOutboxItem[];
    error?: string;
    failure?: PendingFailure;
    /** Directory the daemon asked to create (needs-approval). */
    approvalDirectory?: string;
    approvedNewDirectoryCreation?: boolean;
    /** landed via the draft fallback instead of real sends */
    deliveredAsDraft?: boolean;
    landedAt?: number;
}

export interface PendingSessionDeps {
    /** This page load's tab id (records it creates or reclaims are owned by it). */
    tabId: string;
    /** Is the tab that owns a record still open? */
    isOwnerAlive(ownerTab: string): Promise<boolean>;
    /** Run `fn` while holding a cross-tab exclusive lock (reclaiming orphans). */
    withClaimLock(fn: () => Promise<void>): Promise<void>;
    spawn(options: SpawnSessionOptions): Promise<SpawnSessionResult>;
    hasSession(id: string): boolean;
    /** Called on every session-store change; returns an unsubscribe. */
    subscribeSessions(listener: () => void): () => void;
    /** Resolves with a receipt (truthy) once the message is in the local outbox. */
    sendMessage(sessionId: string, text: string): Promise<unknown>;
    writePermissionMode(sessionId: string, mode: string | null): void;
    writeModelMode(sessionId: string, mode: string | null): void;
    writeEffortLevel(sessionId: string, level: string | null): void;
    /**
     * Hand text back to whoever edits `sessionId`: the composer mounted for
     * `composerId` (the pending page's composer, which becomes the real one),
     * else a composer mounted for `sessionId`, else `sessionId`'s draft.
     */
    restoreText(sessionId: string, text: string, composerId?: string): void;
    /**
     * A record landed. Unless the pending composer is still mounted (it carries
     * its text over itself), merge the pending id's draft into the real id's
     * and delete every key left under the pending id.
     */
    migrateDraft(pendingId: string, realId: string): void;
    /** Delete every per-session key left under a pending id (draft, queue, mode). */
    clearKeys(pendingId: string): void;
    /** A cancelled spawn still created this session — stop it (user intent). */
    killSession(sessionId: string): void;
    /** Success side effects: recent path, task-board attach, timing. */
    onSpawned(record: PendingSessionRecord, realId: string): void;
    /** A spawn failed while the user was NOT on its page. */
    notifyFailure(record: PendingSessionRecord): void;
    load(): unknown;
    save(records: PendingSessionRecord[]): void;
    now(): number;
    newId(): string;
    /** How long a spawned session may take to reach the store before the draft fallback. */
    sessionWaitMs: number;
}

export const PENDING_ID_PREFIX = 'pending-';
const LANDED_KEEP_MS = 24 * 60 * 60 * 1000;
const APPROVAL_KEEP_MS = 24 * 60 * 60 * 1000;
const FAILED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** A lost-ack session is created within seconds of the spawn RPC. */
export const ADOPT_WINDOW_MS = 90_000;
/** Tolerance for server (session.createdAt) vs client (dispatch) clock skew. */
export const ADOPT_SKEW_MS = 15_000;

export function isPendingSessionId(id: string | null | undefined): boolean {
    return typeof id === 'string' && id.startsWith(PENDING_ID_PREFIX);
}

/** Outbox texts joined the way they would read as one message. */
export function outboxText(outbox: readonly PendingOutboxItem[]): string {
    return outbox.map((item) => item.text).join('\n\n');
}

/**
 * Where the pending page must redirect. Only the page that is CURRENTLY showing
 * this pending id may move on to the real session — a user who left is never
 * pulled back (the store itself has no navigator at all).
 */
export function landingRedirect(routeId: string | undefined, record: PendingSessionRecord | undefined): string | null {
    if (!routeId || !record || routeId !== record.pendingId) return null;
    if (record.state !== 'landed' || !record.realId) return null;
    return record.realId;
}

/**
 * The composer's React key: stable from the pending id to ITS OWN real id, so
 * text typed while starting survives the switch; any other id change remounts.
 */
export function composerKey(effectiveId: string, aliasOf: (realId: string) => string | undefined): string {
    return aliasOf(effectiveId) ?? effectiveId;
}

interface AdoptableSession {
    id: string;
    createdAt: number;
    metadata?: { machineId?: string; path?: string; flavor?: string | null } | null;
}

function normalizePath(path: string | undefined): string {
    return (path ?? '').replace(/\/+$/, '') || '/';
}

/** Only failures where the daemon may have created the session despite no reply. */
export function mayHaveLostAck(record: PendingSessionRecord): boolean {
    return record.state === 'failed' && (record.failure === 'lost-ack' || record.failure === 'interrupted');
}

/**
 * Lost-ack adoption: the spawn RPC failed (timeout / relay dropped the reply)
 * but the daemon may still have created the session. Offered: the newest
 * session on the same machine + path + agent whose server createdAt falls in a
 * short window around the spawn dispatch (with clock-skew tolerance).
 */
export function findAdoptableSession(
    record: PendingSessionRecord,
    sessions: Iterable<AdoptableSession>,
    normalizeAgent: (flavor: string | null | undefined) => string,
    claimed: ReadonlySet<string>,
): string | null {
    if (!mayHaveLostAck(record) || record.spawnDispatchedAt === undefined) return null;
    const from = record.spawnDispatchedAt - ADOPT_SKEW_MS;
    const to = record.spawnDispatchedAt + ADOPT_WINDOW_MS + ADOPT_SKEW_MS;
    const path = normalizePath(record.path);
    let best: AdoptableSession | null = null;
    for (const session of sessions) {
        if (claimed.has(session.id)) continue;
        if (session.createdAt < from || session.createdAt > to) continue;
        const meta = session.metadata;
        if (!meta || meta.machineId !== record.machineId || normalizePath(meta.path) !== path) continue;
        if (normalizeAgent(meta.flavor) !== record.agent) continue;
        if (!best || session.createdAt > best.createdAt) best = session;
    }
    return best?.id ?? null;
}

function parseRecord(item: unknown): PendingSessionRecord | null {
    if (!item || typeof item !== 'object') return null;
    const r = item as PendingSessionRecord;
    if (!isPendingSessionId(r.pendingId) || typeof r.machineId !== 'string' || typeof r.path !== 'string') return null;
    if (typeof r.createdAt !== 'number' || typeof r.state !== 'string') return null;
    const outbox = Array.isArray(r.outbox)
        ? r.outbox.filter((o) => o && typeof o.id === 'string' && typeof o.text === 'string')
        : [];
    return { ...r, outbox };
}

function isExpired(record: PendingSessionRecord, now: number): boolean {
    if (record.state === 'landed') return now - (record.landedAt ?? record.createdAt) > LANDED_KEEP_MS;
    if (record.state === 'needs-approval') return now - record.createdAt > APPROVAL_KEEP_MS;
    if (record.state === 'failed') return now - record.createdAt > FAILED_KEEP_MS;
    return false;
}

function parseTable(raw: unknown): PendingSessionRecord[] {
    if (!Array.isArray(raw)) return [];
    return raw.map(parseRecord).filter((r): r is PendingSessionRecord => r !== null);
}

/**
 * Landing while the pending page is NOT mounted (review MAJOR 2): the pending
 * id's draft would otherwise never reach the real session and leak forever.
 * A mounted pending composer carries its own text over — leave it alone.
 */
export function migratePendingDraft(
    pendingId: string,
    realId: string,
    io: {
        hasComposer(id: string): boolean;
        readDraft(id: string): string;
        restoreToComposer(id: string, text: string): boolean;
        writeDraft(id: string, text: string): void;
        clearKeys(pendingId: string): void;
    },
): void {
    if (io.hasComposer(pendingId)) return;
    const text = io.readDraft(pendingId);
    if (text && !io.restoreToComposer(realId, text)) {
        const existing = io.readDraft(realId);
        io.writeDraft(realId, existing ? `${existing}\n${text}` : text);
    }
    io.clearKeys(pendingId);
}

export interface PendingCreateInput {
    machineId: string;
    path: string;
    agent: PendingAgent;
    permissionMode: string | null;
    source: string;
    firstMessage?: string;
    onSpawnedTask?: { taskId: string };
}

export type PendingModeField = 'permissionMode' | 'modelMode' | 'effortLevel';

export function createPendingSessionStore(deps: PendingSessionDeps) {
    let records = new Map<string, PendingSessionRecord>();
    const aliases = new Map<string, string>(); // realId → pendingId, for the tab's lifetime
    const listeners = new Set<() => void>();
    const spawning = new Set<string>();
    const landing = new Set<string>();
    /** discarded while their spawn was in flight — a late success is killed */
    const cancelled = new Set<string>();
    const shownWaiters = new Map<string, Array<() => void>>();
    let viewing: string | null = null;
    let version = 0;

    const mine = (record: PendingSessionRecord | undefined): boolean =>
        !!record && record.ownerTab === deps.tabId;

    function notify() {
        version++;
        for (const listener of [...listeners]) listener();
    }

    /** Per-record read-modify-write against the stored table. */
    function persist(changed: string[], removed: string[] = []) {
        const table = new Map(parseTable(deps.load()).map((r) => [r.pendingId, r]));
        for (const id of changed) {
            const record = records.get(id);
            if (record) table.set(id, record);
        }
        for (const id of removed) table.delete(id);
        deps.save([...table.values()]);
    }

    // Initial load: expired records are dropped (with whatever they left behind).
    {
        const now = deps.now();
        const expired: string[] = [];
        for (const record of parseTable(deps.load())) {
            if (isExpired(record, now)) { expired.push(record.pendingId); continue; }
            records.set(record.pendingId, record);
            if (record.realId) aliases.set(record.realId, record.pendingId);
        }
        if (expired.length > 0) {
            persist([], expired);
            for (const id of expired) deps.clearKeys(id);
        }
    }

    function patch(pendingId: string, changes: Partial<PendingSessionRecord>): PendingSessionRecord | undefined {
        const current = records.get(pendingId);
        if (!current) return undefined;
        const next = { ...current, ...changes };
        records = new Map(records).set(pendingId, next);
        persist([pendingId]);
        notify();
        return next;
    }

    function fail(pendingId: string, failure: PendingFailure, error?: string) {
        const current = records.get(pendingId);
        if (!current || current.realId) return; // never after success
        const text = outboxText(current.outbox);
        const next = patch(pendingId, { state: 'failed', failure, error, outbox: [] });
        if (text) deps.restoreText(pendingId, text);
        // Interrupted = found after a reload; the sidebar row says so, no toast.
        if (next && failure !== 'interrupted' && viewing !== pendingId) deps.notifyFailure(next);
    }

    async function runSpawn(pendingId: string): Promise<void> {
        if (spawning.has(pendingId)) return;
        const record = records.get(pendingId);
        if (!record || !mine(record) || record.state !== 'spawning') return;
        spawning.add(pendingId);
        try {
            patch(pendingId, { spawnDispatchedAt: deps.now() });
            let result: SpawnSessionResult;
            try {
                result = await deps.spawn({
                    machineId: record.machineId,
                    directory: record.path,
                    agent: record.agent,
                    permissionMode: record.permissionMode ?? undefined,
                    approvedNewDirectoryCreation: record.approvedNewDirectoryCreation === true,
                });
            } catch (error) {
                result = { type: 'error', errorMessage: error instanceof Error ? error.message : String(error), transport: true };
            }
            const current = records.get(pendingId);
            if (!current) {
                // Discarded while the RPC was out. A session it created anyway
                // is not wanted: stop it instead of leaving an orphan.
                if (cancelled.delete(pendingId) && result.type === 'success') deps.killSession(result.sessionId);
                return;
            }
            if (current.state !== 'spawning' || !mine(current)) return;
            if (result.type === 'success') {
                land(pendingId, result.sessionId, false);
            } else if (result.type === 'requestToApproveDirectoryCreation') {
                patch(pendingId, { state: 'needs-approval', approvalDirectory: result.directory || current.path });
            } else {
                fail(pendingId, result.transport ? 'lost-ack' : 'spawn-error', result.errorMessage);
            }
        } finally {
            spawning.delete(pendingId);
        }
    }

    /** spawn succeeded (or a lost-ack session was adopted): from here on, never fail. */
    function land(pendingId: string, realId: string, adopted: boolean) {
        const current = records.get(pendingId);
        if (!current) return;
        aliases.set(realId, pendingId);
        const next = patch(pendingId, {
            state: 'landing', realId, adopted, error: undefined, failure: undefined, approvalDirectory: undefined,
        })!;
        // The pending page's choice, written before anything can be sent. An
        // adopted session may be one the user started elsewhere: keep its mode.
        if (!adopted) deps.writePermissionMode(realId, next.permissionMode);
        try { deps.onSpawned(next, realId); } catch (error) { console.warn('[pending-session] onSpawned failed', error); }
        void deliver(pendingId);
    }

    function waitForSession(realId: string): Promise<boolean> {
        if (deps.hasSession(realId)) return Promise.resolve(true);
        return new Promise((resolve) => {
            let done = false;
            const finish = (value: boolean) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                unsubscribe();
                resolve(value);
            };
            const unsubscribe = deps.subscribeSessions(() => {
                if (deps.hasSession(realId)) finish(true);
            });
            const timer = setTimeout(() => finish(deps.hasSession(realId)), deps.sessionWaitMs);
        });
    }

    function markLanded(pendingId: string, changes: Partial<PendingSessionRecord> = {}) {
        const next = patch(pendingId, { state: 'landed', landedAt: deps.now(), ...changes });
        if (next?.realId) deps.migrateDraft(pendingId, next.realId);
    }

    function landAsDraft(pendingId: string) {
        const current = records.get(pendingId);
        if (!current?.realId) return;
        const text = outboxText(current.outbox);
        // The pending composer (same React instance) becomes the real one, so
        // it is the first place to return the text to.
        if (text) deps.restoreText(current.realId, text, pendingId);
        markLanded(pendingId, { outbox: [], deliveredAsDraft: text ? true : current.deliveredAsDraft });
    }

    async function deliver(pendingId: string): Promise<void> {
        if (landing.has(pendingId)) return;
        const start = records.get(pendingId);
        if (!start || !mine(start) || !start.realId || start.state !== 'landing') return;
        const realId = start.realId;
        landing.add(pendingId);
        try {
            if (!(await waitForSession(realId))) {
                landAsDraft(pendingId);
                return;
            }
            const ready = records.get(pendingId);
            if (!ready) return;
            if (!ready.adopted) {
                // Latest choices (the user may have changed them while waiting).
                deps.writePermissionMode(realId, ready.permissionMode);
                if (ready.modelMode !== undefined) deps.writeModelMode(realId, ready.modelMode);
                if (ready.effortLevel !== undefined) deps.writeEffortLevel(realId, ready.effortLevel);
            }
            for (;;) {
                const current = records.get(pendingId);
                if (!current || !mine(current)) return;
                const head = current.outbox[0];
                if (!head) {
                    // Synchronous with the last check: nothing can slip in between.
                    markLanded(pendingId);
                    return;
                }
                let receipt: unknown;
                try {
                    receipt = await deps.sendMessage(realId, head.text);
                } catch (error) {
                    console.warn('[pending-session] outbox send failed', error);
                    receipt = undefined;
                }
                if (!receipt) {
                    landAsDraft(pendingId);
                    return;
                }
                const after = records.get(pendingId);
                if (after) patch(pendingId, { outbox: after.outbox.filter((item) => item.id !== head.id) });
            }
        } finally {
            landing.delete(pendingId);
        }
    }

    /** Take in other tabs' writes. Our own records stay authoritative in memory. */
    function refresh(): void {
        const stored = parseTable(deps.load());
        const next = new Map<string, PendingSessionRecord>();
        for (const record of stored) {
            const local = records.get(record.pendingId);
            next.set(record.pendingId, local && mine(local) && record.ownerTab === deps.tabId ? local : record);
        }
        for (const [id, local] of records) {
            if (!next.has(id) && mine(local)) next.set(id, local);
        }
        records = next;
        for (const record of records.values()) if (record.realId) aliases.set(record.realId, record.pendingId);
        notify();
    }

    let reclaiming: Promise<void> | null = null;
    /**
     * Resume records whose owner tab is gone (this tab's own previous load
     * included): an interrupted spawn becomes failed/interrupted (its result is
     * lost; never re-spawned on its own), a landing record resumes delivery.
     * Serialized across tabs so exactly one tab takes each orphan.
     */
    function reclaim(): Promise<void> {
        if (reclaiming) return reclaiming;
        const foreign = [...records.values()].some((r) => !mine(r) && r.state !== 'landed');
        if (!foreign) return Promise.resolve();
        reclaiming = deps.withClaimLock(async () => {
            refresh(); // fresh view inside the lock: another tab may have just claimed
            for (const record of [...records.values()]) {
                if (mine(record) || record.state === 'landed') continue;
                if (record.ownerTab && await deps.isOwnerAlive(record.ownerTab)) continue;
                const current = records.get(record.pendingId);
                if (!current || mine(current)) continue;
                patch(record.pendingId, { ownerTab: deps.tabId });
                if (current.state === 'spawning') fail(record.pendingId, 'interrupted');
                else if (current.state === 'landing') void deliver(record.pendingId);
            }
        }).finally(() => { reclaiming = null; });
        return reclaiming;
    }

    /** User action on a record: only its owner tab may change it. */
    function owned(pendingId: string): PendingSessionRecord | undefined {
        const record = records.get(pendingId);
        return record && mine(record) ? record : undefined;
    }

    const store = {
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        version: () => version,
        get: (pendingId: string) => records.get(pendingId),
        list: () => [...records.values()],
        aliasOf: (realId: string) => aliases.get(realId),
        isOwnedHere: (pendingId: string) => mine(records.get(pendingId)),
        /** The record a `/session/:id` route belongs to (pending id or its real id). */
        forRoute(routeId: string | undefined): PendingSessionRecord | undefined {
            if (!routeId) return undefined;
            return records.get(routeId) ?? records.get(aliases.get(routeId) ?? '');
        },

        create(input: PendingCreateInput): PendingSessionRecord {
            const pendingId = `${PENDING_ID_PREFIX}${deps.newId()}`;
            const first = input.firstMessage?.trim();
            const record: PendingSessionRecord = {
                pendingId,
                ownerTab: deps.tabId,
                machineId: input.machineId,
                path: input.path,
                agent: input.agent,
                permissionMode: input.permissionMode,
                source: input.source,
                createdAt: deps.now(),
                state: 'spawning',
                outbox: first ? [{ id: deps.newId(), text: first }] : [],
                ...(input.onSpawnedTask ? { onSpawnedTask: input.onSpawnedTask } : {}),
            };
            records = new Map(records).set(pendingId, record);
            persist([pendingId]);
            notify();
            void runSpawn(pendingId);
            return record;
        },

        /** Composer send while pending. False = not accepted (text stays in the composer). */
        append(pendingId: string, text: string): boolean {
            const current = owned(pendingId);
            const value = text.trim();
            if (!current || !value) return false;
            if (current.state !== 'spawning' && current.state !== 'needs-approval' && current.state !== 'landing') return false;
            patch(pendingId, { outbox: [...current.outbox, { id: deps.newId(), text: value }] });
            return true;
        },
        removeOutboxItem(pendingId: string, itemId: string): void {
            const current = owned(pendingId);
            if (!current || current.state === 'landed') return;
            patch(pendingId, { outbox: current.outbox.filter((item) => item.id !== itemId) });
        },

        setMode(pendingId: string, field: PendingModeField, value: string | null): void {
            const current = owned(pendingId);
            if (!current) return;
            patch(pendingId, { [field]: value } as Partial<PendingSessionRecord>);
            if (!current.realId) return;
            if (field === 'permissionMode') deps.writePermissionMode(current.realId, value);
            else if (deps.hasSession(current.realId)) {
                if (field === 'modelMode') deps.writeModelMode(current.realId, value);
                else deps.writeEffortLevel(current.realId, value);
            }
        },

        approveDirectory(pendingId: string): void {
            if (owned(pendingId)?.state !== 'needs-approval') return;
            patch(pendingId, { state: 'spawning', approvedNewDirectoryCreation: true, approvalDirectory: undefined });
            void runSpawn(pendingId);
        },
        declineDirectory(pendingId: string): void {
            if (owned(pendingId)?.state !== 'needs-approval') return;
            fail(pendingId, 'directory-declined');
        },
        retry(pendingId: string): void {
            const current = owned(pendingId);
            if (current?.state !== 'failed') return;
            patch(pendingId, {
                state: 'spawning', error: undefined, failure: undefined,
                approvedNewDirectoryCreation: current.failure === 'directory-declined' ? false : current.approvedNewDirectoryCreation,
            });
            void runSpawn(pendingId);
        },
        /** Lost ack: take over a session the daemon did create. */
        adopt(pendingId: string, sessionId: string): void {
            const current = owned(pendingId);
            if (!current || !mayHaveLostAck(current)) return;
            land(pendingId, sessionId, true);
        },
        /** Drop a record that never landed (⌘W, sidebar ✕). A late spawn success is killed. */
        discard(pendingId: string): boolean {
            const current = owned(pendingId);
            if (!current || current.realId) return false;
            if (spawning.has(pendingId)) cancelled.add(pendingId);
            const next = new Map(records);
            next.delete(pendingId);
            records = next;
            persist([], [pendingId]);
            notify();
            deps.clearKeys(pendingId);
            return true;
        },

        setViewing(pendingId: string | null): void {
            viewing = pendingId;
        },
        /** The pending page rendered. Releases whoever waits on it (global new-chat lock). */
        markShown(pendingId: string): void {
            const waiters = shownWaiters.get(pendingId);
            shownWaiters.delete(pendingId);
            waiters?.forEach((resolve) => resolve());
        },
        waitShown(pendingId: string, timeoutMs: number): Promise<void> {
            return new Promise((resolve) => {
                const done = () => { clearTimeout(timer); resolve(); };
                const timer = setTimeout(() => {
                    const rest = (shownWaiters.get(pendingId) ?? []).filter((w) => w !== done);
                    if (rest.length > 0) shownWaiters.set(pendingId, rest);
                    else shownWaiters.delete(pendingId);
                    resolve();
                }, timeoutMs);
                shownWaiters.set(pendingId, [...(shownWaiters.get(pendingId) ?? []), done]);
            });
        },
        /** @internal test hook */
        waiterCount: () => shownWaiters.size,

        refresh,
        /** After a reload / periodically: take over records whose owner tab is gone. */
        resume: reclaim,
    };
    return store;
}

export type PendingSessionStore = ReturnType<typeof createPendingSessionStore>;
