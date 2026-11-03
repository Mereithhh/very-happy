import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exitTeamMode } from './exitTeamMode';
import { archivedLeadMarker, hasExitedTeamMode, teamExitMarkerPath, teamRelaunchEnv, teamScopeFilePath } from './relaunchScope';
import { writeReceipt } from './journal';

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
const team = (over: Record<string, unknown> = {}) => ({ id: 'team-1', name: 'qa49-exit-cli', tasks: [{ goal: '数一下仓库里有多少个测试文件', ownerBotId: null }], bots: [{ id: 'lead', root: true, sessionId: 's1' }, { id: 'm', root: false, sessionId: 's2' }], operations: [], ...over });
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
        // B-877b: the marker carries what the model is later told (team name, owner's language).
        expect(JSON.parse(readFileSync(teamExitMarkerPath(home, 's1'), 'utf8'))).toMatchObject({ teamId: 'team-1', teamName: 'qa49-exit-cli', managed: true, reason: 'exit', language: { code: 'zh' } });
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

describe('B-877b: a lead relaunched after its team was archived (B-730 path) goes on as an ordinary session', () => {
    const spawned = (botId = 'lead', sessionId = 's1') => {
        writeReceipt(home, { operationId: 'op-lead', teamId: 'team-1', claimId: 'c', phase: 'delivered', sessionId, scopeFile: teamScopeFilePath(home, 'op-lead') });
        return team({ archivedAt: 9, operations: [{ id: 'op-lead', type: 'spawn', botId, sessionId }] });
    };
    it('writes an archived marker and drops the team env', async () => {
        const archived = spawned();
        scope(teamScopeFilePath(home, 'op-lead'));
        const read = vi.fn(async () => archived as any);
        const env = await teamRelaunchEnv({ home, sessionId: 's1', metadata: { teamOperationId: 'op-lead' }, team: read, log: () => {}, recover: async () => { throw new Error('must not rebuild'); } });
        expect(env).toEqual({});
        expect(read).toHaveBeenCalledWith('team-1');
        expect(JSON.parse(readFileSync(teamExitMarkerPath(home, 's1'), 'utf8'))).toMatchObject({ teamId: 'team-1', teamName: 'qa49-exit-cli', reason: 'archived', language: { code: 'zh' } });
        // Later relaunches stop at the marker, without asking the server again.
        expect(await teamRelaunchEnv({ home, sessionId: 's1', metadata: { teamOperationId: 'op-lead' }, team: read, log: () => {} })).toEqual({});
        expect(read).toHaveBeenCalledTimes(1);
    });
    it('keeps the team env for a live team, a member, or an unreachable server', async () => {
        const file = teamScopeFilePath(home, 'op-lead');
        scope(file);
        const live = { ...spawned(), archivedAt: undefined };
        const metadata = { teamOperationId: 'op-lead' };
        expect((await teamRelaunchEnv({ home, sessionId: 's1', metadata, team: async () => live as any, log: () => {} })).VH_TEAM_SCOPE_FILE).toBe(file);
        expect((await teamRelaunchEnv({ home, sessionId: 's2', metadata, team: async () => spawned('m', 's2') as any, log: () => {} })).VH_TEAM_SCOPE_FILE).toBe(file);
        expect((await teamRelaunchEnv({ home, sessionId: 's1', metadata, team: async () => { throw new Error('offline'); }, log: () => {} })).VH_TEAM_SCOPE_FILE).toBe(file);
        expect(hasExitedTeamMode(home, 's1') || hasExitedTeamMode(home, 's2')).toBe(false);
    });
    it('archivedLeadMarker only names the root bot bound to this session', () => {
        const archived = spawned() as any;
        expect(archivedLeadMarker(archived, 'op-lead', 's1')).toMatchObject({ reason: 'archived', managed: true });
        expect(archivedLeadMarker(archived, 'op-lead', 's2')).toBeNull();
        expect(archivedLeadMarker(archived, 'op-other', 's1')).toBeNull();
        expect(archivedLeadMarker({ ...archived, archivedAt: undefined }, 'op-lead', 's1')).toBeNull();
    });
});
