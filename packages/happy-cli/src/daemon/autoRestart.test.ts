import { describe, expect, it, vi } from 'vitest';
import { createAutoRestart, type AutoRestartDeps, type AutoRestartTracked } from './autoRestart';
import { AUTO_RESTART_BACKOFF_MS, AUTO_RESTART_MIN_GAP_MS, AUTO_RESTART_QUIET_MS } from '@/update/autoRestartPolicy';
import type { WrapperIdleSnapshot } from '@/hibernation/hibernationPolicy';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve)).then(() => new Promise<void>((resolve) => setImmediate(resolve)));

function setup(overrides: Partial<AutoRestartDeps> = {}, sessions: Record<string, AutoRestartTracked> = {}) {
    let now = 10 * AUTO_RESTART_QUIET_MS;
    const published: Array<Record<string, unknown>> = [];
    const live: Record<string, AutoRestartTracked> = {
        a: { live: true, wrapperVersion: '0.2.188', flavor: 'claude', capabilities: ['agent-hibernation-v1'] },
        b: { live: true, wrapperVersion: '0.2.188', flavor: 'codex', capabilities: ['agent-hibernation-v1'] },
        ...sessions,
    };
    const restart = vi.fn<AutoRestartDeps['restart']>(async (sessionId) => {
        live[sessionId] = { ...live[sessionId], wrapperVersion: '0.2.190' };
        return { ok: true };
    });
    const deps: AutoRestartDeps = {
        enabled: () => true,
        daemonVersion: '0.2.190',
        installedAgentVersion: () => null,
        tracked: (sessionId) => live[sessionId] ?? null,
        liveSessions: () => Object.entries(live).map(([sessionId, t]) => ({ sessionId, ...t })),
        turnActive: () => false,
        backgroundTasks: () => 0,
        automationRunning: () => false,
        resumable: async () => true,
        restart,
        publish: (sessions) => { published.push(sessions); },
        now: () => now,
        random: () => 0,
        ...overrides,
    };
    const scheduler = createAutoRestart(deps);
    const report = (o: Partial<WrapperIdleSnapshot> = {}): WrapperIdleSnapshot => ({
        flavor: 'claude', resumable: true, uiSession: true, keepAwake: false, thinking: false, queuedInputs: 0,
        waitingForInput: true, pendingRequests: 0, backgroundTasks: 0, lastActivityAt: now - AUTO_RESTART_QUIET_MS, ...o,
    });
    return { scheduler, restart, published, live, report, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('B-852 createAutoRestart', () => {
    it('an idle stale wrapper checking in is restarted (after the reply), then dropped from status', async () => {
        const { scheduler, restart, report } = setup();
        const reply = await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() });
        expect(reply.restarting).toBe(true);
        expect(restart).not.toHaveBeenCalled();
        expect(scheduler.statuses().a?.state).toBe('restarting');
        await flush();
        expect(restart).toHaveBeenCalledWith('a', { kind: 'cli', from: '0.2.188', target: '0.2.190' });
        expect(scheduler.statuses().a).toBeUndefined();
    });

    it('a current wrapper is never touched', async () => {
        const { scheduler, restart, report } = setup({}, { a: { live: true, wrapperVersion: '0.2.190', flavor: 'claude' } });
        expect(await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() })).toEqual({ nextCheckMs: null, restarting: false });
        expect(restart).not.toHaveBeenCalled();
    });

    it('busy → waits with a reason and asks for the next check at the right time; restarts once it is idle', async () => {
        const { scheduler, restart, report, advance } = setup();
        const busy = await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report({ lastActivityAt: 0 + 10 * AUTO_RESTART_QUIET_MS - 60_000 }) });
        expect(busy).toEqual({ nextCheckMs: AUTO_RESTART_QUIET_MS - 60_000, restarting: false });
        expect(scheduler.statuses().a).toMatchObject({ state: 'waiting', reason: 'recent-activity', target: '0.2.190' });
        const since = scheduler.statuses().a!.since;
        advance(AUTO_RESTART_QUIET_MS);
        await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report({ backgroundTasks: 1 }) });
        expect(scheduler.statuses().a).toMatchObject({ state: 'waiting', reason: 'background-tasks', since });
        expect((await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() })).restarting).toBe(true);
        await flush();
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it('one restart at a time per machine, then a gap', async () => {
        let release!: () => void;
        const { scheduler, report, advance } = setup({ restart: vi.fn(() => new Promise<{ ok: true }>((resolve) => { release = () => resolve({ ok: true }); })) });
        expect((await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() })).restarting).toBe(true);
        await flush();
        expect(await scheduler.onCheckIn({ sessionId: 'b', pid: 2, report: report({ flavor: 'codex' }) })).toEqual({ nextCheckMs: AUTO_RESTART_MIN_GAP_MS, restarting: false });
        release();
        await flush();
        expect((await scheduler.onCheckIn({ sessionId: 'b', pid: 2, report: report({ flavor: 'codex' }) })).restarting).toBe(false);
        advance(AUTO_RESTART_MIN_GAP_MS);
        expect((await scheduler.onCheckIn({ sessionId: 'b', pid: 2, report: report({ flavor: 'codex' }) })).restarting).toBe(true);
    });

    it('a second check-in while restarting cannot double-start', async () => {
        const { scheduler, restart, report } = setup();
        await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() });
        await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() });
        await flush();
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it('turn started between the check-in and the stop → no stop, no attempt burned', async () => {
        let turn = false;
        const { scheduler, restart, report } = setup({ turnActive: () => turn });
        await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() });
        turn = true;
        await flush();
        expect(restart).not.toHaveBeenCalled();
        expect(scheduler.statuses().a?.state).toBe('waiting');
    });

    it('failure → backoff → second failure → failed with the reason; never a third try', async () => {
        const { scheduler, report, advance } = setup({ restart: vi.fn(async () => ({ ok: false as const, error: 'restart-precheck:cwd-missing: /x' })) });
        await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() });
        await flush();
        expect(scheduler.statuses().a).toMatchObject({ state: 'waiting', reason: 'backoff' });
        expect((await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() })).nextCheckMs).toBe(AUTO_RESTART_BACKOFF_MS);
        advance(AUTO_RESTART_BACKOFF_MS);
        await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() });
        await flush();
        expect(scheduler.statuses().a).toMatchObject({ state: 'failed', reason: 'restart-precheck:cwd-missing: /x' });
        advance(100 * AUTO_RESTART_BACKOFF_MS);
        expect((await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() })).restarting).toBe(false);
        expect(scheduler.statuses().a?.state).toBe('failed');
    });

    it('a thrown restart counts as a failure (no unhandled rejection, slot released)', async () => {
        const { scheduler, report } = setup({ restart: vi.fn(async () => { throw new Error('boom'); }) });
        await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() });
        await flush();
        expect(scheduler.inFlight()).toBe(0);
        expect(scheduler.statuses().a).toMatchObject({ state: 'waiting', reason: 'backoff' });
    });

    it('sweep: never-reporting wrappers are manual at once, reporting ones wait; caught-up and gone ones disappear', () => {
        const { scheduler, live } = setup({}, {
            team: { live: true, wrapperVersion: '0.2.150', flavor: 'claude', capabilities: ['agent-hibernation-v1'], spawnedBy: 'teams' },
            old: { live: true, wrapperVersion: '0.2.150', flavor: 'claude', capabilities: [] },
        });
        scheduler.sweep();
        expect(scheduler.statuses()).toMatchObject({
            a: { state: 'waiting', reason: 'awaiting-check-in' },
            team: { state: 'manual', reason: 'no-report' },
            old: { state: 'manual' },
        });
        delete live.old;
        live.team = { ...live.team, wrapperVersion: '0.2.190' };
        scheduler.sweep();
        expect(Object.keys(scheduler.statuses()).sort()).toEqual(['a', 'b']);
    });

    it('switch off → no restart and nothing published as waiting', async () => {
        const { scheduler, restart, report } = setup({ enabled: () => false });
        scheduler.sweep();
        expect((await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() })).restarting).toBe(false);
        expect(restart).not.toHaveBeenCalled();
        expect(scheduler.statuses()).toEqual({});
    });

    it('a conversation that is not on disk (server metadata) is handed to the user', async () => {
        const { scheduler, restart, report } = setup({ resumable: async () => false });
        expect((await scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() })).restarting).toBe(false);
        expect(restart).not.toHaveBeenCalled();
        expect(scheduler.statuses().a).toMatchObject({ state: 'manual', reason: 'not-resumable' });
    });

    it('two sessions passing the cheap rules at once still start only one restart', async () => {
        let release!: () => void;
        const gate = new Promise<boolean>((resolve) => { release = () => resolve(true); });
        const { scheduler, report } = setup({ resumable: () => gate });
        const a = scheduler.onCheckIn({ sessionId: 'a', pid: 1, report: report() });
        const b = scheduler.onCheckIn({ sessionId: 'b', pid: 2, report: report({ flavor: 'codex' }) });
        release();
        const results = await Promise.all([a, b]);
        expect(results.filter((r) => r.restarting)).toHaveLength(1);
    });

    it('publishes only on change', () => {
        const { scheduler, published } = setup();
        scheduler.sweep();
        scheduler.sweep();
        expect(published).toHaveLength(1);
    });

    it('Codex whose agent binary was updated since it started (B-487) is restarted too', async () => {
        const { scheduler, restart, report } = setup({ installedAgentVersion: (flavor) => (flavor === 'codex' ? '0.155.0' : null) }, {
            b: { live: true, wrapperVersion: '0.2.190', flavor: 'codex', capabilities: ['agent-hibernation-v1', 'auto-restart-v1'] },
        });
        expect((await scheduler.onCheckIn({ sessionId: 'b', pid: 2, report: { ...report({ flavor: 'codex' }), agentVersion: '0.154.0' } })).restarting).toBe(true);
        await flush();
        expect(restart).toHaveBeenCalledWith('b', { kind: 'agent', from: '0.154.0', target: '0.155.0' });
    });
});
