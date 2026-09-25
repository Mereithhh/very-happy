import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemonControlServer } from './controlServer';
import type { TrackedSession } from './types';

/** B-505: `daemon list` must answer "is anything on this machine mid-turn"
 * for EVERY session, so an operator can check once before a supervised restart
 * instead of opening each session (the 0.2.155 upgrade looked at some only). */
describe('control server /list turnActive', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    const children: TrackedSession[] = [
        { startedBy: 'daemon', happySessionId: 'busy', pid: 11 },
        { startedBy: 'daemon', happySessionId: 'idle', pid: 12 },
        { startedBy: 'daemon', pid: 13 },
    ];
    let port: number;
    let stop: () => Promise<void>;

    beforeAll(async () => {
        const server = await startDaemonControlServer({
            controlToken,
            getChildren: () => children,
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error', errorMessage: 'not implemented' }),
            requestShutdown: () => { },
            onHappySessionWebhook: () => { },
            pushClipboard: () => ({ delivered: false, truncated: false, totalBytes: 0 }),
            isTurnActive: (id) => id === 'busy',
        });
        port = server.port;
        stop = server.stop;
    });

    afterAll(async () => { await stop(); });

    it('reports turnActive per session from the daemon-wide tracker', async () => {
        const response = await fetch(`http://127.0.0.1:${port}/list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${controlToken}` },
            body: '{}',
        });
        expect(response.status).toBe(200);
        expect((await response.json()).children).toEqual([
            { startedBy: 'daemon', happySessionId: 'busy', pid: 11, turnActive: true },
            { startedBy: 'daemon', happySessionId: 'idle', pid: 12, turnActive: false },
        ]);
    });
});
