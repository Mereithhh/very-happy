import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { attentionBoardLocalId } from '@slopus/happy-wire';

/**
 * B-766 end to end through the production `startApi()` (real route
 * registration, auth, socket ingress) on PGlite — not the store directly.
 * Pins the wiring a store-level test cannot see: `attentionRoutes` is
 * registered in api.ts, the archive route and both message ingresses
 * (socket `message`, `POST /v3/sessions/:id/messages`) call the hooks.
 */

const { pushed, shutdown } = vi.hoisted(() => ({ pushed: [] as unknown[], shutdown: [] as (() => Promise<void>)[] }));
vi.mock('@/app/push/pushDispatch', () => ({
    dispatchSessionEventPush: vi.fn(async (p: unknown) => { pushed.push(p); }),
    dispatchDeviceEventPush: vi.fn(),
    sendTestWebPush: vi.fn(),
}));
vi.mock('@/utils/shutdown', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/shutdown')>()),
    onShutdown: (_name: string, fn: () => Promise<void>) => { shutdown.push(fn); return () => undefined; },
}));

const options = [{ id: 'A', label: 'Ship now' }, { id: 'B', label: 'Wait' }];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
    const started = Date.now();
    for (;;) {
        const value = await read();
        if (ok(value)) return value;
        if (Date.now() - started > timeoutMs) throw new Error(`condition not reached: ${JSON.stringify(value)}`);
        await sleep(25);
    }
}
async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise(resolve => server.close(resolve));
    return port;
}

describe('attention REST + hooks through startApi (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/attention-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'api-'));
    let db: PrismaClient; let base: string;
    let accountId: string; let token: string; let otherToken: string;
    const sockets: ClientSocket[] = [];

    const call = async (method: string, path: string, body?: unknown, bearer = token) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const newSession = async (owner = accountId) => (await db.session.create({ data: { accountId: owner, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
    const item = (id: string) => db.attentionItem.findUniqueOrThrow({ where: { id } });

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'attention-api-test-only';
        delete process.env.VH_OWNER_BOARD_ENABLED;
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        const { initEncrypt } = await import('@/modules/encrypt'); await initEncrypt();
        const { auth } = await import('@/app/auth/auth'); await auth.init();
        const { startApi } = await import('@/app/api/api');
        const port = await freePort();
        await startApi({ port, host: '127.0.0.1' });
        base = `http://127.0.0.1:${port}`;
        accountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        const otherId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        token = await auth.createToken(accountId);
        otherToken = await auth.createToken(otherId);
    }, 60000);
    afterAll(async () => {
        for (const s of sockets) s.close();
        for (const fn of shutdown.reverse()) await fn().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
    });

    it('answers 404 owner_board_disabled with the switch off (route registered, gated)', async () => {
        const sessionId = await newSession();
        expect(await call('GET', '/v1/attention-items')).toEqual({ status: 404, body: { error: 'owner_board_disabled' } });
        expect((await call('POST', '/v1/attention-items', { sessionId, source: 'agent', kind: 'blocked', title: 'x' })).body).toEqual({ error: 'owner_board_disabled' });
        process.env.VH_OWNER_BOARD_ENABLED = 'true';
    });

    it('POST upsert / PATCH / resolve / owner-respond / GET over HTTP, with validation and auth', async () => {
        const sessionId = await newSession();
        expect((await call('GET', '/v1/attention-items', undefined, 'not-a-token')).status).toBe(401);
        expect((await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'decision', title: 'no options' })).status).toBe(400);

        const created = await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'decision', title: 'Pick', options, key: 'k', requestId: 'r1' });
        expect(created.status).toBe(200);
        expect(created.body).toMatchObject({ created: true, item: { title: 'Pick', state: 'open', needsOwner: true, inferred: false } });
        const id = created.body.item.id as string;
        const repost = await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'decision', title: 'Pick again', options, key: 'k', requestId: 'r2' });
        expect(repost.body).toMatchObject({ created: false, item: { id, repostCount: 1 } });

        expect((await call('PATCH', `/v1/attention-items/${id}`, { appendMd: 'context' })).body.item).toMatchObject({ bodyMd: 'context' });
        expect((await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'choose', choice: 'B' })).body.item).toMatchObject({ state: 'resolved', ownerChoice: 'B', resolvedBy: 'owner' });
        expect((await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'choose', choice: 'A' }))).toMatchObject({ status: 409, body: { error: 'attention_item_closed' } });
        expect((await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'reopen' })).body.item.state).toBe('open');
        expect((await call('POST', `/v1/attention-items/${id}/resolve`, { outcome: 'dropped', note: 'n' })).body.item).toMatchObject({ state: 'dismissed', resolveNote: 'n' });

        const report = await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'report', title: 'Merged', requestId: 'r3' });
        const listed = await call('GET', `/v1/attention-items?sessionId=${sessionId}&state=all&limit=10`);
        expect(listed.status).toBe(200);
        expect(listed.body.items.map((i: { id: string }) => i.id).sort()).toEqual([id, report.body.item.id].sort());
        expect((await call('GET', `/v1/attention-items?sessionId=${sessionId}`)).body.items.map((i: { id: string }) => i.id)).toEqual([report.body.item.id]);

        // Another account: cannot post into the session, read or touch the item.
        expect(await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'report', title: 'x' }, otherToken)).toEqual({ status: 404, body: { error: 'session_not_found' } });
        expect((await call('PATCH', `/v1/attention-items/${id}`, { title: 'x' }, otherToken))).toEqual({ status: 404, body: { error: 'attention_item_not_found' } });
        expect((await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'resolve' }, otherToken)).status).toBe(404);
        expect((await call('GET', `/v1/attention-items?sessionId=${sessionId}&state=all`, undefined, otherToken)).body.items).toEqual([]);
    });

    it('a repost keeps the fields it omits (active and reopened) and overwrites the ones it carries (S-1c)', async () => {
        const sessionId = await newSession();
        const post = (body: Record<string, unknown>) => call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'todo', key: 'keep', ...body });
        const anchor = { localId: 'l1', snippet: 'first' };
        const links = [{ type: 'pr', ref: '713' }];
        const first = await post({ title: 'T1', bodyMd: 'body 1', anchor, links, replyToId: 'q-none', requestId: 'p1' });
        const id = first.body.item.id as string;

        const bare = await post({ title: 'T2', requestId: 'p2' });
        expect(bare.body.item).toMatchObject({ id, title: 'T2', bodyMd: 'body 1', anchor, links, replyToId: 'q-none', repostCount: 1 });

        await call('POST', `/v1/attention-items/${id}/resolve`, { outcome: 'done' });
        const reopened = await post({ title: 'T3', requestId: 'p3' });
        expect(reopened.body.item).toMatchObject({ id, state: 'open', title: 'T3', bodyMd: 'body 1', anchor, links, replyToId: 'q-none' });

        const anchor2 = { messageId: 'm2' };
        const fresh = await post({ title: 'T4', bodyMd: 'body 2', anchor: anchor2, requestId: 'p4' });
        expect(fresh.body.item).toMatchObject({ title: 'T4', bodyMd: 'body 2', anchor: anchor2, links, replyToId: 'q-none' });
        expect(await item(id)).toMatchObject({ bodyMd: 'body 2', anchor: anchor2 });
    });

    it('POST /v1/sessions/:id/archive dismisses the session’s open items', async () => {
        const sessionId = await newSession();
        const { body } = await call('POST', '/v1/attention-items', { sessionId, source: 'agent', kind: 'blocked', title: 'login', requestId: 'a1' });
        expect((await call('POST', `/v1/sessions/${sessionId}/archive`)).status).toBe(200);
        expect(await until(() => item(body.item.id), r => r.state !== 'open')).toMatchObject({ state: 'dismissed', resolvedBy: 'session-archived' });
    });

    it('an owner message via POST /v3/sessions/:id/messages settles the only open decision; a board- message does not', async () => {
        const sessionId = await newSession();
        const { body } = await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'decision', title: 'Pick', options, requestId: 'v1' });
        const board = await call('POST', `/v3/sessions/${sessionId}/messages`, { messages: [{ localId: attentionBoardLocalId(body.item.id, 'n1'), content: 'enc' }] });
        expect(board.status).toBe(200);
        await sleep(300);
        expect((await item(body.item.id)).state).toBe('open');
        expect((await call('POST', `/v3/sessions/${sessionId}/messages`, { messages: [{ localId: 'owner-1', content: 'enc' }] })).status).toBe(200);
        expect(await until(() => item(body.item.id), r => r.state !== 'open')).toMatchObject({ state: 'resolved', resolvedBy: 'owner-replied' });
    });

    it('an owner message leaves D5 drafts open: alone they are no target, beside a real decision only that one settles', async () => {
        const sessionId = await newSession();
        const draft = (await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'decision', title: 'Maybe region', options, key: 'region', inferred: true, requestId: 'd1' })).body.item;
        expect(draft).toMatchObject({ inferred: true, state: 'open' });
        expect((await call('POST', `/v3/sessions/${sessionId}/messages`, { messages: [{ localId: 'owner-d1', content: 'enc' }] })).status).toBe(200);
        await sleep(300);
        expect((await item(draft.id)).state).toBe('open');

        const real = (await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'decision', title: 'Pick', options, requestId: 'd2' })).body.item;
        expect((await call('POST', `/v3/sessions/${sessionId}/messages`, { messages: [{ localId: 'owner-d2', content: 'enc' }] })).status).toBe(200);
        expect(await until(() => item(real.id), r => r.state !== 'open')).toMatchObject({ state: 'resolved', resolvedBy: 'owner-replied' });
        expect(await item(draft.id)).toMatchObject({ state: 'open', resolvedBy: null });
    });

    it('an owner message over the user-scoped socket settles it too', async () => {
        const sessionId = await newSession();
        const { body } = await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'decision', title: 'Pick', options, requestId: 's1' });
        const socket = connect(base, { path: '/v1/updates', transports: ['websocket'], auth: { token, clientType: 'user-scoped' }, reconnection: false });
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject); });
        socket.emit('message', { sid: sessionId, message: 'enc', localId: 'owner-socket-1' });
        expect(await until(() => item(body.item.id), r => r.state !== 'open')).toMatchObject({ state: 'resolved', resolvedBy: 'owner-replied' });
    });
});
