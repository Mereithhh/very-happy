import type { TeamAction, TeamActionReceipt, TeamOperation, TeamResponse, TeamSchedule, TeamTask } from '@slopus/happy-wire';

/**
 * B-911: the scoped write path (`POST /v1/teams/:id/agent`) answers with a receipt, not the team.
 *
 * Wrappers ≤0.2.186 forward this JSON to the model verbatim, and a wrapper is never hot-swapped: on
 * dev-sg a 0.2.181 lead kept receiving the whole team (median ≈ 438k characters, 1349 of 1457 calls
 * over the host's tool-output limit) three weeks after B-840 made new wrappers build receipts
 * client-side. Doing it here fixes every wrapper at once. Newer CLIs (`teamActionReceipt` in
 * happy-cli toolView.ts) pass an answer without `team.tasks` through untouched, so they show the same
 * receipt. Owner writes (`/actions`: Web, daemon worker, join) keep the full `TeamResponse`.
 *
 * Every write that names or creates a task answers its `taskId` (QA19: the server used to return it
 * for delegate/start only).
 */
export const TEAM_RECEIPT_HINT = 'Receipt only. Call team_inspect for the team view, or team_inspect with taskId for one task in full.';
const GOAL_CHARS = 200;
const ERROR_CHARS = 300;
const BODY_CHARS = 200;
/** Bounded lists: a receipt stays a few KB whatever the team's size. */
const MAX_IDLE_MEMBERS = 10;
const MAX_TASK_IDS = 10;
const MAX_CLEANUP_ISSUES = 5;
const MAX_TASK_OPERATIONS = 5;

const clip = (text: string | null | undefined, max: number) => text == null ? null : text.length > max ? `${text.slice(0, max)}…` : text;
const closed = (task: TeamTask) => task.status === 'done' || task.status === 'cancelled';

export function teamActionReceipt(response: TeamResponse, action: TeamAction): TeamActionReceipt {
    const { team } = response;
    const named = 'taskId' in action && typeof action.taskId === 'string' ? action.taskId : undefined;
    const taskId = response.taskId ?? named;
    const scheduleId = response.scheduleId ?? ('scheduleId' in action && typeof action.scheduleId === 'string' ? action.scheduleId : undefined);
    const task = taskId ? team.tasks.find(t => t.id === taskId) : undefined;
    const schedule = scheduleId ? team.schedules?.find(s => s.id === scheduleId) : undefined;
    const taskOperations = taskId ? team.operations.filter(o => o.taskId === taskId && o.status !== 'completed' && o.id !== response.operation?.id) : [];
    const omitted: Record<string, number> = {};
    const cap = <T>(key: string, list: T[] | undefined, max: number): T[] | undefined => {
        if (!list?.length) return undefined;
        if (list.length > max) omitted[key] = list.length - max;
        return list.slice(0, max);
    };
    const idleMembers = cap('idleMembers', team.idleMembers, MAX_IDLE_MEMBERS)?.map(m => ({ ...m, taskIds: m.taskIds.slice(0, MAX_TASK_IDS) }));
    const cleanupIssues = cap('cleanupIssues', team.cleanupIssues, MAX_CLEANUP_ISSUES)?.map(i => ({ ...i, error: clip(i.error, ERROR_CHARS), waitingTaskIds: i.waitingTaskIds.slice(0, MAX_TASK_IDS) }));
    const ops = cap('taskOperations', taskOperations, MAX_TASK_OPERATIONS);
    return {
        ok: true,
        receipt: 1,
        action: action.type,
        ...(taskId ? { taskId } : {}),
        ...(scheduleId ? { scheduleId } : {}),
        ...(response.scheduleRecordRetained !== undefined ? { scheduleRecordRetained: response.scheduleRecordRetained } : {}),
        ...(task ? { task: taskReceipt(task) } : {}),
        ...(response.operation ? { operation: operationReceipt(response.operation) } : {}),
        ...(ops ? { taskOperations: ops.map(operationReceipt) } : {}),
        ...(schedule ? { schedule: scheduleReceipt(schedule) } : {}),
        team: {
            id: team.id, name: team.name, version: team.version,
            openTasks: team.tasks.filter(t => !closed(t)).length,
            ...(team.capacity ? { capacity: team.capacity } : {}),
            ...(idleMembers ? { idleMembers } : {}),
            ...(cleanupIssues ? { cleanupIssues } : {}),
        },
        ...(Object.keys(omitted).length ? { omitted } : {}),
        hint: TEAM_RECEIPT_HINT,
    };
}

function taskReceipt(task: TeamTask): NonNullable<TeamActionReceipt['task']> {
    const current = task.attempts.find(a => a.id === task.currentAttemptId);
    return {
        id: task.id, parentTaskId: task.parentTaskId, status: task.status, goal: clip(task.goal, GOAL_CHARS) ?? '',
        assigneeBotId: task.assigneeBotId, ownerBotId: task.ownerBotId, currentAttemptId: task.currentAttemptId, goalVersion: task.goalVersion,
        cleanup: task.cleanup, attempts: task.attempts.length,
        ...(current ? { currentAttempt: { id: current.id, botId: current.botId, status: current.status, goalVersion: current.goalVersion, generation: current.generation } } : {}),
    };
}
/** The id and state; the launch prompt repeats the goal and the rest is the daemon's bookkeeping. */
const operationReceipt = (op: TeamOperation) => ({ id: op.id, type: op.type, botId: op.botId, status: op.status, error: clip(op.error, ERROR_CHARS) });
const scheduleReceipt = (s: TeamSchedule): TeamSchedule => ({ ...s, body: clip(s.body, BODY_CHARS) ?? '' });
