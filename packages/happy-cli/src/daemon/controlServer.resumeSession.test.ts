import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

// B-501: `very-happy send --resume` / session_send { resume: true } bring an
// archived or offline session back through the local control server, the
// twin of the `resume-happy-session` machine RPC. Precheck refusals keep
// their `resume-precheck:<reason>` prefix so callers can pass them through.
describe('control server /resume-session', () => {
    const token = 'resume-session-test-control-token-with-at-least-256-bits-of-material';
    const resumeSession = vi.fn(async (sessionId: string) => ({ type: 'success' as const, sessionId }));
    let server: Awaited<ReturnType<typeof startDaemonControlServer>>;
    let bare: Awaited<ReturnType<typeof startDaemonControlServer>>;
    const base = {
        controlToken: token, getChildren: () => [], stopSession: () => false,
        spawnSession: vi.fn() as any,
        requestShutdown: () => {}, onHappySessionWebhook: () => {},
        pushClipboard: () => ({ delivered: false, truncated: false, totalBytes: 0 }),
        pushFilePreview: () => ({ delivered: false }),
    };
    beforeAll(async () => {
        server = await startDaemonControlServer({ ...base, resumeSession: resumeSession as any });
        bare = await startDaemonControlServer(base);
    });
    afterAll(async () => { await server.stop(); await bare.stop(); });
    const post = (target: typeof server, body: unknown) => fetch(`http://127.0.0.1:${target.port}/resume-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });

    it('forwards sessionId / model / permissionMode and answers success', async () => {
        const response = await post(server, { sessionId: 'sess-1', model: 'claude-opus-5-5', permissionMode: 'bypassPermissions' });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ success: true, sessionId: 'sess-1' });
        expect(resumeSession).toHaveBeenLastCalledWith('sess-1', { model: 'claude-opus-5-5', permissionMode: 'bypassPermissions' });
    });

    it('returns the daemon precheck error verbatim with a 500', async () => {
        resumeSession.mockResolvedValueOnce({ type: 'error', errorMessage: 'resume-precheck:not-tracked: Session sess-2 is not tracked by this daemon.' } as any);
        const response = await post(server, { sessionId: 'sess-2' });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ success: false, error: 'resume-precheck:not-tracked: Session sess-2 is not tracked by this daemon.' });
    });

    it('rejects a missing sessionId before touching the handler', async () => {
        resumeSession.mockClear();
        expect((await post(server, {})).status).toBe(400);
        expect(resumeSession).not.toHaveBeenCalled();
    });

    it('answers 503 when the daemon has no resume handler wired yet', async () => {
        const response = await post(bare, { sessionId: 'sess-1' });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ success: false, error: 'daemon is still starting up' });
    });

    it('requires the control token', async () => {
        const response = await fetch(`http://127.0.0.1:${server.port}/resume-session`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'sess-1' }),
        });
        expect(response.status).toBe(401);
    });
});
