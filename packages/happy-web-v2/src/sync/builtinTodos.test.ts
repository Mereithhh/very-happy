import { describe, expect, it, vi } from 'vitest';
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://example.test' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'web-client' }));
import { createBuiltinTodoClient } from './builtinTodos';
import type { AuthCredentials } from '@/auth/tokenStorage';

describe('Web Todo adapter', () => {
    it('passes the current account and Web endpoint to the shared client', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ items: [] })));
        await createBuiltinTodoClient({ token: 'account' } as AuthCredentials, { fetch: fetcher }).list();
        expect(String(fetcher.mock.calls[0][0])).toMatch(/^https:\/\/example.test\/v1\/kv/);
        const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
        expect(headers.get('Authorization')).toBe('Bearer account');
        expect(headers.get('X-Happy-Client')).toBe('web-client');
    });
});
