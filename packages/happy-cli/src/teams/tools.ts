import { z } from 'zod';
import type { AssistantToolRegistrar } from '@/assistant/assistantTools';
import { createTeamsClient } from './client';
import { teamActionReceipt, teamTaskToolView, teamToolView, type TeamToolViewOptions } from './toolView';

export const TEAM_TOOL_NAMES = ['team_create', 'team_join', 'team_inspect', 'team_delegate', 'team_message', 'team_submit', 'team_accept', 'team_return', 'team_cancel', 'team_handoff', 'team_schedule_create', 'team_schedule_pause', 'team_schedule_resume', 'team_schedule_cancel'] as const;
const id = z.string().min(1).max(128);
const text = z.string().min(1).max(32000);
/**
 * B-912: the MCP SDK refuses a call before the tool runs, and its default text («expected string, received
 * undefined at result») sent members guessing (59 refusals in 30 days). A missing or mistyped field now says
 * what to pass and where to read it. The SDK prints these as «<message> at <field>».
 */
export const TEAM_FIELD_FIXES = {
    requestId: 'Missing requestId: add a new unique string such as "B-123-submit-1"; reuse that same value only when retrying this exact call.',
    taskId: 'Missing taskId: pass the task id from team_inspect (your own task is the "Task <id>" line of your assignment).',
    attemptId: 'Missing attemptId: pass the task\'s currentAttemptId from team_inspect with taskId.',
    goalVersion: 'Missing goalVersion: pass the task\'s goalVersion from team_inspect with taskId, as a number (e.g. 1).',
    goal: 'Missing goal: describe the work to delegate.',
    acceptance: 'Missing acceptance: pass an array of 1–32 checkable criteria, e.g. ["tests pass", "PR open with CI green"].',
    reason: 'Missing reason: say concretely why.',
    assigneeBotId: 'Missing assigneeBotId: pass the member\'s bot id from team_inspect (members).',
} as const;
type FixedField = keyof typeof TEAM_FIELD_FIXES;
const fix = (field: FixedField, kind: string) => (issue: { input?: unknown }) =>
    issue.input === undefined ? TEAM_FIELD_FIXES[field] : `${field} must be ${kind}${typeof issue.input === 'string' && kind.startsWith('a number') ? ` (pass ${issue.input} without quotes)` : ''}.`;
const fixedId = (field: FixedField) => z.string({ error: fix(field, 'a string') }).min(1).max(128);
const fixedText = (field: FixedField) => z.string({ error: fix(field, 'a string') }).min(1).max(32000);
const requestId = fixedId('requestId').describe('Unique operation ID. Reuse the same ID and arguments after an uncertain response.');
const goalVersion = z.number({ error: fix('goalVersion', 'a number, not a string') }).int().positive();
/**
 * B-912: the aliases models reach for most (team_submit `summary`: 27 of 59 refusals).
 * B-972: the tools/list schema now lists `body` / `result` as required (a weaker model that fills only the required
 * fields otherwise sends neither), while the aliases still pass validation and reach normalizeTeamToolArgs. The refusal
 * names the fields it received and gives a call to copy.
 */
export const TEAM_SUBMIT_RESULT_MISSING = 'Missing result: pass your evidence as `result` (what you did, PR / head SHA, verification). `summary` is accepted as an alias.';
export const TEAM_MESSAGE_BODY_MISSING = 'Missing body: pass the message text as `body` (`message` is accepted as an alias).';
/** The same refusal this many times in a row tells the model to stop retrying. */
export const TEAM_REPEAT_STOP_AFTER = 3;
const TEAM_CALL_EXAMPLES = {
    message: '{"requestId":"B-123-msg-1","taskId":"<task id from team_inspect>","body":"<your message text>"}',
    submit: '{"requestId":"B-123-submit-1","taskId":"<task id>","attemptId":"<currentAttemptId>","goalVersion":1,"result":"<what you did, PR / head SHA, verification>"}',
} as const;
/** B-972: a non-string body / result is refused by SDK validation before the tool runs; that text carries the example too. */
const aliasText = (field: string, tool: 'message' | 'submit') => z.string({ error: () => `${field} must be a string (the text itself, in quotes). Copy this call and fill in the values: team_${tool} ${TEAM_CALL_EXAMPLES[tool]}` }).max(32000).optional();
function missingFieldError(tool: 'message' | 'submit', raw: Record<string, unknown>): Error {
    const received = Object.keys(raw).join(', ') || 'none besides requestId';
    return new Error(`${tool === 'message' ? TEAM_MESSAGE_BODY_MISSING : TEAM_SUBMIT_RESULT_MISSING} Fields received: ${received}. Copy this call and fill in the values: team_${tool} ${TEAM_CALL_EXAMPLES[tool]}`);
}
export function normalizeTeamToolArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    if (tool === 'submit') {
        const { summary, ...rest } = args;
        const result = rest.result ?? summary;
        if (typeof result !== 'string' || !result) throw missingFieldError('submit', args);
        return { ...rest, result };
    }
    if (tool === 'message') {
        const { message, to, ...rest } = args;
        const body = rest.body ?? message;
        if (typeof body !== 'string' || !body) throw missingFieldError('message', args);
        const recipientBotId = rest.recipientBotId ?? to;
        return { ...rest, body, ...(recipientBotId !== undefined ? { recipientBotId } : {}) };
    }
    return args;
}
/**
 * B-972: the registrars wrapped around the server (dispatch gate adds `risk`, output caps add `cursor`) spread `inputSchema`
 * as a field table, so a tool hands over its fields plus `requiredFields` and this wrapper, applied to the raw McpServer only,
 * turns them into one object schema. Its JSON schema lists every non-optional field (including the ones the wrappers added)
 * plus `requiredFields`; validation is unchanged, so the aliases still reach the handler.
 */
export function withRequiredSchema(inner: AssistantToolRegistrar): AssistantToolRegistrar {
    return {
        registerTool: ((name: string, config: any, handler: (...a: any[]) => any) => {
            if (!config?.requiredFields) return (inner.registerTool as any)(name, config, handler);
            const { requiredFields, ...rest } = config;
            const shape = rest.inputSchema as Record<string, z.ZodTypeAny>;
            const required = Object.entries(shape).filter(([key, field]) => requiredFields.includes(key) || !field.safeParse(undefined).success).map(([key]) => key);
            return (inner.registerTool as any)(name, { ...rest, inputSchema: z.object(shape).meta({ required }) }, handler);
        }) as AssistantToolRegistrar['registerTool'],
    };
}
/**
 * B-972b: the repeat-refusal count. startHappyServer builds one per session and passes it in, because it creates a new
 * McpServer for every HTTP request (stateless transport) and a count kept per registration restarts at 0 on each call.
 * The Codex stdio bridge and `very-happy mcp` keep one server per process and let registerTeamsTools make its own.
 */
export interface TeamRefusalTracker { last?: { tool: string; count: number } }
export const createTeamRefusalTracker = (): TeamRefusalTracker => ({});
export function registerTeamsTools(server: AssistantToolRegistrar, sessionId?: string, client = createTeamsClient(sessionId), options: { refusalTracker?: TeamRefusalTracker } = {}): void {
    const register = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, execute: (args: any) => Promise<unknown>, required?: string[]) => {
        server.registerTool(name, { description, inputSchema, ...(required ? { requiredFields: required } : {}), annotations: { readOnlyHint: name === 'team_inspect', idempotentHint: true, openWorldHint: false, destructiveHint: ['team_cancel', 'team_handoff', 'team_return', 'team_schedule_cancel'].includes(name) } }, async (args: any) => {
            try { return { content: [{ type: 'text' as const, text: JSON.stringify(await execute(args)) }], isError: false }; }
            catch (error) { return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Teams operation failed' }], isError: true }; }
        });
    };
    // B-881: create/join answer with the compact view too (adopt.ts keeps calling `initialize` for the whole team).
    // A Codex stdio bridge forwards to the owning process, whose answer is already compact (`omitted`).
    const compact = (result: any, options: TeamToolViewOptions = {}) => Array.isArray(result?.team?.tasks) && !result.team.omitted ? { ...result, team: teamToolView(result.team, { botId: typeof result.botId === 'string' ? result.botId : undefined, ...options }) } : result;
    register('team_create', 'Create an official Very Happy team and join this session as its root bot. Does not grant access outside this account. The team joins this session\'s project, or a new project with the team\'s name; its members share that project\'s context.',
        { name: id, machineId: id.optional(), requestId, projectId: id.optional().describe('Existing project to put the team in'), noProject: z.boolean().optional().describe('Create the team without a project') }, async (args) => compact(await client.initialize(args)));
    register('team_join', 'Join an existing team as a root bot using this session owner’s account. Scoped workers cannot elevate their role.',
        { teamId: id, name: id, botId: id.optional().describe('Existing root bot to reconnect; preserves its identity'), requestId }, async (args) => compact(await client.initialize(args)));
    // B-840: writes answer with teamActionReceipt (ids, capacity, idle members); the team view stays here.
    // B-881: the default view is an index (open tasks clipped, closed counted, your recent messages clipped, no operations).
    register('team_inspect', 'Read your visible team tasks, attempts and messages. Inspect before decisions; submission is not acceptance. Returns a compact view (members, open tasks with clipped goals, closed-task counts, your recent messages clipped, capacity); pass taskId for one task in full (goal, acceptance, attempts and results, its messages), includeClosed / messagesLimit to widen the view, or full=true for the whole team.',
        {
            taskId: id.optional().describe('Return this task in full: goal, acceptance, all attempts with results, its messages and operations'),
            includeClosed: z.boolean().optional().describe('List closed (done / cancelled) tasks with clipped goals instead of counting them'),
            messagesLimit: z.number().int().min(0).max(500).optional().describe('How many of your most recent messages to list (default 20); undelivered ones are always listed'),
            full: z.boolean().optional().describe('Return the whole team view (can be very large)'),
        },
        async (args) => { const result = await client.inspect(); return args.full ? result : args.taskId ? teamTaskToolView(result.team, args.taskId) : compact(result, { includeClosed: args.includeClosed, messagesLimit: args.messagesLimit }); });
    // B-972: the same refusal 3 times in a row means the model is looping; say so and tell it to stop. Any accepted call resets it.
    const tracker = options.refusalTracker ?? createTeamRefusalTracker();
    const guard = (name: string, raw: Record<string, unknown>, key?: string) => {
        try { const args = normalizeTeamToolArgs(name, key === undefined ? raw : { requestId: key, ...raw }); tracker.last = undefined; const { requestId: _omit, ...rest } = args; return rest; }
        catch (error) {
            const refusal = tracker.last = { tool: name, count: tracker.last?.tool === name ? tracker.last.count + 1 : 1 };
            const stop = refusal.count >= TEAM_REPEAT_STOP_AFTER ? ` Refused ${refusal.count} times in a row: STOP retrying team_${name} and tell the user what is failing (which field is missing, what you sent).` : '';
            throw new Error((error instanceof Error ? error.message : String(error)) + stop);
        }
    };
    const action = (name: string, description: string, fields: Record<string, z.ZodTypeAny>, required?: string[]) => register(`team_${name}`, description,
        { requestId, ...fields }, async ({ requestId: key, ...raw }) => { const args = guard(name, raw, key); return teamActionReceipt(await client.action({ type: name, ...args, ...(name === 'delegate' && args.directory === undefined ? { directory: process.cwd() } : {}) }, key), args.taskId as string | undefined); }, required);
    action('delegate', 'Delegate a goal with acceptance criteria. Use parentTaskId for subdelegation. Existing assigneeBotId or a managed worker may execute it.', {
        goal: fixedText('goal'), acceptance: z.array(text, { error: fix('acceptance', 'an array of strings: wrap a single criterion as ["…"]') }).min(1).max(32), parentTaskId: id.optional(), assigneeBotId: id.optional(), botName: id.optional(), directory: z.string().min(1).optional(), assistant: z.enum(['claude', 'codex', 'pi-acp']).optional(), model: z.string().trim().min(1).max(256).optional(),
        agentProfile: z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(200).optional() }).nullable().optional().describe('Account a member spawns on (id from `very-happy account list`; null = machine login; omit = team default). Unusable → the launch is refused, never the machine login.'),
    });
    const taskId = fixedId('taskId');
    // B-912/B-972: `body` / `result` are optional zod fields so their aliases reach normalizeTeamToolArgs (which requires one of them), but the exported JSON schema lists them as required.
    action('message', 'Send a persistent task-related message. Delivery does not mean the model has read or acted on it. Members reach other members through their lead: send to the task owner (your lead), who forwards it.', {
        taskId, body: aliasText('body', 'message').describe('Required: the message text'), recipientBotId: id.optional().describe('Omit to message the task assignee; members send to their lead (the task owner)'),
        message: aliasText('message', 'message').describe('Alias of body'), to: id.optional().describe('Alias of recipientBotId'),
    }, ['requestId', 'taskId', 'body']);
    action('submit', 'Submit evidence for your current attempt and goal version. The owner still has to accept it.', {
        taskId, attemptId: fixedId('attemptId'), goalVersion, result: aliasText('result', 'submit').describe('Required: your evidence (what you did, PR / head SHA, verification)'), summary: aliasText('summary', 'submit').describe('Alias of result'),
    }, ['requestId', 'taskId', 'attemptId', 'goalVersion', 'result']);
    const current = { attemptId: fixedId('attemptId'), goalVersion };
    action('accept', 'Accept a task you own after checking its evidence. Resource cleanup is tracked separately.', { taskId, ...current });
    action('return', 'Return your task for further work with a concrete reason.', { taskId, reason: fixedText('reason'), ...current });
    action('cancel', 'Cancel an owned task and its dependent work. Cleanup may remain pending.', { taskId, reason: fixedText('reason'), ...current });
    action('handoff', 'Move an owned task to another bot; prior execution authority is superseded.', { taskId, assigneeBotId: fixedId('assigneeBotId'), ...current });
    register('team_schedule_create', 'Create a persistent one-time or fixed-interval reminder for your own root bot. Delivery wakes the bound session; it does not prove task completion. Use epoch milliseconds, and inspect before retrying.', { requestId, name: id, botId: id, body: text, runAt: z.number().int().nonnegative(), intervalMs: z.number().int().min(60_000).optional() }, async ({ requestId: key, ...args }) => teamActionReceipt(await client.action({ type: 'schedule-create', ...args }, key)));
    for (const operation of ['pause', 'resume', 'cancel'] as const) {
        register(`team_schedule_${operation}`, `${operation} your root bot’s schedule using its current version from team_inspect. An already in-flight message may still arrive.`, { requestId, scheduleId: id, version: z.number().int().positive() }, async ({ requestId: key, ...args }) => teamActionReceipt(await client.action({ type: `schedule-${operation}`, ...args }, key)));
    }
}
