import type { TeamState, TeamTask } from '@slopus/happy-wire';

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
const closed = (task: TeamTask) => task.status === 'done' || task.status === 'cancelled';

export function teamToolView(team: TeamState): Record<string, unknown> {
    // Defaults: a partial answer (a test double, a future server) must not turn into a tool error.
    const { tasks = [], messages = [], operations = [], bots = [], ...rest } = team;
    const recent = new Set(messages.filter(m => m.deliveredAt !== null || m.cancelledAt !== undefined).slice(-TEAM_VIEW_RECENT_MESSAGES).map(m => m.id));
    const shownMessages = messages.filter(m => recent.has(m.id) || (m.deliveredAt === null && m.cancelledAt === undefined));
    const liveOperations = operations.filter(o => o.status !== 'completed' && o.error !== 'task_closed_before_spawn');
    const closedTasks = tasks.filter(closed).length;
    return {
        ...rest,
        bots: bots.map(({ previousSessionIds: _previous, ...bot }) => bot),
        tasks: tasks.map(task => closed(task) ? closedTaskSummary(task) : openTask(task)),
        messages: shownMessages,
        operations: liveOperations.map(({ prompt: _prompt, ...op }) => op),
        omitted: {
            closedTaskDetails: closedTasks,
            olderMessages: messages.length - shownMessages.length,
            finishedOperations: operations.length - liveOperations.length,
            hint: 'Compact view: closed tasks are summarized, older delivered messages and finished operations are left out. Call team_inspect with taskId for one task in full, or full=true for the whole team.',
        },
    };
}
/** One task with all its attempts, messages and operations. */
export function teamTaskToolView(team: TeamState, taskId: string): Record<string, unknown> {
    const task = team.tasks.find(t => t.id === taskId);
    if (!task) return { taskId, error: 'Task not visible: it does not exist, is outside your scope, or was archived after it closed.' };
    return { task, messages: team.messages.filter(m => m.taskId === taskId), operations: team.operations.filter(o => o.taskId === taskId), capacity: team.capacity };
}
/** Only the current attempt carries its result; earlier attempts keep their status. */
function openTask(task: TeamTask) {
    return { ...task, attempts: task.attempts.map(a => a.id === task.currentAttemptId ? a : { id: a.id, botId: a.botId, status: a.status, goalVersion: a.goalVersion }) };
}
function closedTaskSummary(task: TeamTask) {
    const accepted = task.attempts.find(a => a.id === task.currentAttemptId);
    return { id: task.id, parentTaskId: task.parentTaskId, status: task.status, goal: clip(task.goal, CLOSED_GOAL_CHARS), assigneeBotId: task.assigneeBotId, ownerBotId: task.ownerBotId, currentAttemptId: task.currentAttemptId, goalVersion: task.goalVersion, cleanup: task.cleanup, attempts: task.attempts.length, ...(accepted?.result ? { result: clip(accepted.result, CLOSED_GOAL_CHARS) } : {}), ...(task.closedAt ? { closedAt: task.closedAt } : {}) };
}
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
