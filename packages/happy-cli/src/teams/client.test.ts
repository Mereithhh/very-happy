import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, stat, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { configuration } from '@/configuration';
import { writeTeamScope, readTeamScope } from './context';
import { createTeamsClient } from './client';
import { readCredentialsForConfiguredRelay } from '@/persistence';
vi.mock('@/persistence', () => ({ readCredentialsForConfiguredRelay: vi.fn() }));

describe('team scope transport boundary', () => {
    const previous = process.env.VH_TEAM_SCOPE_FILE;
    afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); if (previous === undefined) delete process.env.VH_TEAM_SCOPE_FILE; else process.env.VH_TEAM_SCOPE_FILE = previous; });
    it('uses only scope authority and strips credentials from model responses', async () => {
        const base = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
        await mkdir(base, { recursive: true });
        const dir = await mkdtemp(join(base, 'scope-'));
        const file = join(dir, 'scope.json');
        try {
            await writeTeamScope(file, { serverUrl: configuration.serverUrl, scopeToken: 'secret-scope', teamId: 'team', botId: 'bot' });
            if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
            process.env.VH_TEAM_SCOPE_FILE = file;
            const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ team: {}, credential: { token: 'secret-result' } })));
            vi.stubGlobal('fetch', transport);
            const result = await createTeamsClient('session').action({ type: 'accept', taskId: 'task' }, 'request');
            expect(transport.mock.calls[0][1].headers).toEqual({ 'content-type': 'application/json', 'x-happy-team-token': 'secret-scope' });
            expect(result).toEqual({ team: {} });
            expect(readCredentialsForConfiguredRelay).not.toHaveBeenCalled();
            await expect(createTeamsClient('session').initialize({ name: 'root', requestId: 'r' })).rejects.toThrow('already');
            if (process.platform !== 'win32') {
                await chmod(file, 0o644);
                await expect(readTeamScope(file)).rejects.toThrow('unsafe');
            }
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
    it('does not fall back to account authority when an assigned worker scope is missing', async () => {
        process.env.VH_TEAM_SCOPE_FILE = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/no-such-scope.json');
        await expect(createTeamsClient('worker').initialize({ name: 'root', requestId: 'r' })).rejects.toThrow('missing');
        expect(readCredentialsForConfiguredRelay).not.toHaveBeenCalled();
    });
});
