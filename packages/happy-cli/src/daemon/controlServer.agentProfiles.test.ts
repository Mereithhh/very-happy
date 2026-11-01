import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentProfilesState } from '@slopus/happy-wire';
import { startDaemonControlServer } from './controlServer';

/** B-850a: `very-happy account list` reads the daemon's own account state —
 * an env-sourced key is judged in the daemon's environment, not the caller's shell. */
describe('control server /agent-profiles', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    let state: AgentProfilesState | null = null;
    let port: number;
    let stop: () => Promise<void>;

    beforeAll(async () => {
        const server = await startDaemonControlServer({
            controlToken,
            getChildren: () => [],
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error', errorMessage: 'not implemented' }),
            requestShutdown: () => { },
            onHappySessionWebhook: () => { },
            pushClipboard: () => ({ delivered: false, truncated: false, totalBytes: 0 }),
            getAgentProfiles: () => state,
        });
        port = server.port;
        stop = server.stop;
    });

    afterAll(async () => { await stop(); });

    const post = () => fetch(`http://127.0.0.1:${port}/agent-profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${controlToken}` },
        body: '{}',
    });

    it('503 until the account service exists, then the daemon state verbatim; bearer required', async () => {
        expect((await post()).status).toBe(503);
        state = { daemonPid: 7, updatedAt: 1, accounts: [{ id: 'hub', label: 'Hub', agent: 'claude', kind: 'claude-api', status: 'ok', keySource: 'env', keyRef: 'HUB_KEY' }], defaults: {} };
        const response = await post();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(state);
        const anonymous = await fetch(`http://127.0.0.1:${port}/agent-profiles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        expect(anonymous.status).toBe(401);
    });
});
