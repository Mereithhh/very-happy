import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { TeamResponse, TeamState } from '@slopus/happy-wire';
import { ensurePrivateDirectorySync, writePrivateFileSync } from '@/utils/secureFiles';
import { launchTeamId, relaunchTeamOperationId, teamExitMarker, teamExitMarkerPath, teamScopeFilePath } from './relaunchScope';

/**
 * B-877 「退出团队模式」: the lead's session goes on as an ordinary session, history kept.
 * The team is archived the usual way (tasks/schedules cancelled, members stopped,
 * worktrees kept), except that the lead's own session is not stopped
 * (`archive.keepLeadSession`). This machine then forgets the session's team: the
 * scope file goes and a marker makes every later relaunch an ordinary one (B-730
 * would otherwise rebuild the team env from the session metadata).
 */
/** B-962: what `teams exit` answers in an agent's environment (and what the server's refusal says too). */
export const TEAMS_EXIT_REFUSAL = 'Exiting team mode stops every member and cancels their unfinished tasks, so it needs the person: ask the user to open the team page (or the lead conversation) on the Web, choose ⋯ → 「退出团队模式」 and confirm. 退出团队模式会停掉所有成员、取消未完成的任务，需要用户本人在网页 ⋯ 菜单里点「退出团队模式」确认；agent 不能代为执行。';
export type TeamExitHttp = {
    get: (path: string) => Promise<{ data: { team: TeamState } }>;
    post: (path: string, body: unknown) => Promise<{ data: TeamResponse }>;
};

export type TeamExitResult = {
    teamId: string;
    /** Spawned by Teams (env-bound scope): the wrapper must restart to drop it. A `team_create` session reads its scope per call. */
    managed: boolean;
    /** The server stopped the lead anyway (it predates `keepLeadSession`); a later resume is still an ordinary session. */
    leadStopped: boolean;
    /** A repeat: this machine had already taken the session out of its team (nothing to restart). */
    alreadyExited?: true;
};

export async function exitTeamMode(input: { home: string; sessionId: string; metadata: { teamOperationId?: unknown } | undefined; http: TeamExitHttp }): Promise<TeamExitResult> {
    const { home, sessionId, http } = input;
    const marker = teamExitMarkerPath(home, sessionId);
    const operationId = relaunchTeamOperationId(home, sessionId, input.metadata);
    const scopeFile = operationId ? teamScopeFilePath(home, operationId) : join(home, 'teams', 'scopes', `${sessionId}.json`);
    const forgetScope = () => { try { unlinkSync(scopeFile); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; } };
    // A repeat after success, or a lead a relaunch already found archived (relaunchScope.ts): the marker remembers the team.
    if (existsSync(marker)) {
        const { teamId, managed } = JSON.parse(readFileSync(marker, 'utf8'));
        forgetScope();
        return { teamId, managed: managed === true, leadStopped: false, alreadyExited: true };
    }
    let scope: { teamId?: unknown; botId?: unknown } | null = null;
    try { scope = JSON.parse(readFileSync(scopeFile, 'utf8')); } catch { /* B-877b: a stopped lead's spawn receipt still names its team */ }
    const teamId = typeof scope?.teamId === 'string' ? scope.teamId : operationId ? launchTeamId(home, operationId) : null;
    if (!teamId) throw new Error('This session is not in a team on this machine');
    const path = `/v1/teams/${encodeURIComponent(teamId)}`;
    let team = (await http.get(path)).data.team;
    const botId = typeof scope?.botId === 'string' ? scope.botId : team.operations.find(op => op.id === operationId)?.botId;
    const bot = team.bots.find(candidate => candidate.id === botId);
    if (!bot) throw new Error('This session is not in a team on this machine');
    if (!bot.root) throw new Error('Only the team lead session can exit team mode; member sessions end when the team is archived');
    // B-877b (QA49 P2-3): an ordinary archive unbinds the stopped lead (sessionId null, the old id in previousSessionIds).
    const bound = bot.sessionId === sessionId || (team.archivedAt !== undefined && !!bot.previousSessionIds?.includes(sessionId));
    if (!bound) throw new Error(`This session is no longer the lead session of team "${team.name}"; only its current lead session can exit team mode`);
    const archiving = team.archivedAt === undefined;
    if (archiving) {
        // B-962: the server archives only for the person on the Web (the daemon's machine token is refused); the Web
        // archives first and then calls this, which only finishes this machine's side.
        try {
            team = (await http.post(`${path}/actions`, { requestId: `team-exit-${sessionId}`.slice(0, 128), action: { type: 'archive', keepLeadSession: true, source: 'cli' } })).data.team;
        } catch (error: any) {
            if (error?.response?.status === 403) throw new Error(TEAMS_EXIT_REFUSAL);
            throw error;
        }
    }
    // Only this archive can tell: a lead an earlier ordinary archive stopped and the owner resumed is live again
    // with its team env, and must restart without it (QA49 P2-3).
    const leadStopped = archiving && team.operations.some(op => op.type === 'stop' && op.botId === bot.id && op.sessionId === sessionId);
    const result = { teamId, managed: operationId !== null };
    ensurePrivateDirectorySync(join(home, 'teams', 'exited'));
    // B-877b: name and language feed what team tools and the one-time note tell the model (teams/exitNotice.ts).
    writePrivateFileSync(marker, JSON.stringify(teamExitMarker(team, result.managed, 'exit')));
    forgetScope();
    return { ...result, leadStopped };
}
