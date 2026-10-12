import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

describe('control server /rate-limits (B-555)', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    const onRateLimits = vi.fn();
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
            onRateLimits,
        });
        port = server.port;
        stop = server.stop;
    });

    afterAll(async () => { await stop(); });

    const post = (body: unknown, token = controlToken) => fetch(`http://127.0.0.1:${port}/rate-limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });

    it('accepts a report with extra fields and hands over the sanitized value', async () => {
        const res = await post({
            provider: 'claude', observedAt: 1, status: 'allowed', future: { x: 1 },
            windows: [{ kind: 'five_hour', usedPercent: 2, resetsAt: 3, observedAt: 1, extra: 'y' }],
        });
        expect(res.status).toBe(200);
        expect(onRateLimits).toHaveBeenCalledWith({
            provider: 'claude', observedAt: 1, status: 'allowed',
            windows: [{ kind: 'five_hour', usedPercent: 2, resetsAt: 3, observedAt: 1 }],
        });
    });

    it('answers 400 for an unusable body and never calls the sink', async () => {
        onRateLimits.mockClear();
        expect((await post({ provider: 'nope', observedAt: 1, windows: [] })).status).toBe(400);
        expect(onRateLimits).not.toHaveBeenCalled();
    });

    it('still requires the control token', async () => {
        expect((await post({ provider: 'claude', observedAt: 1, windows: [] }, 'wrong')).status).toBe(401);
    });
});
