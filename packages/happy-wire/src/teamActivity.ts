import type { TeamBot, TeamCleanupIssue, TeamOperation, TeamState } from './teams';

/**
 * B-692: the one rule for "who is a member right now" — server (member limit,
 * reuse, teamView counts), Web (B-690 member folding, counts) and agents
 * (team_inspect). Derived from state; never stored.
 *
 * - `active`:   the lead, a member with an unfinished task (queued / running /
 *               submitted), or a launch of its current generation in progress.
 * - `stopping`: an unfinished cleanup (stop), including one retained for the
 *               owner (B-691) — shown as「回收需要处理」, never folded.
 * - `inactive`:「已停用」— no unfinished task and any of: no session (cleanup
 *               unbound it, or it never started), the session is archived, its
 *               last event is `exited`, or its last event is older than 7 days.
 *               Not counted as a member.
 * - `idle`:     bound to a live-looking session with nothing to do; still a member.
 */
export type TeamBotActivity = 'active' | 'stopping' | 'idle' | 'inactive';
export type TeamMemberCounts = { active: number; stopping: number; idle: number; inactive: number };
export type TeamActivityContext = {
    now?: number;
    /** Whether a member's session is archived (only the Web knows); default: not archived. */
    sessionArchived?: (sessionId: string) => boolean;
};

/** A member whose last event is older than this is inactive (B-690). */
export const TEAM_MEMBER_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

const UNFINISHED = ['pending', 'claimed', 'failed', 'unknown'];

export function teamBotActivity(team: Pick<TeamState, 'tasks' | 'operations'>, bot: TeamBot, context: TeamActivityContext = {}): TeamBotActivity {
    if (bot.root) return 'active';
    if (team.tasks.some(t => t.assigneeBotId === bot.id && !['done', 'cancelled'].includes(t.status))) return 'active';
    if (team.operations.some(o => o.botId === bot.id && o.type === 'stop' && UNFINISHED.includes(o.status))) return 'stopping';
    if (team.operations.some(o => o.botId === bot.id && o.type === 'spawn' && o.generation === bot.generation && UNFINISHED.includes(o.status) && o.error !== 'task_closed_before_spawn')) return 'active';
    if (!bot.sessionId) return 'inactive';
    if (context.sessionArchived?.(bot.sessionId)) return 'inactive';
    if (bot.lastEvent === 'exited') return 'inactive';
    if (bot.lastEventAt !== undefined && (context.now ?? Date.now()) - bot.lastEventAt > TEAM_MEMBER_IDLE_MS) return 'inactive';
    return 'idle';
}

/** Members = everyone but `inactive`; `inactive` is the「已停用 M」count. */
export function teamMemberCounts(team: Pick<TeamState, 'bots' | 'tasks' | 'operations'>, context: TeamActivityContext = {}): TeamMemberCounts {
    const counts: TeamMemberCounts = { active: 0, stopping: 0, idle: 0, inactive: 0 };
    for (const bot of team.bots) counts[teamBotActivity(team, bot, context)]++;
    return counts;
}

/**
 * B-775: whether a launch for `botId` must wait for its cleanup. Only a cleanup
 * whose session is still bound to the member blocks: that wrapper may still be
 * running and a member has at most one live session. When the daemon confirmed
 * the session stopped and only the worktree was retained (dirty / unmerged /
 * ownership unknown), the server unbinds the session (`fail-operation`
 * `sessionStopped`) and new work launches in a fresh worktree.
 */
export function teamCleanupHoldsSession(team: Pick<TeamState, 'bots' | 'operations'>, botId: string): TeamOperation | undefined {
    const bot = team.bots.find(b => b.id === botId);
    if (!bot?.sessionId) return undefined;
    return team.operations.find(o => o.botId === botId && o.type === 'stop' && o.status !== 'completed' && o.sessionId === bot.sessionId);
}

/**
 * B-775: cleanups that failed and wait for the owner (「重试清理」/「标记已处理」 on
 * the team page). `holdsSession`: new work for this member cannot start until
 * then; `waitingTaskIds`: queued tasks of the member whose launch is held.
 */
export function teamCleanupIssues(team: Pick<TeamState, 'bots' | 'tasks' | 'operations'>): TeamCleanupIssue[] {
    return team.operations.filter(o => o.type === 'stop' && (o.status === 'failed' || o.status === 'unknown')).map(o => {
        const bot = team.bots.find(b => b.id === o.botId);
        const holdsSession = teamCleanupHoldsSession(team, o.botId)?.id === o.id;
        const waitingTaskIds = holdsSession ? team.tasks.filter(t => t.assigneeBotId === o.botId && t.status === 'queued').map(t => t.id) : [];
        return { botId: o.botId, name: bot?.name ?? o.botId, operationId: o.id, taskId: o.taskId, error: o.error, holdsSession, waitingTaskIds };
    });
}
