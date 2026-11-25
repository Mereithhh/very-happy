import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { z } from 'zod';
import { AttentionItemAnySchema, AttentionPluginPayloadSchema } from '@slopus/happy-wire';

/**
 * B-974 end to end through the production `startApi()` on PGlite: real routes, auth (login vs machine
 * tokens), the machine socket's `plugin-op`, the briefing-board bridge, and the plugin-origin gateway
 * (Host dispatch in front of everything). The daemon side of panel forwarding is a fake RPC seam.
 */

const { pushed, shutdown } = vi.hoisted(() => ({ pushed: [] as unknown[], shutdown: [] as (() => Promise<void>)[] }));
vi.mock('@/app/push/pushDispatch', () => ({
    dispatchSessionEventPush: vi.fn(async (p: unknown) => { pushed.push(p); }),
    dispatchDeviceEventPush: vi.fn(async (p: unknown) => { pushed.push(p); }),
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

const manifest = {
    schema: 'vh-plugin/v1', id: 'hello-board', name: 'Hello Board', version: '0.1.0', icon: 'kanban',
    permissions: ['sidebar', 'panel', 'decisions', 'session.widget', 'sessions.read'],
    sidebar: { title: 'Hello', panel: 'main' },
    panels: [{ id: 'main', title: 'Counter', upstream: 'http://127.0.0.1:4310', entry: '/' }],
    callback: { url: 'http://127.0.0.1:4310/vh/callback' },
    sessionWidget: true,
};

/** What a Web from before B-974 validates every attention item with (sessionId required). */
const OldWebItem = z.object({ id: z.string(), sessionId: z.string() }).passthrough();

describe('B-974 plugins through startApi (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/plugin-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'api-'));
    let db: PrismaClient; let base: string; let port: number;
    let accountId: string; let human: string; let machineToken: string;
    let otherHuman: string;
    const machineId = 'machine-plugin-1'; const otherMachineId = 'machine-plugin-2';
    let sessionId: string; let otherMachineSessionId: string;
    let machineSocket: ClientSocket; let otherMachineSocket: ClientSocket; let webSocket: ClientSocket; let oldWebSocket: ClientSocket;
    const oldWebUpdates: any[] = [];
    const webPluginUpdates: any[] = []; const webUpdates: any[] = []; const machineNotices: any[] = [];
    let installId: string;
    let gateway: typeof import('./pluginGateway');
    const rpcCalls: Array<{ method: string; params: any }> = [];
    let rpcReply: (method: string, params: any) => unknown = () => ({ status: 200, headers: { 'content-type': 'text/plain' }, bodyB64: Buffer.from('hi').toString('base64') });

    const call = async (method: string, path: string, body?: unknown, bearer = human) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    let reqN = 0;
    const op = (socket: ClientSocket, body: Record<string, unknown>) => socket.timeout(10_000).emitWithAck('plugin-op', { installId: null, payload: {}, requestId: `r${++reqN}`, ...body }) as Promise<any>;
    const plugin = (o: string, payload?: unknown, socket = machineSocket) => op(socket, { installId, op: o, payload: payload ?? {} });
    const pluginBodies = () => webUpdates.map(u => u.body).filter(Boolean);
    const pluginHost = () => `p.test:${port}`;
    const raw = (path: string, opts: { method?: string; host: string; headers?: Record<string, string>; body?: Buffer | string }) =>
        new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
            const req = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: opts.host, ...(opts.headers ?? {}) } }, res => {
                const chunks: Buffer[] = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
            });
            req.on('error', reject);
            if (opts.body) req.write(opts.body);
            req.end();
        });

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'plugin-api-test-only';
        process.env.VH_OWNER_BOARD_ENABLED = 'true';
        delete process.env.VH_PLUGINS_ENABLED;
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        const { initEncrypt } = await import('@/modules/encrypt'); await initEncrypt();
        const { auth } = await import('@/app/auth/auth'); await auth.init();
        const crypto = await import('@/app/session/sessionCrypto');
        const { upsertAccountSecret } = await import('@/app/auth/accountSecrets');
        gateway = await import('./pluginGateway');
        gateway.setPluginRpcForTests(async (_a, _m, method, params) => { rpcCalls.push({ method, params }); return rpcReply(method, params); });
        const { startApi } = await import('@/app/api/api');
        port = await freePort();
        process.env.VH_PLUGIN_HOST = `p.test:${port}`;
        process.env.VH_PLUGIN_HOST_SCHEME = 'http';
        await startApi({ port, host: '127.0.0.1' });
        base = `http://127.0.0.1:${port}`;

        const secret = randomBytes(32);
        accountId = (await db.account.create({ data: { publicKey: randomBytes(16).toString('hex') } })).id;
        await upsertAccountSecret(db, accountId, secret.toString('base64url'));
        const keys = crypto.contentKeyPairFromSecret(new Uint8Array(secret));
        for (const id of [machineId, otherMachineId]) {
            await db.machine.create({ data: { id, accountId, metadata: 'x', dataEncryptionKey: Buffer.from(crypto.wrapDataEncryptionKey(new Uint8Array(randomBytes(32)), keys.publicKey)) } });
        }
        const session = async (onMachine: string) => {
            const dek = new Uint8Array(randomBytes(32));
            return (await db.session.create({ data: {
                accountId, tag: randomBytes(8).toString('hex'),
                metadata: Buffer.from(crypto.encryptWithDataKey({ path: '/w', machineId: onMachine }, dek)).toString('base64'),
                dataEncryptionKey: Buffer.from(crypto.wrapDataEncryptionKey(dek, keys.publicKey)),
            } })).id;
        };
        sessionId = await session(machineId);
        otherMachineSessionId = await session(otherMachineId);
        human = (await auth.createLoginToken(accountId)).token;
        machineToken = await auth.createToken(accountId);
        const otherId = (await db.account.create({ data: { publicKey: randomBytes(16).toString('hex') } })).id;
        otherHuman = (await auth.createLoginToken(otherId)).token;

        const open = (authData: Record<string, unknown>) => new Promise<ClientSocket>((resolve, reject) => {
            const s = connect(base, { path: '/v1/updates', transports: ['websocket'], auth: authData, reconnection: false });
            s.on('connect', () => resolve(s)); s.on('connect_error', reject);
        });
        machineSocket = await open({ token: machineToken, clientType: 'machine-scoped', machineId });
        otherMachineSocket = await open({ token: machineToken, clientType: 'machine-scoped', machineId: otherMachineId });
        // A plugin-aware Web declares include=plugin; an older Web does not and must never get a plugin body.
        webSocket = await open({ token: human, clientType: 'user-scoped', include: 'plugin' });
        oldWebSocket = await open({ token: human, clientType: 'user-scoped' });
        webSocket.on('update', (b: any) => { webUpdates.push(b); if (b?.body?.t?.startsWith('plugin') || b?.body?.item?.pluginInstallId) webPluginUpdates.push(b.body); });
        oldWebSocket.on('update', (b: any) => oldWebUpdates.push(b));
        machineSocket.on('plugin-install-changed', (b: any) => machineNotices.push({ t: 'changed', ...b }));
        machineSocket.on('plugin-events-due', (b: any) => machineNotices.push({ t: 'due', ...b }));
    }, 90_000);

    afterAll(async () => {
        gateway?.setPluginRpcForTests(null);
        for (const s of [machineSocket, otherMachineSocket, webSocket, oldWebSocket]) s?.close();
        for (const fn of shutdown.reverse()) await fn().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
    });

    it('plugins off: every route 404 plugins_disabled, plugin-op refused', async () => {
        expect(await call('GET', '/v1/plugins/installs')).toEqual({ status: 404, body: { error: 'plugins_disabled' } });
        expect((await call('GET', '/v1/features')).body).toEqual({ features: [] });
        expect((await call('POST', '/v1/plugins/installs', { machineId, manifest }, machineToken)).status).toBe(404);
        expect(await db.attentionItem.count({ where: { sessionId: null } })).toBe(0);
        expect(await op(machineSocket, { op: 'install.sync' })).toMatchObject({ ok: false, status: 404, error: 'plugins_disabled' });
        // B-974f P3-1: the switch answers before body validation, and an unknown path looks the same as a real one.
        const off = { status: 404, body: { error: 'plugins_disabled' } };
        expect(await call('POST', '/v1/plugins/installs', { machineId: 7, manifest }, machineToken)).toEqual(off);
        expect(await call('POST', '/v1/plugins/installs/pi_x/approve', { grants: 'nope' })).toEqual(off);
        expect(await call('POST', '/v1/plugins/installs/pi_x/mute', { muted: 'yes' })).toEqual(off);
        expect(await call('POST', '/v1/plugins/installs/pi_x/grants', {})).toEqual(off);
        expect(await call('POST', '/v1/plugins/installs/pi_x/frame-ticket', { panelId: 1 })).toEqual(off);
        expect(await call('POST', '/v1/plugins/installs/pi_x/disable', { reason: 5 }, machineToken)).toEqual(off);
        expect(await call('POST', '/v1/plugins/installs/pi_x/enable', { machineId: 5 }, machineToken)).toEqual(off);
        expect(await call('POST', '/v1/plugins/widgets/pi_x/s/action', { actionId: 3 })).toEqual(off);
        expect(await call('GET', '/v1/plugins/installs/pi_x/audit?limit=abc')).toEqual(off);
        expect(await call('GET', '/v1/plugins/no-such-route')).toEqual(off);
        expect(await call('DELETE', '/v1/plugins/installs/pi_x?keepItems=maybe', undefined, machineToken)).toEqual(off);
        expect((await call('GET', '/v1/plugins/no-such-route', undefined, 'bad-token')).status).toBe(401);
        process.env.VH_PLUGINS_ENABLED = '1';
        // On: validation applies again, and an unknown path is a plain not_found.
        expect((await call('POST', '/v1/plugins/installs/pi_x/mute', { muted: 'yes' })).status).toBe(400);
        expect(await call('GET', '/v1/plugins/no-such-route')).toEqual({ status: 404, body: { error: 'not_found' } });
    });

    it('install: machine token submits (pending + review card); approval is the signed-in owner only, hash-bound', async () => {
        const submitted = await call('POST', '/v1/plugins/installs', { machineId, manifest }, machineToken);
        expect(submitted.status).toBe(201);
        expect(submitted.body).toMatchObject({ state: 'pending', reviewUrl: expect.stringMatching(/^\/settings\/plugins\/pi_/), manifestHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
        expect((await call('POST', '/v1/plugins/installs', { manifest }, machineToken)).body).toEqual({ error: 'machine_id_required' });
        expect((await call('GET', '/v1/features')).body).toEqual({ features: ['plugins-v1'] });
        expect((await call('GET', '/v1/features', undefined, machineToken)).body).toEqual({ features: ['plugins-v1'] });
        installId = submitted.body.installId;
        const listed = await call('GET', '/v1/plugins/installs');
        expect(listed.body.installs[0]).toMatchObject({ id: installId, state: 'pending', origin: expect.stringMatching(/^http:\/\/hello-board-[a-z2-7]{8}\.p\.test:/) });
        expect(JSON.stringify(listed.body)).not.toContain('4310');

        // Another account's machine id: not found.
        expect((await call('POST', '/v1/plugins/installs', { machineId, manifest }, otherHuman)).body).toEqual({ error: 'machine_not_found' });

        const detail = await call('GET', `/v1/plugins/installs/${installId}`);
        expect(detail.body.review.manifest.panels[0].upstream).toBe('http://127.0.0.1:4310');
        const hash = detail.body.review.manifestHash;
        expect((await call('GET', `/v1/plugins/installs/${installId}`, undefined, machineToken)).body).toEqual({ error: 'owner_login_required' });

        expect(await call('POST', `/v1/plugins/installs/${installId}/approve`, { grants: ['sidebar'], manifestHash: hash }, machineToken)).toEqual({ status: 403, body: { error: 'owner_login_required' } });
        expect((await call('POST', `/v1/plugins/installs/${installId}/approve`, { grants: ['sidebar'], manifestHash: '0'.repeat(64) })).body).toMatchObject({ error: 'manifest_changed' });
        expect((await call('POST', `/v1/plugins/installs/${installId}/approve`, { grants: ['sidebar'], manifestHash: hash }, otherHuman)).status).toBe(404);
        expect(await plugin('info')).toMatchObject({ ok: false, status: 403, error: 'plugin_pending' });

        const approved = await call('POST', `/v1/plugins/installs/${installId}/approve`, { grants: ['sidebar', 'panel', 'decisions', 'session.widget'], manifestHash: hash });
        expect(approved.body.install).toMatchObject({ state: 'enabled', grants: ['sidebar', 'panel', 'decisions', 'session.widget'] });
        expect(machineNotices.some(n => n.t === 'changed' && n.installId === installId)).toBe(true);
        const review = await db.attentionItem.findFirstOrThrow({ where: { pluginInstallId: installId, key: 'vh:install-review' } });
        expect(review).toMatchObject({ source: 'owner-system', state: 'resolved', sessionId: null, title: '插件安装待批准 · Hello Board' });
        // B-974f P3-5: the Web titles the card in its own language from the payload; `title` stays for an older Web.
        expect(review.payload).toEqual({ v: 1, type: 'plugin-review', pluginName: 'Hello Board', update: false });
        const listedReview = (await call('GET', '/v1/attention-items?state=all&include=plugin')).body.items.find((i: any) => i.id === review.id);
        expect(listedReview.payload).toEqual({ v: 1, type: 'plugin-review', pluginName: 'Hello Board', update: false });
        expect(OldWebItem.safeParse({ ...listedReview, sessionId: 'x' }).success).toBe(true);
    });

    it('plugin-op is checked against the socket: other machine → not_found; a user socket → machine_only; info without trust in the payload', async () => {
        expect(await plugin('info', undefined, otherMachineSocket)).toMatchObject({ ok: false, status: 404, error: 'not_found' });
        expect(await plugin('info', undefined, webSocket)).toMatchObject({ ok: false, status: 403, error: 'machine_only' });
        expect(await plugin('info')).toMatchObject({ ok: true, result: { installId, pluginId: 'hello-board', machineId, apiVersion: 1 } });
        const sync = await op(machineSocket, { op: 'install.sync' });
        expect(sync.result.installs[0]).toMatchObject({ id: installId, state: 'enabled', manifest: { panels: [{ upstream: 'http://127.0.0.1:4310' }] } });
        expect((await op(otherMachineSocket, { op: 'install.sync' })).result.installs).toEqual([]);
        expect(await plugin('nope')).toMatchObject({ ok: false, error: 'invalid_request' });
        expect(await op(machineSocket, { installId, op: 'install.sync' })).toMatchObject({ ok: false, error: 'invalid_request' });
    });

    it('badge: granted → stored and sent on plugin-update (never on update); same value dropped', async () => {
        webPluginUpdates.length = 0;
        expect(await plugin('badge.put', { count: 3, tone: 'attention' })).toMatchObject({ ok: true, result: { badge: { count: 3, tone: 'attention' } } });
        await sleep(100);
        expect(webPluginUpdates.filter(u => u.t === 'plugin-install').at(-1).install.badge).toMatchObject({ count: 3 });
        expect(oldWebUpdates.some(u => String(u.body?.t).startsWith('plugin'))).toBe(false);
        const before = webPluginUpdates.length;
        await plugin('badge.put', { count: 3, tone: 'attention' });
        await sleep(100);
        expect(webPluginUpdates.length).toBe(before);
        expect(await plugin('badge.put', { count: 10_000 })).toMatchObject({ ok: false, error: 'invalid_request' });
    });

    it('sensitive reads: not granted → permission_denied', async () => {
        expect(await plugin('audit.sensitiveRead', { permission: 'sessions.read', sessionIds: [sessionId] })).toMatchObject({ ok: false, status: 403, error: 'permission_denied', permission: 'sessions.read' });
    });

    let choiceId: string;
    it('decisions: kept out of the default list (older Web) and the update stream; ?include=plugin returns them', async () => {
        webUpdates.length = 0;
        const posted = await plugin('decision.post', { key: 'case:1', kind: 'choice', title: 'Release?', options: [{ id: 'go', label: 'Go' }, { id: 'wait', label: 'Wait' }], sessionId });
        expect(posted).toMatchObject({ ok: true, result: { created: true, item: { key: 'case:1', kind: 'choice', state: 'open', delivery: 'pending' } } });
        choiceId = posted.result.item.itemId;
        expect((await plugin('decision.post', { key: 'vh:install-review', kind: 'notice', title: 'spoof' })).error).toBe('invalid_request');
        expect((await plugin('decision.post', { key: 'x', kind: 'notice', title: 't', sessionId: otherMachineSessionId })).error).toBe('session_not_on_machine');

        const oldWeb = await call('GET', '/v1/attention-items?state=all');
        expect(oldWeb.status).toBe(200);
        for (const item of oldWeb.body.items) expect(OldWebItem.safeParse(item).success).toBe(true);
        expect(oldWeb.body.items.some((i: any) => i.pluginInstallId)).toBe(false);
        const newWeb = await call('GET', '/v1/attention-items?state=all&include=plugin');
        const card = newWeb.body.items.find((i: any) => i.id === choiceId);
        expect(card).toMatchObject({ sessionId: null, pluginInstallId: installId, source: 'plugin', kind: 'decision', links: [{ type: 'session', ref: sessionId }], payload: { v: 1, type: 'plugin', pluginId: 'hello-board', pluginName: 'Hello Board', machineId, decisionKind: 'choice', pluginState: 'open', delivery: 'pending' } });
        expect(AttentionItemAnySchema.safeParse(card).success).toBe(true);
        expect(AttentionPluginPayloadSchema.safeParse(card.payload).success).toBe(true);
        await sleep(100);
        expect(oldWebUpdates.some(u => u.body?.t === 'attention-item' && (u.body.item.sessionId === null || u.body.item.pluginInstallId))).toBe(false);
        expect(webPluginUpdates.some(u => u.t === 'attention-item' && u.item.id === choiceId)).toBe(true);
        expect(pushed.some((p: any) => p.data?.itemId === choiceId)).toBe(true);
        // An agent's account token cannot edit or close a plugin card.
        expect((await call('POST', `/v1/attention-items/${choiceId}/resolve`, { outcome: 'done' }, machineToken)).status).toBe(404);
    });

    it('the owner answers (signed-in only) → decision.responded queued → daemon pulls, reports, card shows delivery', async () => {
        expect((await call('POST', `/v1/attention-items/${choiceId}/owner-respond`, { action: 'choose', choice: 'go' }, machineToken)).body).toEqual({ error: 'owner_login_required' });
        machineNotices.length = 0;
        const responded = await call('POST', `/v1/attention-items/${choiceId}/owner-respond`, { action: 'choose', choice: 'go' });
        expect(responded.body.item).toMatchObject({ state: 'resolved', resolvedBy: 'owner', ownerChoice: 'go' });
        expect((await call('POST', `/v1/attention-items/${choiceId}/owner-respond`, { action: 'choose', choice: 'wait' })).body.error).toBe('attention_item_closed');
        await sleep(100);
        expect(machineNotices).toContainEqual({ t: 'due', installId });

        const due = await plugin('events.pull', {});
        const event = due.result.events.find((e: any) => e.type === 'decision.responded');
        expect(event).toMatchObject({ installId, pluginId: 'hello-board', attempt: 1, data: { itemId: choiceId, key: 'case:1', action: 'choose', choice: 'go', actor: 'owner' } });
        expect(await plugin('events.result', { eventId: event.id, status: 'failed', attempt: 1, error: 'ECONNREFUSED' })).toMatchObject({ ok: true, result: { delivery: 'pending', nextAttemptAt: expect.any(Number) } });
        // Not due again before the backoff.
        expect((await plugin('events.pull', {})).result.events.some((e: any) => e.id === event.id)).toBe(false);
        expect(await plugin('events.result', { eventId: event.id, status: 'delivered', attempt: 2 })).toMatchObject({ result: { delivery: 'delivered' } });
        const view = (await plugin('decision.list', { state: 'all' })).result.items.find((i: any) => i.key === 'case:1');
        expect(view).toMatchObject({ state: 'responded', delivery: 'delivered', response: { action: 'choose', choice: 'go' } });
        // Another install's event id is not reachable.
        expect((await plugin('events.result', { eventId: event.id, status: 'delivered', attempt: 1 }, otherMachineSocket)).error).toBe('not_found');
        // The plugin acknowledges by closing; a repost reopens without a second push.
        await plugin('decision.delete', { key: 'case:1', outcome: 'done' });
        const pushes = pushed.length;
        expect((await plugin('decision.post', { key: 'case:1', kind: 'choice', title: 'Again?', options: [{ id: 'go', label: 'Go' }, { id: 'wait', label: 'Wait' }] })).result.item.state).toBe('open');
        await sleep(100);
        expect(pushed.length).toBe(pushes);
    });

    it('input cards take a submit; pull API cursor + ack', async () => {
        const posted = await plugin('decision.post', { key: 'ask:1', kind: 'input', title: 'Name?', input: { maxLength: 5 }, push: false });
        const id = posted.result.item.itemId;
        expect((await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'submit', text: 'toolong' })).body.error).toBe('attention_body_too_large');
        expect((await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'submit', text: 'Ann' })).body.item.payload).toMatchObject({ decisionKind: 'input', pluginState: 'responded', response: { action: 'submit', text: 'Ann' } });
        const pulled = await plugin('events.pull', {});
        const submit = pulled.result.events.find((e: any) => e.data.itemId === id);
        expect(submit.data).toMatchObject({ action: 'submit', text: 'Ann' });
        expect((await plugin('events.ack', { upTo: pulled.result.cursor })).result.acked).toBeGreaterThan(0);
        expect((await plugin('events.pull', {})).result.events).toEqual([]);
        // submit on a non-plugin card is refused.
        expect((await call('POST', `/v1/attention-items/${choiceId}/owner-respond`, { action: 'submit', text: 'x' })).body.error).toBe('attention_check_unsupported');
    });

    it('widgets: own machine sessions only; listed for the Web; actions (signed-in) queue widget.action', async () => {
        expect((await plugin('widget.put', { sessionId: otherMachineSessionId, status: { label: 'x', tone: 'info' } })).error).toBe('session_not_on_machine');
        const put = await plugin('widget.put', { sessionId, status: { label: 'count: 1', tone: 'info' }, actions: [{ id: 'inc', label: '+1' }] });
        expect(put).toMatchObject({ ok: true, result: { widget: { sessionId, version: 1 } } });
        expect((await plugin('widget.put', { sessionId, status: { label: 'x', tone: 'info' }, expectedVersion: 7 })).error).toBe('version_conflict');
        const listed = await call('GET', `/v1/plugins/widgets?sessionId=${sessionId}`);
        expect(listed.body.widgets).toEqual([expect.objectContaining({ installId, sessionId, status: { label: 'count: 1', tone: 'info' } })]);
        expect((await call('POST', `/v1/plugins/widgets/${installId}/${sessionId}/action`, { actionId: 'inc' }, machineToken)).status).toBe(403);
        expect((await call('POST', `/v1/plugins/widgets/${installId}/${sessionId}/action`, { actionId: 'nope' })).body.error).toBe('unknown_action');
        const acted = await call('POST', `/v1/plugins/widgets/${installId}/${sessionId}/action`, { actionId: 'inc' });
        expect(acted.body.eventId).toMatch(/^evt_/);
    });

    let cookie: string; let origin: string; let siblingHost: string;
    it('panel: frame ticket (signed-in only) → /__vh/enter sets __Host-vhp once → forwarding with rewritten headers', async () => {
        expect((await call('POST', `/v1/plugins/installs/${installId}/frame-ticket`, { panelId: 'main' }, machineToken)).status).toBe(403);
        const ticket = await call('POST', `/v1/plugins/installs/${installId}/frame-ticket`, { panelId: 'main', path: '/board' });
        expect(ticket.status).toBe(200);
        origin = ticket.body.origin;
        const host = new URL(origin).host;
        const enterPath = new URL(ticket.body.url).pathname + new URL(ticket.body.url).search;
        const entered = await raw(enterPath, { host });
        expect(entered.status).toBe(302);
        expect(entered.headers.location).toBe('/board');
        const setCookie = String(entered.headers['set-cookie']);
        expect(setCookie).toMatch(/^__Host-vhp=[^;]+; Path=\/; Max-Age=43200; Secure; HttpOnly; SameSite=/);
        cookie = setCookie.split(';')[0];
        expect((await raw(enterPath, { host })).status).toBe(401);
        // A ticket is bound to its install's origin: not a missing one, not a sibling install's.
        const other = await call('POST', `/v1/plugins/installs/${installId}/frame-ticket`, { panelId: 'main' });
        const otherPath = new URL(other.body.url).pathname + new URL(other.body.url).search;
        expect((await raw(otherPath, { host: `hello-board-zzzzzzzz.${pluginHost()}` })).status).toBe(404);
        const sibling = await call('POST', '/v1/plugins/installs', { machineId: otherMachineId, manifest }, machineToken);
        const siblingHash = (await call('GET', `/v1/plugins/installs/${sibling.body.installId}`)).body.review.manifestHash;
        await call('POST', `/v1/plugins/installs/${sibling.body.installId}/approve`, { grants: ['panel', 'sidebar'], manifestHash: siblingHash });
        siblingHost = new URL(sibling.body.install.origin).host;
        expect((await raw(otherPath, { host: siblingHost })).status).toBe(401);

        expect((await raw('/board', { host })).status).toBe(401);
        // This install's frame session opens nothing on a sibling install's origin (other machine, same plugin).
        expect((await raw('/board', { host: siblingHost, headers: { cookie } })).status).toBe(401);
        rpcCalls.length = 0;
        rpcReply = () => ({ status: 200, headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'set-cookie': ['s=1; Domain=p.test', '__Host-vhp=evil'], 'content-security-policy': "script-src 'self'; frame-ancestors *" }, bodyB64: Buffer.from('<p>ok</p>').toString('base64') });
        const page = await raw('/board?x=1', { host, headers: { cookie: `${cookie}; mine=1`, 'x-vh-viewer': 'forged' } });
        expect(page.status).toBe(200);
        expect(page.body.toString()).toBe('<p>ok</p>');
        expect(page.headers['x-frame-options']).toBeUndefined();
        expect(page.headers['set-cookie']).toEqual(['s=1']);
        expect(page.headers['cross-origin-resource-policy']).toBe('same-origin');
        expect(page.headers['permissions-policy']).toContain('camera=()');
        expect(String(page.headers['content-security-policy'])).toContain("script-src 'self'");
        expect(String(page.headers['content-security-policy'])).not.toContain('frame-ancestors *');
        expect(rpcCalls).toHaveLength(1);
        expect(rpcCalls[0]).toMatchObject({ method: 'plugin-http', params: { installId, panelId: 'main', method: 'GET', path: '/board', query: 'x=1', headers: { cookie: 'mine=1' } } });
        expect(rpcCalls[0].params.headers['x-vh-viewer']).toBeUndefined();
        expect(JSON.stringify(rpcCalls[0].params)).not.toContain('4310');
        // Reserved paths never reach the plugin.
        expect((await raw('/__vh/anything', { host, headers: { cookie } })).status).toBe(404);
        expect((await raw('/__vh/health', { host })).status).toBe(200);
        // Plugin-host requests never reach the API: the path goes to the plugin (and the bearer is not the host's business).
        const notApi = await raw('/v1/plugins/installs', { host, headers: { cookie, authorization: `Bearer ${human}` } });
        expect(notApi.body.toString()).toBe('<p>ok</p>');
        expect(rpcCalls.at(-1)?.params.path).toBe('/v1/plugins/installs');
    });

    it('panel: Origin check on writes, service worker and upgrade refused, chunked bodies both ways', async () => {
        const host = new URL(origin).host;
        rpcCalls.length = 0;
        expect((await raw('/api/x', { method: 'POST', host, headers: { cookie, origin: 'http://other-1abcdefg.' + pluginHost(), 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
        expect((await raw('/api/x', { method: 'POST', host, headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
        expect((await raw('/sw.js', { host, headers: { cookie, 'service-worker': 'script' } })).status).toBe(404);
        expect((await raw('/a/%2e%2e/secret', { host, headers: { cookie } })).status).toBe(400);
        expect((await raw('/ws', { host, headers: { cookie, accept: 'text/event-stream' } })).status).toBe(501);
        // B-974f P3-8: a real WebSocket upgrade (Node never runs request hooks for it) gets 501 too, cookie or not.
        for (const headers of [{ cookie }, {}] as Array<Record<string, string>>) {
            const ws = await raw('/ws', { host, headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') } });
            expect(ws.status).toBe(501);
            expect(JSON.parse(ws.body.toString())).toEqual({ error: 'unsupported_upgrade' });
        }
        expect(rpcCalls).toEqual([]);

        rpcReply = (method, params) => method === 'plugin-http'
            ? { status: 201, headers: { 'content-type': 'application/octet-stream' }, bodyB64: Buffer.alloc(10, 1).toString('base64'), streamId: 's1' }
            : method === 'plugin-http-pull' ? { chunkB64: Buffer.alloc(5, params.seq).toString('base64'), end: params.seq === 2 } : { ok: true };
        const big = Buffer.alloc(300 * 1024, 2);
        const res = await raw('/api/upload', { method: 'POST', host, headers: { cookie, origin, 'content-type': 'application/octet-stream', 'content-length': String(big.length) }, body: big });
        expect(res.status).toBe(201);
        expect(res.body.length).toBe(20);
        expect(rpcCalls.map(c => c.method)).toEqual(['plugin-http-body', 'plugin-http', 'plugin-http-pull', 'plugin-http-pull']);
        expect(rpcCalls[0].params).toMatchObject({ seq: 0, end: true });
        expect(rpcCalls[1].params.bodyStreamId).toBe(rpcCalls[0].params.streamId);
        expect(rpcCalls[1].params.bodyB64).toBeUndefined();
    });

    it('revoking panel or disabling voids the frame session at once; kill switch beats enabled', async () => {
        const host = new URL(origin).host;
        rpcReply = () => ({ status: 200, headers: {}, bodyB64: '' });
        expect((await raw('/', { host, headers: { cookie } })).status).toBe(200);
        await call('POST', `/v1/plugins/installs/${installId}/disable`, { reason: 'test' });
        expect((await raw('/', { host, headers: { cookie } })).status).toBe(401);
        expect(await plugin('badge.put', { count: 1 })).toMatchObject({ ok: false, status: 403, error: 'plugin_disabled' });
        const hidden = await call('GET', '/v1/attention-items?state=all&include=plugin');
        expect(hidden.body.items.some((i: any) => i.pluginInstallId === installId && i.source === 'plugin')).toBe(false);
        expect((await call('GET', `/v1/plugins/widgets?sessionId=${sessionId}`)).body.widgets).toEqual([]);
        expect((await call('POST', `/v1/plugins/installs/${installId}/enable`)).body.install.state).toBe('enabled');

        // Answering a stopped plugin's card is refused too (its cards are hidden).
        const card = await plugin('decision.post', { key: 'stop:1', kind: 'notice', title: 'n', push: false });
        await call('POST', `/v1/plugins/installs/${installId}/disable`, {});
        expect((await call('POST', `/v1/attention-items/${card.result.item.itemId}/owner-respond`, { action: 'resolve' })).body.error).toBe('plugin_disabled');
        await call('POST', `/v1/plugins/installs/${installId}/enable`);
        // r6: `gave_up` from the daemon is final; the card shows failed.
        const ask = await plugin('decision.post', { key: 'gu:1', kind: 'choice', title: 'g', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], push: false });
        await call('POST', `/v1/attention-items/${ask.result.item.itemId}/owner-respond`, { action: 'choose', choice: 'a' });
        const ev = (await plugin('events.pull', {})).result.events.find((e: any) => e.data.itemId === ask.result.item.itemId);
        expect((await plugin('events.result', { eventId: ev.id, status: 'failed', attempt: 7, error: 'gave_up' })).result).toEqual({ delivery: 'failed' });
        expect((await plugin('decision.list', { state: 'all' })).result.items.find((i: any) => i.key === 'gu:1').delivery).toBe('failed');
        // Fallback sweep: an overdue event is failed only once its machine has been offline > 24 h.
        const { sweepPluginEvents } = await import('./pluginStore');
        const stale = await db.pluginEvent.create({ data: { id: 'evt_stale', installId, accountId, seq: 9999, type: 'ping', data: {}, createdAt: new Date(Date.now() - 25 * 3600_000), nextAttemptAt: new Date(Date.now() - 3600_000) } });
        await sweepPluginEvents();
        expect((await db.pluginEvent.findUniqueOrThrow({ where: { id: stale.id } })).delivery).toBe('pending');
        await db.machine.update({ where: { id: machineId }, data: { lastActiveAt: new Date(Date.now() - 25 * 3600_000) } });
        await sweepPluginEvents();
        expect((await db.pluginEvent.findUniqueOrThrow({ where: { id: stale.id } })).delivery).toBe('failed');
        await db.machine.update({ where: { id: machineId }, data: { lastActiveAt: new Date() } });
        // An agent's reply_to cannot settle a plugin card.
        await call('POST', '/v1/attention-items', { sessionId, source: 'agent', kind: 'report', title: 'r', replyToId: card.result.item.itemId }, machineToken);
        expect((await db.attentionItem.findUniqueOrThrow({ where: { id: card.result.item.itemId } })).state).toBe('open');

        const t = await call('POST', `/v1/plugins/installs/${installId}/frame-ticket`, { panelId: 'main' });
        const freshCookie = String((await raw(new URL(t.body.url).pathname + new URL(t.body.url).search, { host })).headers['set-cookie']).split(';')[0];
        expect((await raw('/', { host, headers: { cookie: freshCookie } })).status).toBe(200);
        process.env.VH_PLUGINS_DISABLED = '1';
        try {
            // A live frame session stops with the switch (no epoch bump needed).
            expect((await raw('/', { host, headers: { cookie: freshCookie } })).status).toBe(403);
            expect(await plugin('info')).toMatchObject({ ok: false, error: 'disabled_by_operator' });
            expect((await call('POST', `/v1/plugins/installs/${installId}/frame-ticket`, { panelId: 'main' })).body.error).toBe('disabled_by_operator');
            expect((await call('GET', '/v1/plugins/installs')).body.installs[0]).toMatchObject({ state: 'disabled_by_operator', stateReason: 'all_disabled' });
            // B-974f P3-12: the owner cannot lift the operator's switch, and is told so (not `not_disabled`).
            expect(await call('POST', `/v1/plugins/installs/${installId}/enable`)).toEqual({ status: 409, body: { error: 'disabled_by_operator' } });
            await call('POST', `/v1/plugins/installs/${installId}/disable`, {});
            expect(await call('POST', `/v1/plugins/installs/${installId}/enable`)).toEqual({ status: 409, body: { error: 'disabled_by_operator' } });
            expect((await db.pluginInstall.findUniqueOrThrow({ where: { id: installId } })).state).toBe('disabled');
        } finally {
            delete process.env.VH_PLUGINS_DISABLED;
        }
        expect((await call('POST', `/v1/plugins/installs/${installId}/enable`)).body.install.state).toBe('enabled');
        // R-b rollback = switch off: plugin cards vanish from every read (include ignored), nothing errors.
        delete process.env.VH_PLUGINS_ENABLED;
        try {
            const off = await call('GET', '/v1/attention-items?state=all&include=plugin');
            expect(off.status).toBe(200);
            expect(off.body.items.some((i: any) => i.pluginInstallId)).toBe(false);
            expect((await call('GET', '/v1/plugins/installs')).status).toBe(404);
        } finally {
            process.env.VH_PLUGINS_ENABLED = '1';
        }
        expect((await call('GET', '/v1/attention-items?state=all&include=plugin')).body.items.some((i: any) => i.pluginInstallId)).toBe(true);
        process.env.VH_PLUGIN_DENYLIST = 'hello-board';
        try { expect(await plugin('info')).toMatchObject({ ok: false, error: 'disabled_by_operator' }); }
        finally { delete process.env.VH_PLUGIN_DENYLIST; }

        const revoked = await call('POST', `/v1/plugins/installs/${installId}/grants`, { revoke: ['sidebar'] });
        expect(revoked.body.install.grants).not.toContain('sidebar');
        expect(await plugin('badge.put', { count: 2 })).toMatchObject({ ok: false, error: 'permission_denied', permission: 'sidebar' });
    });

    it('update: a privileged change waits (old approval keeps working); a cosmetic one applies at once', async () => {
        const submit = (m: unknown) => call('POST', '/v1/plugins/installs', { machineId, manifest: m }, machineToken).then(r => r.body);
        const updated = await submit({ ...manifest, version: '0.2.0', permissions: [...manifest.permissions, 'sessions.list'] });
        expect(updated.state).toBe('update_pending');
        expect(updated.install.pendingDiff.addedPermissions).toEqual(['sessions.list']);
        expect((await db.attentionItem.findFirstOrThrow({ where: { pluginInstallId: installId, key: 'vh:install-review' } })).payload).toEqual({ v: 1, type: 'plugin-review', pluginName: 'Hello Board', update: true });
        expect(await plugin('info')).toMatchObject({ ok: true });
        const rejected = await call('POST', `/v1/plugins/installs/${installId}/reject`);
        expect(rejected.body.install.state).toBe('enabled');
        const cosmetic = await submit({ ...manifest, version: '0.3.0', description: 'new' });
        expect(cosmetic).toMatchObject({ state: 'enabled', install: { version: '0.3.0' } });
        // §5.9: a change submitted while disabled waits; re-enabling puts it up for review (old approval in force).
        await call('POST', `/v1/plugins/installs/${installId}/disable`, {});
        expect((await submit({ ...manifest, version: '0.4.0', name: 'Hello Renamed' })).state).toBe('disabled');
        expect((await call('POST', `/v1/plugins/installs/${installId}/enable`)).body.install).toMatchObject({ state: 'update_pending', name: 'Hello Board' });
        await call('POST', `/v1/plugins/installs/${installId}/reject`);
    });

    it('B-974f: a machine re-enables only an install it disabled itself, on its own machine', async () => {
        const enable = (body: unknown, bearer = machineToken) => call('POST', `/v1/plugins/installs/${installId}/enable`, body, bearer);
        const stored = () => db.pluginInstall.findUniqueOrThrow({ where: { id: installId } });
        expect((await stored()).state).toBe('enabled');
        // Not disabled: same answer as for the owner.
        expect(await enable({ machineId })).toEqual({ status: 409, body: { error: 'not_disabled', state: 'enabled' } });
        expect(await enable({})).toEqual({ status: 400, body: { error: 'machine_id_required' } });

        // Disabled by the machine (CLI `plugin disable`): another machine of the account cannot lift it; its own can.
        expect((await call('POST', `/v1/plugins/installs/${installId}/disable`, { machineId }, machineToken)).body.install.state).toBe('disabled');
        expect((await stored()).disabledBy).toBe('machine');
        expect(await enable({ machineId: otherMachineId })).toEqual({ status: 403, body: { error: 'enable_requires_owner' } });
        expect((await stored()).state).toBe('disabled');
        // The operator's switch beats the machine's own lift.
        process.env.VH_PLUGINS_DISABLED = '1';
        try { expect(await enable({ machineId })).toEqual({ status: 409, body: { error: 'disabled_by_operator' } }); }
        finally { delete process.env.VH_PLUGINS_DISABLED; }
        expect((await stored()).state).toBe('disabled');
        const before = await db.pluginAudit.count({ where: { installId, action: 'install.enabled', actor: 'machine' } });
        expect(await call('POST', `/v1/plugins/installs/${installId}/enable`, undefined, machineToken)).toEqual({ status: 400, body: { error: 'machine_id_required' } });
        // `X-VH-Machine-Id` names the machine as on /disable.
        const viaHeader = await fetch(`${base}/v1/plugins/installs/${installId}/enable`, { method: 'POST', headers: { authorization: `Bearer ${machineToken}`, 'x-vh-machine-id': machineId } });
        expect(viaHeader.status).toBe(200);
        expect(((await viaHeader.json()) as any).install.state).toBe('enabled');
        expect(await db.pluginAudit.count({ where: { installId, action: 'install.enabled', actor: 'machine' } })).toBe(before + 1);

        // Disabled by the owner on the Web: the machine cannot lift it, not even its own.
        await call('POST', `/v1/plugins/installs/${installId}/disable`, {});
        expect((await stored()).disabledBy).toBe('owner');
        expect(await enable({ machineId })).toEqual({ status: 403, body: { error: 'enable_requires_owner' } });
        expect((await stored()).state).toBe('disabled');
        expect((await call('POST', `/v1/plugins/installs/${installId}/enable`)).body.install.state).toBe('enabled');
        expect(await db.pluginAudit.count({ where: { installId, action: 'install.enabled', actor: 'owner' } })).toBeGreaterThan(0);
    });

    it('audit and remove (machine may remove only its own install)', async () => {
        const audit = await call('GET', `/v1/plugins/installs/${installId}/audit`);
        expect(audit.body.entries.map((e: any) => e.action)).toEqual(expect.arrayContaining(['install.submitted', 'install.approved', 'install.disabled', 'grants.revoked', 'decision.responded']));
        expect((await op(otherMachineSocket, { installId, op: 'install.remove' })).error).toBe('not_found');
        expect((await call('DELETE', `/v1/plugins/installs/${installId}`, undefined, machineToken)).body.error).toBe('machine_id_required');
        expect((await call('DELETE', `/v1/plugins/installs/${installId}?machineId=${otherMachineId}`, undefined, machineToken)).body.error).toBe('not_found');
        expect((await call('DELETE', `/v1/plugins/installs/${installId}?machineId=${machineId}`, undefined, machineToken)).body).toEqual({ removed: true });
        expect(await db.pluginInstall.count({ where: { id: installId } })).toBe(0);
        expect(await db.pluginAudit.count({ where: { installId, action: 'install.removed' } })).toBe(1);
        const cards = await db.attentionItem.findMany({ where: { pluginInstallId: installId } });
        expect(cards.every(c => c.state === 'dismissed' || c.state === 'resolved')).toBe(true);
    });
});
