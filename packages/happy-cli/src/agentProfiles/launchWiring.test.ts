/**
 * B-850d wiring: the daemon hands forks their parent's account and gives the
 * automation runner / team worker the spawn-time account check. Pure parts
 * (launchAccount, runner, worker) have their own tests. Source assertions,
 * verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n');
const daemon = read('daemon/run.ts');
const spawnCmd = read('commands/spawn.ts');

describe('B-850d daemon wiring', () => {
    it('a fork without an explicit account continues on its parent\'s binding', () => {
        expect(daemon).toContain('const requested = forkSpawnAccount(options.agentProfileId, options.parentSessionId, (id) => accountServiceRef!.sessionAccount(id));\n            spawnAccountId = accountServiceRef.resolveSpawnAccount(accountAgent, requested);');
    });

    it('the team worker refuses members on an unusable account with the same check', () => {
        expect(daemon).toContain("...(accountServiceRef ? { resolveAccount: (agent: 'claude' | 'codex', requested: string | null | undefined) => accountServiceRef!.resolveSpawnAccount(agent, requested) } : {}),");
    });

    it('the automation runner aligns sticky sessions through the daemon (check + in-place rebind)', () => {
        expect(daemon).toContain("resolve: (agent: 'claude' | 'codex', requested: string | null | undefined) => accountServiceRef!.resolveSpawnAccount(agent, requested),");
        expect(daemon).toContain('const result = await accountServiceRef!.bind({ sessionId, accountId });\n            if (result.restart === \'failed\') throw new Error(result.error ?? \'restart failed\');');
    });

    it('spawn --project resolves the project account (explicit --account first)', () => {
        expect(spawnCmd).toContain("if (machineId) accountChoice = resolveLaunchAgentProfile({ project: defaults.agentProfiles, agent: agent ?? 'claude', machineId }).agentProfileId");
        expect(spawnCmd).toContain('...(accountChoice !== undefined ? { agentProfileId: accountChoice } : {}),');
    });
});
