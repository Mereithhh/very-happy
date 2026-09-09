import { z } from 'zod';
import type { AssistantToolRegistrar } from '@/assistant/assistantTools';
import { createTeamsClient } from './client';

export const TEAM_TOOL_NAMES = ['team_create', 'team_join', 'team_inspect', 'team_delegate', 'team_message', 'team_submit', 'team_accept', 'team_return', 'team_cancel', 'team_handoff', 'team_schedule_create', 'team_schedule_pause', 'team_schedule_resume', 'team_schedule_cancel'] as const;
const id = z.string().min(1).max(128);
const text = z.string().min(1).max(32000);
const requestId = id.describe('Unique operation ID. Reuse the same ID and arguments after an uncertain response.');
export function registerTeamsTools(server: AssistantToolRegistrar, sessionId?: string, client = createTeamsClient(sessionId)): void {
    const register = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, execute: (args: any) => Promise<unknown>) => {
        server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: name === 'team_inspect', idempotentHint: true, openWorldHint: false, destructiveHint: ['team_cancel', 'team_handoff', 'team_return', 'team_schedule_cancel'].includes(name) } }, async (args) => {
            try { return { content: [{ type: 'text' as const, text: JSON.stringify(await execute(args)) }], isError: false }; }
            catch (error) { return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Teams operation failed' }], isError: true }; }
        });
    };
    register('team_create', 'Create an official Very Happy team and join this session as its root bot. Does not grant access outside this account.',
        { name: id, machineId: id.optional(), requestId }, (args) => client.initialize(args));
    register('team_join', 'Join an existing team as a root bot using this session owner’s account. Scoped workers cannot elevate their role.',
        { teamId: id, name: id, botId: id.optional().describe('Existing root bot to reconnect; preserves its identity'), requestId }, (args) => client.initialize(args));
    register('team_inspect', 'Read your visible team tasks, attempts and messages. Inspect before decisions; submission is not acceptance.', {}, () => client.inspect());
    const action = (name: string, description: string, fields: Record<string, z.ZodTypeAny>) => register(`team_${name}`, description,
        { requestId, ...fields }, ({ requestId: key, ...args }) => client.action({ type: name, ...args, ...(name === 'delegate' && args.directory === undefined ? { directory: process.cwd() } : {}) }, key));
    action('delegate', 'Delegate a goal with acceptance criteria. Use parentTaskId for subdelegation. Existing assigneeBotId or a managed worker may execute it.', {
        goal: text, acceptance: z.array(text).min(1).max(32), parentTaskId: id.optional(), assigneeBotId: id.optional(), botName: id.optional(), directory: z.string().min(1).optional(), assistant: z.enum(['claude', 'codex', 'pi-acp']).optional(), model: z.string().trim().min(1).max(256).optional(),
    });
    action('message', 'Send a persistent task-related message. Delivery does not mean the model has read or acted on it.', { taskId: id, body: text, recipientBotId: id.optional() });
    action('submit', 'Submit evidence for your current attempt and goal version. The owner still has to accept it.', { taskId: id, attemptId: id, goalVersion: z.number().int().positive(), result: text });
    const current = { attemptId: id, goalVersion: z.number().int().positive() };
    action('accept', 'Accept a task you own after checking its evidence. Resource cleanup is tracked separately.', { taskId: id, ...current });
    action('return', 'Return your task for further work with a concrete reason.', { taskId: id, reason: text, ...current });
    action('cancel', 'Cancel an owned task and its dependent work. Cleanup may remain pending.', { taskId: id, reason: text, ...current });
    action('handoff', 'Move an owned task to another bot; prior execution authority is superseded.', { taskId: id, assigneeBotId: id, ...current });
    register('team_schedule_create', 'Create a persistent one-time or fixed-interval reminder for your own root bot. Delivery wakes the bound session; it does not prove task completion. Use epoch milliseconds, and inspect before retrying.', { requestId, name: id, botId: id, body: text, runAt: z.number().int().nonnegative(), intervalMs: z.number().int().min(60_000).optional() }, ({ requestId: key, ...args }) => client.action({ type: 'schedule-create', ...args }, key));
    for (const operation of ['pause', 'resume', 'cancel'] as const) {
        register(`team_schedule_${operation}`, `${operation} your root bot’s schedule using its current version from team_inspect. An already in-flight message may still arrive.`, { requestId, scheduleId: id, version: z.number().int().positive() }, ({ requestId: key, ...args }) => client.action({ type: `schedule-${operation}`, ...args }, key));
    }
}
