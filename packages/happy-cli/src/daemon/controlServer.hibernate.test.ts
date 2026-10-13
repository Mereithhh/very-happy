import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

/** B-587: the wrapper's idle check-in route. */
describe('control server /session-hibernate-check (B-587)', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    const report = {
        flavor: 'claude', resumable: true, uiSession: true, keepAwake: false, thinking: false, queuedInputs: 0, waitingForInput: true,
        pendingRequests: 0, backgroundTasks: 0, lastActivityAt: 1, futureField: 'ignored-but-kept',
    };
    const base = {
        controlToken,
        getChildren: () => [],
        stopSession: () => false,
        spawnSession: async () => ({ type: 'error' as const, errorMessage: 'not implemented' }),
        requestShutdown: () => { },
        onHappySessionWebhook: () => { },
        pushClipboard: () => ({ delivered: false, truncated: false, totalBytes: 0 }),
    };
    const servers: Array<{ port: number; stop: () => Promise<void> }> = [];
    const onHibernateCheck = vi.fn(async () => ({ hibernate: true, idleMs: 5000 }));

    beforeAll(async () => {
        servers.push(await startDaemonControlServer({ ...base, onHibernateCheck }));
        servers.push(await startDaemonControlServer(base)); // wiring without the feature
    });
    afterAll(async () => { for (const s of servers) await s.stop(); });

    const post = (port: number, body: unknown) => fetch(`http://127.0.0.1:${port}/session-hibernate-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${controlToken}` },
        body: JSON.stringify(body),
    });

    it('passes the check-in through and answers the decision', async () => {
        const response = await post(servers[0].port, { sessionId: 's1', pid: 42, report });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ hibernate: true, idleMs: 5000 });
        expect(onHibernateCheck).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', pid: 42, report: expect.objectContaining({ flavor: 'claude' }) }));
    });

    it('rejects a malformed report instead of guessing', async () => {
        expect((await post(servers[0].port, { sessionId: 's1', pid: 42, report: { flavor: 'claude' } })).status).toBe(400);
    });

    it('a daemon without the feature answers 404 (the wrapper backs off)', async () => {
        expect((await post(servers[1].port, { sessionId: 's1', pid: 42, report })).status).toBe(404);
    });
});
