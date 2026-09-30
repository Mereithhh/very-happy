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
 *                     └──adopt(lost ack)──▶ landing
 *
 * Invariants (each has a test in pendingSessions.test.ts):
 *  - one spawn in flight per pendingId; a discarded record ignores its result;
 *  - the permission mode chosen on the pending page (not the spawn-time one)
 *    is written to the real id BEFORE any outbox send;
 *  - after a successful spawn the record never becomes `failed`;
 *  - outbox items are sent in order, each needs a receipt before the next;
 *  - the store never navigates. Only the pending page itself redirects, and
 *    only while it is still showing that pending id (see landingRedirect).
 */
import type { SpawnSessionOptions, SpawnSessionResult } from './ops';

export type PendingAgent = NonNullable<SpawnSessionOptions['agent']>;
export type PendingState = 'spawning' | 'needs-approval' | 'failed' | 'landing' | 'landed';
export type PendingFailure = 'spawn-error' | 'interrupted' | 'directory-declined';

export interface PendingOutboxItem {
    id: string;
    text: string;
}

export interface PendingSessionRecord {
    pendingId: string;
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
    state: PendingState;
    realId?: string;
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
    /** Delete every per-session key left under a pending id (draft, queue, mode). */
    clearKeys(pendingId: string): void;
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
const FAILED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

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

/**
 * Lost-ack adoption: the spawn RPC failed (timeout / relay dropped the reply)
 * but the daemon may still have created the session. The newest session on the
 * same machine + path + agent created after the pending record is offered.
 */
export function findAdoptableSession(
    record: PendingSessionRecord,
    sessions: Iterable<AdoptableSession>,
    normalizeAgent: (flavor: string | null | undefined) => string,
    claimed: ReadonlySet<string>,
): string | null {
    if (record.state !== 'failed' || record.failure === 'directory-declined') return null;
    let best: AdoptableSession | null = null;
    for (const session of sessions) {
        if (claimed.has(session.id)) continue;
        if (session.createdAt <= record.createdAt) continue;
        const meta = session.metadata;
        if (!meta || meta.machineId !== record.machineId || meta.path !== record.path) continue;
        if (normalizeAgent(meta.flavor) !== record.agent) continue;
        if (!best || session.createdAt > best.createdAt) best = session;
    }
    return best?.id ?? null;
}

function parseRecords(raw: unknown, now: number): PendingSessionRecord[] {
    if (!Array.isArray(raw)) return [];
    const out: PendingSessionRecord[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const r = item as PendingSessionRecord;
        if (!isPendingSessionId(r.pendingId) || typeof r.machineId !== 'string' || typeof r.path !== 'string') continue;
        if (typeof r.createdAt !== 'number' || typeof r.state !== 'string') continue;
        const outbox = Array.isArray(r.outbox)
            ? r.outbox.filter((o) => o && typeof o.id === 'string' && typeof o.text === 'string')
            : [];
        const record: PendingSessionRecord = { ...r, outbox };
        if (record.state === 'landed' && now - (record.landedAt ?? record.createdAt) > LANDED_KEEP_MS) continue;
        if (record.state === 'failed' && now - record.createdAt > FAILED_KEEP_MS) continue;
        out.push(record);
    }
    return out;
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
    const shownWaiters = new Map<string, Array<() => void>>();
    let viewing: string | null = null;
    let version = 0;

    const restored = new Set<string>();
    for (const record of parseRecords(deps.load(), deps.now())) {
        records.set(record.pendingId, record);
        restored.add(record.pendingId);
        if (record.realId) aliases.set(record.realId, record.pendingId);
    }

    function emit() {
        version++;
        deps.save([...records.values()]);
        for (const listener of [...listeners]) listener();
    }

    function patch(pendingId: string, changes: Partial<PendingSessionRecord>): PendingSessionRecord | undefined {
        const current = records.get(pendingId);
        if (!current) return undefined;
        const next = { ...current, ...changes };
        records = new Map(records).set(pendingId, next);
        emit();
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
        if (!record || record.state !== 'spawning') return;
        spawning.add(pendingId);
        try {
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
                result = { type: 'error', errorMessage: error instanceof Error ? error.message : String(error) };
            }
            const current = records.get(pendingId);
            // Discarded (or otherwise moved on) while the RPC was out: ignore.
            if (!current || current.state !== 'spawning') return;
            if (result.type === 'success') {
                land(pendingId, result.sessionId);
            } else if (result.type === 'requestToApproveDirectoryCreation') {
                patch(pendingId, { state: 'needs-approval', approvalDirectory: result.directory || current.path });
            } else {
                fail(pendingId, 'spawn-error', result.errorMessage);
            }
        } finally {
            spawning.delete(pendingId);
        }
    }

    /** spawn succeeded (or a lost-ack session was adopted): from here on, never fail. */
    function land(pendingId: string, realId: string) {
        const current = records.get(pendingId);
        if (!current) return;
        aliases.set(realId, pendingId);
        const next = patch(pendingId, {
            state: 'landing', realId, error: undefined, failure: undefined, approvalDirectory: undefined,
        })!;
        // The pending page's choice, written before anything can be sent.
        deps.writePermissionMode(realId, next.permissionMode);
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

    function landAsDraft(pendingId: string) {
        const current = records.get(pendingId);
        if (!current?.realId) return;
        const text = outboxText(current.outbox);
        patch(pendingId, { state: 'landed', outbox: [], deliveredAsDraft: text ? true : current.deliveredAsDraft, landedAt: deps.now() });
        // The pending composer (same React instance) becomes the real one, so
        // it is the first place to return the text to.
        if (text) deps.restoreText(current.realId, text, pendingId);
    }

    async function deliver(pendingId: string): Promise<void> {
        if (landing.has(pendingId)) return;
        const start = records.get(pendingId);
        if (!start?.realId || start.state !== 'landing') return;
        const realId = start.realId;
        landing.add(pendingId);
        try {
            if (!(await waitForSession(realId))) {
                landAsDraft(pendingId);
                return;
            }
            const ready = records.get(pendingId);
            if (!ready) return;
            // Latest choices (the user may have changed them while waiting).
            deps.writePermissionMode(realId, ready.permissionMode);
            if (ready.modelMode !== undefined) deps.writeModelMode(realId, ready.modelMode);
            if (ready.effortLevel !== undefined) deps.writeEffortLevel(realId, ready.effortLevel);
            for (;;) {
                const current = records.get(pendingId);
                if (!current) return;
                const head = current.outbox[0];
                if (!head) {
                    // Synchronous with the last check: nothing can slip in between.
                    patch(pendingId, { state: 'landed', landedAt: deps.now() });
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

    const store = {
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        version: () => version,
        get: (pendingId: string) => records.get(pendingId),
        list: () => [...records.values()],
        aliasOf: (realId: string) => aliases.get(realId),
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
            emit();
            void runSpawn(pendingId);
            return record;
        },

        /** Composer send while pending. False = not accepted (text stays in the composer). */
        append(pendingId: string, text: string): boolean {
            const current = records.get(pendingId);
            const value = text.trim();
            if (!current || !value) return false;
            if (current.state !== 'spawning' && current.state !== 'needs-approval' && current.state !== 'landing') return false;
            patch(pendingId, { outbox: [...current.outbox, { id: deps.newId(), text: value }] });
            return true;
        },
        removeOutboxItem(pendingId: string, itemId: string): void {
            const current = records.get(pendingId);
            if (!current || current.state === 'landed') return;
            patch(pendingId, { outbox: current.outbox.filter((item) => item.id !== itemId) });
        },

        setMode(pendingId: string, field: PendingModeField, value: string | null): void {
            const current = records.get(pendingId);
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
            const current = records.get(pendingId);
            if (current?.state !== 'needs-approval') return;
            patch(pendingId, { state: 'spawning', approvedNewDirectoryCreation: true, approvalDirectory: undefined });
            void runSpawn(pendingId);
        },
        declineDirectory(pendingId: string): void {
            if (records.get(pendingId)?.state !== 'needs-approval') return;
            fail(pendingId, 'directory-declined');
        },
        retry(pendingId: string): void {
            const current = records.get(pendingId);
            if (current?.state !== 'failed') return;
            patch(pendingId, {
                state: 'spawning', error: undefined, failure: undefined,
                approvedNewDirectoryCreation: current.failure === 'directory-declined' ? false : current.approvedNewDirectoryCreation,
            });
            void runSpawn(pendingId);
        },
        /** Lost ack: take over a session the daemon did create. */
        adopt(pendingId: string, sessionId: string): void {
            if (records.get(pendingId)?.state !== 'failed') return;
            land(pendingId, sessionId);
        },
        /** Drop a record that never landed (⌘W, sidebar ✕). A late spawn result is ignored. */
        discard(pendingId: string): boolean {
            const current = records.get(pendingId);
            if (!current || current.realId) return false;
            const next = new Map(records);
            next.delete(pendingId);
            records = next;
            emit();
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
                const list = shownWaiters.get(pendingId) ?? [];
                const timer = setTimeout(() => {
                    shownWaiters.set(pendingId, (shownWaiters.get(pendingId) ?? []).filter((w) => w !== done));
                    resolve();
                }, timeoutMs);
                const done = () => { clearTimeout(timer); resolve(); };
                list.push(done);
                shownWaiters.set(pendingId, list);
            });
        },

        /**
         * After a reload: a spawn that was in flight cannot be resumed (its
         * result is gone) → failed/interrupted with the text recoverable; a
         * landing record resumes delivery (success already happened).
         */
        resume(): void {
            const ids = [...restored];
            restored.clear();
            for (const id of ids) {
                const record = records.get(id);
                if (!record) continue;
                if (record.state === 'spawning' && !spawning.has(record.pendingId)) {
                    fail(record.pendingId, 'interrupted');
                } else if (record.state === 'landing') {
                    void deliver(record.pendingId);
                }
            }
        },
    };
    return store;
}

export type PendingSessionStore = ReturnType<typeof createPendingSessionStore>;
