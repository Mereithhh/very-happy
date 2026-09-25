import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_TASKS_MAX, BACKGROUND_TASK_DESCRIPTION_MAX, createBackgroundTaskTracker, sameBackgroundTasks } from './backgroundTasks';

const sys = (subtype: string, fields: Record<string, unknown>) => ({ type: 'system', subtype, uuid: 'u', session_id: 's', ...fields }) as any;
const ids = (tracker: ReturnType<typeof createBackgroundTaskTracker>) => tracker.list().map((task) => task.id);

describe('B-507 background task tracker (wrapper side, pure)', () => {
    it('background_tasks_changed is the level: replaces the set, keeps startedAt, drops ambient tasks', () => {
        const t = createBackgroundTaskTracker();
        t.observe(sys('background_tasks_changed', { tasks: [{ task_id: 'a', task_type: 'local_bash', description: 'sleep 300' }] }), 1_000);
        expect(t.list()).toEqual([{ id: 'a', type: 'local_bash', description: 'sleep 300', startedAt: 1_000 }]);
        t.observe(sys('background_tasks_changed', { tasks: [
            { task_id: 'a', task_type: 'local_bash', description: 'sleep 300' },
            { task_id: 'b', task_type: 'local_agent', description: 'Explore repo' },
            { task_id: 'watch', task_type: 'monitor', description: 'live-update watcher', ambient: true },
        ] }), 5_000);
        expect(t.list()).toEqual([
            { id: 'a', type: 'local_bash', description: 'sleep 300', startedAt: 1_000 },
            { id: 'b', type: 'local_agent', description: 'Explore repo', startedAt: 5_000 },
        ]);
        // a task missing from the next level payload is gone, however it ended
        t.observe(sys('background_tasks_changed', { tasks: [{ task_id: 'b', task_type: 'local_agent', description: 'Explore repo' }] }), 9_000);
        expect(ids(t)).toEqual(['b']);
        t.observe(sys('background_tasks_changed', { tasks: [] }), 9_500);
        expect(t.list()).toEqual([]);
    });

    it('edges: only a backgrounded task_started counts; a later move to the background keeps the foreground description; notification / settled patch remove', () => {
        const t = createBackgroundTaskTracker();
        t.observe(sys('task_started', { task_id: 'fg', tool_use_id: 'tu-fg', task_type: 'local_agent', description: 'Foreground agent', is_backgrounded: false }), 1_000);
        t.observe(sys('task_started', { task_id: 'bg', tool_use_id: 'tu-bg', task_type: 'local_bash', description: 'pnpm test', is_backgrounded: true }), 1_100);
        t.observe(sys('task_started', { task_id: 'housekeeping', task_type: 'local_workflow', description: 'x', is_backgrounded: true, skip_transcript: true }), 1_150);
        t.observe(sys('task_started', { task_id: 'watch', task_type: 'monitor', description: 'x', is_backgrounded: true, ambient: true }), 1_150);
        expect(ids(t)).toEqual(['bg']);
        // Ctrl-B on the foreground agent
        t.observe(sys('task_updated', { task_id: 'fg', patch: { is_backgrounded: true } }), 2_000);
        expect(t.list()).toEqual([
            { id: 'bg', type: 'local_bash', description: 'pnpm test', startedAt: 1_100 },
            { id: 'fg', type: 'local_agent', description: 'Foreground agent', startedAt: 2_000 },
        ]);
        t.observe(sys('task_progress', { task_id: 'bg', description: 'pnpm test', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }), 2_500);
        expect(ids(t)).toEqual(['bg', 'fg']);
        t.observe(sys('task_notification', { task_id: 'bg', status: 'completed', output_file: '/tmp/x', summary: 'done' }), 3_000);
        expect(ids(t)).toEqual(['fg']);
        t.observe(sys('task_updated', { task_id: 'fg', patch: { status: 'killed' } }), 3_500);
        expect(t.list()).toEqual([]);
    });

    it('a foreground Agent whose tool_result is the async stub moved to the background (old-runtime fallback)', () => {
        const t = createBackgroundTaskTracker();
        t.observe(sys('task_started', { task_id: 'agent-1', tool_use_id: 'toolu_1', task_type: 'local_agent', description: 'Research' }), 1_000);
        expect(t.list()).toEqual([]);
        t.observe({ type: 'user', tool_use_result: { status: 'async_launched' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched' }] } } as any, 2_000);
        expect(t.list()).toEqual([{ id: 'agent-1', type: 'local_agent', description: 'Research', startedAt: 2_000 }]);
        // a completed foreground result is not a background task
        t.observe(sys('task_started', { task_id: 'agent-2', tool_use_id: 'toolu_2', task_type: 'local_agent', description: 'Quick' }), 2_500);
        t.observe({ type: 'user', tool_use_result: { status: 'completed', content: [] }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'report' }] } } as any, 3_000);
        expect(ids(t)).toEqual(['agent-1']);
    });

    it('level and edges agree on one transition whichever arrives first', () => {
        const levelFirst = createBackgroundTaskTracker();
        levelFirst.observe(sys('background_tasks_changed', { tasks: [{ task_id: 'a', task_type: 'local_bash', description: 'd' }] }), 1_000);
        levelFirst.observe(sys('task_started', { task_id: 'a', tool_use_id: 'tu', task_type: 'local_bash', description: 'd', is_backgrounded: true }), 1_001);
        const edgeFirst = createBackgroundTaskTracker();
        edgeFirst.observe(sys('task_started', { task_id: 'a', tool_use_id: 'tu', task_type: 'local_bash', description: 'd', is_backgrounded: true }), 1_000);
        edgeFirst.observe(sys('background_tasks_changed', { tasks: [{ task_id: 'a', task_type: 'local_bash', description: 'd' }] }), 1_001);
        expect(levelFirst.list()).toEqual(edgeFirst.list());
        // completion: level (empty) then notification, or notification then level
        levelFirst.observe(sys('background_tasks_changed', { tasks: [] }), 2_000);
        levelFirst.observe(sys('task_notification', { task_id: 'a', status: 'completed', output_file: '', summary: '' }), 2_001);
        edgeFirst.observe(sys('task_notification', { task_id: 'a', status: 'completed', output_file: '', summary: '' }), 2_000);
        edgeFirst.observe(sys('background_tasks_changed', { tasks: [] }), 2_001);
        expect(levelFirst.list()).toEqual([]);
        expect(edgeFirst.list()).toEqual([]);
    });

    it('reset empties everything (a new Claude Code process has no tasks); caps and clips', () => {
        const t = createBackgroundTaskTracker();
        t.observe(sys('task_started', { task_id: 'a', tool_use_id: 'tu', task_type: 'local_bash', description: 'x'.repeat(500), is_backgrounded: true }), 1);
        expect(t.list()[0].description).toHaveLength(BACKGROUND_TASK_DESCRIPTION_MAX);
        for (let i = 0; i < BACKGROUND_TASKS_MAX + 10; i++) {
            t.observe(sys('task_started', { task_id: `t${i}`, tool_use_id: `tu${i}`, task_type: 'local_bash', description: 'd', is_backgrounded: true }), 2 + i);
        }
        expect(t.list()).toHaveLength(BACKGROUND_TASKS_MAX);
        t.reset();
        expect(t.list()).toEqual([]);
        // and the forgotten foreground bookkeeping cannot resurrect a task
        t.observe({ type: 'user', tool_use_result: { status: 'async_launched' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu' }] } } as any, 100);
        expect(t.list()).toEqual([]);
    });

    it('sameBackgroundTasks compares ids and descriptions, not startedAt', () => {
        expect(sameBackgroundTasks([{ id: 'a', type: 't', description: 'd', startedAt: 1 }], [{ id: 'a', type: 't', description: 'd', startedAt: 2 }])).toBe(true);
        expect(sameBackgroundTasks([{ id: 'a', type: 't', description: 'd', startedAt: 1 }], [{ id: 'a', type: 't', description: 'e', startedAt: 1 }])).toBe(false);
        expect(sameBackgroundTasks([], [{ id: 'a', type: 't', description: 'd', startedAt: 1 }])).toBe(false);
    });
});

describe('B-507 wrapper wiring', () => {
    // Verified with scripts/dev/mutation-check.mjs (see PR).
    const launcher = readFileSync(join(__dirname, 'claudeRemoteLauncher.ts'), 'utf8');
    const session = readFileSync(join(__dirname, 'session.ts'), 'utf8');

    it('every SDK message feeds the tracker and the session publishes its list', () => {
        expect(launcher).toContain('backgroundTasks.observe(message);\n        session.setBackgroundTasks(backgroundTasks.list());');
    });

    it('the set is reset when a query starts and when it ends', () => {
        expect(launcher).toContain('runtimeControls.setQuery(q);\n                        // A new Claude Code process starts with no background\n                        // tasks (SDK: reset the set whenever the process restarts).\n                        backgroundTasks.reset();\n                        session.setBackgroundTasks([]);');
        expect(launcher).toContain('runtimeControls.setQuery(null);\n                backgroundTasks.reset();\n                session.setBackgroundTasks([]);');
    });

    it('the session heartbeats the set on every tick and immediately on a change', () => {
        expect(session).toContain('this.client.keepAlive(this.thinking, this.mode, this.backgroundTasks);\n        }, 2000);');
        expect(session).toContain('if (sameBackgroundTasks(this.backgroundTasks, tasks)) return;\n        this.backgroundTasks = tasks;\n        this.client.keepAlive(this.thinking, this.mode, this.backgroundTasks);');
        expect(session).toContain('this.thinking = thinking;\n        this.client.keepAlive(thinking, this.mode, this.backgroundTasks);');
    });
});
