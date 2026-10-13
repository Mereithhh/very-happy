/**
 * B-569 / B-570: what pushDispatch hands to sendWebPush — the per-target
 * Topic, per-class TTL, `sentAt` + `seen` watermark read from the account KV,
 * and the test-push fan-out (no presence suppression, dead subs pruned).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state, dbMock, sendWebPushSpy, isUserActiveSpy } = vi.hoisted(() => {
    const state = {
        tokens: [] as Array<{ id: string; token: string }>,
        kvValue: null as Uint8Array | null,
        kvThrows: false,
        kvUpdatedAt: new Date(),
        status: 201,
        executedDeletes: [] as string[],
    };
    const dbMock = {
        accountPushToken: {
            findMany: vi.fn(async () => state.tokens),
            // Prisma queries are LAZY: nothing runs until .then(). Model that so
            // a fire-and-forget `void db...deleteMany()` is caught (it never ran).
            deleteMany: vi.fn((args: { where: { id: string } }) => ({
                then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
                    state.executedDeletes.push(args.where.id);
                    return Promise.resolve({ count: 1 }).then(onOk, onErr);
                },
            })),
        },
        userKVStore: {
            findUnique: vi.fn(async () => {
                if (state.kvThrows) throw new Error('db down');
                return state.kvValue ? { value: state.kvValue, updatedAt: state.kvUpdatedAt } : null;
            }),
        },
    };
    const sendWebPushSpy = vi.fn(async (_sub: unknown, _payload: any, _opts?: any) => ({
        ok: state.status < 300,
        statusCode: state.status,
        gone: state.status === 404 || state.status === 410,
    }));
    const isUserActiveSpy = vi.fn(async () => false);
    return { state, dbMock, sendWebPushSpy, isUserActiveSpy };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));
vi.mock('@/app/push/focusTracker', () => ({ isUserActive: isUserActiveSpy }));
vi.mock('@/app/push/pushSend', () => ({ sendPushNotifications: vi.fn(async () => []) }));
vi.mock('@/app/push/webPush', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/push/webPush')>();
    return { ...actual, sendWebPush: sendWebPushSpy, webPushConfigured: () => true };
});

import { dispatchDeviceEventPush, dispatchSessionEventPush, sendTestWebPush } from './pushDispatch';
import { webPushTopic } from './pushHygiene';
import { validateWebhookUrl, WEBHOOK_TOKEN_PREFIX } from './webhookNotify';

const SUB = 'webpush:' + JSON.stringify({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } });

beforeEach(() => {
    state.tokens = [{ id: 'w1', token: SUB }];
    state.kvValue = null;
    state.kvThrows = false;
    state.kvUpdatedAt = new Date();
    state.status = 201;
    state.executedDeletes = [];
    sendWebPushSpy.mockClear();
    dbMock.accountPushToken.deleteMany.mockClear();
    isUserActiveSpy.mockReset();
    isUserActiveSpy.mockResolvedValue(false);
});

describe('dispatchSessionEventPush → Web Push', () => {
    it('done: 6h TTL, session Topic, sentAt, and the seen watermark from KV', async () => {
        const now = Date.now();
        state.kvValue = new TextEncoder().encode(JSON.stringify({ seen: { s1: now - 1000, other: now - 2000 } }));
        await dispatchSessionEventPush({ userId: 'u', sessionId: 's1', title: 'T', body: 'B', data: { kind: 'done' } });
        expect(sendWebPushSpy).toHaveBeenCalledTimes(1);
        const [, payload, opts] = sendWebPushSpy.mock.calls[0];
        expect(opts).toEqual({ ttlSeconds: 21600, topic: webPushTopic('s1') });
        expect(payload.title).toBe('T');
        expect(payload.data).toEqual({ sessionId: 's1', kind: 'done' });
        expect(typeof payload.sentAt).toBe('number');
        expect(payload.seen).toEqual({ s1: now - 1000, other: now - 2000 });
    });

    it('permission: 24h TTL; KV failure → no seen field (old-server-shaped payload)', async () => {
        state.kvThrows = true;
        await dispatchSessionEventPush({ userId: 'u', sessionId: 's1', title: 'T', body: 'B', data: { kind: 'permission' } });
        const [, payload, opts] = sendWebPushSpy.mock.calls[0];
        expect(opts.ttlSeconds).toBe(86400);
        expect(payload.seen).toBeUndefined();
    });

    it('still presence-suppressed', async () => {
        isUserActiveSpy.mockResolvedValue(true);
        await dispatchSessionEventPush({ userId: 'u', sessionId: 's1', title: 'T', body: 'B', data: { kind: 'done' } });
        expect(sendWebPushSpy).not.toHaveBeenCalled();
    });
});

describe('seen watermark vs device clock skew (review #1)', () => {
    it('a stamp from a fast device clock is capped at the KV row server write time', async () => {
        const writtenAt = Date.now() - 60_000;
        state.kvUpdatedAt = new Date(writtenAt);
        // device clock 10 minutes ahead wrote "seen" in the future
        state.kvValue = new TextEncoder().encode(JSON.stringify({ seen: { s1: writtenAt + 600_000, s2: writtenAt - 5 } }));
        await dispatchSessionEventPush({ userId: 'u', sessionId: 's9', title: 'T', body: 'B', data: { kind: 'permission' } });
        const [, payload] = sendWebPushSpy.mock.calls[0];
        expect(payload.seen).toEqual({ s1: writtenAt, s2: writtenAt - 5 });
        // a decision push for s1 sent after the write is therefore never covered
        expect(payload.seen.s1).toBeLessThan(payload.sentAt);
    });
});

describe('webhook tokens are only deleted when corrupt (review #2)', () => {
    it('keeps a well-formed config that fails current URL validation; deletes broken JSON', async () => {
        const badUrl = 'http://127.0.0.1/hook';
        expect(validateWebhookUrl(badUrl)).not.toBeNull();
        state.tokens = [
            { id: 'wh-valid-json', token: WEBHOOK_TOKEN_PREFIX + JSON.stringify({ url: badUrl, events: ['completed'] }) },
            { id: 'wh-corrupt', token: WEBHOOK_TOKEN_PREFIX + '{not json' },
        ];
        await dispatchSessionEventPush({ userId: 'u', sessionId: 's1', title: 'T', body: 'B', data: { kind: 'done' } });
        await new Promise((r) => setTimeout(r, 10)); // webhook leg is fire-and-forget
        expect(state.executedDeletes).toEqual(['wh-corrupt']);
    });
});

describe('dispatchDeviceEventPush → Web Push', () => {
    it('terminal events get a terminal Topic and no fake sessionId', async () => {
        await dispatchDeviceEventPush({ userId: 'u', title: 'T', body: 'B', data: { kind: 'completed', url: '/terminal/m?tid=t1' } });
        const [, payload, opts] = sendWebPushSpy.mock.calls[0];
        expect(opts).toEqual({ ttlSeconds: 21600, topic: webPushTopic('t:t1') });
        expect(payload.data.sessionId).toBeUndefined();
    });
});

describe('sendTestWebPush', () => {
    it('sends to every subscription without a presence check and counts results', async () => {
        isUserActiveSpy.mockResolvedValue(true);
        state.tokens = [{ id: 'w1', token: SUB }, { id: 'w2', token: SUB }];
        const res = await sendTestWebPush('u', { title: 'Test', body: 'b' });
        expect(res).toEqual({ configured: true, total: 2, sent: 2, failed: 0, pruned: 0 });
        expect(isUserActiveSpy).not.toHaveBeenCalled();
        const [, payload, opts] = sendWebPushSpy.mock.calls[0];
        expect(payload.data).toEqual({ kind: 'test', url: '/settings/notifications' });
        expect(opts).toEqual({ ttlSeconds: 300, topic: webPushTopic('test') });
        expect(dbMock.accountPushToken.findMany).toHaveBeenLastCalledWith({
            where: { accountId: 'u', token: { startsWith: 'webpush:' } },
        });
    });

    it('prunes gone and malformed subscriptions', async () => {
        state.status = 410;
        state.tokens = [{ id: 'w1', token: SUB }, { id: 'bad', token: 'webpush:{nope' }];
        const res = await sendTestWebPush('u', { title: 'Test', body: 'b' });
        expect(res).toEqual({ configured: true, total: 2, sent: 0, failed: 2, pruned: 2 });
        // actually EXECUTED, not just built (lazy Prisma promise)
        expect(state.executedDeletes.sort()).toEqual(['bad', 'w1']);
    });

    it('no subscriptions → total 0', async () => {
        state.tokens = [];
        const res = await sendTestWebPush('u', { title: 'Test', body: 'b' });
        expect(res).toEqual({ configured: true, total: 0, sent: 0, failed: 0, pruned: 0 });
    });
});
