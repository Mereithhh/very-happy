import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

describe('control server /terminal-agent-hook (B-547)', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    const onTerminalAgentHook = vi.fn((body: unknown) => {
        if ((body as { boom?: boolean })?.boom) throw new Error('handler failure');
    });
    const onTerminalHook = vi.fn();
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
            onTerminalHook,
            onTerminalAgentHook,
        });
        port = server.port;
        stop = server.stop;
    });

    afterAll(async () => {
        await stop();
    });

    const post = (body: unknown, auth = `Bearer ${controlToken}`) => fetch(`http://127.0.0.1:${port}/terminal-agent-hook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(body),
    });

    it('hands the raw body to the status callback, not to the mirror hook', async () => {
        const body = { hook_event_name: 'SessionStart', session_id: 's', terminalId: 't1' };
        const res = await post(body);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok' });
        expect(onTerminalAgentHook).toHaveBeenCalledWith(body);
        expect(onTerminalHook).not.toHaveBeenCalled();
    });

    it('still answers 200 when the handler throws (a hook must never see an error)', async () => {
        const res = await post({ boom: true });
        expect(res.status).toBe(200);
    });

    it('rejects a wrong token before the callback', async () => {
        onTerminalAgentHook.mockClear();
        const res = await post({ hook_event_name: 'Stop' }, 'Bearer nope');
        expect(res.status).toBe(401);
        expect(onTerminalAgentHook).not.toHaveBeenCalled();
    });
});
