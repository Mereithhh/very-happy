import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

describe('control server /file-preview', () => {
    const token = 'preview-test-control-token-with-at-least-256-bits-of-material';
    const pushFilePreview = vi.fn(() => ({ delivered: true }));
    let server: Awaited<ReturnType<typeof startDaemonControlServer>>;
    beforeAll(async () => {
        server = await startDaemonControlServer({
            controlToken: token, getChildren: () => [], stopSession: () => false,
            spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
            requestShutdown: () => {}, onHappySessionWebhook: () => {},
            pushClipboard: () => ({ delivered: false, truncated: false, totalBytes: 0 }), pushFilePreview,
        });
    });
    afterAll(async () => { await server.stop(); });
    const post = (body: unknown, authorization = `Bearer ${token}`) => fetch(`http://127.0.0.1:${server.port}/file-preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(body),
    });

    it('forwards an allowed normalized path with the terminal identity and defaults to file mode', async () => {
        const response = await post({ terminalId: 'term_1', path: '/workspace/a/../report.md' });
        expect(await response.json()).toEqual({ delivered: true });
        expect(pushFilePreview).toHaveBeenLastCalledWith('term_1', '/workspace/report.md', 'file', undefined);
    });
    it('B-562: forwards a download intent and ignores unknown intents or extra keys', async () => {
        await post({ terminalId: 'term_1', path: '/workspace/out.zip', intent: 'download' });
        expect(pushFilePreview).toHaveBeenLastCalledWith('term_1', '/workspace/out.zip', 'file', 'download');
        const future = await post({ terminalId: 'term_1', path: '/workspace/out.zip', intent: 'future-intent', future: 1 });
        expect(await future.json()).toEqual({ delivered: true });
        expect(pushFilePreview).toHaveBeenLastCalledWith('term_1', '/workspace/out.zip', 'file', undefined);
    });
    it('applies the preview denylist again at the daemon boundary', async () => {
        pushFilePreview.mockClear();
        expect(await (await post({ terminalId: 'term_1', path: '~/.ssh/id_ed25519' })).json()).toMatchObject({ delivered: false, error: expect.stringContaining('refusing') });
        expect(pushFilePreview).not.toHaveBeenCalled();
    });
    it.each([
        { terminalId: 'a b', path: '/workspace/readme.md' },
        { terminalId: 'a'.repeat(65), path: '/workspace/readme.md' },
        { path: '/workspace/readme.md' },
        { terminalId: 'term_1', path: '/workspace/readme.md', mode: 'unknown' },
    ])('rejects invalid identities and request shapes', async (body) => {
        pushFilePreview.mockClear();
        expect((await post(body)).status).toBe(400);
        expect(pushFilePreview).not.toHaveBeenCalled();
    });
    it('requires the daemon bearer token', async () => {
        pushFilePreview.mockClear();
        expect((await post({ terminalId: 'term_1', path: '/workspace/readme.md' }, 'Bearer wrong')).status).toBe(401);
        expect(pushFilePreview).not.toHaveBeenCalled();
    });
});
