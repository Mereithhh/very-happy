import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

describe('control server /terminal-title', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    const setTerminalTitle = vi.fn((_terminalId: string, _title: string, _ifAbsent: boolean) => true);
    let port: number;
    let stop: () => Promise<void>;

    const post = (body: unknown, authorization: string | null = `Bearer ${controlToken}`) => fetch(`http://127.0.0.1:${port}/terminal-title`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify(body),
    });

    beforeAll(async () => {
        const server = await startDaemonControlServer({
            controlToken,
            getChildren: () => [],
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error', errorMessage: 'not implemented' }),
            requestShutdown: () => { },
            onHappySessionWebhook: () => { },
            pushClipboard: () => ({ delivered: false, truncated: false, totalBytes: 0 }),
            setTerminalTitle,
        });
        port = server.port;
        stop = server.stop;
    });

    afterAll(async () => {
        await stop();
    });

    it('forwards terminalId/title/ifAbsent to setTerminalTitle and returns 200 when tmux accepted it', async () => {
        setTerminalTitle.mockClear();
        const res = await post({ terminalId: 'term_1', title: 'pi: fix tests' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok' });
        expect(setTerminalTitle).toHaveBeenCalledWith('term_1', 'pi: fix tests', false);

        const res2 = await post({ terminalId: 'term_1', title: 'again', ifAbsent: true });
        expect(res2.status).toBe(200);
        expect(setTerminalTitle).toHaveBeenLastCalledWith('term_1', 'again', true);
    });

    it('returns 409 with the reason when the title did not land', async () => {
        setTerminalTitle.mockReturnValueOnce(false);
        const res = await post({ terminalId: 'term_gone', title: 'x' });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: expect.stringContaining('Failed to set terminal title') });
    });

    it.each([
        ['missing title', { terminalId: 'term_1' }],
        ['empty title', { terminalId: 'term_1', title: '' }],
        ['missing terminalId', { title: 'x' }],
        ['terminalId with shell-unsafe chars', { terminalId: 'a b;c', title: 'x' }],
    ])('rejects %s with 400 before calling setTerminalTitle', async (_label, body) => {
        setTerminalTitle.mockClear();
        const res = await post(body);
        expect(res.status).toBe(400);
        expect(setTerminalTitle).not.toHaveBeenCalled();
    });

    it.each([
        ['missing', null],
        ['invalid', 'Bearer wrong-token'],
    ])('rejects %s authorization before invoking the callback', async (_label, authorization) => {
        setTerminalTitle.mockClear();
        const res = await post({ terminalId: 'term_1', title: 'x' }, authorization);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
        expect(setTerminalTitle).not.toHaveBeenCalled();
    });
});

describe('control server /terminal-title without a wired setter', () => {
    it('returns 503 instead of pretending the title landed', async () => {
        const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
        const server = await startDaemonControlServer({
            controlToken,
            getChildren: () => [],
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error', errorMessage: 'not implemented' }),
            requestShutdown: () => { },
            onHappySessionWebhook: () => { },
            pushClipboard: () => ({ delivered: false, truncated: false, totalBytes: 0 }),
        });
        try {
            const res = await fetch(`http://127.0.0.1:${server.port}/terminal-title`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${controlToken}` },
                body: JSON.stringify({ terminalId: 'term_1', title: 'x' }),
            });
            expect(res.status).toBe(503);
        } finally {
            await server.stop();
        }
    });
});
