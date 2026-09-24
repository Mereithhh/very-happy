import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

// B-492: `very-happy spawn --fork` rides /spawn-session with the same resume +
// lineage fields the web fork sends over the machine RPC, and relies on
// `resumed: true` to tell a real fork from an old daemon's fresh spawn.
describe('control server /spawn-session fork fields', () => {
    const token = 'spawn-fork-test-control-token-with-at-least-256-bits-of-material';
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'new-session' }));
    let server: Awaited<ReturnType<typeof startDaemonControlServer>>;
    beforeAll(async () => {
        server = await startDaemonControlServer({
            controlToken: token, getChildren: () => [], stopSession: () => false,
            spawnSession: spawnSession as any,
            requestShutdown: () => {}, onHappySessionWebhook: () => {},
            pushClipboard: () => ({ delivered: false, truncated: false, totalBytes: 0 }),
            pushFilePreview: () => ({ delivered: false }),
        });
    });
    afterAll(async () => { await server.stop(); });
    const post = (body: unknown) => fetch(`http://127.0.0.1:${server.port}/spawn-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });

    it('forwards resume + lineage to spawnSession and answers resumed: true', async () => {
        const claudeId = '0f8fad5b-d9cb-469f-a165-70867728950e';
        const response = await post({ directory: '/w', agent: 'claude', permissionMode: 'bypassPermissions', resumeClaudeSessionId: claudeId, parentSessionId: 'parent-1' });
        expect(await response.json()).toMatchObject({ success: true, sessionId: 'new-session', resumed: true });
        expect(spawnSession).toHaveBeenLastCalledWith(expect.objectContaining({ directory: '/w', resumeClaudeSessionId: claudeId, parentSessionId: 'parent-1', permissionMode: 'bypassPermissions' }));
    });

    it('does not claim resumed for a plain spawn', async () => {
        const response = await post({ directory: '/w' });
        const body = await response.json();
        expect(body).toMatchObject({ success: true });
        expect(body.resumed).toBeUndefined();
    });

    it('rejects a malformed Claude conversation id before spawning', async () => {
        spawnSession.mockClear();
        expect((await post({ directory: '/w', resumeClaudeSessionId: '../../etc/passwd' })).status).toBe(400);
        expect(spawnSession).not.toHaveBeenCalled();
    });
});
