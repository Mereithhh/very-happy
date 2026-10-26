import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/**
 * B-836 end to end through the production `startApi()` on PGlite: the
 * migration applies, `feedbackRoutes` is registered in api.ts, auth / zod /
 * body limit / rate limit / admin gate answer over real HTTP, and a new row
 * pushes the admins (not the sender) — not the store called directly.
 */

const { pushed, shutdown } = vi.hoisted(() => ({ pushed: [] as Array<{ userId: string; title: string; body: string; data?: Record<string, unknown> }>, shutdown: [] as (() => Promise<void>)[] }));
vi.mock('@/app/push/pushDispatch', () => ({
    dispatchSessionEventPush: vi.fn(),
    dispatchDeviceEventPush: vi.fn(async (p: (typeof pushed)[number]) => { pushed.push(p); }),
    sendTestWebPush: vi.fn(),
}));
vi.mock('@/utils/shutdown', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/shutdown')>()),
    onShutdown: (_name: string, fn: () => Promise<void>) => { shutdown.push(fn); return () => undefined; },
}));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise(resolve => server.close(resolve));
    return port;
}

describe('feedback REST through startApi (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/feedback-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'api-'));
    let db: PrismaClient; let base: string;
    let userId: string; let userToken: string; let adminId: string; let adminToken: string;

    const call = async (method: string, path: string, body?: unknown, bearer = userToken) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'feedback-api-test-only';
        process.env.MAX_FEEDBACK_PER_ACCOUNT_PER_HOUR = '3';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        const { initEncrypt } = await import('@/modules/encrypt'); await initEncrypt();
        const { auth } = await import('@/app/auth/auth'); await auth.init();
        const { startApi } = await import('@/app/api/api');
        const port = await freePort();
        await startApi({ port, host: '127.0.0.1' });
        base = `http://127.0.0.1:${port}`;
        userId = (await db.account.create({ data: { publicKey: crypto.randomUUID(), firstName: 'Ada', lastName: 'L' } })).id;
        await db.accountIdentity.create({ data: { accountId: userId, provider: 'email', providerSubject: 'ada@example.com', email: 'ada@example.com' } });
        adminId = (await db.account.create({ data: { publicKey: crypto.randomUUID(), username: 'owner' } })).id;
        userToken = await auth.createToken(userId);
        adminToken = await auth.createToken(adminId);
        process.env.VH_FEEDBACK_ADMIN_ACCOUNT_IDS = adminId;
    }, 60000);
    afterAll(async () => {
        delete process.env.VH_FEEDBACK_ADMIN_ACCOUNT_IDS;
        delete process.env.MAX_FEEDBACK_PER_ACCOUNT_PER_HOUR;
        for (const fn of shutdown.reverse()) await fn().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
    });

    it('validates and authenticates', async () => {
        expect((await call('POST', '/v1/feedback', { rating: 'good' }, 'not-a-token')).status).toBe(401);
        expect((await call('POST', '/v1/feedback', { text: 'no rating' })).status).toBe(400);
        expect((await call('POST', '/v1/feedback', { rating: 'good', text: 'x'.repeat(2001) })).status).toBe(400);
        expect((await call('POST', '/v1/feedback', JSON.stringify({ rating: 'good', pad: 'x'.repeat(20_000) }))).status).toBe(413);
    });

    it('stores rating, text and whitelisted diagnostics only; pushes the admin with a name', async () => {
        pushed.length = 0;
        const res = await call('POST', '/v1/feedback', {
            rating: 'bad', text: 'Sidebar jumps', source: 'manual',
            diagnostics: { webVersion: '2.1.0', route: '/session/cmvph7gqg03ifrz2uk2cweyto?q=1', messages: ['secret'] },
        });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ deduped: false, feedback: { rating: 'bad', text: 'Sidebar jumps', source: 'manual', readAt: null } });
        const row = await db.feedback.findUniqueOrThrow({ where: { id: res.body.feedback.id } });
        expect(row).toMatchObject({ accountId: userId, rating: 1 });
        expect(row.diagnostics).toEqual({ webVersion: '2.1.0', route: '/session/:id' });
        for (let i = 0; i < 20 && pushed.length === 0; i++) await sleep(25);
        expect(pushed).toEqual([{ userId: adminId, title: '新反馈 · 👎 不好用', body: 'Ada L：Sidebar jumps', data: { kind: 'feedback', feedbackId: row.id, url: '/settings/feedback' } }]);

        // A resend inside 10 minutes is the same row, not a new one.
        const again = await call('POST', '/v1/feedback', { rating: 'bad', text: 'Sidebar jumps' });
        expect(again.body).toMatchObject({ deduped: true, feedback: { id: row.id } });
    });

    it('one-tap rating can be amended by its sender only', async () => {
        const tap = await call('POST', '/v1/feedback', { rating: 'good', source: 'prompt' });
        const id = tap.body.feedback.id;
        expect((await call('PATCH', `/v1/feedback/${id}`, { text: 'more' }, adminToken)).status).toBe(404);
        const amended = await call('PATCH', `/v1/feedback/${id}`, { text: 'Love the board', diagnostics: { webVersion: '2.1.0' } });
        expect(amended.body.feedback).toMatchObject({ id, rating: 'good', text: 'Love the board', diagnostics: { webVersion: '2.1.0' }, source: 'prompt' });
        const cleared = await call('PATCH', `/v1/feedback/${id}`, { diagnostics: null });
        expect(cleared.body.feedback.diagnostics).toBeNull();
        await db.feedback.update({ where: { id }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60_000) } });
        expect(await call('PATCH', `/v1/feedback/${id}`, { text: 'late' })).toEqual({ status: 409, body: { error: 'feedback_amend_expired' } });
    });

    it('rate limits per hour (3 in this test) and does not charge resends', async () => {
        // Two rows so far this hour (the dedupe resend was free).
        expect((await call('POST', '/v1/feedback', { rating: 'ok', text: 'third' })).status).toBe(200);
        expect(await call('POST', '/v1/feedback', { rating: 'ok', text: 'fourth' })).toEqual({ status: 429, body: { error: 'feedback_rate_limited' } });
        expect((await call('POST', '/v1/feedback', { rating: 'ok', text: 'third' })).body.deduped).toBe(true);
    });

    it('admin gate: non-admins get 404, admin lists newest first with names and can mark read', async () => {
        expect(await call('GET', '/v1/feedback/admin/access')).toEqual({ status: 200, body: { admin: false } });
        expect(await call('GET', '/v1/feedback/admin')).toEqual({ status: 404, body: { error: 'not_found' } });
        expect(await call('GET', '/v1/feedback/admin/access', undefined, adminToken)).toEqual({ status: 200, body: { admin: true } });

        const list = await call('GET', '/v1/feedback/admin?limit=2', undefined, adminToken);
        expect(list.status).toBe(200);
        expect(list.body.unreadCount).toBe(3);
        expect(list.body.items).toHaveLength(2);
        expect(list.body.items[0]).toMatchObject({ text: 'third', account: { id: userId, displayName: 'Ada L', email: 'ada@example.com' } });
        const page2 = await call('GET', `/v1/feedback/admin?limit=2&cursor=${list.body.nextCursor}`, undefined, adminToken);
        expect(page2.body.items).toHaveLength(1);
        expect(page2.body.nextCursor).toBeNull();

        const id = list.body.items[0].id;
        expect((await call('POST', `/v1/feedback/admin/${id}/read`, { read: true })).status).toBe(404);
        expect((await call('POST', `/v1/feedback/admin/${id}/read`, { read: true }, adminToken)).body.feedback.readAt).toEqual(expect.any(Number));
        const unread = await call('GET', '/v1/feedback/admin?unread=true&rating=bad', undefined, adminToken);
        expect(unread.body).toMatchObject({ unreadCount: 2, items: [{ text: 'Sidebar jumps' }] });
    });

    it('an admin sending feedback does not push themselves', async () => {
        pushed.length = 0;
        expect((await call('POST', '/v1/feedback', { rating: 'good', text: 'self' }, adminToken)).status).toBe(200);
        await sleep(100);
        expect(pushed).toEqual([]);
    });
});
