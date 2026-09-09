import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCredentialsForConfiguredRelay } from '@/persistence';
import { teamRequest } from './client';
import { setTeamPermissionMode } from './permissions';
vi.mock('@/persistence', () => ({ readCredentialsForConfiguredRelay: vi.fn() }));
vi.mock('./client', () => ({ teamRequest: vi.fn() }));
describe('owner team permissions', () => {
    beforeEach(() => { vi.stubEnv('VH_TEAM_SCOPE_FILE', ''); vi.stubEnv('HAPPY_SESSION_ID', ''); vi.mocked(readCredentialsForConfiguredRelay).mockResolvedValue({ token: 'owner-token' } as any); });
    afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
    it.each(['VH_TEAM_SCOPE_FILE', 'HAPPY_SESSION_ID'])('does not load account credentials in managed %s context', async key => {
        vi.stubEnv(key, 'managed');
        await expect(setTeamPermissionMode('team', 'bypassPermissions', 'request')).rejects.toThrow('owner Web UI');
        expect(readCredentialsForConfiguredRelay).not.toHaveBeenCalled();
        expect(teamRequest).not.toHaveBeenCalled();
    });
    it('keeps the caller request ID and uses owner authority, stripping returned credentials', async () => {
        vi.mocked(teamRequest).mockResolvedValue({ team: { permissionMode: 'bypassPermissions' }, credential: { token: 'private' } });
        expect(await setTeamPermissionMode('team', 'bypassPermissions', 'stable-request')).toEqual({ team: { permissionMode: 'bypassPermissions' } });
        expect(teamRequest).toHaveBeenCalledWith('/v1/teams/team/actions', 'POST', 'owner-token', false, { requestId: 'stable-request', action: { type: 'set-permission-mode', permissionMode: 'bypassPermissions' } });
    });
    it('rejects unknown modes without making a request', async () => {
        await expect(setTeamPermissionMode('team', 'surprise', 'request')).rejects.toThrow('Mode must');
        expect(teamRequest).not.toHaveBeenCalled();
    });
});
