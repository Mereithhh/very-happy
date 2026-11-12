import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemonControlServer } from './controlServer';

/** B-920: `very-happy settings set --scope machine` through the daemon — writable keys only, validated here too. */
describe('control server /machine-setting', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    const writes: Array<[string, unknown]> = [];
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
            setMachineSetting: async (key, value) => { writes.push([key, value]); },
        });
        port = server.port;
        stop = server.stop;
    });
    afterAll(async () => { await stop(); });

    const post = (body: unknown, auth = true) => fetch(`http://127.0.0.1:${port}/machine-setting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${controlToken}` } : {}) },
        body: JSON.stringify(body),
    });

    it('applies a writable key and refuses everything else', async () => {
        expect((await post({ key: 'agentHibernationIdleMs', value: 2 * 60 * 60 * 1000 })).status).toBe(200);
        expect((await post({ key: 'cliAutoUpdate', value: 'off' })).status).toBe(200);
        for (const body of [
            { key: 'todoProvider', value: { command: 'sh' } },
            { key: 'webPanels', value: [] },
            { key: 'machineId', value: 'x' },
            { key: 'agentHibernationIdleMs', value: 5 },
            { key: 'sandboxConfig', value: { enabled: true, surprise: 1 } },
        ]) expect((await post(body)).status, body.key).toBe(400);
        expect((await post({ key: 'cliAutoUpdate', value: 'idle' }, false)).status).toBe(401);
        expect(writes).toEqual([['agentHibernationIdleMs', 7_200_000], ['cliAutoUpdate', 'off']]);
    });
});
