import { readCredentialsForConfiguredRelay } from '@/persistence';
import { teamRequest } from './client';

/** Explicit account operation; never offered as a scoped agent tool. */
export async function setTeamPermissionMode(teamId: string, mode: string, requestId: string) {
    if (process.env.VH_TEAM_SCOPE_FILE || process.env.HAPPY_SESSION_ID) {
        throw new Error('Change team execution mode from the owner Web UI or an independent CLI terminal');
    }
    if (!teamId?.trim() || !requestId?.trim()) throw new Error('Team and request ID are required');
    if (mode !== 'default' && mode !== 'bypassPermissions') throw new Error('Mode must be default or bypassPermissions');
    const credentials = await readCredentialsForConfiguredRelay();
    if (!credentials) throw new Error('Sign in before changing team execution mode');
    const result = await teamRequest(`/v1/teams/${encodeURIComponent(teamId)}/actions`, 'POST', credentials.token, false,
        { requestId, action: { type: 'set-permission-mode', permissionMode: mode } });
    const { credential: _credential, ...safe } = result;
    return safe;
}
