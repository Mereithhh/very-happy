/**
 * B-850a follow-up: `very-happy account list` shows the DAEMON's account state
 * (an env-sourced key is judged in the daemon's environment), served by the
 * control server. Source assertions, verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');

describe('account list reads the daemon state', () => {
    it('CLI prefers the daemon view; the daemon serves its own AccountService state', () => {
        expect(read('commands/account.ts')).toContain('const state = daemonState ?? service.state();');
        expect(read('daemon/run.ts')).toContain('getAgentProfiles: () => accountServiceRef?.state() ?? null,');
        expect(read('daemon/controlServer.ts')).toContain("typed.post('/agent-profiles', {");
        expect(read('daemon/controlClient.ts')).toContain("const result = await daemonPost('/agent-profiles');");
    });
});
