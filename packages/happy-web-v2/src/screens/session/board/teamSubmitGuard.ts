/**
 * B-945: a「根目标已提交，等你验收」card whose lead still owns open tasks — its「验收」
 * would be refused (`owned_tasks_unfinished`) and, before the fix, stopped the lead.
 * Facts come from the team list the sidebar already holds; unknown = no guard (the
 * server still refuses, and the toast says why).
 */
import { isAttentionActive, type AttentionItem, type TeamOwnedOpenTasks, type TeamState } from '@slopus/happy-wire';
import { acceptBlockedByOpenTasks } from '@/screens/teams/leadRevive';

export const TEAM_SUBMIT_PREFIX = 'team-submit:';
export const TEAM_SUBMIT_ACCEPT = 'accept';

export function teamSubmitOpenTasks(item: Pick<AttentionItem, 'source' | 'key' | 'teamId' | 'state'>, teams: readonly TeamState[]): TeamOwnedOpenTasks | null {
    if (item.source !== 'team' || !item.key?.startsWith(TEAM_SUBMIT_PREFIX) || !item.teamId || !isAttentionActive(item.state)) return null;
    const team = teams.find(t => t.id === item.teamId);
    const task = team?.tasks.find(t => t.id === item.key!.slice(TEAM_SUBMIT_PREFIX.length));
    return team && task ? acceptBlockedByOpenTasks(team, task) : null;
}
