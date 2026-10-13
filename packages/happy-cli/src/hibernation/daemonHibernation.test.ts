import { describe, expect, it, vi } from 'vitest';
import { AutomationsRequestError } from '@/automations/client';
import { collectAutomationBindings, createDaemonHibernation, HIBERNATION_IN_FLIGHT_MS, type DaemonHibernationDeps } from './daemonHibernation';
import type { WrapperIdleSnapshot } from './hibernationPolicy';

const IDLE = 10_000;
let clock = 1_000_000;

function report(overrides: Partial<WrapperIdleSnapshot> = {}): WrapperIdleSnapshot {
    return {
        flavor: 'claude', resumable: true, uiSession: true, keepAwake: false, thinking: false, queuedInputs: 0, waitingForInput: true,
        pendingRequests: 0, backgroundTasks: 0, lastActivityAt: clock - IDLE, ...overrides,
    };
}

function make(overrides: Partial<DaemonHibernationDeps> = {}) {
    const deps: DaemonHibernationDeps = {
        idleMs: () => IDLE,
        checkMs: 1000,
        tracked: (sessionId, pid) => (pid > 0 ? { live: true } : null),
        teamsMember: () => false,
        turnActive: () => false,
        backgroundTasks: () => 0,
        loadAutomationBindings: vi.fn(async () => []),
        now: () => clock,
        ...overrides,
    };
    return { h: createDaemonHibernation(deps), deps };
}

describe('B-587 daemon hibernation coordinator', () => {
    it('two identical samples are needed (Orca confirmation); then approves once', async () => {
        const { h } = make();
        const r = report();
        expect(await h.check({ sessionId: 's1', pid: 1, report: r })).toMatchObject({ hibernate: false, reason: 'unconfirmed' });
        expect(await h.check({ sessionId: 's1', pid: 1, report: r })).toEqual({ hibernate: true, idleMs: IDLE });
    });

    it('activity between samples resets the confirmation', async () => {
        const { h } = make();
        await h.check({ sessionId: 's1', pid: 1, report: report() });
        const moved = report({ lastActivityAt: clock - IDLE - 1 });
        expect(await h.check({ sessionId: 's1', pid: 1, report: moved })).toMatchObject({ hibernate: false, reason: 'unconfirmed' });
    });

    it('Automations unreadable → nobody hibernates (fail closed); 404-style empty list → allowed', async () => {
        const failing = make({ loadAutomationBindings: async () => { throw new Error('ECONNRESET'); } });
        await failing.h.check({ sessionId: 's1', pid: 1, report: report() });
        expect(await failing.h.check({ sessionId: 's1', pid: 1, report: report() })).toMatchObject({ hibernate: false, reason: 'automations-unknown' });
    });

    it('a session an Automation reuses is never hibernated', async () => {
        const { h } = make({ loadAutomationBindings: async () => ['s1'] });
        await h.check({ sessionId: 's1', pid: 1, report: report() });
        expect(await h.check({ sessionId: 's1', pid: 1, report: report() })).toMatchObject({ hibernate: false, reason: 'automation-bound' });
    });

    it('only one hibernation in flight per machine; the slot frees on exit or after the timeout', async () => {
        const { h } = make();
        for (const id of ['a', 'b']) await h.check({ sessionId: id, pid: 1, report: report() });
        expect(await h.check({ sessionId: 'a', pid: 1, report: report() })).toMatchObject({ hibernate: true });
        expect(await h.check({ sessionId: 'b', pid: 1, report: report() })).toMatchObject({ hibernate: false, reason: 'busy' });
        expect(h.consumeExit('a')).toBe(true);
        expect(await h.check({ sessionId: 'b', pid: 1, report: report() })).toMatchObject({ hibernate: true });
        clock += HIBERNATION_IN_FLIGHT_MS + 1;
        await h.check({ sessionId: 'c', pid: 1, report: report() });
        expect(await h.check({ sessionId: 'c', pid: 1, report: report() })).toMatchObject({ hibernate: true });
    });

    it('an exit nobody approved is not a hibernation (crash / SIGTERM stay what they are)', () => {
        const { h } = make();
        expect(h.consumeExit('never-approved')).toBe(false);
    });

    it('untracked pid, Teams member, live turn lease → refused with the reason', async () => {
        for (const [deps, reason] of [
            [{ tracked: () => null }, 'not-tracked'],
            [{ teamsMember: () => true }, 'teams'],
            [{ turnActive: () => true }, 'turn-active'],
            [{ backgroundTasks: () => 1 }, 'background-tasks'],
            [{ idleMs: () => 0 }, 'disabled'],
        ] as const) {
            const { h } = make(deps as Partial<DaemonHibernationDeps>);
            await h.check({ sessionId: 's', pid: 1, report: report() });
            expect(await h.check({ sessionId: 's', pid: 1, report: report() })).toMatchObject({ hibernate: false, reason });
        }
    });
});

describe('B-587 collectAutomationBindings', () => {
    it('send targets and sticky bindings (paused automations included)', async () => {
        const client = {
            list: vi.fn(async () => [
                { id: 'a1', action: { kind: 'send', sessionId: 's-send' } },
                { id: 'a2', action: { kind: 'spawn', sticky: { key: 'k' } } },
                { id: 'a3', action: { kind: 'spawn' } },
                { id: 'a4', action: { kind: 'script' } },
            ]),
            stickies: vi.fn(async (id: string) => (id === 'a2' ? [{ sessionId: 's-sticky' }] : [])),
        };
        expect((await collectAutomationBindings(client, 'm1')).sort()).toEqual(['s-send', 's-sticky']);
        expect(client.list).toHaveBeenCalledWith('m1');
        expect(client.stickies).toHaveBeenCalledTimes(1);
    });
    it('errors propagate (the daemon maps 404 to "none", everything else to unknown)', async () => {
        const client = { list: async () => { throw new AutomationsRequestError(404, 'not_found'); }, stickies: async () => [] };
        await expect(collectAutomationBindings(client, 'm')).rejects.toBeInstanceOf(AutomationsRequestError);
    });
});

describe('B-587 keep-awake latch (an old web strips metadata.keepAwake on rename)', () => {
    it('true is latched and survives the key disappearing; only an explicit false turns it off', async () => {
        const store = new Map<string, boolean>();
        const { h } = make({ readKeepAwake: (id) => store.get(id) ?? false, writeKeepAwake: (id, v) => { store.set(id, v); } });
        const on = report({ keepAwake: true, keepAwakeSetting: true });
        await h.check({ sessionId: 's1', pid: 1, report: on });
        expect(store.get('s1')).toBe(true);
        // old web renamed the session: key gone, wrapper restarted (its own latch lost)
        const stripped = report({ keepAwake: false });
        await h.check({ sessionId: 's1', pid: 1, report: stripped });
        expect(await h.check({ sessionId: 's1', pid: 1, report: stripped })).toMatchObject({ hibernate: false, reason: 'keep-awake' });
        // new web turns it off explicitly
        const off = report({ keepAwake: false, keepAwakeSetting: false });
        await h.check({ sessionId: 's1', pid: 1, report: off });
        expect(store.get('s1')).toBe(false);
        expect(await h.check({ sessionId: 's1', pid: 1, report: off })).toMatchObject({ hibernate: true });
    });
});

describe('B-587 review P1-2: a wake racing the hibernating exit', () => {
    it('pendingExit is true from approval until the exit is consumed', async () => {
        const { h } = make();
        await h.check({ sessionId: 's1', pid: 1, report: report() });
        await h.check({ sessionId: 's1', pid: 1, report: report() });
        expect(h.pendingExit('s1')).toBe(true);
        h.consumeExit('s1');
        expect(h.pendingExit('s1')).toBe(false);
    });
    it('waitForPidsToExit waits for the dying pid, bounded', async () => {
        const { waitForPidsToExit } = await import('./daemonHibernation');
        let t = 0;
        let alive = true;
        const sleep = async (ms: number) => { t += ms; if (t >= 1000) alive = false; };
        expect(await waitForPidsToExit([7], () => alive, 15_000, sleep, () => t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(1000);
        t = 0;
        expect(await waitForPidsToExit([7], () => true, 500, async (ms) => { t += ms; }, () => t)).toBe(false);
    });
});

describe('B-587 review P2-5: the final yes uses a FRESH Automations read', () => {
    it('a send target bound after the cache was filled is not hibernated', async () => {
        let bound: string[] = [];
        const load = vi.fn(async () => bound);
        const { h } = make({ loadAutomationBindings: load });
        await h.check({ sessionId: 's1', pid: 1, report: report() }); // fills the cache (empty)
        bound = ['s1']; // an automation now targets s1
        expect(await h.check({ sessionId: 's1', pid: 1, report: report() })).toMatchObject({ hibernate: false, reason: 'automation-bound' });
    });
    it('waitForSessionLive resolves when the woken wrapper is tracked again, false on timeout', async () => {
        const { waitForSessionLive } = await import('./daemonHibernation');
        let t = 0;
        expect(await waitForSessionLive('s', () => t >= 750, 60_000, async (ms) => { t += ms; }, () => t)).toBe(true);
        t = 0;
        expect(await waitForSessionLive('s', () => false, 1000, async (ms) => { t += ms; }, () => t)).toBe(false);
    });
});

describe('B-587 review P2-4: field stripped + NEW wrapper (and daemon restart) still stays awake', () => {
    it('the persisted latch alone refuses, and the reply tells the wrapper to heal the field', async () => {
        const store = new Map<string, boolean>([['s1', true]]); // written before the old web stripped the field
        const { h } = make({ readKeepAwake: (id) => store.get(id) ?? false, writeKeepAwake: (id, v) => { store.set(id, v); } });
        const fresh = report({ keepAwake: false }); // new wrapper, field absent, no local latch
        await h.check({ sessionId: 's1', pid: 2, report: fresh });
        expect(await h.check({ sessionId: 's1', pid: 2, report: fresh })).toMatchObject({ hibernate: false, reason: 'keep-awake', keepAwake: true });
    });
});
