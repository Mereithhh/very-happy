import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

describe('control server /session-event auth_failed (B-276)', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    const onSessionStateEvent = vi.fn();
    const onClaudeAuthFailed = vi.fn();
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

    it('routes auth_failed to the auth preflight, never to the assistant-report sink', async () => {
        const res = await post({ sessionId: 's1', event: 'auth_failed' });
        expect(res.status).toBe(200);
        expect(onClaudeAuthFailed).toHaveBeenCalledWith('s1');
        expect(onSessionStateEvent).not.toHaveBeenCalled();
    });

    it('keeps completed/needs_input on the assistant-report path', async () => {
        const res = await post({ sessionId: 's2', event: 'completed', spawnedBy: 'assistant' });
        expect(res.status).toBe(200);
        expect(onSessionStateEvent).toHaveBeenCalledWith('s2', 'completed', 'assistant');
        expect(onClaudeAuthFailed).toHaveBeenCalledTimes(1);
    });

    it('still rejects unknown event values (what an old daemon does with auth_failed)', async () => {
        const res = await post({ sessionId: 's3', event: 'something_else' });
        expect(res.status).toBe(400);
    });
});
