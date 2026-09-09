import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sendUserMessage, waitForSessionKey } from '@/commands/sessionMessage';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { configuration } from '@/configuration';
import { readCredentialsForConfiguredRelay, readPersistedSessions, readSettings } from '@/persistence';
import { createTeamAdoption, type TeamAdoptResult } from './adopt';
import { readTeamScope, teamScopePath, writeTeamScope } from './context';

vi.mock('@/commands/sessionMessage', () => ({ sendUserMessage: vi.fn(), waitForSessionKey: vi.fn() }));
vi.mock('@/persistence', () => ({ readCredentialsForConfiguredRelay: vi.fn(), readSettings: vi.fn(), readPersistedSessions: vi.fn() }));
const input = { name: 'Website', requestId: 'adopt-one' };
const team = { id: 'team-one', machineId: 'machine', bots: [{ id: 'lead', root: true, managed: false, sessionId: 'session' }] };
let base: string;
const previousHome = configuration.happyHomeDir;
const previousScope = process.env.VH_TEAM_SCOPE_FILE;
let fetchMock: ReturnType<typeof vi.fn>;
async function settle(adopt: ReturnType<typeof createTeamAdoption>, payload = input): Promise<TeamAdoptResult> {
    let result = adopt(payload);
    for (let i = 0; i < 100 && 'status' in result && result.status === 'pending'; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
        result = adopt(payload);
    }
    return result;
}
beforeEach(async () => {
    delete process.env.VH_TEAM_SCOPE_FILE;
    const root = join(homedir(), 'code/github/skills/tmp/teams-first-use/tests');
    await mkdir(root, { recursive: true });
    base = await mkdtemp(join(root, 'adopt-'));
    Object.defineProperty(configuration, 'happyHomeDir', { value: base, configurable: true });
    vi.mocked(waitForSessionKey).mockResolvedValue({ encryptionKey: 'key' } as any);
    vi.mocked(sendUserMessage).mockResolvedValue(undefined);
    vi.mocked(readSettings).mockResolvedValue({ machineId: 'machine' } as any);
    vi.mocked(readPersistedSessions).mockReturnValue({ session: { metadata: { machineId: 'machine' } } } as any);
    vi.mocked(readCredentialsForConfiguredRelay).mockResolvedValue({ token: 'owner-secret' } as any);
    fetchMock = vi.fn(async (_url: string, options: any) => new Response(JSON.stringify(options.method === 'POST' && _url.endsWith('/actions')
        ? { team, credential: { botId: 'lead', token: 'scope-secret' } } : { team })));
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
    Object.defineProperty(configuration, 'happyHomeDir', { value: previousHome, configurable: true });
    if (previousScope === undefined) delete process.env.VH_TEAM_SCOPE_FILE; else process.env.VH_TEAM_SCOPE_FILE = previousScope;
    vi.unstubAllGlobals(); vi.clearAllMocks();
    await rm(base, { recursive: true, force: true });
});

describe('session adoption', () => {
    it('immediately returns pending and same-request polling connects once without returning credentials', async () => {
        const adopt = createTeamAdoption('session');
        expect(adopt(input)).toEqual({ status: 'pending', requestId: input.requestId });
        expect(adopt(input)).toEqual({ status: 'pending', requestId: input.requestId });
        const result = await settle(adopt);
        expect(result).toMatchObject({ status: 'connected', teamId: team.id, botId: 'lead' });
        expect(JSON.stringify(result)).not.toContain('scope-secret');
        expect(JSON.stringify(result)).toContain('team_inspect');
        expect(sendUserMessage).toHaveBeenCalledWith('session', { encryptionKey: 'key' }, expect.stringContaining('team_inspect'), 'teams', { localId: 'teams-adopt-adopt-one', sentFrom: 'team' });
        expect(fetchMock.mock.calls.filter(([url, options]) => options.method === 'POST')).toHaveLength(2);
        expect((await readTeamScope(teamScopePath('session')))?.scopeToken).toBe('scope-secret');
        expect(await readFile(`${teamScopePath('session')}.adopt.json`, 'utf8')).not.toContain('secret');
    });
    it('recovers after scope was written but the RPC response was lost', async () => {
        await settle(createTeamAdoption('session'));
        fetchMock.mockClear();
        const result = await settle(createTeamAdoption('session'));
        expect(result).toMatchObject({ status: 'connected', teamId: team.id });
        expect(fetchMock.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
        expect(sendUserMessage).toHaveBeenCalledTimes(1);
    });
    it('retries a lost join response with the original request ID and no second create', async () => {
        let lost = true;
        fetchMock.mockImplementation(async (url, options) => {
            if (url.endsWith('/actions') && lost) { lost = false; throw new Error('lost response'); }
            return new Response(JSON.stringify(url.endsWith('/actions') ? { team, credential: { botId: 'lead', token: 'scope-secret' } } : { team }));
        });
        expect(await settle(createTeamAdoption('session'))).toHaveProperty('error');
        expect(await settle(createTeamAdoption('session'))).toMatchObject({ status: 'connected' });
        expect(fetchMock.mock.calls.filter(([url, options]) => url.endsWith('/v1/teams') && options.method === 'POST')).toHaveLength(1);
        const joins = fetchMock.mock.calls.filter(([url]) => url.endsWith('/actions'));
        expect(joins).toHaveLength(2);
        expect(joins.map(([, options]) => JSON.parse(options.body).requestId)).toEqual(['adopt-one', 'adopt-one']);
    });
    it('recovers guidance delivery after connection succeeds and the wrapper restarts', async () => {
        vi.mocked(sendUserMessage).mockRejectedValueOnce(new Error('Message response lost'));
        expect(await settle(createTeamAdoption('session'))).toHaveProperty('error');
        expect((await readTeamScope(teamScopePath('session')))?.teamId).toBe(team.id);
        fetchMock.mockClear();
        expect(await settle(createTeamAdoption('session'))).toMatchObject({ status: 'connected' });
        expect(fetchMock.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
        expect(sendUserMessage).toHaveBeenCalledTimes(2);
        expect(vi.mocked(sendUserMessage).mock.calls.map(call => call[4]?.localId)).toEqual(['teams-adopt-adopt-one', 'teams-adopt-adopt-one']);
        expect(JSON.parse(await readFile(`${teamScopePath('session')}.adopt.json`, 'utf8')).guidanceDelivered).toBe(true);
    });
    it('finishes guidance without another UI poll, so leaving the page does not interrupt adoption', async () => {
        const adopt = createTeamAdoption('session');
        expect(adopt(input)).toEqual({ status: 'pending', requestId: input.requestId });
        await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(1));
        await vi.waitFor(async () => expect(JSON.parse(await readFile(`${teamScopePath('session')}.adopt.json`, 'utf8')).guidanceDelivered).toBe(true));
        expect(adopt(input)).toMatchObject({ status: 'connected' });
    });
    it('rejects changed intent across process restart', async () => {
        await settle(createTeamAdoption('session'));
        fetchMock.mockClear();
        expect(await settle(createTeamAdoption('session'), { ...input, requestId: 'different' })).toHaveProperty('error');
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('joins an existing team only after matching this machine', async () => {
        const result = await settle(createTeamAdoption('session'), { ...input, teamId: team.id } as any);
        expect(result).toMatchObject({ status: 'connected' });
        expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    });
    it('rejects existing unrelated scopes before creating any team', async () => {
        await writeTeamScope(teamScopePath('session'), { serverUrl: configuration.serverUrl, scopeToken: 'prior', teamId: 'other', botId: 'other' });
        expect(await settle(createTeamAdoption('session'))).toHaveProperty('error');
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('refuses assigned workers including those with missing scope files', async () => {
        process.env.VH_TEAM_SCOPE_FILE = join(base, 'missing.json');
        expect(createTeamAdoption('session')(input)).toHaveProperty('error');
        expect(readCredentialsForConfiguredRelay).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('registers the capability and handler only on an ordinary managed session', async () => {
        let metadata: any = { capabilities: ['existing'] };
        const registerHandler = vi.fn();
        const unregisterHandler = vi.fn();
        const client = { sessionId: 'session', rpcHandlerManager: { registerHandler, unregisterHandler }, updateMetadata: (fn: any) => { metadata = fn(metadata); } };
        const server = await startHappyServer(client as any);
        try {
            expect(registerHandler).toHaveBeenCalledWith('teams-adopt', expect.any(Function));
            expect(metadata.capabilities).toEqual(['existing', 'teams-adopt-v1']);
        } finally { server.stop(); }
        expect(unregisterHandler).toHaveBeenCalledWith('teams-adopt');
        registerHandler.mockClear();
        process.env.VH_TEAM_SCOPE_FILE = join(base, 'assigned.json');
        const assigned = await startHappyServer(client as any);
        try { expect(registerHandler).not.toHaveBeenCalled(); }
        finally { assigned.stop(); }
    });
    it('allows correcting a fresh request rejected before any remote mutation', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ team: { ...team, machineId: 'other' } })));
        const adopt = createTeamAdoption('session');
        expect(await settle(adopt, { ...input, teamId: 'wrong' } as any)).toHaveProperty('error');
        expect(await settle(adopt, { ...input, requestId: 'corrected', teamId: team.id } as any)).toMatchObject({ status: 'connected' });
    });
    it('refuses a team on a different machine without joining', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ team: { ...team, machineId: 'other' } })));
        expect(await settle(createTeamAdoption('session'), { ...input, teamId: team.id } as any)).toHaveProperty('error');
        expect(fetchMock.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
    });
});
