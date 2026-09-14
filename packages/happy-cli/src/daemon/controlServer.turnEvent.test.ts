import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

describe('control server /session-event turn events (B-466)', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    const onSessionStateEvent = vi.fn();
    const onClaudeAuthFailed = vi.fn();
    const onSessionTurnEvent = vi.fn();
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
            onSessionStateEvent,
            onClaudeAuthFailed,
            onSessionTurnEvent,
            pushClipboard: () => ({ delivered: false, truncated: false, totalBytes: 0 }),
        });
        port = server.port;
        stop = server.stop;
    });

    afterAll(async () => { await stop(); });

    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/session-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${controlToken}` },
        body: JSON.stringify(body),
    });

    it('routes turn_started / turn_ended to the turn sink only', async () => {
        expect((await post({ sessionId: 's1', event: 'turn_started' })).status).toBe(200);
        expect((await post({ sessionId: 's1', event: 'turn_ended' })).status).toBe(200);
        expect(onSessionTurnEvent.mock.calls).toEqual([['s1', 'turn_started'], ['s1', 'turn_ended']]);
        expect(onSessionStateEvent).not.toHaveBeenCalled();
        expect(onClaudeAuthFailed).not.toHaveBeenCalled();
    });

    it('still rejects unknown events', async () => {
        expect((await post({ sessionId: 's1', event: 'turn_paused' })).status).toBe(400);
    });
});
