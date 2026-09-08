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
export function createTeamsClient(sessionId?: string) {
    const scopePath = () => teamScopePath(sessionId ?? process.env.HAPPY_SESSION_ID);
    return {
        async initialize(input: { teamId?: string; name: string; machineId?: string; botId?: string; requestId: string }) {
            const path = scopePath();
            if (await readTeamScope(path)) throw new Error('This session already has a team scope; use scoped team tools');
            // A worker with a missing scope must never fall back to account authority.
            if (process.env.VH_TEAM_SCOPE_FILE) throw new Error('Assigned team scope is missing; ask the owner to restore it');
            const sid = sessionId ?? process.env.HAPPY_SESSION_ID;
            if (!sid) throw new Error('A managed session identity is required');
            const machineId = (await readSettings()).machineId;
            if (!machineId) throw new Error('Connect this machine to Very Happy before joining a team');
            if (input.machineId && input.machineId !== machineId) throw new Error('Teams must use this session’s local machine');
            const persisted = readPersistedSessions()[sid];
            if (!persisted || persisted.metadata.machineId !== machineId) throw new Error('Team identity must be a persisted session on this machine');
            const credentials = await readCredentialsForConfiguredRelay();
            if (!credentials) throw new Error('Sign in to Very Happy before creating or joining a team');
            let teamId = input.teamId;
            if (!teamId) {
                const created = await teamRequest('/v1/teams', 'POST', credentials.token, false, { name: input.name, machineId, requestId: input.requestId });
                teamId = created.team.id;
            } else {
                const existing = await teamRequest(`/v1/teams/${encodeURIComponent(teamId)}`, 'GET', credentials.token, false);
                if (existing.team?.machineId !== machineId) throw new Error('Team belongs to another machine');
            }
            const result = await teamRequest(`/v1/teams/${encodeURIComponent(teamId!)}/actions`, 'POST', credentials.token, false,
                { requestId: input.requestId, action: { type: 'join', name: input.name, sessionId: sid, ...(input.botId ? { botId: input.botId } : {}) } });
            if (!result.credential?.token || !result.credential?.botId) throw new Error('Team join did not issue a credential');
            await writeTeamScope(path, { serverUrl: configuration.serverUrl, teamId: teamId!, botId: result.credential.botId, scopeToken: result.credential.token });
            return { team: result.team, botId: result.credential.botId };
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
