/**
 * B-569: the real sendWebPush (real RFC 8291 encryption, VAPID signing) with
 * fetch stubbed — pins the TTL / Topic headers that reach the push service.
 */
import crypto from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/log', () => ({ log: vi.fn() }));

let mod: typeof import('./webPush');

beforeAll(async () => {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    vi.stubEnv('VAPID_PUBLIC_KEY', ecdh.getPublicKey().toString('base64url'));
    vi.stubEnv('VAPID_PRIVATE_KEY', ecdh.getPrivateKey().toString('base64url'));
    mod = await import('./webPush');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function subscription() {
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    return {
        endpoint: 'https://push.example.com/send/abc',
        keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
    };
}

function captureFetch(status = 201) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        calls.push({ url, headers: init.headers });
        return new Response(null, { status });
    }));
    return calls;
}

describe('sendWebPush headers', () => {
    it('defaults to a 24h TTL with no Topic (was 28 days)', async () => {
        const calls = captureFetch();
        const res = await mod.sendWebPush(subscription(), { title: 't' });
        expect(res.ok).toBe(true);
        expect(calls[0].headers.TTL).toBe('86400');
        expect(calls[0].headers.Topic).toBeUndefined();
        expect(calls[0].headers.Urgency).toBe('high');
    });

    it('passes TTL and Topic through', async () => {
        const calls = captureFetch();
        await mod.sendWebPush(subscription(), { title: 't' }, { ttlSeconds: 21600, topic: 'AbC_-123' });
        expect(calls[0].headers.TTL).toBe('21600');
        expect(calls[0].headers.Topic).toBe('AbC_-123');
    });

    it('410 marks the subscription gone', async () => {
        captureFetch(410);
        const res = await mod.sendWebPush(subscription(), { title: 't' });
        expect(res).toEqual({ ok: false, statusCode: 410, gone: true });
    });
});

describe('webPushOptionHeaders', () => {
    it('drops an invalid Topic instead of sending it', () => {
        expect(mod.webPushOptionHeaders({ topic: 'x'.repeat(33) }).Topic).toBeUndefined();
        expect(mod.webPushOptionHeaders({ topic: 'has space' }).Topic).toBeUndefined();
        expect(mod.webPushOptionHeaders({ topic: 'a+b/c=' }).Topic).toBeUndefined();
        expect(mod.webPushOptionHeaders({ ttlSeconds: -1 }).TTL).toBe('86400');
        expect(mod.webPushOptionHeaders({ ttlSeconds: 300.7 }).TTL).toBe('300');
    });
});
