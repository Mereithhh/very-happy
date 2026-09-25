import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

describe('control server background tasks (B-507)', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    const onSessionStateEvent = vi.fn();
    const onSessionTurnEvent = vi.fn();
    const onSessionBackgroundTasks = vi.fn();
    const reports: Record<string, { count: number; tasks: any[]; reportedAt?: number; stale?: boolean }> = {
        s1: { count: 1, tasks: [{ id: 't1', type: 'local_bash', description: 'sleep 300', startedAt: 5 }], reportedAt: 10 },
        s2: { count: 0, tasks: [] },
    };
    let port: number;
    let stop: () => Promise<void>;

    beforeAll(async () => {
        const server = await startDaemonControlServer({
            controlToken,
            getChildren: () => [
                { startedBy: 'daemon', happySessionId: 's1', pid: 11 },
                { startedBy: 'daemon', happySessionId: 's2', pid: 12 },
            ],
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error', errorMessage: 'not implemented' }),
            requestShutdown: () => { },
            onHappySessionWebhook: () => { },
            onSessionStateEvent,
            onSessionTurnEvent,
            onSessionBackgroundTasks,
            getBackgroundTasks: (id) => reports[id] ?? { count: 0, tasks: [] },
            pushClipboard: () => ({ delivered: false, truncated: false, totalBytes: 0 }),
        });
        port = server.port;
        stop = server.stop;
    });

    afterAll(async () => { await stop(); });

    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${controlToken}` },
        body: JSON.stringify(body),
    });

    it('routes background_tasks (with its set, or empty) to the tracker sink only', async () => {
        const tasks = [{ id: 't1', type: 'local_agent', description: 'Explore', startedAt: 1 }];
        expect((await post('/session-event', { sessionId: 's1', event: 'background_tasks', backgroundTasks: tasks })).status).toBe(200);
        expect((await post('/session-event', { sessionId: 's1', event: 'background_tasks' })).status).toBe(200);
        expect(onSessionBackgroundTasks.mock.calls).toEqual([['s1', tasks], ['s1', []]]);
        expect(onSessionStateEvent).not.toHaveBeenCalled();
        expect(onSessionTurnEvent).not.toHaveBeenCalled();
    });

    it('rejects malformed task entries', async () => {
        expect((await post('/session-event', { sessionId: 's1', event: 'background_tasks', backgroundTasks: [{ id: '' }] })).status).toBe(400);
    });

    it('/list carries the daemon-side report per child', async () => {
        const body = await (await post('/list', {})).json();
        expect(body.children).toEqual([
            { startedBy: 'daemon', happySessionId: 's1', pid: 11, turnActive: false, backgroundTasks: reports.s1 },
            { startedBy: 'daemon', happySessionId: 's2', pid: 12, turnActive: false, backgroundTasks: { count: 0, tasks: [] } },
        ]);
    });
});
