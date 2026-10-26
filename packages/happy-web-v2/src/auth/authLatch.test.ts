import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    AuthFailedError,
    assertNotAuthFailure,
    confirmAuthExpired,
    isSocketTokenRejection,
    getAuthLatch,
    installAxiosAuthGuard,
    isAuthFailure,
    isAuthLatched,
    resetAuthLatch,
    subscribeAuthLatch,
    wrapFetchWithAuthGuard,
} from './authLatch';

const SERVER = 'https://veryhappy.dev';
const deps = {
    currentToken: () => 'tok-current',
    isServerUrl: (url: string) => url.startsWith(SERVER),
};
const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

afterEach(() => resetAuthLatch());

describe('fetch auth guard (B-490)', () => {
    it('a 401 on the current token trips the latch, and after that no authenticated request reaches the network', async () => {
        const inner = vi.fn(async () => new Response('{}', { status: 401 }));
        const guarded = wrapFetchWithAuthGuard(inner, deps);
        const seen = vi.fn();
        const unsubscribe = subscribeAuthLatch(seen);

        const first = await guarded(`${SERVER}/v1/kv?x=1`, { method: 'POST', ...bearer('tok-current') });
        expect(first.status).toBe(401);
        expect(isAuthLatched()).toBe(true);
        expect(getAuthLatch()?.path).toBe('/v1/kv');
        expect(seen).toHaveBeenCalledTimes(1);

        for (const path of ['/v1/kv', '/v1/friends', '/v1/feed', '/v1/sessions']) {
            await expect(guarded(`${SERVER}${path}`, bearer('tok-current'))).rejects.toBeInstanceOf(AuthFailedError);
        }
        expect(inner).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    it('Headers objects and Request inputs are recognised', async () => {
        const inner = vi.fn(async () => new Response('{}', { status: 401 }));
        const guarded = wrapFetchWithAuthGuard(inner, deps);
        await guarded(`${SERVER}/v1/feed`, { headers: new Headers({ authorization: 'Bearer tok-current' }) });
        expect(isAuthLatched()).toBe(true);
        await expect(guarded(new Request(`${SERVER}/v1/feed`, bearer('tok-current')))).rejects.toBeInstanceOf(AuthFailedError);
        expect(inner).toHaveBeenCalledTimes(1);
    });

    it('B-825: 5xx, 503 auth_unavailable, 403 and network errors never latch (nothing is wiped)', async () => {
        for (const status of [500, 502, 503, 504, 403, 429]) {
            const guarded = wrapFetchWithAuthGuard(async () => new Response('{"error":"auth_unavailable"}', { status }), deps);
            const res = await guarded(`${SERVER}/v1/sessions`, bearer('tok-current'));
            expect(res.status).toBe(status);
        }
        const offline = wrapFetchWithAuthGuard(async () => { throw new TypeError('Failed to fetch'); }, deps);
        await expect(offline(`${SERVER}/v1/sessions`, bearer('tok-current'))).rejects.toThrow('Failed to fetch');
        expect(isAuthLatched()).toBe(false);
    });

    it('does not latch for a stale token, anonymous requests or other origins', async () => {
        const inner = vi.fn(async () => new Response('{}', { status: 401 }));
        const guarded = wrapFetchWithAuthGuard(inner, deps);
        await guarded(`${SERVER}/v1/kv`, bearer('tok-rotated-away'));
        await guarded(`${SERVER}/v1/account/login`, { method: 'POST' });
        await guarded('https://api.github.com/user', bearer('tok-current'));
        expect(isAuthLatched()).toBe(false);
        expect(inner).toHaveBeenCalledTimes(3);
    });

    it('403 does not latch (it also means "not allowed here" with a valid token)', async () => {
        const guarded = wrapFetchWithAuthGuard(async () => new Response('{}', { status: 403 }), deps);
        await guarded(`${SERVER}/v1/teams`, bearer('tok-current'));
        expect(isAuthLatched()).toBe(false);
    });
});

describe('axios auth guard (B-490)', () => {
    function fakeAxios() {
        let req: (c: any) => any = (c) => c;
        let rej: (e: any) => any = (e) => Promise.reject(e);
        return {
            interceptors: {
                request: { use: (f: (c: any) => any) => { req = f; } },
                response: { use: (_ok: unknown, f: (e: any) => any) => { rej = f; } },
            },
            request: (c: any) => req(c),
            fail: (e: any) => rej(e),
        };
    }

    it('401 trips the latch; latched requests are refused before sending', async () => {
        const ax = fakeAxios();
        installAxiosAuthGuard(ax, deps);
        const config = { url: `${SERVER}/v1/account/identities`, headers: { Authorization: 'Bearer tok-current' } };
        expect(ax.request(config)).toBe(config);
        await expect(ax.fail({ config, response: { status: 401 } })).rejects.toBeTruthy();
        expect(isAuthLatched()).toBe(true);
        expect(() => ax.request(config)).toThrow(AuthFailedError);
        // anonymous (login) calls still go through
        expect(ax.request({ url: `${SERVER}/v1/account/login`, headers: {} })).toBeTruthy();
    });
});

describe('isAuthFailure / assertNotAuthFailure', () => {
    it('classifies 401/403 from fetch helpers and axios, nothing else', () => {
        expect(isAuthFailure(new AuthFailedError(401))).toBe(true);
        expect(isAuthFailure({ response: { status: 403 } })).toBe(true);
        expect(isAuthFailure(new Error('Failed: 500'))).toBe(false);
        expect(isAuthFailure({ response: { status: 500 } })).toBe(false);
        expect(() => assertNotAuthFailure({ status: 401 }, 'x')).toThrow(AuthFailedError);
        expect(() => assertNotAuthFailure({ status: 403 }, 'x')).toThrow(AuthFailedError);
        expect(() => assertNotAuthFailure({ status: 500 }, 'x')).not.toThrow();
    });
});

describe('B-825 / B-824 §6.2: confirm before wiping', () => {
    it('only a second 401 is "expired"; 2xx is a misfire; everything else is unknown', async () => {
        expect(await confirmAuthExpired(async () => ({ status: 401 }))).toBe('expired');
        expect(await confirmAuthExpired(async () => ({ status: 200 }))).toBe('valid');
        for (const status of [403, 429, 500, 502, 503]) expect(await confirmAuthExpired(async () => ({ status }))).toBe('unknown');
        expect(await confirmAuthExpired(async () => { throw new TypeError('Failed to fetch'); })).toBe('unknown');
        expect(await confirmAuthExpired(async () => { throw new DOMException('aborted', 'AbortError'); })).toBe('unknown');
    });

    it('recognises the socket handshake rejecting the token, nothing else', () => {
        expect(isSocketTokenRejection(new Error('Invalid authentication token'))).toBe(true);
        for (const message of ['Authentication unavailable', 'Missing authentication token', 'xhr poll error', 'Socket connection limit reached']) {
            expect(isSocketTokenRejection(new Error(message))).toBe(false);
        }
        expect(isSocketTokenRejection(null)).toBe(false);
    });
});
