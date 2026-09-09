import { randomUUID } from 'node:crypto';
import { configuration } from '@/configuration';
import { readCredentialsForConfiguredRelay, readSettings, readPersistedSessions } from '@/persistence';
import { readTeamScope, teamScopePath, writeTeamScope } from './context';

// Never propagate HTTP bodies/errors: upstream diagnostics may contain credentials.
export async function teamRequest(path: string, method: string, token: string, scoped: boolean, body?: unknown): Promise<any> {
    const response = await fetch(`${configuration.serverUrl}${path}`, {
        method, redirect: 'error', headers: { 'content-type': 'application/json', ...(scoped ? { 'x-happy-team-token': token } : { authorization: `Bearer ${token}` }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25_000),
    }).catch(() => { throw new Error('Teams connection failed; outcome may be unknown. Reuse the request ID when retrying.'); });
    if (!response.ok) throw new Error(`Teams request failed (HTTP ${response.status})`);
    try { return await response.json(); } catch { throw new Error('Teams returned an invalid response'); }
}
export class TeamConnectionPreflightError extends Error {}

const initializationLocks = new Map<string, Promise<unknown>>();
async function serializeInitialization<T>(path: string, work: () => Promise<T>): Promise<T> {
    const previous = initializationLocks.get(path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    initializationLocks.set(path, next);
    try { return await next; }
    finally { if (initializationLocks.get(path) === next) initializationLocks.delete(path); }
}

export function createTeamsClient(sessionId?: string) {
    const scopePath = () => teamScopePath(sessionId ?? process.env.HAPPY_SESSION_ID);
    return {
        async initialize(input: { teamId?: string; name: string; machineId?: string; botId?: string; requestId: string }, options?: { resumeAdoption?: boolean; expectedTeamId?: string; onTeamResolved?: (teamId: string) => Promise<void> }) {
            const path = scopePath();
            return serializeInitialization(path, async () => {
                const priorScope = await readTeamScope(path);
                if (priorScope && !options?.resumeAdoption) throw new Error('This session already has a team scope; use scoped team tools');
                // A worker with a missing scope must never fall back to account authority.
                if (process.env.VH_TEAM_SCOPE_FILE) throw new Error('Assigned team scope is missing or already managed; ask the owner to restore it');
                const sid = sessionId ?? process.env.HAPPY_SESSION_ID;
                if (!sid) throw new Error('A managed session identity is required');
                const machineId = (await readSettings()).machineId;
                if (!machineId) throw new TeamConnectionPreflightError('Connect this machine to Very Happy before joining a team');
                if (input.machineId && input.machineId !== machineId) throw new TeamConnectionPreflightError('Teams must use this session’s local machine');
                const persisted = readPersistedSessions()[sid];
                if (!persisted || persisted.metadata.machineId !== machineId) throw new TeamConnectionPreflightError('Team identity must be a persisted session on this machine');
                const credentials = await readCredentialsForConfiguredRelay();
                if (!credentials) throw new TeamConnectionPreflightError('Sign in to Very Happy before creating or joining a team');
                if (priorScope && !options?.expectedTeamId) throw new Error('This session already belongs to another team scope');
                let teamId = input.teamId ?? options?.expectedTeamId;
                if (!teamId) {
                    const created = await teamRequest('/v1/teams', 'POST', credentials.token, false, { name: input.name, machineId, requestId: input.requestId });
                    teamId = created.team.id;
                } else {
                    const existing = await teamRequest(`/v1/teams/${encodeURIComponent(teamId)}`, 'GET', credentials.token, false);
                    if (existing.team?.machineId !== machineId) throw new TeamConnectionPreflightError('Team belongs to another machine');
                }
                if (options?.onTeamResolved) await options.onTeamResolved(teamId!);
                if (priorScope) {
                    if (priorScope.teamId !== teamId || priorScope.taskId) throw new Error('This session already belongs to another team scope');
                    const inspected = await teamRequest(`/v1/teams/${encodeURIComponent(teamId!)}/agent`, 'GET', priorScope.scopeToken, true);
                    const bot = inspected.team?.bots?.find((candidate: any) => candidate.id === priorScope.botId);
                    if (!bot?.root || bot.managed || bot.sessionId !== sid) throw new Error('Existing scope is not this session’s root identity');
                    return { team: inspected.team, botId: priorScope.botId };
                }
                const result = await teamRequest(`/v1/teams/${encodeURIComponent(teamId!)}/actions`, 'POST', credentials.token, false,
                    { requestId: input.requestId, action: { type: 'join', name: input.name, sessionId: sid, ...(input.botId ? { botId: input.botId } : {}) } });
                if (!result.credential?.token || !result.credential?.botId) throw new Error('Team join did not issue a credential');
                await writeTeamScope(path, { serverUrl: configuration.serverUrl, teamId: teamId!, botId: result.credential.botId, scopeToken: result.credential.token });
                return { team: result.team, botId: result.credential.botId };
            });
        },
        async inspect() {
            const scope = await readTeamScope(scopePath());
            if (!scope) throw new Error('Join or create a team first');
            const { credential: _credential, ...safe } = await teamRequest(`/v1/teams/${encodeURIComponent(scope.teamId)}/agent`, 'GET', scope.scopeToken, true);
            return safe;
        },
        async action(action: Record<string, unknown>, requestId: string = randomUUID()) {
            const scope = await readTeamScope(scopePath());
            if (!scope) throw new Error('Join or create a team first');
            const result = await teamRequest(`/v1/teams/${encodeURIComponent(scope.teamId)}/agent`, 'POST', scope.scopeToken, true, { requestId, action });
            // Scope issuance is never part of a model-facing response.
            const { credential: _credential, ...safe } = result;
            return safe;
        },
    };
}
