import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

describe('control server /clipboard', () => {
    const pushClipboard = vi.fn((text: string) => ({
        delivered: true,
        truncated: false,
        totalBytes: Buffer.byteLength(text, 'utf8'),
    }));
    let port: number;
    let stop: () => Promise<void>;

    beforeAll(async () => {
        const server = await startDaemonControlServer({
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
            headers: { 'Content-Type': 'application/json' },
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });
});
