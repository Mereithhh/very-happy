import type { TeamBot, TeamState, TeamTask } from './teams';
import { teamCleanupHoldsSession } from './teamActivity';

/**
 * B-945: tasks a bot delegated and has not closed — it is the one to accept, return,
 * cancel or hand them off (`ownerBotId`). A lead's own top-level delegations have no
 * `parentTaskId`, so the「直属子任务」check (`children_unfinished`) never saw them:
 * the owner accepted the root task, cleanup stopped the lead, and 31 tasks were left
 * with no one to review or push them.
 */
export type TeamOwnedOpenTasks = { total: number; submitted: number; queued: number; running: number; taskIds: string[] };

const OPEN: readonly TeamTask['status'][] = ['queued', 'running', 'submitted'];

export function teamOwnedOpenTasks(team: Pick<TeamState, 'tasks'>, botId: string): TeamOwnedOpenTasks {
    const open = team.tasks.filter(t => t.ownerBotId === botId && OPEN.includes(t.status));
    return {
        total: open.length,
        submitted: open.filter(t => t.status === 'submitted').length,
        queued: open.filter(t => t.status === 'queued').length,
        running: open.filter(t => t.status === 'running').length,
        taskIds: open.map(t => t.id),
    };
}

/** B-945: the refusal code for submitting / accepting a task whose assignee still owns open tasks. */
export const TEAM_OWNED_TASKS_UNFINISHED = 'owned_tasks_unfinished';

/** The team's managed lead — the root bot the owner can relaunch (an adopted, unmanaged lead runs outside the team's launches). */
export function teamManagedLead(team: Pick<TeamState, 'bots'>): TeamBot | undefined {
    return team.bots.find(b => b.root && b.managed);
}

/**
 * B-945: why the owner cannot relaunch `lead` now (「接回负责人」), or null when it can.
 * The relaunch is for a lead that is gone (no session) while tasks it delegated are still open.
 */
export type TeamLeadReviveBlock =
    | 'team_archived' | 'bot_not_root' | 'lead_not_managed' | 'lead_cleanup_pending'
    | 'lead_online' | 'lead_has_task' | 'lead_launch_pending' | 'lead_has_no_open_tasks';

export function teamLeadReviveBlock(team: Pick<TeamState, 'archivedAt' | 'bots' | 'tasks' | 'operations'>, lead: TeamBot): TeamLeadReviveBlock | null {
    if (team.archivedAt !== undefined) return 'team_archived';
    if (!lead.root) return 'bot_not_root';
    if (!lead.managed) return 'lead_not_managed';
    if (teamCleanupHoldsSession(team, lead.id)) return 'lead_cleanup_pending';
    if (lead.sessionId) return 'lead_online';
    // Its own unfinished task has its own launch (「重试启动」), not a second lead.
    if (team.tasks.some(t => t.assigneeBotId === lead.id && OPEN.includes(t.status))) return 'lead_has_task';
    if (team.operations.some(o => o.botId === lead.id && o.type === 'spawn' && ['pending', 'claimed', 'unknown'].includes(o.status))) return 'lead_launch_pending';
    if (teamOwnedOpenTasks(team, lead.id).total === 0) return 'lead_has_no_open_tasks';
    return null;
}
