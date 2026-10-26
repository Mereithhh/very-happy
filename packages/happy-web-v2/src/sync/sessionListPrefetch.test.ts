import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hedgedRead } from './hedgedRead';
import { isAuthLatched, resetAuthLatch } from '@/auth/authLatch';
import {
    adoptSessionListPrefetch,
    PREFETCH_MAX_AGE_MS,
    resetSessionListPrefetchForTest,
    startSessionListPrefetch,
    takeSessionListPrefetch,
} from './sessionListPrefetch';

const creds = (token: string) => ({ getItem: (key: string) => (key === 'auth_credentials' ? JSON.stringify({ token, secret: 's' }) : null) });

/** A fetch whose response the test releases by hand; records every request. */
function controllableFetch() {
    const calls: Array<{ url: string; init: RequestInit; respond: (status?: number, body?: unknown) => void; fail: (e: Error) => void }> = [];
    const fetchImpl = vi.fn((url: string, init: RequestInit) => new Promise<Response>((ok, fail) => {
        const call = {
            url,
            init,
            respond: (status = 200, body: unknown = { sessions: [] }) => ok(new Response(JSON.stringify(body), { status })),
            fail,
        };
        calls.push(call);
        init.signal?.addEventListener('abort', () => fail(init.signal!.reason));
    })) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

afterEach(() => {
    resetSessionListPrefetchForTest();
    resetAuthLatch();
});

describe('B-823 boot prefetch of /v1/sessions', () => {
    it('starts only with stored credentials, with the token and the bounded no-store read', () => {
        const { fetchImpl, calls } = controllableFetch();
        expect(startSessionListPrefetch({ fetchImpl, storage: { getItem: () => null }, serverUrl: 'https://x' })).toBeNull();
        expect(startSessionListPrefetch({ fetchImpl, storage: creds('tok'), serverUrl: 'https://x' })).not.toBeNull();
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://x/v1/sessions');
        expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
        expect(calls[0].init.cache).toBe('no-store');
        expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    });

    it('is adopted once, by the same token only; another token or a stale one is aborted', () => {
        const { fetchImpl, calls } = controllableFetch();
        startSessionListPrefetch({ fetchImpl, storage: creds('tok'), serverUrl: '', now: () => 1_000 });
        expect(takeSessionListPrefetch('tok', 1_500)).not.toBeNull();
        expect(takeSessionListPrefetch('tok', 1_500)).toBeNull(); // one use only

        startSessionListPrefetch({ fetchImpl, storage: creds('old'), serverUrl: '', now: () => 1_000 });
        expect(takeSessionListPrefetch('new', 1_500)).toBeNull();
        expect(calls[1].init.signal?.aborted).toBe(true);

        startSessionListPrefetch({ fetchImpl, storage: creds('tok'), serverUrl: '', now: () => 1_000 });
        expect(takeSessionListPrefetch('tok', 1_000 + PREFETCH_MAX_AGE_MS + 1)).toBeNull();
        expect(calls[2].init.signal?.aborted).toBe(true);
    });

    it('as the first hedged attempt it commits on its headers: no hedge, no second request', async () => {
        vi.useFakeTimers();
        try {
            const { fetchImpl, calls } = controllableFetch();
            const prefetch = startSessionListPrefetch({ fetchImpl, storage: creds('tok'), serverUrl: '' })!;
            const regular = vi.fn(async () => ({ sessions: ['regular'] }));
            const read = hedgedRead(async (signal, init, index) => {
                if (index === 0) return adoptSessionListPrefetch(prefetch, signal, init.onResponse);
                return regular();
            }, { hedgeAfterMs: 2_000 });
            calls[0].respond(200, { sessions: ['prefetched'] });
            await vi.advanceTimersByTimeAsync(5_000);
            await expect(read).resolves.toEqual({ data: { sessions: ['prefetched'] }, date: null });
            expect(regular).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a prefetch stuck before its headers is hedged like any attempt, and aborted when the hedge wins', async () => {
        vi.useFakeTimers();
        try {
            const { fetchImpl, calls } = controllableFetch();
            const prefetch = startSessionListPrefetch({ fetchImpl, storage: creds('tok'), serverUrl: '' })!;
            const read = hedgedRead(async (signal, init, index) => {
                if (index === 0) return adoptSessionListPrefetch(prefetch, signal, init.onResponse);
                init.onResponse();
                return { sessions: ['hedge'] };
            }, { hedgeAfterMs: 2_000 });
            await vi.advanceTimersByTimeAsync(2_000);
            await expect(read).resolves.toEqual({ sessions: ['hedge'] });
            expect(calls[0].init.signal?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a 401 trips the auth latch like the guarded fetch; a network failure only fails its attempt', async () => {
        const { fetchImpl, calls } = controllableFetch();
        const prefetch = startSessionListPrefetch({ fetchImpl, storage: creds('tok'), serverUrl: '' })!;
        const onResponse = vi.fn();
        const attempt = adoptSessionListPrefetch(prefetch, new AbortController().signal, onResponse);
        expect(isAuthLatched()).toBe(false);
        calls[0].respond(401, { error: 'nope' });
        await expect(attempt).rejects.toThrow('401');
        expect(isAuthLatched()).toBe(true);
        // Headers did arrive (a 401 is a response) — like a regular attempt it committed.
        expect(onResponse).toHaveBeenCalledTimes(1);
        resetAuthLatch();

        const second = startSessionListPrefetch({ fetchImpl, storage: creds('tok'), serverUrl: '' })!;
        const onResponse2 = vi.fn();
        const attempt2 = adoptSessionListPrefetch(second, new AbortController().signal, onResponse2);
        calls[1].fail(new TypeError('Failed to fetch'));
        await expect(attempt2).rejects.toThrow('Failed to fetch');
        await Promise.resolve();
        expect(onResponse2).not.toHaveBeenCalled(); // no headers: hedges stay possible
    });
});

describe('B-823 prefetch wiring', () => {
    const main = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8');

    it('main.tsx starts it for the signed-in root only, before the root chunk is imported', () => {
        const start = main.indexOf('if (!usePublicRoot) startSessionListPrefetch();');
        expect(start).toBeGreaterThan(0);
        expect(start).toBeLessThan(main.indexOf("import('./app/AppRoot.tsx')"));
    });
});
