import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_TASKS_LEASE_MS, BACKGROUND_TASKS_TTL_MS, BackgroundTaskReporter, BackgroundTaskTracker, backgroundTasksReport } from './backgroundTaskActivity';

const task = (id: string, description = 'd') => ({ id, type: 'local_bash', description, startedAt: 1 });

describe('BackgroundTaskReporter (B-507, wrapper side)', () => {
    it('publishes on a change, renews every lease while non-empty, stays silent when idle', () => {
        const publish = vi.fn();
        const r = new BackgroundTaskReporter(publish);
        expect(r.observe([], 0)).toBe(false);                    // empty → empty: nothing to say
        expect(r.observe([task('a')], 1_000)).toBe(true);        // edge
        expect(r.observe([task('a')], 3_000)).toBe(false);       // same set, lease not due
        expect(r.observe([task('a')], 1_000 + BACKGROUND_TASKS_LEASE_MS - 1)).toBe(false);
        expect(r.observe([task('a')], 1_000 + BACKGROUND_TASKS_LEASE_MS)).toBe(true); // renewal
        expect(r.observe([task('a'), task('b')], 70_000)).toBe(true); // membership edge
        expect(r.observe([task('a'), task('b', 'renamed')], 71_000)).toBe(true); // description edge
        expect(r.observe([], 80_000)).toBe(true);                // falling edge publishes the empty set
        expect(r.observe([], 200_000)).toBe(false);              // empty never renews
        expect(publish.mock.calls.map((c) => [c[0].map((t: any) => t.id), c[1]])).toEqual([
            [['a'], 1_000], [['a'], 1_000 + BACKGROUND_TASKS_LEASE_MS], [['a', 'b'], 70_000], [['a', 'b'], 71_000], [[], 80_000],
        ]);
        expect(r.current()).toEqual([]);
    });
});

describe('BackgroundTaskTracker (B-507, daemon side)', () => {
    it('reports the last set until an empty publish, forget, or TTL expiry', () => {
        const t = new BackgroundTaskTracker();
        expect(t.report('s1', 0)).toEqual({ count: 0, tasks: [] });
        t.apply('s1', [task('a')], 1_000);
        expect(t.report('s1', 1_000)).toEqual({ count: 1, tasks: [task('a')], reportedAt: 1_000 });
        expect(t.count('s1', 1_000 + BACKGROUND_TASKS_TTL_MS)).toBe(1);
        expect(t.report('s1', 1_000 + BACKGROUND_TASKS_TTL_MS + 1)).toEqual({ count: 0, tasks: [], reportedAt: 1_000, stale: true });
        // once expired it is dropped, not reported stale forever
        expect(t.report('s1', 1_000 + BACKGROUND_TASKS_TTL_MS + 2)).toEqual({ count: 0, tasks: [] });
        t.apply('s1', [task('a')], 5_000);
        t.apply('s1', [task('a')], 5_000 + BACKGROUND_TASKS_LEASE_MS); // renewal extends
        expect(t.count('s1', 5_000 + BACKGROUND_TASKS_LEASE_MS + BACKGROUND_TASKS_TTL_MS)).toBe(1);
        t.apply('s1', [], 200_000);
        expect(t.count('s1', 200_000)).toBe(0);
        t.apply('s2', [task('b')], 200_000);
        t.forget('s2');
        expect(t.hasAny(200_000)).toBe(false);
    });

    it('one session with background tasks keeps the machine busy; expired or empty ones do not', () => {
        const t = new BackgroundTaskTracker();
        t.apply('quiet', [], 0);
        t.apply('old', [task('x')], 0);
        t.apply('busy', [task('y')], 100_000);
        expect(t.activeSessions(100_000 + BACKGROUND_TASKS_TTL_MS)).toEqual(['busy']);
        expect(t.hasAny(100_000 + BACKGROUND_TASKS_TTL_MS)).toBe(true);
        expect(t.hasAny(100_000 + BACKGROUND_TASKS_TTL_MS + 1)).toBe(false);
    });
});

describe('backgroundTasksReport (B-507, agentState reader)', () => {
    it('is empty without a stored set, fresh inside the TTL, stale past it or when no wrapper is attached', () => {
        expect(backgroundTasksReport(undefined, 0)).toEqual({ count: 0, tasks: [] });
        expect(backgroundTasksReport(null, 0)).toEqual({ count: 0, tasks: [] });
        expect(backgroundTasksReport({ updatedAt: 10, tasks: [] }, 20)).toEqual({ count: 0, tasks: [], reportedAt: 10 });
        const stored = { updatedAt: 1_000, tasks: [task('a')] };
        expect(backgroundTasksReport(stored, 1_000 + BACKGROUND_TASKS_TTL_MS, { active: true })).toEqual({ count: 1, tasks: [task('a')], reportedAt: 1_000 });
        expect(backgroundTasksReport(stored, 1_000 + BACKGROUND_TASKS_TTL_MS + 1, { active: true })).toEqual({ count: 0, tasks: [], reportedAt: 1_000, stale: true });
        expect(backgroundTasksReport(stored, 1_000, { active: false })).toEqual({ count: 0, tasks: [], reportedAt: 1_000, stale: true });
        // a set without a timestamp cannot be trusted at all
        expect(backgroundTasksReport({ tasks: [task('a')] }, 1_000)).toEqual({ count: 0, tasks: [], stale: true });
        // garbage entries are dropped rather than crashing the listing
        expect(backgroundTasksReport({ updatedAt: 1_000, tasks: [null as any, task('b')] }, 1_000).count).toBe(1);
    });
});

describe('daemon / wrapper wiring (B-507)', () => {
    // Verified with scripts/dev/mutation-check.mjs (see PR).
    const run = readFileSync(join(__dirname, '..', 'daemon', 'run.ts'), 'utf8');
    const apiSession = readFileSync(join(__dirname, '..', 'api', 'apiSession.ts'), 'utf8');
    const controlServer = readFileSync(join(__dirname, '..', 'daemon', 'controlServer.ts'), 'utf8');
    const runner = readFileSync(join(__dirname, '..', 'daemon', 'automations', 'runner.ts'), 'utf8');

    it('install AND handover also wait for "no background task in flight"', () => {
        expect(run).toContain('idle: () => !turnActivity.hasActiveTurn() && !backgroundTasks.hasAny(),');
        expect(run).toContain('if (bundleReplaced && !teamWorker?.busy && !automationRunner?.busy && !updateController.isRunning() && !turnActivity.hasActiveTurn() && !backgroundTasks.hasAny()) {');
        expect(run).toContain('if (teamWorker?.busy || automationRunner?.busy || updateController.isRunning() || turnActivity.hasActiveTurn() || backgroundTasks.hasAny()) return;');
        // an exited wrapper releases its set; the control server feeds the tracker and /list reads it
        expect(run).toContain('if (session?.happySessionId) backgroundTasks.forget(session.happySessionId);');
        expect(run).toContain('onSessionBackgroundTasks: (sessionId, tasks) => backgroundTasks.apply(sessionId, tasks),');
        expect(run).toContain('getBackgroundTasks: (sessionId) => backgroundTasks.report(sessionId),');
        // the Automations runner is told too
        expect(run).toContain('backgroundTasks: id => backgroundTasks.count(id),');
    });

    it('the wrapper heartbeats the count and publishes the set to the daemon AND into agentState', () => {
        expect(apiSession).toContain('if (backgroundTasks) this.backgroundTaskReporter.observe(backgroundTasks);');
        expect(apiSession).toContain('...(backgroundTasks ? { backgroundTasks: backgroundTasks.length } : {}),');
        expect(apiSession).toContain('void notifyDaemonBackgroundTasks(this.sessionId, tasks)');
        expect(apiSession).toContain('backgroundTasks: tasks.length > 0 ? { updatedAt: now, tasks } : undefined,');
    });

    it('the control server accepts the event, routes it only to the tracker, and lists the report', () => {
        expect(controlServer).toContain("event: z.enum(['completed', 'needs_input', 'auth_failed', 'turn_started', 'turn_ended', 'background_tasks']),");
        expect(controlServer).toContain("if (event === 'background_tasks') {\n        // B-507: the daemon's own tracker is the only consumer.\n        onSessionBackgroundTasks?.(sessionId, request.body.backgroundTasks ?? []);\n        return { status: 'ok' as const };");
        expect(controlServer).toContain('...(getBackgroundTasks ? { backgroundTasks: getBackgroundTasks(child.happySessionId!) } : {}),');
    });

    it('an Automations run whose turn ended is held open while background tasks are running', () => {
        expect(runner).toContain('const background = deps.backgroundTasks?.(sessionId) ?? 0;\n            if (background > 0 && turn.status !== \'failed\' && turn.status !== \'cancelled\') {');
    });
});
