import type { TeamBot, TeamState } from './teams';

/**
 * B-692: one rule for "who is a member right now", shared by the server
 * (limits, reuse, teamView counts), the Web (member list folding, B-690) and
 * agents (team_inspect). Derived from authoritative state; never stored.
 *
 * - `active`:   the lead, a bot with unfinished work (task not done/cancelled,
 *               or a launch of its current generation still in progress), or a
 *               user-linked session.
 * - `stopping`: a cleanup (stop) that has not completed — including a retained
 *               cleanup that needs the owner (B-691). Not yet reusable.
 * - `idle`:     a managed bot still bound to a session with nothing to do.
 * - `inactive`: a managed bot with no session, no work and no pending
 *               operation —「已停用」. It is not counted as a member and can be
 *               reused or reactivated by delegating to it.
 */
export type TeamBotActivity = 'active' | 'stopping' | 'idle' | 'inactive';
export type TeamMemberCounts = { active: number; stopping: number; idle: number; inactive: number };

const UNFINISHED = ['pending', 'claimed', 'failed', 'unknown'];

export function teamBotActivity(team: Pick<TeamState, 'tasks' | 'operations'>, bot: TeamBot): TeamBotActivity {
    if (bot.root) return 'active';
    if (team.tasks.some(t => t.assigneeBotId === bot.id && !['done', 'cancelled'].includes(t.status))) return 'active';
    if (team.operations.some(o => o.botId === bot.id && o.type === 'spawn' && o.generation === bot.generation && UNFINISHED.includes(o.status) && o.error !== 'task_closed_before_spawn')) return 'active';
    if (team.operations.some(o => o.botId === bot.id && o.type === 'stop' && UNFINISHED.includes(o.status))) return 'stopping';
    if (bot.sessionId) return bot.managed ? 'idle' : 'active';
    return bot.managed ? 'inactive' : 'active';
}

/** Members = everyone except `inactive`; the counts let UIs show「已停用 M」. */
export function teamMemberCounts(team: Pick<TeamState, 'bots' | 'tasks' | 'operations'>): TeamMemberCounts {
    const counts: TeamMemberCounts = { active: 0, stopping: 0, idle: 0, inactive: 0 };
    for (const bot of team.bots) counts[teamBotActivity(team, bot)]++;
    return counts;
}
