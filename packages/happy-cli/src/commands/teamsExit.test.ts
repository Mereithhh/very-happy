import { describe, expect, it, vi } from 'vitest';
vi.mock('@/daemon/controlClient', () => ({ exitDaemonTeamMode: vi.fn(async () => ({ success: true, teamId: 't' })) }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
import { exitDaemonTeamMode } from '@/daemon/controlClient';
import { handleTeamsCommand, teamExitAgentEnvironment } from './teams';
import { TEAMS_EXIT_REFUSAL } from '@/daemon/teams/exitTeamMode';
import { resolveArea } from '@/skill/content';
import { TEAM_SKILL } from '@/teams/resources';

/** B-962: an agent asked to "restart a new team" ran `very-happy teams exit` and archived a 16-member team. */
describe('B-962 teams exit inside an agent', () => {
    it('detects every agent / managed-session marker, and none in a plain terminal', () => {
        for (const key of ['VH_TEAM_SCOPE_FILE', 'VH_TEAM_OPERATION_ID', 'HAPPY_SESSION_ID', 'HAPPY_MANAGED', 'HAPPY_SPAWNED_BY', 'VH_PEER_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_MANAGED_BY_NPM', 'CODEX_CI']) {
            expect(teamExitAgentEnvironment({ [key]: '1' }), key).toBe(key);
        }
        expect(teamExitAgentEnvironment({ HOME: '/home/x', PATH: '/bin', TERM: 'xterm' })).toBeNull();
        expect(teamExitAgentEnvironment({ CLAUDECODE: '' })).toBeNull();
    });
    it('refuses before asking the daemon, and says the person confirms it on the Web', async () => {
        const saved = process.env.VH_TEAM_SCOPE_FILE;
        process.env.VH_TEAM_SCOPE_FILE = '/tmp/scope.json';
        try {
            await expect(handleTeamsCommand(['exit', '--session-id', 's1'])).rejects.toThrow(TEAMS_EXIT_REFUSAL);
            expect(exitDaemonTeamMode).not.toHaveBeenCalled();
        } finally { if (saved === undefined) delete process.env.VH_TEAM_SCOPE_FILE; else process.env.VH_TEAM_SCOPE_FILE = saved; }
        expect(TEAMS_EXIT_REFUSAL).toContain('退出团队模式');
    });
    it('help no longer offers teams exit', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handleTeamsCommand(['--help']);
        expect(String(log.mock.calls[0][0])).not.toContain('teams exit');
        log.mockRestore();
    });
    it('the skills no longer list teams exit and tell the agent to send the user to the Web', () => {
        const teams = resolveArea('teams')!.body();
        expect(teams).not.toContain('teams exit');
        expect(teams).toContain('「退出团队模式」');
        expect(TEAM_SKILL).toContain('Only the user can leave team mode');
        expect(TEAM_SKILL).not.toContain('teams exit');
    });
});
