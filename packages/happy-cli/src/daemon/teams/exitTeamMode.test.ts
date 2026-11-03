import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exitTeamMode } from './exitTeamMode';
import { hasExitedTeamMode, teamRelaunchEnv, teamScopeFilePath } from './relaunchScope';

let home: string;
beforeEach(() => {
    const root = join(homedir(), 'code/github/skills/tmp/vh-team-B-877/tests');
    mkdirSync(root, { recursive: true });
    home = mkdtempSync(join(root, 'exit-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const scope = (file: string, botId = 'lead') => {
    mkdirSync(join(home, 'teams', 'scopes'), { recursive: true });
    writeFileSync(file, JSON.stringify({ serverUrl: 'http://s', scopeToken: 'tok', teamId: 'team-1', botId }), { mode: 0o600 });
};
const team = (over: Record<string, unknown> = {}) => ({ id: 'team-1', bots: [{ id: 'lead', root: true, sessionId: 's1' }, { id: 'm', root: false, sessionId: 's2' }], operations: [], ...over });
function http(state = team(), archived = team({ archivedAt: 1 })) {
    return { get: vi.fn(async () => ({ data: { team: state } })), post: vi.fn(async () => ({ data: { team: archived } })) } as any;
}

describe('B-877: a team lead leaves team mode and goes on as an ordinary session', () => {
    it('archives with keepLeadSession, forgets the scope, and later relaunches carry no team env', async () => {
        const file = teamScopeFilePath(home, 'op-lead');
        scope(file);
        const metadata = { teamOperationId: 'op-lead' };
        // Before: a relaunch rebuilds the team env (B-730).
        expect((await teamRelaunchEnv({ home, sessionId: 's1', metadata, log: () => {} })).VH_TEAM_SCOPE_FILE).toBe(file);
        const client = http();
        const result = await exitTeamMode({ home, sessionId: 's1', metadata, http: client });
        expect(result).toEqual({ teamId: 'team-1', managed: true, leadStopped: false });
        expect(client.post).toHaveBeenCalledWith('/v1/teams/team-1/actions', { requestId: 'team-exit-s1', action: { type: 'archive', keepLeadSession: true } });
        expect(existsSync(file)).toBe(false);
        expect(hasExitedTeamMode(home, 's1')).toBe(true);
        // After: restart / resume / automation wake relaunch it as an ordinary session, even with the old metadata.
        expect(await teamRelaunchEnv({ home, sessionId: 's1', metadata, log: () => {}, recover: async () => { throw new Error('must not rebuild'); } })).toEqual({});
        // A repeat is idempotent.
        expect(await exitTeamMode({ home, sessionId: 's1', metadata, http: http() })).toMatchObject({ teamId: 'team-1', managed: true, alreadyExited: true });
    });
    it('a team_create (adopted) lead keeps no restart: its scope file is per session', async () => {
        const file = join(home, 'teams', 'scopes', 's1.json');
        scope(file);
        expect(await exitTeamMode({ home, sessionId: 's1', metadata: {}, http: http() })).toMatchObject({ managed: false });
        expect(existsSync(file)).toBe(false);
    });
    it('does not archive again when the team is already archived', async () => {
        scope(teamScopeFilePath(home, 'op-lead'));
        const client = http(team({ archivedAt: 5 }));
        await exitTeamMode({ home, sessionId: 's1', metadata: { teamOperationId: 'op-lead' }, http: client });
        expect(client.post).not.toHaveBeenCalled();
    });
    it('reports an old server that stopped the lead anyway', async () => {
        scope(teamScopeFilePath(home, 'op-lead'));
        const client = http(team(), team({ archivedAt: 1, operations: [{ type: 'stop', botId: 'lead', sessionId: 's1' }] }));
        expect(await exitTeamMode({ home, sessionId: 's1', metadata: { teamOperationId: 'op-lead' }, http: client })).toMatchObject({ leadStopped: true });
    });
    it('refuses members and sessions outside a team, changing nothing', async () => {
        const file = teamScopeFilePath(home, 'op-m');
        scope(file, 'm');
        const client = http();
        await expect(exitTeamMode({ home, sessionId: 's2', metadata: { teamOperationId: 'op-m' }, http: client })).rejects.toThrow('Only the team lead');
        expect(client.post).not.toHaveBeenCalled();
        expect(existsSync(file)).toBe(true);
        expect(hasExitedTeamMode(home, 's2')).toBe(false);
        await expect(exitTeamMode({ home, sessionId: 's9', metadata: {}, http: client })).rejects.toThrow('not in a team');
    });
});
