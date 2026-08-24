import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ debug: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: mocks.debug } }));

import { startHookServer } from './startHookServer';

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
        expect(onSessionHook).toHaveBeenCalledWith('session-safe-id', expect.objectContaining({ cwd: `/repo/${secret}` }));

        const logged = JSON.stringify(mocks.debug.mock.calls);
        expect(logged).toContain(`bodyBytes`);
        expect(logged).toContain(String(Buffer.byteLength(body, 'utf8')));
        expect(logged).toContain('session-safe-id');
        expect(logged).not.toContain(secret);
        expect(logged).not.toContain('transcript_path');
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
