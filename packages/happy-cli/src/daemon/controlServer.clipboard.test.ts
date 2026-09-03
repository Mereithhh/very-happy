import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

describe('control server /clipboard', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    const pushClipboard = vi.fn((text: string) => ({
        delivered: true,
        truncated: false,
        totalBytes: Buffer.byteLength(text, 'utf8'),
    }));
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
            pushClipboard,
        });
        port = server.port;
        stop = server.stop;
    });

    afterAll(async () => {
        await stop();
    });

    it('forwards text to the pushClipboard callback and returns its result', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/clipboard`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${controlToken}`,
            },
            body: JSON.stringify({ text: 'copy me' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ delivered: true, truncated: false, totalBytes: 7 });
        expect(pushClipboard).toHaveBeenCalledWith('copy me');
    });

    it('rejects a missing text field', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/clipboard`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${controlToken}`,
            },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });

    it.each([
        ['missing', undefined],
        ['invalid', 'Bearer wrong-token'],
        ['wrong scheme', `Basic ${controlToken}`],
    ])('rejects %s authorization before invoking the callback', async (_label, authorization) => {
        pushClipboard.mockClear();
        const res = await fetch(`http://127.0.0.1:${port}/clipboard`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(authorization ? { Authorization: authorization } : {}),
            },
            body: JSON.stringify({ text: 'must not pass' }),
        });

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
        expect(pushClipboard).not.toHaveBeenCalled();
    });

    it.each([
        '/session-started',
        '/session-event',
        '/list',
        '/stop-session',
        '/spawn-session',
        '/terminal-hook',
        '/clipboard',
        '/terminal-title',
        '/stop',
    ])('protects %s with the common fail-closed gate', async (path) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });
});
