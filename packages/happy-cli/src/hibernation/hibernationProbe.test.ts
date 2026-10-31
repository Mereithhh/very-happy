import { describe, expect, it, vi } from 'vitest';
import { HibernationExitLatch, HibernationProbe, commitHibernation, type HibernationCommitClient, type HibernationCommitDeps } from './hibernationProbe';
import { HIBERNATION_UNSUPPORTED_BACKOFF_MS, type WrapperIdleSnapshot } from './hibernationPolicy';
import { SessionExitGate } from '@/claude/sessionExitLifecycle';
import type { Metadata } from '@/api/types';

/** A fake session client with the real freeze/hold semantics. */
function client(opts: { onFlush?: () => void; stamp?: 'ok' | 'timeout' | 'throw'; onStamp?: () => void } = {}) {
    const calls: string[] = [];
    let inbound = false;
    let frozen = false;
    const held: string[] = [];
    const routed: string[] = [];
    let metadata: Metadata = { path: '/p', host: 'h' } as Metadata;
    const c = {
        calls, routed, held,
        get metadata() { return metadata; },
        /** what the socket does with an inbound user message */
        deliver(text: string) { if (frozen) held.push(text); else routed.push(text); inbound = true; },
        muteHeartbeats: vi.fn(() => { calls.push('mute'); }),
        unmuteHeartbeats: vi.fn(() => { calls.push('unmute'); }),
        lastHeartbeatAt: 0,
        beginHibernationCommit: vi.fn(() => { calls.push('begin'); inbound = false; }),
        inboundRoutedSinceCommit: vi.fn(() => inbound),
        freezeInbound: vi.fn(() => { calls.push('freeze'); frozen = true; }),
        unfreezeInbound: vi.fn(() => { calls.push('unfreeze'); frozen = false; routed.push(...held.splice(0)); }),
        flush: vi.fn(async () => { calls.push('flush'); opts.onFlush?.(); }),
        updateMetadataAndWait: vi.fn(async (handler: (m: Metadata) => Metadata) => {
            const next = handler(metadata);
            if (!next.hibernation) { calls.push('clear'); metadata = next; return true; }
            calls.push('stamp');
            opts.onStamp?.();
            if (opts.stamp === 'throw') throw new Error('socket closed');
            if (opts.stamp === 'timeout') return false;
            metadata = next;
            return true;
        }),
        updateMetadata: vi.fn((handler: (m: Metadata) => Metadata) => { calls.push('metadata'); metadata = handler(metadata); }),
        messageCursor: 77,
    };
    return c;
}

/** runClaude's wiring of the commit, against the REAL SessionExitGate. */
function claudeLike(c: ReturnType<typeof client>, extra: Partial<HibernationCommitDeps> = {}) {
    const gate = new SessionExitGate();
    const cleanup = vi.fn(async (_opts: { archive?: boolean }) => {});
    const finish = vi.fn(async () => { c.calls.push('finish'); });
    const deps: HibernationCommitDeps = {
        client: c as unknown as HibernationCommitClient,
        claimExit: () => gate.claim('hibernate') !== null,
        exitRequested: () => gate.exitRequested,
        markCommitted: () => gate.commitHibernate(),
        releaseExit: () => { const deferred = gate.release('hibernate'); if (deferred) void cleanup({ archive: deferred === 'archive' }); },
        recheck: () => ({ ok: true }),
        idleMs: 5000,
        finish,
        now: () => 1234,
        sleep: async () => {},
        log: () => {},
        ...extra,
    };
    /** what runClaude's cleanup() entry does for a kill / archive / SIGTERM */
    const requestExit = (archive: boolean) => { const intent = gate.claim(archive ? 'archive' : 'offline'); if (intent) void cleanup({ archive }); };
    return { gate, cleanup, finish, deps, requestExit };
}

describe('B-587 commitHibernation', () => {
    it('success: claim → begin → flush → freeze → stamp (awaited) → finish with the cursor stamp', async () => {
        const c = client();
        const { deps, finish } = claudeLike(c);
        expect(await commitHibernation(deps)).toBe(true);
        expect(c.calls).toEqual(['begin', 'flush', 'freeze', 'mute', 'stamp', 'finish']);
        expect(finish).toHaveBeenCalledWith({ at: 1234, seq: 77, idleMs: 5000, v: 1 });
        expect(c.metadata.hibernation).toEqual({ at: 1234, seq: 77, idleMs: 5000, v: 1 });
    });

    it('a message routed during the flush aborts; the session keeps running', async () => {
        const c = client({ onFlush: () => c.deliver('hi') });
        const { deps, finish, gate } = claudeLike(c);
        expect(await commitHibernation(deps)).toBe(false);
        expect(finish).not.toHaveBeenCalled();
        expect(c.routed).toEqual(['hi']);
        expect(gate.current).toBeNull();
    });

    it('P1-1: the user archives/kills DURING the flush → hibernation aborts and the kill runs (archive)', async () => {
        let h!: ReturnType<typeof claudeLike>;
        const c = client({ onFlush: () => h.requestExit(true) });
        h = claudeLike(c);
        expect(await commitHibernation(h.deps)).toBe(false);
        expect(h.finish).not.toHaveBeenCalled();
        expect(h.cleanup).toHaveBeenCalledTimes(1);
        expect(h.cleanup).toHaveBeenCalledWith({ archive: true });
    });

    it('P1-1: SIGTERM (daemon stop) during the flush → aborts and the OFFLINE exit runs', async () => {
        let h!: ReturnType<typeof claudeLike>;
        const c = client({ onFlush: () => h.requestExit(false) });
        h = claudeLike(c);
        expect(await commitHibernation(h.deps)).toBe(false);
        expect(h.cleanup).toHaveBeenCalledWith({ archive: false });
    });

    it('P1-1: SIGTERM then archive while deciding → the archive wins', async () => {
        let h!: ReturnType<typeof claudeLike>;
        const c = client({ onFlush: () => { h.requestExit(false); h.requestExit(true); } });
        h = claudeLike(c);
        await commitHibernation(h.deps);
        expect(h.cleanup).toHaveBeenCalledTimes(1);
        expect(h.cleanup).toHaveBeenCalledWith({ archive: true });
    });

    it('P1-1: an exit requested while the stamp is written aborts too: stamp cleared, held inbound routed', async () => {
        let h!: ReturnType<typeof claudeLike>;
        const c = client({ onStamp: () => { c.deliver('late'); h.requestExit(true); } });
        h = claudeLike(c);
        expect(await commitHibernation(h.deps)).toBe(false);
        expect(c.metadata.hibernation).toBeUndefined();
        expect(c.routed).toEqual(['late']);
        expect(h.cleanup).toHaveBeenCalledWith({ archive: true });
    });

    it('P3-1: a stamp that does not land (timeout or error) → abort, held inbound routed, stamp cleared', async () => {
        for (const stamp of ['timeout', 'throw'] as const) {
            const c = client({ stamp, onStamp: () => c.deliver('x') });
            const h = claudeLike(c);
            expect(await commitHibernation(h.deps)).toBe(false);
            expect(h.finish).not.toHaveBeenCalled();
            expect(c.routed).toEqual(['x']);
            expect(c.calls).toContain('clear'); // the clearing write, awaited (review P3-2)
            expect(h.gate.current).toBeNull();
        }
    });

    it('old-server presence race: beats stop at freeze and a batch window passes before going offline', async () => {
        const c = client();
        c.lastHeartbeatAt = 1000;
        const sleep = vi.fn(async (_ms: number) => {});
        const h = claudeLike(c, { sleep, now: () => 2000, presenceSettleMs: 6000 });
        expect(await commitHibernation(h.deps)).toBe(true);
        expect(sleep).toHaveBeenCalledWith(5000);
        expect(c.calls.indexOf('mute')).toBeLessThan(c.calls.indexOf('finish'));
    });

    it('a message arriving during the settle wait aborts: routed now, beats resume, stamp cleared', async () => {
        const c = client();
        c.lastHeartbeatAt = 1234;
        let once = false;
        const h = claudeLike(c, { sleep: async () => { if (!once) { once = true; c.deliver('during-settle'); } } });
        expect(await commitHibernation(h.deps)).toBe(false);
        expect(c.routed).toEqual(['during-settle']);
        expect(c.calls).toContain('unmute');
        expect(c.metadata.hibernation).toBeUndefined();
        expect(h.finish).not.toHaveBeenCalled();
    });

    it('review P3-3: a SIGTERM during the settle wait is acted on at once, not after the whole wait', async () => {
        const c = client();
        c.lastHeartbeatAt = 1234;               // a full 6 s settle is due
        let polls = 0;
        let h!: ReturnType<typeof claudeLike>;
        const sleep = vi.fn((ms: number) => {
            if (ms !== 100) return new Promise<void>(() => {}); // the settle itself never ends on its own
            polls += 1;
            if (polls === 3) h.requestExit(false);
            return Promise.resolve();
        });
        h = claudeLike(c, { sleep, presenceSettleMs: 6000 });
        expect(await commitHibernation(h.deps)).toBe(false);
        expect(polls).toBe(3);
        expect(h.cleanup).toHaveBeenCalledWith({ archive: false });
        expect(h.finish).not.toHaveBeenCalled();
    });

    it('state moved (recheck fails) → abort, never freeze', async () => {
        const c = client();
        const h = claudeLike(c, { recheck: () => ({ ok: false, reason: 'turn-active' }) });
        expect(await commitHibernation(h.deps)).toBe(false);
        expect(c.freezeInbound).not.toHaveBeenCalled();
    });

    it('exit already claimed (SIGTERM / archive first) → do nothing at all', async () => {
        const c = client();
        const h = claudeLike(c);
        h.requestExit(false);
        expect(await commitHibernation(h.deps)).toBe(false);
        expect(c.beginHibernationCommit).not.toHaveBeenCalled();
    });

    it('after the commit a late signal is dropped (the process is already going offline)', async () => {
        const c = client();
        const h = claudeLike(c, { finish: async () => { h.requestExit(true); } });
        expect(await commitHibernation(h.deps)).toBe(true);
        expect(h.cleanup).not.toHaveBeenCalled();
    });
});

describe('B-587 HibernationExitLatch (Codex, review P1-1)', () => {
    const latch = () => new HibernationExitLatch<'archive' | 'offline'>((a, b) => a === 'archive' && b !== 'archive');
    it('deferred while deciding, handed back on abort; archive outranks offline', () => {
        const l = latch();
        expect(l.intercept('offline')).toBe(false); // not hibernating: run it
        expect(l.begin()).toBe(true);
        expect(l.intercept('offline')).toBe(true);
        expect(l.intercept('archive')).toBe(true);
        expect(l.intercept('offline')).toBe(true);
        expect(l.exitRequested).toBe(true);
        expect(l.release()).toBe('archive');
        expect(l.hibernating).toBe(false);
        expect(l.intercept('offline')).toBe(false);
    });
    it('after commit: swallowed, release is a no-op', () => {
        const l = latch();
        l.begin();
        l.commit();
        expect(l.intercept('archive')).toBe(true);
        expect(l.exitRequested).toBe(false);
        expect(l.release()).toBeNull();
        expect(l.hibernating).toBe(true);
    });
});

describe('B-587 HibernationProbe', () => {
    const snapshot = (overrides: Partial<WrapperIdleSnapshot> = {}): WrapperIdleSnapshot => ({
        flavor: 'claude', resumable: true, uiSession: true, keepAwake: false, thinking: false, queuedInputs: 0, waitingForInput: true,
        pendingRequests: 0, backgroundTasks: 0, lastActivityAt: 0, ...overrides,
    });
    function probe(overrides: Partial<ConstructorParameters<typeof HibernationProbe>[0]> = {}) {
        const timers: number[] = [];
        const deps = {
            checkMs: 60_000,
            snapshot: () => snapshot(),
            ask: vi.fn(async () => ({ hibernate: false, reason: 'recent-activity', nextCheckMs: 3_600_000 })),
            commit: vi.fn(async () => true),
            now: () => 10_000,
            setTimer: (_fn: () => void, ms: number) => { timers.push(ms); return ms; },
            clearTimer: () => {},
            log: () => {},
            ...overrides,
        };
        return { p: new HibernationProbe(deps as never), deps, timers };
    }

    it('P2-4: keep-awake is still reported (the daemon latches it) and a latch heals the field', async () => {
        const healed = vi.fn();
        const ask = vi.fn(async () => ({ hibernate: false, reason: 'keep-awake', keepAwake: true }));
        const { p } = probe({ snapshot: () => snapshot({ keepAwake: true }), ask, onKeepAwakeLatched: healed });
        await p.tick();
        expect(ask).toHaveBeenCalledTimes(1);
        expect(healed).toHaveBeenCalledTimes(1);
    });

    it('a daemon yes is never acted on while the wrapper itself says keep-awake', async () => {
        const commit = vi.fn(async () => true);
        const { p } = probe({ snapshot: () => snapshot({ keepAwake: true }), ask: vi.fn(async () => ({ hibernate: true, idleMs: 5000 })), commit });
        await p.tick();
        expect(commit).not.toHaveBeenCalled();
    });

    it('a busy session never even asks the daemon', async () => {
        const { p, deps, timers } = probe({ snapshot: () => snapshot({ thinking: true }) });
        expect(await p.tick()).toBe(60_000);
        expect(deps.ask).not.toHaveBeenCalled();
        expect(timers).toEqual([60_000]);
    });

    it('follows the daemon\'s next-check hint', async () => {
        const { p } = probe();
        expect(await p.tick()).toBe(3_600_000);
    });

    it('old daemon / no daemon → long back-off, no error', async () => {
        const { p } = probe({ ask: vi.fn(async () => 'unsupported' as const) });
        expect(await p.tick()).toBe(HIBERNATION_UNSUPPORTED_BACKOFF_MS);
    });

    it('approved → commits with the daemon threshold and stops', async () => {
        const commit = vi.fn(async () => true);
        const { p, timers } = probe({ ask: vi.fn(async () => ({ hibernate: true, idleMs: 5000 })), commit });
        expect(await p.tick()).toBeNull();
        expect(commit).toHaveBeenCalledWith(5000);
        expect(timers).toEqual([]);
    });

    it('approved but the commit aborted → keeps sampling', async () => {
        const { p } = probe({ ask: vi.fn(async () => ({ hibernate: true, idleMs: 5000 })), commit: vi.fn(async () => false) });
        expect(await p.tick()).toBe(60_000);
    });

    it('B-852: a quiescent team / automation / pi session still reports (auto-restart) but never commits', async () => {
        for (const extra of [{ spawnedBy: 'teams' }, { tags: ['automation'] }, { flavor: 'acp' }, { resumable: false }]) {
            const commit = vi.fn(async () => true);
            const ask = vi.fn(async () => ({ hibernate: true, idleMs: 5000 }));
            const { p } = probe({ snapshot: () => snapshot(extra), ask, commit });
            await p.tick();
            expect(ask).toHaveBeenCalledTimes(1);
            expect(commit).not.toHaveBeenCalled();
        }
    });

    it('B-852: a non-quiescent or local-terminal session with a hibernation refusal does not report', async () => {
        for (const extra of [{ spawnedBy: 'teams', pendingRequests: 1 }, { spawnedBy: 'teams', backgroundTasks: 1 }, { uiSession: false }, { variant: 'assistant' }, { spawnedBy: 'teams', waitingForInput: false }]) {
            const { p, deps } = probe({ snapshot: () => snapshot(extra) });
            await p.tick();
            expect(deps.ask).not.toHaveBeenCalled();
        }
    });

    it('an approval without a threshold is ignored (fail closed)', async () => {
        const commit = vi.fn(async () => true);
        const { p } = probe({ ask: vi.fn(async () => ({ hibernate: true })), commit });
        await p.tick();
        expect(commit).not.toHaveBeenCalled();
    });
});
