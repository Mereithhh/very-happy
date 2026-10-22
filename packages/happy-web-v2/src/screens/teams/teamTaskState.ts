import type { TeamState, TeamTask } from '@slopus/happy-wire';
import type { AgentExecution } from '@/sync/agentStatus';

/**
 * B-761 — the one rule for「这个任务现在是什么状态」: board lanes, task cards,
 * the details dialog, the list card, member avatars and the chat's task pill.
 *
 * `task.status` is the protocol state (queued → running → submitted → done /
 * cancelled) and only moves on explicit actions — a member whose turn ended,
 * or whose session exited, leaves its task `running` until someone submits,
 * hands off or cancels (reducer `session-event`: "still requires explicit
 * submission"). Showing that raw value as「运行中」is what lied (prod 10-22:
 * 业务数据治理's lead idle for 2 h, its goal still 运行中). So an unfinished
 * task is refined by what its member's session is doing NOW — the same
 * `sessionExecution` the sidebar and the session board use (heartbeat lease,
 * AGENTS #13) — and「运行中」means exactly: that session has an active turn,
 * a running sub-agent or background tasks.
 *
 * | task.status | condition                                   | state        |
 * |-------------|---------------------------------------------|--------------|
 * | queued      | current launch failed / outcome unknown     | launchFailed |
 * | queued      | current launch pending / claimed            | starting     |
 * | queued      | otherwise (waiting for a member slot)       | queued       |
 * | running     | no session, launch pending / claimed        | starting     |
 * | running     | no session otherwise                        | stopped      |
 * | running     | session running / background                | working      |
 * | running     | session has a pending permission request    | waiting      |
 * | running     | session online, no active turn              | idle         |
 * | running     | session offline / archived                  | stopped      |
 * | running     | session not loaded / lease stale, `exited`  | stopped      |
 * | running     | session not loaded / lease stale            | checking     |
 * | submitted   | —                                           | submitted    |
 * | done        | —                                           | done         |
 * | cancelled   | —                                           | cancelled    |
 *
 * `checking` never claims「运行中」: unknown is shown as unknown (宁可晚亮，不可长亮).
 */
export const TEAM_TASK_STATES = ['queued', 'starting', 'launchFailed', 'working', 'waiting', 'idle', 'stopped', 'checking', 'submitted', 'done', 'cancelled'] as const;
export type TeamTaskState = (typeof TEAM_TASK_STATES)[number];
/** Board lanes: 待开始 / 进行中 / 待验收 / 已结束. */
export type TeamTaskLane = 'queued' | 'running' | 'submitted' | 'finished';
/** What a member session is doing now (`sessionExecution`), `undefined` when it is not loaded. */
export type MemberExecution = (sessionId: string) => AgentExecution | undefined;

const LANE: Record<TeamTaskState, TeamTaskLane> = {
    queued: 'queued', starting: 'queued', launchFailed: 'queued',
    working: 'running', waiting: 'running', idle: 'running', stopped: 'running', checking: 'running',
    submitted: 'submitted', done: 'finished', cancelled: 'finished',
};

export function teamTaskLane(state: TeamTaskState): TeamTaskLane {
    return LANE[state];
}

/** States the owner should act on: a dead member, a failed launch, a permission prompt. */
export function teamTaskNeedsOwner(state: TeamTaskState): boolean {
    return state === 'stopped' || state === 'launchFailed' || state === 'waiting';
}

export function teamTaskState(team: Pick<TeamState, 'bots' | 'operations'>, task: TeamTask, execution: MemberExecution): TeamTaskState {
    if (task.status === 'done' || task.status === 'cancelled' || task.status === 'submitted') return task.status;
    const launch = team.operations.find(op => op.type === 'spawn' && op.taskId === task.id && op.attemptId === task.currentAttemptId);
    const launching = !!launch && (launch.status === 'pending' || launch.status === 'claimed');
    if (task.status === 'queued') {
        if (launch && (launch.status === 'failed' || launch.status === 'unknown')) return 'launchFailed';
        return launching ? 'starting' : 'queued';
    }
    const bot = team.bots.find(b => b.id === task.assigneeBotId);
    if (!bot?.sessionId) return launching ? 'starting' : 'stopped';
    switch (execution(bot.sessionId)) {
        case 'running': case 'background': return 'working';
        case 'input': return 'waiting';
        case 'idle': return 'idle';
        case 'offline': return 'stopped';
        default: return bot.lastEvent === 'exited' ? 'stopped' : 'checking';
    }
}

/** The status pill tone: accent only for a live turn (design contract), warn / danger for owner work. */
export function teamTaskTone(state: TeamTaskState): 'live' | 'warn' | 'danger' | null {
    if (state === 'working') return 'live';
    if (state === 'stopped' || state === 'launchFailed') return 'danger';
    if (state === 'waiting' || state === 'submitted') return 'warn';
    return null;
}
