import { describe, expect, it, vi } from 'vitest';
import { HibernationProbe, commitHibernation, type HibernationCommitClient } from './hibernationProbe';
import { HIBERNATION_UNSUPPORTED_BACKOFF_MS, type WrapperIdleSnapshot } from './hibernationPolicy';

function client(overrides: Partial<HibernationCommitClient> & { inbound?: boolean } = {}) {
    const calls: string[] = [];
    let inbound = false;
    const c = {
        calls,
        beginHibernationCommit: vi.fn(() => { calls.push('begin'); inbound = false; }),
        inboundRoutedSinceCommit: vi.fn(() => inbound),
        freezeInbound: vi.fn(() => { calls.push('freeze'); }),
        flush: vi.fn(async () => { calls.push('flush'); if (overrides.inbound) inbound = true; }),
        messageCursor: 77,
    };
    return c;
}

describe('B-587 commitHibernation', () => {
    it('success: claim → begin → flush → recheck → freeze → finish(stamp with cursor)', async () => {
        const c = client();
        const finish = vi.fn(async () => { c.calls.push('finish'); });
        const ok = await commitHibernation({
            client: c, claimExit: () => true, releaseExit: vi.fn(), recheck: () => ({ ok: true }),
            idleMs: 5000, finish, now: () => 1234, log: () => {},
        });
        expect(ok).toBe(true);
        expect(c.calls).toEqual(['begin', 'flush', 'freeze', 'finish']);
        expect(finish).toHaveBeenCalledWith({ at: 1234, seq: 77, idleMs: 5000, v: 1 });
    });

    it('a message routed during the commit window aborts and hands the exit back', async () => {
        const c = client({ inbound: true });
        const releaseExit = vi.fn();
        const finish = vi.fn();
        const ok = await commitHibernation({ client: c, claimExit: () => true, releaseExit, recheck: () => ({ ok: true }), idleMs: 1, finish, log: () => {} });
        expect(ok).toBe(false);
        expect(releaseExit).toHaveBeenCalledTimes(1);
        expect(c.freezeInbound).not.toHaveBeenCalled();
        expect(finish).not.toHaveBeenCalled();
    });

    it('state moved (recheck fails) → abort, never freeze', async () => {
        const c = client();
        const releaseExit = vi.fn();
        const finish = vi.fn();
        const ok = await commitHibernation({ client: c, claimExit: () => true, releaseExit, recheck: () => ({ ok: false, reason: 'turn-active' }), idleMs: 1, finish, log: () => {} });
        expect(ok).toBe(false);
        expect(releaseExit).toHaveBeenCalled();
        expect(c.freezeInbound).not.toHaveBeenCalled();
        expect(finish).not.toHaveBeenCalled();
    });

    it('exit already claimed (SIGTERM / archive first) → do nothing at all', async () => {
        const c = client();
        const finish = vi.fn();
        const ok = await commitHibernation({ client: c, claimExit: () => false, releaseExit: vi.fn(), recheck: () => ({ ok: true }), idleMs: 1, finish, log: () => {} });
        expect(ok).toBe(false);
        expect(c.beginHibernationCommit).not.toHaveBeenCalled();
        expect(finish).not.toHaveBeenCalled();
    });
});

describe('B-587 HibernationProbe', () => {
    const snapshot = (overrides: Partial<WrapperIdleSnapshot> = {}): WrapperIdleSnapshot => ({
        flavor: 'claude', uiSession: true, keepAwake: false, thinking: false, queuedInputs: 0, waitingForInput: true,
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

    it('an approval without a threshold is ignored (fail closed)', async () => {
        const commit = vi.fn(async () => true);
        const { p } = probe({ ask: vi.fn(async () => ({ hibernate: true })), commit });
        await p.tick();
        expect(commit).not.toHaveBeenCalled();
    });
});
