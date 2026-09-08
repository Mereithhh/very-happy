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
        expect(client.action).toHaveBeenCalledWith({ type: 'delegate', goal: 'g', acceptance: ['test'], parentTaskId: 'p' }, 'r');
        expect(result.isError).toBe(false);
        await calls.get('team_schedule_create')!({ requestId: 'schedule-r', name: 'Review', botId: 'root', body: 'Inspect tasks', runAt: 123, intervalMs: 600000 });
        expect(client.action).toHaveBeenLastCalledWith({ type: 'schedule-create', name: 'Review', botId: 'root', body: 'Inspect tasks', runAt: 123, intervalMs: 600000 }, 'schedule-r');
        await calls.get('team_schedule_pause')!({ requestId: 'pause-r', scheduleId: 'schedule', version: 2 });
        expect(client.action).toHaveBeenLastCalledWith({ type: 'schedule-pause', scheduleId: 'schedule', version: 2 }, 'pause-r');
    });
});
