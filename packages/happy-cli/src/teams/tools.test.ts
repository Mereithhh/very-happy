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
        // The server's real write answer: `taskId` only for a task it created (delegate); JSON drops the undefined one otherwise.
        const client = { initialize: vi.fn(), inspect: vi.fn().mockResolvedValue({ team }), action: vi.fn().mockResolvedValue({ team }) };
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
            client.action.mockResolvedValueOnce(name === 'team_delegate' ? { team, taskId: 'x' } : { team });
            const answer = await read(name, { requestId: `w-${name}` });
            expect(answer.team.tasks, name).toBeUndefined();
            expect(answer.hint, name).toContain('team_inspect');
        }
    });
    it('QA19 P2-1: a write naming a task answers with that task and its current attempt, though the server returns no taskId', async () => {
        const calls = new Map<string, Function>();
        // After return: a new attempt superseded the old one. The Lead must be able to accept it without team_inspect.
        const attempt = (id: string, status: string) => ({ id, botId: 'b', status, goalVersion: 1, generation: 1, result: 'evidence', createdAt: 1 });
        const team = { id: 't', name: 'T', machineId: 'm', version: 2, createdAt: 1, bots: [], messages: [], operations: [], tasks: [
            { id: 'x', parentTaskId: null, goal: 'g', acceptance: ['a'], goalVersion: 1, ownerBotId: 'lead', assigneeBotId: 'b', status: 'running', attempts: [attempt('a1', 'superseded'), attempt('a2', 'running')], currentAttemptId: 'a2', cleanup: 'pending' },
            { id: 'other', parentTaskId: null, goal: 'g', acceptance: ['a'], goalVersion: 1, ownerBotId: 'lead', assigneeBotId: 'c', status: 'running', attempts: [], currentAttemptId: 'o1', cleanup: 'pending' },
        ] };
        const client = { initialize: vi.fn(), inspect: vi.fn(), action: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify({ team, taskId: undefined, scheduleId: undefined }))) };
        registerTeamsTools({ registerTool: (name: string, _schema: any, handler: Function) => { calls.set(name, handler); } } as any, 'normal-session', client);
        const read = async (name: string, args: object) => JSON.parse((await calls.get(name)!(args)).content[0].text);
        const writes: Record<string, object> = {
            team_message: { body: 'b' }, team_submit: { attemptId: 'a2', goalVersion: 1, result: 'r' }, team_accept: { attemptId: 'a1', goalVersion: 1 },
            team_return: { reason: 'r', attemptId: 'a1', goalVersion: 1 }, team_cancel: { reason: 'r', attemptId: 'a2', goalVersion: 1 }, team_handoff: { assigneeBotId: 'c', attemptId: 'a2', goalVersion: 1 },
        };
        for (const [name, args] of Object.entries(writes)) {
            const answer = await read(name, { requestId: `p21-${name}`, taskId: 'x', ...args });
            expect(answer.taskId, name).toBe('x');
            expect(answer.task, name).toMatchObject({ id: 'x', status: 'running', currentAttemptId: 'a2', goalVersion: 1, attempts: 2 });
            expect(answer.task.currentAttempt, name).toEqual({ id: 'a2', botId: 'b', status: 'running', goalVersion: 1, generation: 1 });
        }
        // A task the server created still wins over the (absent) argument; an error answer is never decorated.
        client.action.mockResolvedValueOnce({ team, taskId: 'other' });
        expect((await read('team_delegate', { requestId: 'p21-d', goal: 'g', acceptance: ['a'] })).task.id).toBe('other');
        client.action.mockResolvedValueOnce({ error: 'stale_attempt' });
        expect(await read('team_accept', { requestId: 'p21-e', taskId: 'x', attemptId: 'a1', goalVersion: 1 })).toEqual({ error: 'stale_attempt' });
    });
});
