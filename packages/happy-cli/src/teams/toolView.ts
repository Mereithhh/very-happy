import type { TeamMessage, TeamOperation, TeamState, TeamTask } from '@slopus/happy-wire';

/**
 * B-822: what the team_* tools hand the model. A lead's view is the whole team and every call
 * returned it (1–4 MB per call in the incident team): closed tasks with all attempts, every
 * delivered message, every operation with its launch prompt. The compact view keeps everything a
 * decision needs — open tasks in full (current attemptId / goalVersion / result), undelivered and
 * recent messages, operations that are not finished — and summarizes the rest; `team_inspect`
 * with `taskId` or `full` returns the detail.
 */
export const TEAM_VIEW_RECENT_MESSAGES = 20;
const CLOSED_GOAL_CHARS = 200;
const MESSAGE_BODY_CHARS = 500;
const closed = (task: TeamTask) => task.status === 'done' || task.status === 'cancelled';
const undelivered = (m: TeamMessage) => m.deliveredAt === null && m.cancelledAt === undefined;

/**
 * B-881: the B-822 view still carried every open task's goal, acceptance and submission, every
 * message body, and the unfinished operations — 89,650 characters on the lead's 68-task /
 * 138-message team (raw 589,754), past a host's tool-output limit. The default view is now an
 * index: members (activity, last event), open tasks with the ids a write needs, closed tasks as
 * counts, the caller's recent messages clipped, capacity. Detail is one `team_inspect` away
 * (`taskId`, `includeClosed`, `messagesLimit`, `full`).
 */
export type TeamToolViewOptions = {
    /** The caller's bot: only messages it sent or received are listed. Unknown (an old bridge) → all. */
    botId?: string;
    includeClosed?: boolean;
    messagesLimit?: number;
};
export function teamToolView(team: TeamState, options: TeamToolViewOptions = {}): Record<string, unknown> {
    // Defaults: a partial answer (a test double, a future server) must not turn into a tool error.
    const { tasks = [], messages = [], operations = [], bots = [], schedules, creationLaunch: _launch, capacityWarned: _warned, ...rest } = team;
    const limit = options.messagesLimit ?? TEAM_VIEW_RECENT_MESSAGES;
    const mine = options.botId ? messages.filter(m => m.senderBotId === options.botId || m.recipientBotId === options.botId) : messages;
    // Undelivered ones addressed to the caller are still actionable: always listed, beyond the limit. Ones it sent
    // to a stopped member can stay undelivered for weeks; they compete on recency like the rest.
    const pinned = (m: TeamMessage) => undelivered(m) && (!options.botId || m.recipientBotId === options.botId);
    const recent = new Set(mine.filter(m => !pinned(m)).slice(limit > 0 ? -limit : mine.length).map(m => m.id));
    const shown = mine.filter(m => recent.has(m.id) || pinned(m));
    const closedTasks = tasks.filter(closed);
    const closedCounts = { done: closedTasks.filter(t => t.status === 'done').length, cancelled: closedTasks.filter(t => t.status === 'cancelled').length };
    return {
        ...rest,
        ...(options.botId ? { selfBotId: options.botId } : {}),
        bots: bots.map(bot => ({ id: bot.id, name: bot.name, root: bot.root, activity: bot.activity, lastEvent: bot.lastEvent })),
        tasks: tasks.filter(t => !closed(t)).map(openTaskView),
        closedTasks: options.includeClosed ? closedTasks.map(closedTaskSummary) : closedCounts,
        messages: shown.map(messageView),
        ...(schedules?.length ? { schedules: schedules.map(s => ({ ...s, body: clip(s.body, CLOSED_GOAL_CHARS) })) } : {}),
        omitted: {
            closedTaskDetails: options.includeClosed ? 0 : closedTasks.length,
            olderMessages: mine.length - shown.length,
            ...(options.botId ? { otherMembersMessages: messages.length - mine.length } : {}),
            operations: operations.length,
            unfinishedOperations: operations.filter(o => o.status !== 'completed').length,
            hint: 'Compact view: goals and message bodies are clipped, closed tasks are counted, operations are left out. 需要完整内容时用 taskId 调 team_inspect (one task: full goal, acceptance, attempts with results, its messages and operations); includeClosed=true lists closed tasks, messagesLimit sets how many recent messages, full=true returns the whole team (very large).',
        },
    };
}
/** No tool takes a message id, and delivery time is the daemon's bookkeeping; whether it is still undelivered is the signal. */
/** What a decision about an open task needs; its goal, acceptance and submission are one `taskId` call away. */
function openTaskView(task: TeamTask) {
    const current = task.attempts.find(a => a.id === task.currentAttemptId);
    return { id: task.id, parentTaskId: task.parentTaskId, status: task.status, goal: clip(task.goal, CLOSED_GOAL_CHARS), assigneeBotId: task.assigneeBotId, ownerBotId: task.ownerBotId, currentAttemptId: task.currentAttemptId, ...(current ? { currentAttemptStatus: current.status } : {}), goalVersion: task.goalVersion, cleanup: task.cleanup, attempts: task.attempts.length };
}
function messageView({ id: _id, deliveredAt, body, ...m }: TeamMessage) {
    return { ...m, body: clip(body, MESSAGE_BODY_CHARS), ...(body.length > MESSAGE_BODY_CHARS ? { bodyChars: body.length } : {}), ...(deliveredAt === null ? { undelivered: true } : {}) };
}
/** One task with all its attempts, messages and operations. */
export function teamTaskToolView(team: TeamState, taskId: string): Record<string, unknown> {
    const task = team.tasks.find(t => t.id === taskId);
    if (!task) return { taskId, error: 'Task not visible: it does not exist, is outside your scope, or was archived after it closed.' };
    return { task, messages: team.messages.filter(m => m.taskId === taskId), operations: team.operations.filter(o => o.taskId === taskId), capacity: team.capacity };
}
function closedTaskSummary(task: TeamTask) {
    const accepted = task.attempts.find(a => a.id === task.currentAttemptId);
    return { id: task.id, parentTaskId: task.parentTaskId, status: task.status, goal: clip(task.goal, CLOSED_GOAL_CHARS), assigneeBotId: task.assigneeBotId, ownerBotId: task.ownerBotId, currentAttemptId: task.currentAttemptId, goalVersion: task.goalVersion, cleanup: task.cleanup, attempts: task.attempts.length, ...(accepted?.result ? { result: clip(accepted.result, CLOSED_GOAL_CHARS) } : {}), ...(task.closedAt ? { closedAt: task.closedAt } : {}) };
}
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * B-840: what a team_* write (delegate, message, submit, accept, return, cancel, handoff, schedule_*)
 * hands the model. Even the compact view was 30–190k characters per write on dev-sg (p50 ≈ 70k for a
 * lead), and every write's answer stays in the caller's context and prompt cache. The caller already
 * knows what it sent, so a write answers with the ids it needs next (task, current attempt,
 * goalVersion, schedule version) plus the small team signals (capacity, idle members, cleanup issues);
 * the team view stays on team_inspect.
 */
/** `actedTaskId`: the task the write named. The server returns `taskId` only for a task it created (delegate). */
export function teamActionReceipt(result: any, actedTaskId?: string): Record<string, unknown> {
    // Not a team view (an error shape, or a receipt forwarded by a Codex stdio bridge): pass through untouched.
    if (!Array.isArray(result?.team?.tasks)) return result;
    const { team, operation, ...rest } = result as { team: TeamState; operation?: TeamOperation } & Record<string, unknown>;
    const { tasks = [], operations = [], schedules = [] } = team;
    const taskId = typeof rest.taskId === 'string' ? rest.taskId : actedTaskId;
    const task = taskId ? tasks.find(t => t.id === taskId) : undefined;
    const schedule = typeof rest.scheduleId === 'string' ? schedules.find(s => s.id === rest.scheduleId) : undefined;
    const taskOperations = taskId ? operations.filter(o => o.taskId === taskId && o.status !== 'completed') : [];
    return {
        ok: true,
        ...rest,
        ...(taskId ? { taskId } : {}),
        ...(task ? { task: taskReceipt(task) } : {}),
        ...(operation ? { operation: operationReceipt(operation) } : {}),
        ...(taskOperations.length ? { taskOperations: taskOperations.map(operationReceipt) } : {}),
        ...(schedule ? { schedule } : {}),
        team: {
            id: team.id, name: team.name, version: team.version,
            openTasks: tasks.filter(t => !closed(t)).length,
            ...(team.capacity ? { capacity: team.capacity } : {}),
            ...(team.idleMembers?.length ? { idleMembers: team.idleMembers } : {}),
            ...(team.cleanupIssues?.length ? { cleanupIssues: team.cleanupIssues } : {}),
        },
        hint: 'Receipt only. Call team_inspect for the team view, or team_inspect with taskId for one task in full.',
    };
}
function taskReceipt(task: TeamTask) {
    const current = task.attempts.find(a => a.id === task.currentAttemptId);
    return { id: task.id, parentTaskId: task.parentTaskId, status: task.status, goal: clip(task.goal, CLOSED_GOAL_CHARS), assigneeBotId: task.assigneeBotId, ownerBotId: task.ownerBotId, currentAttemptId: task.currentAttemptId, goalVersion: task.goalVersion, cleanup: task.cleanup, attempts: task.attempts.length, ...(current ? { currentAttempt: { id: current.id, botId: current.botId, status: current.status, goalVersion: current.goalVersion, generation: current.generation } } : {}) };
}
// B-881: the id and state; the launch prompt repeats the goal and the rest is the daemon's bookkeeping.
const operationReceipt = (op: TeamOperation) => ({ id: op.id, type: op.type, botId: op.botId, status: op.status, error: op.error });
