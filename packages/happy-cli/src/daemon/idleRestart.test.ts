import { describe, expect, it, vi } from 'vitest';
import { createIdleRestart, idleRestartSessionRefusal, ownerRestartRequest, type IdleRestartDeps, type IdleRestartPersisted, type IdleRestartSessionFacts } from './idleRestart';
import { AGENT_RESTART_COOLDOWN_MS, AGENT_RESTART_PENDING_TTL_MS } from '@/update/idleRestartPolicy';

const QUIET = 30_000;
const OBSERVE = 90_000;

function setup(overrides: Partial<IdleRestartDeps> = {}, facts: Record<string, IdleRestartSessionFacts> = {}) {
    let now = 1_000_000_000;
    const sessions: Record<string, IdleRestartSessionFacts> = {
        lead: { live: true, wrapperVersion: '0.2.181', flavor: 'claude' },
        ...facts,
    };
    const busy = new Set<string>();
    let saved: IdleRestartPersisted | null = null;
    const restart = vi.fn<IdleRestartDeps['restart']>(async () => ({ ok: true }));
    const onSettled = vi.fn();
    const onQueued = vi.fn();
    const deps: IdleRestartDeps = {
        now: () => now,
        quietMs: QUIET, observeMs: OBSERVE, checkMs: 10_000,
        session: (id) => sessions[id] ?? null,
        turnActive: (id) => busy.has(id),
        backgroundTasks: () => 0,
        automationRunning: () => false,
        upgradePending: () => null,
        resumable: async () => true,
        restart,
        save: (state) => { saved = JSON.parse(JSON.stringify(state)); },
        load: () => saved,
        setTimer: () => ({ clear: () => undefined }),
        onSettled, onQueued,
        ...overrides,
    };
    const queue = createIdleRestart(deps);
    return { queue, restart, onSettled, onQueued, busy, sessions, advance: (ms: number) => { now += ms; }, saved: () => saved, deps };
}

describe('B-911 idle restart queue', () => {
    it('owner request: waits while the turn runs, restarts after turn_ended + quiet; never while busy (control)', async () => {
        const { queue, restart, busy, advance, onQueued, onSettled } = setup();
        busy.add('lead');
        queue.noteTurn('lead', 'turn_started');
        expect(await queue.request({ sessionId: 'lead', source: 'owner', target: '0.2.209' })).toMatchObject({ ok: true, state: 'queued' });
        expect(onQueued).toHaveBeenCalledWith('lead', expect.objectContaining({ source: 'owner', target: '0.2.209' }));
        // Control: a turn in flight for far longer than every window — never restarted.
        for (let i = 0; i < 30; i++) { advance(60_000); queue.noteTurn('lead', 'turn_started'); await queue.check(); }
        expect(restart).not.toHaveBeenCalled();
        expect(queue.status('lead')).toMatchObject({ wait: 'turn-active' });
        // The turn ends; still inside the quiet spell.
        busy.delete('lead');
        queue.noteTurn('lead', 'turn_ended');
        advance(QUIET - 1);
        await queue.check();
        expect(restart).not.toHaveBeenCalled();
        expect(queue.status('lead')).toMatchObject({ wait: 'quiet' });
        advance(1);
        await queue.check();
        expect(restart).toHaveBeenCalledTimes(1);
        expect(restart).toHaveBeenCalledWith('lead', expect.objectContaining({ source: 'owner' }));
        expect(onSettled).toHaveBeenCalledWith('lead', expect.anything(), { ok: true });
        expect(queue.status('lead')).toBeUndefined();
    });

    it('a session that looks idle at once still waits one observation window (a running turn renews its lease within it)', async () => {
        const { queue, restart, advance } = setup();
        await queue.request({ sessionId: 'lead', source: 'owner' });
        advance(OBSERVE - 1);
        await queue.check();
        expect(restart).not.toHaveBeenCalled();
        expect(queue.status('lead')).toMatchObject({ wait: 'observing' });
        advance(1);
        await queue.check();
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it('refuses what it cannot restart or prove idle', async () => {
        const { queue } = setup({}, {
            term: { live: true, wrapperVersion: '0.2.200', flavor: 'claude', startedBy: 'terminal' },
            ancient: { live: true, wrapperVersion: '0.2.130', flavor: 'claude' },
            asst: { live: true, wrapperVersion: '0.2.200', flavor: 'claude', variant: 'assistant' },
            gem: { live: true, wrapperVersion: '0.2.200', flavor: 'gemini' },
        });
        expect(await queue.request({ sessionId: 'gone', source: 'owner' })).toEqual({ ok: false, code: 'not-live' });
        expect(await queue.request({ sessionId: 'term', source: 'owner' })).toEqual({ ok: false, code: 'local-terminal' });
        expect(await queue.request({ sessionId: 'ancient', source: 'owner' })).toEqual({ ok: false, code: 'no-turn-reports' });
        expect(await queue.request({ sessionId: 'asst', source: 'agent' })).toEqual({ ok: false, code: 'assistant' });
        expect(await queue.request({ sessionId: 'gem', source: 'agent' })).toEqual({ ok: false, code: 'unsupported-flavor' });
        const unresumable = setup({ resumable: async () => false });
        expect(await unresumable.queue.request({ sessionId: 'lead', source: 'owner' })).toEqual({ ok: false, code: 'not-resumable' });
    });

    it('agent limits: one pending (idempotent), cooldown after a restart, 3 per 24 h, pending TTL', async () => {
        const { queue, restart, advance } = setup({}, { me: { live: true, wrapperVersion: '0.2.210', flavor: 'claude' } });
        expect(await queue.request({ sessionId: 'me', source: 'agent' })).toMatchObject({ ok: true, state: 'queued' });
        expect(await queue.request({ sessionId: 'me', source: 'agent' })).toMatchObject({ ok: true, state: 'already-queued' });
        advance(OBSERVE);
        await queue.check();
        expect(restart).toHaveBeenCalledTimes(1);
        // Right after its restart: cooldown.
        expect(await queue.request({ sessionId: 'me', source: 'agent' })).toMatchObject({ ok: false, code: 'cooldown' });
        advance(AGENT_RESTART_COOLDOWN_MS);
        expect(await queue.request({ sessionId: 'me', source: 'agent' })).toMatchObject({ ok: true, state: 'queued' });
        advance(OBSERVE); await queue.check();
        advance(AGENT_RESTART_COOLDOWN_MS);
        expect(await queue.request({ sessionId: 'me', source: 'agent' })).toMatchObject({ ok: true, state: 'queued' });
        advance(OBSERVE); await queue.check();
        expect(restart).toHaveBeenCalledTimes(3);
        advance(AGENT_RESTART_COOLDOWN_MS);
        const fourth = await queue.request({ sessionId: 'me', source: 'agent' });
        expect(fourth).toMatchObject({ ok: false, code: 'rate-limited' });
        expect(fourth.ok === false && fourth.retryAfterMs).toBeGreaterThan(0);
        // The owner is not rate-limited.
        expect(await queue.request({ sessionId: 'me', source: 'owner' })).toMatchObject({ ok: true, state: 'queued' });
    });

    it('an agent request never idle within its lifetime is dropped; the owner\'s is kept', async () => {
        const { queue, restart, busy, advance, onSettled } = setup({}, { me: { live: true, wrapperVersion: '0.2.210', flavor: 'claude' } });
        busy.add('me'); busy.add('lead');
        await queue.request({ sessionId: 'me', source: 'agent' });
        await queue.request({ sessionId: 'lead', source: 'owner' });
        advance(AGENT_RESTART_PENDING_TTL_MS);
        await queue.check();
        expect(queue.status('me')).toBeUndefined();
        expect(queue.status('lead')).toBeDefined();
        expect(onSettled).toHaveBeenCalledWith('me', expect.anything(), { ok: false, error: 'never idle within the request lifetime' });
        expect(restart).not.toHaveBeenCalled();
    });

    it('the wrapper exiting drops the request, except the exit of our own restart', async () => {
        let queueRef: ReturnType<typeof createIdleRestart> | null = null;
        const { queue, advance, onSettled } = setup({ restart: async (id) => { queueRef!.forget(id); return { ok: true }; } });
        queueRef = queue;
        await queue.request({ sessionId: 'lead', source: 'owner' });
        advance(OBSERVE);
        await queue.check();
        expect(queue.status('lead')).toBeUndefined();
        // Settled once, as restarted — the stop of our own restart is not "wrapper exited".
        expect(onSettled.mock.calls).toEqual([['lead', expect.anything(), { ok: true }]]);
        const other = setup();
        await other.queue.request({ sessionId: 'lead', source: 'owner' });
        other.queue.forget('lead');
        expect(other.onSettled).toHaveBeenCalledWith('lead', expect.anything(), { ok: false, error: 'wrapper exited' });
        expect(other.restart).not.toHaveBeenCalled();
    });

    it('persists the queue and the agent history across a daemon handover', async () => {
        const first = setup({}, { me: { live: true, wrapperVersion: '0.2.210', flavor: 'claude' } });
        await first.queue.request({ sessionId: 'lead', source: 'owner', target: '0.2.209' });
        await first.queue.request({ sessionId: 'me', source: 'agent' });
        const saved = first.saved()!;
        expect(Object.keys(saved.pending).sort()).toEqual(['lead', 'me']);
        const second = setup({ load: () => saved }, { me: { live: true, wrapperVersion: '0.2.210', flavor: 'claude' } });
        expect(second.queue.status('lead')).toMatchObject({ source: 'owner', target: '0.2.209' });
        expect(await second.queue.request({ sessionId: 'me', source: 'agent' })).toMatchObject({ ok: true, state: 'already-queued' });
    });

    it('after a daemon handover an inherited request waits a full window again: the new daemon has not seen a lease yet', async () => {
        const first = setup();
        await first.queue.request({ sessionId: 'lead', source: 'owner' });
        first.advance(10 * OBSERVE); // long before the handover
        const saved = first.saved()!;
        let t = 2_000_000_000;
        const handover = setup({ load: () => saved, now: () => t });
        await handover.queue.check();
        expect(handover.restart).not.toHaveBeenCalled();
        expect(handover.queue.status('lead')).toMatchObject({ wait: 'observing' });
        // The wrapper's next lease renewal arrives inside the window: busy → still nothing.
        t += 30_000; handover.busy.add('lead'); handover.queue.noteTurn('lead', 'turn_started');
        t += OBSERVE; await handover.queue.check();
        expect(handover.restart).not.toHaveBeenCalled();
        handover.busy.delete('lead'); handover.queue.noteTurn('lead', 'turn_ended');
        t += QUIET; await handover.queue.check();
        expect(handover.restart).toHaveBeenCalledTimes(1);
    });

    it('one restart at a time; a failure is reported and not retried by itself', async () => {
        let release: (v: { ok: false; error: string }) => void = () => undefined;
        const restart = vi.fn(() => new Promise<{ ok: false; error: string }>((r) => { release = r; }));
        const { queue, advance, onSettled } = setup({ restart }, { b: { live: true, wrapperVersion: '0.2.181', flavor: 'claude' } });
        await queue.request({ sessionId: 'lead', source: 'owner' });
        await queue.request({ sessionId: 'b', source: 'owner' });
        advance(OBSERVE);
        const pass = queue.check();
        await queue.check();
        expect(restart).toHaveBeenCalledTimes(1);
        expect(queue.status('lead')).toMatchObject({ restarting: true });
        release({ ok: false, error: 'restart-precheck:cwd-missing' });
        await pass;
        expect(onSettled).toHaveBeenCalledWith('lead', expect.anything(), { ok: false, error: 'restart-precheck:cwd-missing' });
        expect(queue.status('lead')).toBeUndefined();
    });
});

// B-919: the main agent's session_restart (owner request) — the same guards as the B-911 queue.
describe('owner restart for the main agent (B-919)', () => {
    const live = { live: true, wrapperVersion: '0.2.211', flavor: 'claude', variant: null, startedBy: 'daemon' };
    const make = (over: Partial<Parameters<typeof ownerRestartRequest>[1]> = {}) => {
        const calls: string[] = [];
        const deps: Parameters<typeof ownerRestartRequest>[1] = {
            queue: async (id) => { calls.push(`queue:${id}`); return { ok: true, state: 'queued', requestedAt: 1 }; },
            facts: () => live,
            queued: () => false,
            activity: () => ({ turnActive: false, backgroundTasks: 0, automationRunning: false, upgradePending: null, lastTurnEventAt: 1_000 }),
            quietMs: 30_000,
            now: () => 100_000,
            watchingSince: 0,
            minObserveMs: 65_000,
            restartIfIdle: async (id) => { calls.push(`restart:${id}`); return { ok: true }; },
            version: '0.2.212',
            ...over,
        };
        return { deps, calls };
    };
    it('idle → the owner queue (its refusals pass through)', async () => {
        const { deps, calls } = make();
        expect(await ownerRestartRequest({ sessionId: 's', when: 'idle' }, deps)).toEqual({ ok: true, state: 'queued', targetVersion: '0.2.212' });
        expect(calls).toEqual(['queue:s']);
        const refused = make({ queue: async () => ({ ok: false, code: 'local-terminal' }) });
        expect(await ownerRestartRequest({ sessionId: 's', when: 'idle' }, refused.deps)).toEqual({ ok: false, code: 'local-terminal' });
    });
    it('now → never restarts a terminal / assistant / old / dead / already-queued / not-yet-idle session; the ifIdle restart re-checks', async () => {
        for (const [facts, code] of [
            [{ ...live, startedBy: 'terminal' }, 'local-terminal'],
            [{ ...live, variant: 'assistant' }, 'assistant'],
            [{ ...live, wrapperVersion: '0.2.100' }, 'no-turn-reports'],
            [null, 'not-live'],
        ] as const) {
            const { deps, calls } = make({ facts: () => facts });
            expect(await ownerRestartRequest({ sessionId: 's', when: 'now' }, deps)).toEqual({ ok: false, code });
            expect(calls).toEqual([]);
        }
        const queued = make({ queued: () => true });
        expect(await ownerRestartRequest({ sessionId: 's', when: 'now' }, queued.deps)).toEqual({ ok: false, code: 'already-queued' });
        expect(queued.calls).toEqual([]);
        // QA P2-2: the owner's `now` is as strict as the queue — a turn that just ended and a running automation are refused, nothing is stopped.
        const idleActivity = { turnActive: false, backgroundTasks: 0, automationRunning: false, upgradePending: null, lastTurnEventAt: 1_000 };
        for (const [activity, error] of [
            [{ ...idleActivity, lastTurnEventAt: 100_000 - 5_000 }, 'busy:quiet'],
            [{ ...idleActivity, automationRunning: true }, 'busy:automation-run'],
            [{ ...idleActivity, turnActive: true }, 'busy:turn-active'],
            [{ ...idleActivity, backgroundTasks: 2 }, 'busy:background-tasks'],
            [{ ...idleActivity, upgradePending: '0.2.300' }, 'busy:upgrade-pending'],
        ] as const) {
            const refused = make({ activity: () => activity });
            expect(await ownerRestartRequest({ sessionId: 's', when: 'now' }, refused.deps)).toEqual({ ok: false, code: 'busy', error });
            expect(refused.calls).toEqual([]);
        }
        // QA round 3: right after a daemon start / handover nothing is known yet (turnActive=false, no tasks, no turn edge) → observing, not idle.
        for (const watchingSince of [100_000, 100_000 - 64_999]) {
            const fresh = make({ watchingSince, activity: () => ({ turnActive: false, backgroundTasks: 0, automationRunning: false, upgradePending: null, lastTurnEventAt: null }) });
            expect(await ownerRestartRequest({ sessionId: 's', when: 'now' }, fresh.deps)).toEqual({ ok: false, code: 'busy', error: 'busy:observing' });
            expect(fresh.calls).toEqual([]);
        }
        const watched = make({ watchingSince: 100_000 - 65_000, activity: () => ({ ...idleActivity, lastTurnEventAt: null }) });
        expect(await ownerRestartRequest({ sessionId: 's', when: 'now' }, watched.deps)).toMatchObject({ ok: true, state: 'restarted' });
        // `idle` is unaffected: the queue has its own observation window.
        const freshIdle = make({ watchingSince: 100_000 });
        expect(await ownerRestartRequest({ sessionId: 's', when: 'idle' }, freshIdle.deps)).toMatchObject({ ok: true, state: 'queued' });
        // Quiet for longer than quietMs (or never seen a turn edge) → allowed.
        const quiet = make({ activity: () => ({ ...idleActivity, lastTurnEventAt: 100_000 - 30_000 }) });
        expect(await ownerRestartRequest({ sessionId: 's', when: 'now' }, quiet.deps)).toMatchObject({ ok: true, state: 'restarted' });
        const busy = make({ restartIfIdle: async () => ({ ok: false, error: 'busy:turn-active' }) });
        expect(await ownerRestartRequest({ sessionId: 's', when: 'now' }, busy.deps)).toEqual({ ok: false, code: 'busy', error: 'busy:turn-active' });
        const { deps, calls } = make();
        expect(await ownerRestartRequest({ sessionId: 's', when: 'now' }, deps)).toEqual({ ok: true, state: 'restarted', targetVersion: '0.2.212' });
        expect(calls).toEqual(['restart:s']);
    });
    it('the session guards are the queue\'s own', () => {
        expect(idleRestartSessionRefusal(live)).toBeNull();
        expect(idleRestartSessionRefusal({ ...live, flavor: 'gemini' })).toBe('unsupported-flavor');
    });
});
