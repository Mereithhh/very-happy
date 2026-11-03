import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { TeamResponse, TeamState } from '@slopus/happy-wire';
import { ensurePrivateDirectorySync, writePrivateFileSync } from '@/utils/secureFiles';
import { relaunchTeamOperationId, teamExitMarker, teamExitMarkerPath, teamScopeFilePath } from './relaunchScope';

/**
 * B-877 「退出团队模式」: the lead's session goes on as an ordinary session, history kept.
 * The team is archived the usual way (tasks/schedules cancelled, members stopped,
 * worktrees kept), except that the lead's own session is not stopped
 * (`archive.keepLeadSession`). This machine then forgets the session's team: the
 * scope file goes and a marker makes every later relaunch an ordinary one (B-730
 * would otherwise rebuild the team env from the session metadata).
 */
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
    let scope: { teamId: string; botId: string };
    try { scope = JSON.parse(readFileSync(scopeFile, 'utf8')); }
    catch {
        // A repeat after success: the scope is gone, the marker remembers the team.
        if (existsSync(marker)) {
            const { teamId, managed } = JSON.parse(readFileSync(marker, 'utf8'));
            return { teamId, managed: managed === true, leadStopped: false, alreadyExited: true };
        }
        throw new Error('This session is not in a team on this machine');
    }
    if (typeof scope?.teamId !== 'string' || typeof scope.botId !== 'string') throw new Error('Invalid team scope');
    const path = `/v1/teams/${encodeURIComponent(scope.teamId)}`;
    let team = (await http.get(path)).data.team;
    const bot = team.bots.find(candidate => candidate.id === scope.botId);
    if (!bot?.root || bot.sessionId !== sessionId) throw new Error('Only the team lead session can exit team mode; member sessions end when the team is archived');
    if (team.archivedAt === undefined) {
        team = (await http.post(`${path}/actions`, { requestId: `team-exit-${sessionId}`.slice(0, 128), action: { type: 'archive', keepLeadSession: true } })).data.team;
    }
    const leadStopped = team.operations.some(op => op.type === 'stop' && op.botId === bot.id && op.sessionId === sessionId);
    const result = { teamId: scope.teamId, managed: operationId !== null };
    ensurePrivateDirectorySync(join(home, 'teams', 'exited'));
    // B-877b: name and language feed what team tools and the one-time note tell the model (teams/exitNotice.ts).
    writePrivateFileSync(marker, JSON.stringify(teamExitMarker(team, result.managed, 'exit')));
    try { unlinkSync(scopeFile); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    return { ...result, leadStopped };
}
