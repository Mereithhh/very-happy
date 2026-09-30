import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    composerKey,
    createPendingSessionStore,
    findAdoptableSession,
    migratePendingDraft,
    ADOPT_SKEW_MS,
    ADOPT_WINDOW_MS,
    landingRedirect,
    type PendingSessionDeps,
    type PendingSessionRecord,
} from './pendingSessions';
import type { SpawnSessionResult } from './ops';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

interface Backing { table: unknown; lock: Promise<void> }

function harness(opts: { saved?: unknown; backing?: Backing; tabId?: string; alive?: Set<string> } = {}) {
    const backing: Backing = opts.backing ?? { table: opts.saved ?? [], lock: Promise.resolve() };
    const alive = opts.alive ?? new Set<string>();
    const sessions = new Set<string>();
    const sessionListeners = new Set<() => void>();
    const spawns: Array<{ options: Parameters<PendingSessionDeps['spawn']>[0]; result: ReturnType<typeof deferred<SpawnSessionResult>> }> = [];
    const events: string[] = [];
    let seq = 0;
    const tabId = opts.tabId ?? 'tab-a';
    alive.add(tabId);
    const deps: PendingSessionDeps = {
        tabId,
        isOwnerAlive: async (owner) => alive.has(owner),
        withClaimLock: (fn) => { const run = backing.lock.then(fn); backing.lock = run.catch(() => {}); return run; },
        spawn: vi.fn((options) => {
            const result = deferred<SpawnSessionResult>();
            spawns.push({ options, result });
            return result.promise;
        }),
        hasSession: (id) => sessions.has(id),
        subscribeSessions: (listener) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; },
        sendMessage: vi.fn(async (id: string, text: string) => { events.push(`send:${id}:${text}`); return `receipt-${text}`; }),
        writePermissionMode: vi.fn((id: string, mode: string | null) => { events.push(`perm:${id}:${mode}`); }),
        writeModelMode: vi.fn((id: string, mode: string | null) => { events.push(`model:${id}:${mode}`); }),
        writeEffortLevel: vi.fn((id: string, level: string | null) => { events.push(`effort:${id}:${level}`); }),
        restoreText: vi.fn(),
        migrateDraft: vi.fn(),
        clearKeys: vi.fn(),
        killSession: vi.fn(),
        onSpawned: vi.fn(),
        notifyFailure: vi.fn(),
        load: () => structuredClone(backing.table),
        save: (records) => { backing.table = structuredClone(records); },
        now: () => 1_000 + seq,
        newId: () => `${tabId}-id${++seq}`,
        sessionWaitMs: 5_000,
    };
    const store = createPendingSessionStore(deps);
    const addSession = (id: string) => { sessions.add(id); sessionListeners.forEach((l) => l()); };
    const states: string[] = [];
    store.subscribe(() => { for (const r of store.list()) states.push(`${r.pendingId}:${r.state}`); });
    return { store, deps, spawns, events, addSession, states, backing, alive, persisted: () => backing.table as PendingSessionRecord[] };
}

const input = { machineId: 'm1', path: '/repo', agent: 'claude' as const, permissionMode: 'default', source: 'quick' };

describe('pending session store (B-516)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('spawns once, applies the pending-page permission before any send, and flushes the outbox in order', async () => {
        const h = harness();
        const record = h.store.create({ ...input, firstMessage: '  first  ' });
        expect(h.spawns).toHaveLength(1);
        expect(h.spawns[0].options).toMatchObject({ machineId: 'm1', directory: '/repo', agent: 'claude', permissionMode: 'default', approvedNewDirectoryCreation: false });
        // typed + changed mode while starting
        expect(h.store.append(record.pendingId, 'second')).toBe(true);
        h.store.setMode(record.pendingId, 'permissionMode', 'bypassPermissions');
        h.store.setMode(record.pendingId, 'modelMode', 'opus');
        h.spawns[0].result.resolve({ type: 'success', sessionId: 'real1' });
        await flush();
        expect(h.store.get(record.pendingId)).toMatchObject({ state: 'landing', realId: 'real1' });
        expect(h.store.aliasOf('real1')).toBe(record.pendingId);
        expect(h.deps.onSpawned).toHaveBeenCalledTimes(1);
        expect(h.deps.sendMessage).not.toHaveBeenCalled(); // session not in the store yet
        // persisted for the real id right away (applySessions attaches it on arrival)
        expect(h.events).toEqual(['perm:real1:bypassPermissions']);
        h.addSession('real1');
        await flush();
        expect(h.store.get(record.pendingId)).toMatchObject({ state: 'landed', outbox: [] });
        // the pending draft follows the session (merged unless its composer is still mounted)
        expect(h.deps.migrateDraft).toHaveBeenCalledWith(record.pendingId, 'real1');
        const firstSend = h.events.indexOf('send:real1:first');
        expect(h.events.indexOf('perm:real1:bypassPermissions')).toBeGreaterThanOrEqual(0);
        expect(h.events.indexOf('perm:real1:bypassPermissions')).toBeLessThan(firstSend);
        expect(h.events.indexOf('model:real1:opus')).toBeLessThan(firstSend);
        expect(h.events.filter((e) => e.startsWith('send:'))).toEqual(['send:real1:first', 'send:real1:second']);
        expect(h.events).not.toContain('perm:real1:default');
    });

    it('waits for each receipt before the next send; a message typed while landing still goes before the switch', async () => {
        const h = harness();
        const record = h.store.create({ ...input, firstMessage: 'a' });
        const gate = deferred<unknown>();
        (h.deps.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(async (id: string, text: string) => { h.events.push(`send:${id}:${text}`); return gate.promise; });
        h.addSession('real1');
        h.spawns[0].result.resolve({ type: 'success', sessionId: 'real1' });
        await flush();
        expect(h.deps.sendMessage).toHaveBeenCalledTimes(1);
        expect(h.store.append(record.pendingId, 'b')).toBe(true); // still landing
        await flush();
        expect(h.deps.sendMessage).toHaveBeenCalledTimes(1); // no receipt yet
        gate.resolve('receipt-a');
        await flush();
        expect(h.events.filter((e) => e.startsWith('send:'))).toEqual(['send:real1:a', 'send:real1:b']);
        expect(h.store.get(record.pendingId)?.state).toBe('landed');
        expect(h.store.append(record.pendingId, 'late')).toBe(false); // the real composer owns sending now
    });

    it('never fails after a successful spawn: a missing session or a send without receipt lands the text as the real draft', async () => {
        const h = harness();
        const a = h.store.create({ ...input, firstMessage: 'lost?' });
        h.spawns[0].result.resolve({ type: 'success', sessionId: 'real-a' });
        await flush();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(h.store.get(a.pendingId)).toMatchObject({ state: 'landed', outbox: [], deliveredAsDraft: true });
        expect(h.deps.restoreText).toHaveBeenCalledWith('real-a', 'lost?', a.pendingId);
        expect(h.deps.sendMessage).not.toHaveBeenCalled();

        const b = h.store.create({ ...input, firstMessage: 'one' });
        h.store.append(b.pendingId, 'two');
        h.store.append(b.pendingId, 'three');
        (h.deps.sendMessage as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce('receipt-one')
            .mockResolvedValueOnce(undefined);
        h.addSession('real-b');
        h.spawns[1].result.resolve({ type: 'success', sessionId: 'real-b' });
        await flush();
        expect(h.store.get(b.pendingId)).toMatchObject({ state: 'landed', outbox: [] });
        expect(h.deps.restoreText).toHaveBeenLastCalledWith('real-b', 'two\n\nthree', b.pendingId);
        expect(h.states.some((s) => s.endsWith(':failed'))).toBe(false);
        expect(h.deps.notifyFailure).not.toHaveBeenCalled();
    });

    it('spawn error or timeout → failed, text back in the pending composer; toast only when the user left', async () => {
        const h = harness();
        const viewed = h.store.create({ ...input, firstMessage: 'keep me' });
        h.store.setViewing(viewed.pendingId);
        h.spawns[0].result.resolve({ type: 'error', errorMessage: 'machine offline' });
        await flush();
        expect(h.store.get(viewed.pendingId)).toMatchObject({ state: 'failed', failure: 'spawn-error', error: 'machine offline', outbox: [] });
        expect(h.deps.restoreText).toHaveBeenCalledWith(viewed.pendingId, 'keep me');
        expect(h.deps.notifyFailure).not.toHaveBeenCalled();

        const left = h.store.create({ ...input });
        h.store.setViewing(null);
        h.spawns[1].result.reject(new Error('RPC timeout'));
        await flush();
        expect(h.store.get(left.pendingId)).toMatchObject({ state: 'failed', error: 'RPC timeout' });
        expect(h.deps.notifyFailure).toHaveBeenCalledTimes(1);
        expect(h.deps.onSpawned).not.toHaveBeenCalled();
    });

    it('directory approval happens on the page: approve respawns with approval, cancel fails with the text kept', async () => {
        const h = harness();
        const record = h.store.create({ ...input, firstMessage: 'hello' });
        h.spawns[0].result.resolve({ type: 'requestToApproveDirectoryCreation', directory: '/repo/new' });
        await flush();
        expect(h.store.get(record.pendingId)).toMatchObject({ state: 'needs-approval', approvalDirectory: '/repo/new' });
        h.store.approveDirectory(record.pendingId);
        h.store.approveDirectory(record.pendingId); // double click
        expect(h.spawns).toHaveLength(2);
        expect(h.spawns[1].options.approvedNewDirectoryCreation).toBe(true);
        h.spawns[1].result.resolve({ type: 'requestToApproveDirectoryCreation', directory: '/repo/new' });
        await flush();
        h.store.declineDirectory(record.pendingId);
        expect(h.store.get(record.pendingId)).toMatchObject({ state: 'failed', failure: 'directory-declined' });
        expect(h.deps.restoreText).toHaveBeenCalledWith(record.pendingId, 'hello');
    });

    it('dedupes spawns per pending id and ignores a late result after discard', async () => {
        const h = harness();
        const record = h.store.create({ ...input });
        h.store.retry(record.pendingId); // not failed: no-op
        expect(h.spawns).toHaveLength(1);
        expect(h.store.discard(record.pendingId)).toBe(true);
        expect(h.deps.clearKeys).toHaveBeenCalledWith(record.pendingId);
        h.spawns[0].result.resolve({ type: 'success', sessionId: 'orphan' });
        await flush();
        expect(h.store.get(record.pendingId)).toBeUndefined();
        expect(h.deps.onSpawned).not.toHaveBeenCalled();
        // review: the cancelled spawn still created a session — it is stopped
        expect(h.deps.killSession).toHaveBeenCalledExactlyOnceWith('orphan');
        expect(h.deps.writePermissionMode).not.toHaveBeenCalled();

        const failed = h.store.create({ ...input });
        h.spawns[1].result.resolve({ type: 'error', errorMessage: 'x' });
        await flush();
        h.store.retry(failed.pendingId);
        h.store.retry(failed.pendingId);
        expect(h.spawns).toHaveLength(3);
        // a landed/landing record cannot be discarded (the session exists)
        h.spawns[2].result.resolve({ type: 'success', sessionId: 'r' });
        await flush();
        expect(h.store.discard(failed.pendingId)).toBe(false);
    });

    it('persists records; after a reload an in-flight spawn is interrupted (text recoverable) and a landing one resumes', async () => {
        const first = harness();
        const interrupted = first.store.create({ ...input, firstMessage: 'draft 1' });
        const landing = first.store.create({ ...input, firstMessage: 'draft 2' });
        first.spawns[1].result.resolve({ type: 'success', sessionId: 'real2' });
        await flush();
        const saved = first.persisted();
        expect(saved.map((r) => r.state)).toEqual(['spawning', 'landing']);

        // reload = a new tab id; the old page load's tab is gone
        const second = harness({ tabId: 'tab-reloaded', saved: [
            ...saved,
            { ...saved[0], pendingId: 'pending-old', state: 'landed', landedAt: -10 * 24 * 3600 * 1000 },
            { ...saved[0], pendingId: 'pending-stale-approval', state: 'needs-approval', createdAt: -2 * 24 * 3600 * 1000 },
            { junk: true },
        ] });
        expect(second.store.list().map((r) => r.pendingId)).toEqual([interrupted.pendingId, landing.pendingId]);
        // expired records are dropped from storage together with their keys
        expect(second.deps.clearKeys).toHaveBeenCalledWith('pending-old');
        expect(second.deps.clearKeys).toHaveBeenCalledWith('pending-stale-approval');
        expect(second.persisted().map((r) => r.pendingId)).not.toContain('pending-stale-approval');
        expect(second.store.aliasOf('real2')).toBe(landing.pendingId);
        await second.store.resume();
        expect(second.store.get(interrupted.pendingId)).toMatchObject({ state: 'failed', failure: 'interrupted', outbox: [] });
        expect(second.deps.restoreText).toHaveBeenCalledWith(interrupted.pendingId, 'draft 1');
        expect(second.deps.notifyFailure).not.toHaveBeenCalled();
        expect(second.spawns).toHaveLength(0); // never re-spawned on its own
        second.addSession('real2');
        await flush();
        expect(second.events).toContain('send:real2:draft 2');
        expect(second.store.get(landing.pendingId)?.state).toBe('landed');
        await second.store.resume(); // idempotent
        expect(second.deps.sendMessage).toHaveBeenCalledTimes(1);
        expect(second.deps.migrateDraft).toHaveBeenCalledWith(landing.pendingId, 'real2');
    });

    it('adopts only after a possibly lost ack, within a short window around the dispatch, without touching its mode', async () => {
        const h = harness();
        const record = h.store.create({ ...input, path: '/repo/', firstMessage: 'go' });
        h.spawns[0].result.reject(new Error('timeout'));
        await flush();
        const failed = h.store.get(record.pendingId)!;
        expect(failed.failure).toBe('lost-ack');
        const at = failed.spawnDispatchedAt!;
        const norm = (f: string | null | undefined) => (f ?? 'claude');
        const meta = { machineId: 'm1', path: '/repo', flavor: 'claude' };
        const sessions = [
            { id: 'before-window', createdAt: at - ADOPT_SKEW_MS - 1, metadata: meta },
            { id: 'after-window', createdAt: at + ADOPT_WINDOW_MS + ADOPT_SKEW_MS + 1, metadata: meta },
            { id: 'other-path', createdAt: at + 5, metadata: { ...meta, path: '/elsewhere' } },
            { id: 'codex', createdAt: at + 6, metadata: { ...meta, flavor: 'codex' } },
            { id: 'match', createdAt: at - 3_000, metadata: meta }, // server clock a bit behind
            { id: 'claimed', createdAt: at + 9, metadata: meta },
        ];
        expect(findAdoptableSession(failed, sessions, norm, new Set(['claimed']))).toBe('match');
        // a daemon that ANSWERED with an error did not create anything
        expect(findAdoptableSession({ ...failed, failure: 'spawn-error' }, sessions, norm, new Set())).toBeNull();
        expect(findAdoptableSession({ ...failed, failure: 'directory-declined' }, sessions, norm, new Set())).toBeNull();
        expect(findAdoptableSession({ ...failed, failure: 'interrupted' }, sessions, norm, new Set(['claimed']))).toBe('match');
        expect(findAdoptableSession({ ...failed, state: 'spawning' }, sessions, norm, new Set())).toBeNull();
        h.store.adopt(record.pendingId, 'match');
        await flush();
        h.addSession('match');
        await flush();
        expect(h.store.get(record.pendingId)).toMatchObject({ state: 'landed', realId: 'match', adopted: true });
        // never writes the pending page's mode onto a session that may be someone else's
        expect(h.deps.writePermissionMode).not.toHaveBeenCalled();
        expect(h.deps.sendMessage).not.toHaveBeenCalled();
        expect(h.deps.onSpawned).toHaveBeenCalledWith(expect.anything(), 'match');
    });

    it('a daemon error is not adoptable; a transport error is', async () => {
        const h = harness();
        const a = h.store.create({ ...input });
        h.spawns[0].result.resolve({ type: 'error', errorMessage: 'no such agent' });
        const b = h.store.create({ ...input });
        h.spawns[1].result.resolve({ type: 'error', errorMessage: 'relay dropped', transport: true });
        await flush();
        expect(h.store.get(a.pendingId)?.failure).toBe('spawn-error');
        expect(h.store.get(b.pendingId)?.failure).toBe('lost-ack');
        h.store.adopt(a.pendingId, 'x');
        expect(h.store.get(a.pendingId)?.state).toBe('failed');
    });

    it('multi-tab: a loading tab never re-delivers or interrupts a live tab\'s records, and saves merge per record', async () => {
        const backing: Backing = { table: [], lock: Promise.resolve() };
        const alive = new Set<string>();
        const a = harness({ backing, alive, tabId: 'tab-a' });
        const landing = a.store.create({ ...input, firstMessage: 'once' });
        const starting = a.store.create({ ...input });
        a.spawns[0].result.resolve({ type: 'success', sessionId: 'real-a' });
        await flush();

        const b = harness({ backing, alive, tabId: 'tab-b' });
        b.addSession('real-a');
        await b.store.resume();
        await flush();
        expect(b.deps.sendMessage).not.toHaveBeenCalled();
        expect(b.store.get(starting.pendingId)?.state).toBe('spawning');
        // read-only for B
        expect(b.store.append(starting.pendingId, 'from b')).toBe(false);
        expect(b.store.discard(starting.pendingId)).toBe(false);

        // B creates its own; A's next write must not drop it (no whole-table overwrite)
        const mineB = b.store.create({ ...input });
        a.addSession('real-a');
        await flush();
        expect(a.store.get(landing.pendingId)?.state).toBe('landed');
        expect(a.events.filter((e) => e.startsWith('send:'))).toEqual(['send:real-a:once']);
        expect(b.persisted().map((r) => r.pendingId)).toEqual(expect.arrayContaining([landing.pendingId, starting.pendingId, mineB.pendingId]));
        // B's memory picks up A's writes
        b.store.refresh();
        expect(b.store.get(landing.pendingId)?.state).toBe('landed');

        // A goes away: exactly one surviving tab takes its in-flight record over
        alive.delete('tab-a');
        const c = harness({ backing, alive, tabId: 'tab-c' });
        await Promise.all([b.store.resume(), c.store.resume()]);
        b.store.refresh();
        c.store.refresh();
        const owners = [b, c].filter((t) => t.store.isOwnedHere(starting.pendingId));
        expect(owners).toHaveLength(1);
        expect(owners[0].store.get(starting.pendingId)).toMatchObject({ state: 'failed', failure: 'interrupted' });
    });

    it('releases waiters when the pending page is shown, with a timeout fallback', async () => {
        const h = harness();
        const shown = vi.fn();
        void h.store.waitShown('pending-a', 1_000).then(shown);
        h.store.markShown('pending-a');
        await flush();
        expect(shown).toHaveBeenCalledTimes(1);
        const late = vi.fn();
        void h.store.waitShown('pending-b', 1_000).then(late);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(late).toHaveBeenCalledTimes(1);
        expect(h.store.waiterCount()).toBe(0); // no empty lists left behind
    });
});

describe('pending page routing guards (B-516)', () => {
    const base = { pendingId: 'pending-1', realId: 'real1', state: 'landed' } as PendingSessionRecord;

    it('redirects only the page that still shows that pending id, and only once landed', () => {
        expect(landingRedirect('pending-1', base)).toBe('real1');
        expect(landingRedirect('some-other-session', base)).toBeNull(); // user left: never pulled back
        expect(landingRedirect('real1', base)).toBeNull();
        expect(landingRedirect('pending-1', { ...base, state: 'landing' })).toBeNull();
        expect(landingRedirect('pending-1', undefined)).toBeNull();
    });

    it('keeps the composer key from a pending id to its own real id only', () => {
        const alias = (id: string) => (id === 'real1' ? 'pending-1' : undefined);
        expect(composerKey('pending-1', alias)).toBe('pending-1');
        expect(composerKey('real1', alias)).toBe('pending-1');
        expect(composerKey('real2', alias)).toBe('real2');
    });
});

describe('pending draft migration on landing (B-516 review)', () => {
    function io(drafts: Record<string, string>, mounted: string[] = []) {
        return {
            drafts,
            hasComposer: (id: string) => mounted.includes(id),
            readDraft: (id: string) => drafts[id] ?? '',
            restoreToComposer: vi.fn(() => false),
            writeDraft: vi.fn((id: string, text: string) => { drafts[id] = text; }),
            clearKeys: vi.fn((id: string) => { delete drafts[id]; }),
        };
    }

    it('moves an unmounted pending draft into the real session and clears the pending keys', () => {
        const x = io({ 'pending-1': 'typed while starting', real1: 'outbox fallback' });
        migratePendingDraft('pending-1', 'real1', x);
        expect(x.drafts).toEqual({ real1: 'outbox fallback\ntyped while starting' });
        expect(x.clearKeys).toHaveBeenCalledWith('pending-1');
    });

    it('leaves a mounted pending composer alone (it carries its text over itself)', () => {
        const x = io({ 'pending-1': 'still editing' }, ['pending-1']);
        migratePendingDraft('pending-1', 'real1', x);
        expect(x.drafts).toEqual({ 'pending-1': 'still editing' });
        expect(x.clearKeys).not.toHaveBeenCalled();
    });
});
