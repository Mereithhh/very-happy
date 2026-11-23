import type { TeamArchiveRecord, TeamBot, TeamOperation, TeamState } from './teams';
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

/**
 * B-962c: why a restored member started a fresh session instead of continuing its own. The server
 * writes the first three at restore time; the daemon reports the rest from its relaunch attempt
 * (`restart:restart-limit: …`, `resume-precheck:not-tracked: …`, …).
 */
export type TeamRestoreFallbackKind = 'conflict' | 'transferred' | 'no-session' | 'restart-limit' | 'cwd-missing' | 'not-tracked' | 'conversation-missing' | 'other';
export function teamRestoreFallbackKind(reason: string): TeamRestoreFallbackKind {
    if (reason.startsWith('conflict')) return 'conflict';
    if (reason.startsWith('transferred')) return 'transferred';
    if (reason.startsWith('no-session')) return 'no-session';
    if (reason.includes('restart-limit')) return 'restart-limit';
    if (reason.includes('cwd-missing') || reason.includes('missing-cwd')) return 'cwd-missing';
    if (reason.includes('not-tracked')) return 'not-tracked';
    if (reason.includes('conversation-missing') || reason.includes('no-backend-id')) return 'conversation-missing';
    return 'other';
}
/** B-962c: the line a member that starts fresh on a restore reads first (server and daemon say the same). */
export function teamRestoreFreshNote(reason: string): string {
    return `[Very Happy: team restored] The owner restored this team after it was archived; your previous conversation could not be continued (${reason.slice(0, 300)}), so this is a fresh session in a new worktree; earlier work is on the previous worktree's branch if it was committed. Run team_inspect first.`;
}

export type TeamRestoreOutcome = {
    botId: string; botName: string; root: boolean;
    /** pending: not launched yet; continued: its own conversation; fresh: a new session (see reason); failed: the launch failed. */
    state: 'pending' | 'continued' | 'fresh' | 'failed';
    kind?: TeamRestoreFallbackKind; reason?: string;
};
/**
 * B-962c: how each member came back from the team's latest restore, lead first; null when the team
 * was never restored. A member continued only when its launch bound the session it was to resume.
 */
export function teamRestoreOutcomes(team: Pick<TeamState, 'archivedAt' | 'archiveHistory' | 'operations' | 'bots'>): TeamRestoreOutcome[] | null {
    if (team.archivedAt !== undefined) return null;
    const restoredAt = [...(team.archiveHistory ?? [])].reverse().find(h => typeof h.restoredAt === 'number')?.restoredAt;
    if (restoredAt === undefined) return null;
    const ops = team.operations.filter(o => o.restoreVersion === 1 && o.type === 'spawn' && o.createdAt === restoredAt);
    const outcome = (o: TeamOperation): Pick<TeamRestoreOutcome, 'state' | 'kind' | 'reason'> => {
        if (o.restoreFallback) return { state: o.status === 'failed' || o.status === 'unknown' ? 'failed' : 'fresh', kind: teamRestoreFallbackKind(o.restoreFallback), reason: o.restoreFallback };
        if (o.status === 'failed' || o.status === 'unknown') return { state: 'failed', ...(o.error ? { reason: o.error } : {}) };
        if (o.status !== 'completed') return { state: 'pending' };
        // An old daemon reports no reason: it still started fresh when the bound session differs.
        return o.resumeSessionId && o.sessionId === o.resumeSessionId ? { state: 'continued' } : { state: 'fresh', kind: 'other' };
    };
    return ops.map(o => {
        const bot = team.bots.find(b => b.id === o.botId);
        return { botId: o.botId, botName: bot?.name ?? o.botId, root: bot?.root === true, ...outcome(o) };
    }).sort((a, b) => Number(b.root) - Number(a.root));
}
