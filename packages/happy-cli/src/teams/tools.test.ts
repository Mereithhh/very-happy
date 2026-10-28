import { describe, it, expect, vi } from 'vitest';
import { registerTeamsTools, TEAM_TOOL_NAMES } from './tools';

describe('public scoped team tools', () => {
    it('registers on a normal session and sends only the intended operation', async () => {
        const calls = new Map<string, Function>();
        const client = { initialize: vi.fn(), inspect: vi.fn(), action: vi.fn().mockResolvedValue({ team: { id: 't' } }) };
        registerTeamsTools({ registerTool: (name: string, _schema: any, handler: Function) => { calls.set(name, handler); } } as any, 'normal-session', client);
        expect([...calls.keys()]).toEqual(TEAM_TOOL_NAMES);
        expect(calls.has('session_spawn')).toBe(false);
        const result = await calls.get('team_delegate')!({ requestId: 'r', goal: 'g', acceptance: ['test'], parentTaskId: 'p' });
        expect(client.action).toHaveBeenCalledWith({ type: 'delegate', goal: 'g', acceptance: ['test'], parentTaskId: 'p', directory: process.cwd() }, 'r');
        expect(result.isError).toBe(false);
        await calls.get('team_delegate')!({ requestId: 'explicit', goal: 'g', acceptance: ['test'], directory: '/explicit/repo' });
        expect(client.action).toHaveBeenLastCalledWith({ type: 'delegate', goal: 'g', acceptance: ['test'], directory: '/explicit/repo' }, 'explicit');
        await calls.get('team_schedule_create')!({ requestId: 'schedule-r', name: 'Review', botId: 'root', body: 'Inspect tasks', runAt: 123, intervalMs: 600000 });
        expect(client.action).toHaveBeenLastCalledWith({ type: 'schedule-create', name: 'Review', botId: 'root', body: 'Inspect tasks', runAt: 123, intervalMs: 600000 }, 'schedule-r');
        await calls.get('team_schedule_pause')!({ requestId: 'pause-r', scheduleId: 'schedule', version: 2 });
        expect(client.action).toHaveBeenLastCalledWith({ type: 'schedule-pause', scheduleId: 'schedule', version: 2 }, 'pause-r');
    });
    it('B-822/B-840: team_inspect is compact by default, one task with taskId, everything with full; actions return a receipt', async () => {
        const calls = new Map<string, Function>();
        const team = { id: 't', name: 'T', machineId: 'm', version: 1, createdAt: 1, bots: [], messages: [], operations: [], tasks: [{ id: 'x', parentTaskId: null, goal: 'g', acceptance: ['a'], goalVersion: 1, ownerBotId: null, assigneeBotId: 'b', status: 'done', attempts: [], currentAttemptId: 'a', cleanup: 'done' }] };
        const client = { initialize: vi.fn(), inspect: vi.fn().mockResolvedValue({ team }), action: vi.fn().mockResolvedValue({ team, taskId: 'x' }) };
        registerTeamsTools({ registerTool: (name: string, _schema: any, handler: Function) => { calls.set(name, handler); } } as any, 'normal-session', client);
        const read = async (name: string, args: object) => JSON.parse((await calls.get(name)!(args)).content[0].text);
        expect((await read('team_inspect', {})).team.omitted.closedTaskDetails).toBe(1);
        expect((await read('team_inspect', { full: true })).team).toEqual(team);
        expect((await read('team_inspect', { taskId: 'x' })).task).toEqual(team.tasks[0]);
        const accepted = await read('team_accept', { requestId: 'r', taskId: 'x', attemptId: 'a', goalVersion: 1 });
        expect(accepted.taskId).toBe('x');
        expect(accepted.task).toMatchObject({ id: 'x', status: 'done', currentAttemptId: 'a', goalVersion: 1 });
        expect(accepted.team).toEqual({ id: 't', name: 'T', version: 1, openTasks: 0 });
        expect(accepted.team.tasks).toBeUndefined();
        // Already a receipt (forwarded by a Codex bridge): passed through untouched.
        client.action.mockResolvedValueOnce(accepted);
        expect(await read('team_accept', { requestId: 'r2', taskId: 'x', attemptId: 'a', goalVersion: 1 })).toEqual(accepted);
        // Every write tool answers with a receipt, never the team view.
        for (const name of ['team_delegate', 'team_message', 'team_submit', 'team_return', 'team_cancel', 'team_handoff', 'team_schedule_create', 'team_schedule_pause', 'team_schedule_resume', 'team_schedule_cancel']) {
            client.action.mockResolvedValueOnce({ team, taskId: 'x' });
            const answer = await read(name, { requestId: `w-${name}` });
            expect(answer.team.tasks, name).toBeUndefined();
            expect(answer.hint, name).toContain('team_inspect');
        }
    });
});
