import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ debug: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: mocks.debug } }));

import { parseSessionHookTarget, startHookServer } from './startHookServer';

describe('hook server safe diagnostics', () => {
    const stops: Array<() => void> = [];
    beforeEach(() => mocks.debug.mockClear());
    afterEach(() => stops.splice(0).forEach((stop) => stop()));

    it('forwards the hook while logging only body metadata and session id', async () => {
        const secret = 'private/customer/project and prompt text';
        const onSessionHook = vi.fn();
        const server = await startHookServer({ onSessionHook });
        stops.push(server.stop);
        const body = JSON.stringify({
            session_id: 'session-safe-id',
            transcript_path: `/Users/customer/${secret}.jsonl`,
            cwd: `/repo/${secret}`,
            model: `provider/${secret}`,
        });
        const response = await fetch(`http://127.0.0.1:${server.port}/hook/session-start`, {
            method: 'POST',
            body,
        });
        expect(response.status).toBe(200);
        expect(onSessionHook).toHaveBeenCalledWith('session-safe-id', expect.objectContaining({ cwd: `/repo/${secret}` }), {});

        const logged = JSON.stringify(mocks.debug.mock.calls);
        expect(logged).toContain(`bodyBytes`);
        expect(logged).toContain(String(Buffer.byteLength(body, 'utf8')));
        expect(logged).toContain('session-safe-id');
        expect(logged).not.toContain(secret);
        expect(logged).not.toContain('transcript_path');
    });

    it('B-515: reports the forwarder source tag, and the real forwarder script sends it', async () => {
        const onSessionHook = vi.fn();
        const server = await startHookServer({ onSessionHook });
        stops.push(server.stop);
        const post = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, {
            method: 'POST', body: JSON.stringify({ session_id: 'sid' }),
        });
        expect((await post('/hook/session-start')).status).toBe(200);
        expect(onSessionHook).toHaveBeenLastCalledWith('sid', expect.anything(), {});
        expect((await post('/hook/session-start?source=prewarm-12-0')).status).toBe(200);
        expect(onSessionHook).toHaveBeenLastCalledWith('sid', expect.anything(), { source: 'prewarm-12-0' });
        expect((await post('/hook/elsewhere?source=prewarm-12-0')).status).toBe(404);

        // Async spawn: the hook server lives on this event loop.
        const { spawn } = await import('node:child_process');
        const { resolve } = await import('node:path');
        const forwarder = resolve(__dirname, '../../../scripts/session_hook_forwarder.cjs');
        const child = spawn(process.execPath, [forwarder, String(server.port), 'prewarm-99-1'], { stdio: ['pipe', 'ignore', 'ignore'] });
        child.stdin.end(JSON.stringify({ session_id: 'from-forwarder' }));
        const code = await new Promise((done) => child.on('exit', done));
        expect(code).toBe(0);
        await vi.waitFor(() => expect(onSessionHook).toHaveBeenLastCalledWith('from-forwarder', expect.anything(), { source: 'prewarm-99-1' }));
    });

    it('parseSessionHookTarget accepts only the session-start route and a safe source', () => {
        expect(parseSessionHookTarget('/hook/session-start')).toEqual({});
        expect(parseSessionHookTarget('/hook/session-start?source=prewarm-1-0')).toEqual({ source: 'prewarm-1-0' });
        expect(parseSessionHookTarget('/hook/session-start?source=' + encodeURIComponent('../x y'))).toEqual({});
        expect(parseSessionHookTarget('/hook/other')).toBeNull();
        expect(parseSessionHookTarget(undefined)).toBeNull();
    });

    it('does not echo malformed hook bodies through JSON parse errors', async () => {
        const secret = 'malformed-private-hook-body';
        const server = await startHookServer({ onSessionHook: vi.fn() });
        stops.push(server.stop);
        await fetch(`http://127.0.0.1:${server.port}/hook/session-start`, {
            method: 'POST',
            body: `{${secret}`,
        });
        const logged = JSON.stringify(mocks.debug.mock.calls);
        expect(logged).toContain('Failed to parse session hook');
        expect(logged).not.toContain(secret);
    });
});
