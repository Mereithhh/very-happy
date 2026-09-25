import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';
import type { PeerSessionInfo } from './types';

describe('control server /session-edit and /peers (B-497)', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    const onSessionEdit = vi.fn();
    const peers: PeerSessionInfo[] = [
        { sessionId: 's1', kind: 'managed', pid: 42, cwd: '/repo', flavor: 'claude', title: 'T', edits: [{ path: '/repo/a.ts', tool: 'Edit', at: 5 }] },
        { sessionId: 'm1', kind: 'mirror', cwd: '/repo', flavor: 'terminal-mirror', edits: [] },
    ];
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
            onSessionEdit,
            listPeers: () => peers,
        });
        port = server.port;
        stop = server.stop;
    });

    afterAll(async () => { await stop(); });

    const post = (path: string, body: unknown, token = controlToken) => fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });

    it('records an edit report and always answers ok', async () => {
        const response = await post('/session-edit', { sessionId: 's1', path: 'src/a.ts', tool: 'Edit', cwd: '/repo' });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: 'ok' });
        expect(onSessionEdit).toHaveBeenCalledWith({ sessionId: 's1', path: 'src/a.ts', tool: 'Edit', cwd: '/repo' });
        expect((await post('/session-edit', { sessionId: 's1', path: 'b.ts', tool: 'Write', at: 1_700_000_000_000 })).status).toBe(200);
        expect(onSessionEdit).toHaveBeenLastCalledWith({ sessionId: 's1', path: 'b.ts', tool: 'Write', at: 1_700_000_000_000 });
        expect((await post('/session-edit', { sessionId: 's1', path: 'b.ts', tool: 'Write', at: -5 })).status).toBe(400);
    });

    it('rejects malformed reports and unauthenticated calls', async () => {
        expect((await post('/session-edit', { sessionId: '../x', path: 'a', tool: 'Edit' })).status).toBe(400);
        expect((await post('/session-edit', { sessionId: 's1', path: '', tool: 'Edit' })).status).toBe(400);
        expect((await post('/session-edit', { sessionId: 's1', path: 'a', tool: 'Edit' }, 'wrong')).status).toBe(401);
        expect((await post('/peers', {}, 'wrong')).status).toBe(401);
    });

    it('lists peers with their edits', async () => {
        const response = await post('/peers', {});
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ sessions: peers });
    });
});
