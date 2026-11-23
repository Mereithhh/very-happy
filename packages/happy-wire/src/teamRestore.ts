import type { TeamArchiveRecord, TeamBot, TeamState } from './teams';
import { TEAM_RESTORE_WINDOW_MS } from './teams';

/**
 * B-962: what an archive cancelled — tasks (with their state before), schedules and undelivered messages.
 * A recorded archive says it exactly; an archive from before B-962 is inferred: what closed at the very
 * moment of the archive (`closedAt` / `finishedAt` / `cancelledAt` == `archivedAt`). Inferred schedules come
 * back paused (their state before is unknown); inferred tasks come back queued.
 */
export function archiveRestorable(team: Pick<TeamState, 'archivedAt' | 'archive' | 'tasks' | 'schedules' | 'messages'>): NonNullable<TeamArchiveRecord['restorable']> | null {
    if (team.archivedAt === undefined) return null;
    if (team.archive?.restorable && team.archive.at === team.archivedAt) return team.archive.restorable;
    const at = team.archivedAt;
    return {
        tasks: team.tasks.filter(t => t.status === 'cancelled' && t.closedAt === at).map(t => ({ id: t.id, status: 'queued' as const, attemptStatus: 'pending' as const })),
        schedules: (team.schedules ?? []).filter(x => x.status === 'cancelled' && x.finishedAt === at).map(x => ({ id: x.id, status: 'paused' as const, nextRunAt: null })),
        messageIds: team.messages.filter(m => m.deliveredAt === null && m.cancelledAt === at && !m.scheduleId).map(m => m.id),
    };
}
/** B-962: the conversation a restored member continues — its bound session (a lead kept by 「退出团队模式」), else its last one. */
export function restoreSessionId(bot: TeamBot): string | null {
    if (bot.sessionId) return bot.sessionId;
    return bot.previousSessionIds?.length ? bot.previousSessionIds[bot.previousSessionIds.length - 1] : null;
}

/** B-962: why the owner cannot restore this team now, or null when it can. */
export type TeamRestoreBlock = 'team_not_archived' | 'restore_expired';
export function teamRestoreBlock(team: Pick<TeamState, 'archivedAt'>, now: number): TeamRestoreBlock | null {
    if (team.archivedAt === undefined) return 'team_not_archived';
    return now - team.archivedAt > TEAM_RESTORE_WINDOW_MS ? 'restore_expired' : null;
}
