import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { relaunchTeamOperationId, teamRelaunchEnv, teamScopeFilePath } from './relaunchScope';
import { writeReceipt } from './journal';
import { buildResumeLaunch } from '@/resume/handleResumeCommand';

let home: string;
beforeEach(() => {
    const root = join(homedir(), 'code/github/skills/tmp/vh-team-B-730/tests');
    mkdirSync(root, { recursive: true });
    home = mkdtempSync(join(root, 'relaunch-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const writeScope = (operationId: string) => {
    mkdirSync(join(home, 'teams', 'scopes'), { recursive: true });
    writeFileSync(teamScopeFilePath(home, operationId), '{}', { mode: 0o600 });
};

describe('B-730: a relaunched team wrapper stays in its team', () => {
    // The roll-pool lead was a pi session; restart, resume, offline recovery and
    // automation wake all relaunch through resumeSessionImpl / restartSessionImpl.
    it.each([
        ['claude', { flavor: 'claude', claudeSessionId: 'c1' }],
        ['codex', { flavor: 'codex', codexThreadId: 't1' }],
        ['pi', { flavor: 'acp', piSessionId: 'p1' }],
    ] as const)('%s: the relaunch env carries the scope file and operation id from session metadata', async (flavor, extra) => {
        writeScope('op-lead');
        const metadata = { path: home, host: 'h', ...extra, teamOperationId: 'op-lead' } as any;
        const env = await teamRelaunchEnv({ home, sessionId: 's1', metadata, log: () => {} });
        expect(env).toEqual({ VH_TEAM_SCOPE_FILE: join(home, 'teams', 'scopes', 'op-lead.json'), VH_TEAM_OPERATION_ID: 'op-lead', HAPPY_SPAWNED_BY: 'teams' });
        expect(buildResumeLaunch({ id: 's1', active: true, metadata }, { startedBy: 'daemon', claudeStartingMode: 'remote' }).args[0]).toBe(flavor);
    });
    it('a session that was never in a team relaunches unchanged', async () => {
        expect(await teamRelaunchEnv({ home, sessionId: 's1', metadata: { flavor: 'claude' } as any, log: () => {} })).toEqual({});
    });
    it('falls back to the newest local spawn receipt when metadata lost the operation id', () => {
        writeReceipt(home, { operationId: 'op-old', teamId: 't', claimId: 'c', phase: 'completed', sessionId: 's1', scopeFile: '/x' });
        writeReceipt(home, { operationId: 'op-new', teamId: 't', claimId: 'c', phase: 'delivered', sessionId: 's1', scopeFile: '/y' });
        writeReceipt(home, { operationId: 'op-stop', teamId: 't', claimId: 'c', phase: 'completed' });
        writeReceipt(home, { operationId: 'op-other', teamId: 't', claimId: 'c', phase: 'completed', sessionId: 's2', scopeFile: '/z' });
        utimesSync(join(home, 'teams', 'effects', 'op-old.json'), 1, 1);
        expect(relaunchTeamOperationId(home, 's1', {})).toBe('op-new');
        expect(relaunchTeamOperationId(home, 's3', {})).toBeNull();
        expect(relaunchTeamOperationId(home, 's1', { teamOperationId: '../escape' })).toBe('op-new');
    });
    it('rebuilds a missing scope file through the daemon', async () => {
        const recover = vi.fn(async (_op: string, file: string) => { mkdirSync(join(home, 'teams', 'scopes'), { recursive: true }); writeFileSync(file, '{"rebuilt":true}'); });
        const env = await teamRelaunchEnv({ home, sessionId: 's1', metadata: { teamOperationId: 'op-lead' }, recover, log: () => {} });
        expect(recover).toHaveBeenCalledWith('op-lead', env.VH_TEAM_SCOPE_FILE);
        expect(readFileSync(env.VH_TEAM_SCOPE_FILE, 'utf8')).toContain('rebuilt');
    });
    it('a scope that cannot be rebuilt still pins the wrapper to its team (it refuses, never goes teamless)', async () => {
        const log = vi.fn();
        const env = await teamRelaunchEnv({ home, sessionId: 's1', metadata: { teamOperationId: 'op-lead' }, recover: async () => { throw new Error('No live team launch for this session'); }, log });
        expect(env.VH_TEAM_SCOPE_FILE).toBe(teamScopeFilePath(home, 'op-lead'));
        expect(env.VH_TEAM_OPERATION_ID).toBe('op-lead');
        expect(log.mock.calls.flat().join('\n')).toMatch(/could not be rebuilt[\s\S]*missing/);
    });
    it('every daemon relaunch path spreads the team env', () => {
        const source = readFileSync(join(__dirname, '..', 'run.ts'), 'utf8');
        for (const name of ['resumeSessionImpl', 'restartSessionImpl']) {
            const start = source.indexOf(`const ${name} = async`);
            const body = source.slice(start, source.indexOf('\n    };\n', start));
            expect(body, name).toContain('await teamRelaunchEnvFor(happySessionId, metadata)');
            expect(body, name).toContain('...teamEnv,');
        }
    });
});
