// @vitest-environment happy-dom
/**
 * B-490 regression: a dead token must not turn the notification-seen KV push
 * (or any InvalidateSync poller) into an unbounded 401 request storm.
 * Incident: one tab, POST /v1/kv 12/s → ~240/s, all 401, for days.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => null }));
vi.mock('@/sync/apiSocket', () => ({ getHappyClientId: () => 'test-client' }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://vh.test' }));
vi.mock('@/sync/kvUpdates', () => ({ onKvChanges: () => () => {} }));

import { isAuthLatched, resetAuthLatch, wrapFetchWithAuthGuard, AuthFailedError } from '@/auth/authLatch';
import { kvMutate, KV_MAX_ATTEMPTS } from '@/sync/apiKv';
import { pushSeenWithCas } from '@/sync/notificationSeen';
import {
    __resetSeenPushStateForTests,
    setSeenCredentials,
    useNotificationSeen,
} from '@/sync/notificationSeenStore';
import { InvalidateSync } from '@/utils/sync';

const creds = { token: 'tok-dead', secret: 's' };
let network: ReturnType<typeof vi.fn>;

function install(status: number | (() => number)) {
    network = vi.fn(async () => {
        const code = typeof status === 'function' ? status() : status;
        return new Response(code === 200 ? JSON.stringify({ success: true, results: [{ key: 'k', version: 1 }] }) : '{}', { status: code });
    });
    // Same wiring as app/authGuards.ts: the guard sits in front of the network.
    vi.stubGlobal('fetch', wrapFetchWithAuthGuard(network as any, {
        currentToken: () => creds.token,
        isServerUrl: (url) => url.startsWith('https://vh.test'),
    }));
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetAuthLatch();
    __resetSeenPushStateForTests();
    setSeenCredentials(creds);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetAuthLatch();
});

describe('kvMutate', () => {
    it('401: exactly one request, throws AuthFailedError, latch tripped', async () => {
        install(401);
        await expect(kvMutate(creds, [{ key: 'k', value: 'v', version: -1 }])).rejects.toBeInstanceOf(AuthFailedError);
        expect(network).toHaveBeenCalledTimes(1);
        expect(isAuthLatched()).toBe(true);
    });

    it('5xx: bounded retries, then gives up', async () => {
        install(502);
        const p = kvMutate(creds, [{ key: 'k', value: 'v', version: -1 }]);
        const settled = expect(p).rejects.toThrow('502');
        await vi.runAllTimersAsync();
        await settled;
        expect(network).toHaveBeenCalledTimes(KV_MAX_ATTEMPTS);
    });
});

describe('CAS loop', () => {
    it('stops at the first 401 instead of treating it as a conflict', async () => {
        install(401);
        const write = vi.fn(async (value: Record<string, number>, version: number) => {
            const r = await kvMutate(creds, [{ key: 'k', value: JSON.stringify(value), version }]);
            return r.success ? { ok: true as const, version: r.results[0].version } : { ok: false as const, version: 0, remote: {} };
        });
        const outcome = await pushSeenWithCas({ read: () => ({ a: 1 }), version: () => -1, write, absorb: vi.fn() }, 4);
        expect(outcome.status).toBe('error');
        expect(write).toHaveBeenCalledTimes(1);
        expect(network).toHaveBeenCalledTimes(1);
    });
});

describe('notificationSeenStore push', () => {
    it('a dead token costs ONE request; later markSeen calls (heartbeats) send nothing', async () => {
        install(401);
        const store = useNotificationSeen.getState();
        store.markSeen(['s1'], 1_000);
        await vi.advanceTimersByTimeAsync(600);
        expect(network).toHaveBeenCalledTimes(1);
        expect(isAuthLatched()).toBe(true);

        // an hour of 60 s heartbeats + arrivals + a wake-up refresh
        for (let i = 0; i < 60; i++) {
            store.markSeen(['s1'], 2_000 + i * 60_000);
            store.markSeen([`s${i + 2}`], 2_000 + i * 60_000);
            await vi.advanceTimersByTimeAsync(60_000);
        }
        await store.refresh(true);
        expect(network).toHaveBeenCalledTimes(1);
    });

    it('never runs two pushes at once; markSeen during a slow push only queues one follow-up', async () => {
        let resolveFirst: (() => void) | null = null;
        network = vi.fn(() => new Promise<Response>((resolve) => {
            resolveFirst = () => resolve(new Response(JSON.stringify({ success: true, results: [{ key: 'k', version: 1 }] }), { status: 200 }));
        }));
        vi.stubGlobal('fetch', network);
        const store = useNotificationSeen.getState();
        store.markSeen(['a'], 1_000);
        await vi.advanceTimersByTimeAsync(600);
        expect(network).toHaveBeenCalledTimes(1);
        for (let i = 0; i < 20; i++) {
            store.markSeen([`b${i}`], 2_000 + i);
            await vi.advanceTimersByTimeAsync(600);
        }
        expect(network).toHaveBeenCalledTimes(1);
        resolveFirst!();
        await vi.advanceTimersByTimeAsync(600);
        expect(network).toHaveBeenCalledTimes(2);
    });
});

describe('InvalidateSync pollers', () => {
    it('401 stops the sync for good: no retries, later invalidations send nothing', async () => {
        install(401);
        const command = vi.fn(async () => {
            const res = await fetch('https://vh.test/v1/friends', { headers: { Authorization: `Bearer ${creds.token}` } });
            if (!res.ok) throw new Error(`Failed to fetch friends: ${res.status}`);
        });
        const sync = new InvalidateSync(command);
        sync.invalidate();
        await vi.advanceTimersByTimeAsync(60_000);
        for (let i = 0; i < 10; i++) {
            sync.invalidate();
            await vi.advanceTimersByTimeAsync(10_000);
        }
        expect(command).toHaveBeenCalledTimes(1);
        expect(network).toHaveBeenCalledTimes(1);
    });
});
