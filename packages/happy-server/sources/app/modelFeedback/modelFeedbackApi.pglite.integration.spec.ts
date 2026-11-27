import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/**
 * B-980 end to end through the production `startApi()` on PGlite: the
 * migration applies, the routes are registered, the instance config file
 * switches the feature, a rating is stored once per turn, forwarded to the
 * configured target (env-referenced credential), and exported as JSONL/CSV
 * by an admin only.
 */

const { shutdown } = vi.hoisted(() => ({ shutdown: [] as (() => Promise<void>)[] }));
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

describe('model feedback REST through startApi (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/model-feedback-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'api-'));
    const configFile = join(root, 'instance.json');
    let db: PrismaClient; let base: string;
    let userId: string; let userToken: string; let adminId: string; let adminToken: string; let strangerToken: string;
    let sessionId: string;
    const forwarded: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    let forwardStatus = 200;

    const call = async (method: string, path: string, body?: unknown, bearer = userToken) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let parsed: any = text;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* csv / jsonl */ }
        return { status: res.status, body: parsed, headers: res.headers };
    };

    const writeConfig = async (config: unknown) => {
        writeFileSync(configFile, JSON.stringify(config));
        const { setInstanceConfigSource, createInstanceConfigSource } = await import('@/app/instance/instanceConfig');
        setInstanceConfigSource(createInstanceConfigSource({ file: configFile }));
    };

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'model-feedback-api-test-only';
        process.env.TEST_FORWARD_TOKEN = 'fwd-secret';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        const { initEncrypt } = await import('@/modules/encrypt'); await initEncrypt();
        const { auth } = await import('@/app/auth/auth'); await auth.init();
        const { startApi } = await import('@/app/api/api');
        const { setModelFeedbackForwardFetch } = await import('./modelFeedbackStore');
        setModelFeedbackForwardFetch(async (url, init) => {
            forwarded.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
            return new Response('{}', { status: forwardStatus });
        });
        const port = await freePort();
        await startApi({ port, host: '127.0.0.1' });
        base = `http://127.0.0.1:${port}`;
        userId = (await db.account.create({ data: { publicKey: crypto.randomUUID(), firstName: 'Ada', lastName: 'L', username: 'ada' } })).id;
        adminId = (await db.account.create({ data: { publicKey: crypto.randomUUID(), username: 'owner' } })).id;
        const strangerId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        userToken = await auth.createToken(userId);
        adminToken = await auth.createToken(adminId);
        strangerToken = await auth.createToken(strangerId);
        sessionId = (await db.session.create({ data: { accountId: userId, tag: 'mf-test', metadata: '{}' } })).id;
    }, 60000);
    afterAll(async () => {
        const { setInstanceConfigSource } = await import('@/app/instance/instanceConfig');
        setInstanceConfigSource(null);
        delete process.env.TEST_FORWARD_TOKEN;
        for (const fn of shutdown.reverse()) await fn().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
    });

    const rating = (over: Record<string, unknown> = {}) => ({
        sessionId, turnId: 'turn-1', rating: 'down', comment: 'wrong file', requestIds: ['req-a', 'req-b', 'req-a'],
        model: 'custom-model', agent: 'claude', accountProfile: { id: 'acct-1', label: 'Gateway', kind: 'claude-api' }, messageSeq: 12, answeredAt: 1764200000000,
        ...over,
    });

    it('is off (404) and advertised off without a config file', async () => {
        await writeConfig({});
        expect((await call('GET', '/v1/instance/config')).body).toEqual({ modelRequestTagging: null, modelFeedback: null, modelFeedbackAdmin: false });
        expect((await call('PUT', '/v1/model-feedback', rating())).body).toEqual({ error: 'model_feedback_disabled' });
    });

    it('advertises tagging + feedback but never the forward target or its credentials', async () => {
        await writeConfig({
            admins: [adminId],
            modelRequestTagging: { sessionHeader: 'X-Session', requestHeader: 'X-Request', hosts: ['gateway.example.com'] },
            modelFeedback: { enabled: true, scope: 'tagged', forward: { url: 'https://collector.example.com/feedback', headers: { Authorization: 'Bearer ${TEST_FORWARD_TOKEN}' } } },
        });
        const cfg = await call('GET', '/v1/instance/config');
        expect(cfg.body).toEqual({
            modelRequestTagging: { sessionHeader: 'X-Session', requestHeader: 'X-Request', hosts: ['gateway.example.com'] },
            modelFeedback: { enabled: true, scope: 'tagged' },
            modelFeedbackAdmin: false,
        });
        expect(JSON.stringify(cfg.body)).not.toContain('collector');
        expect((await call('GET', '/v1/instance/config', undefined, adminToken)).body.modelFeedbackAdmin).toBe(true);
    });

    it('stores one rating per turn, replaces it on resend, and forwards each version', async () => {
        forwarded.length = 0;
        const first = await call('PUT', '/v1/model-feedback', rating());
        expect(first.status).toBe(200);
        expect(first.body.feedback).toMatchObject({ sessionId, turnId: 'turn-1', rating: 'down', comment: 'wrong file' });
        const changed = await call('PUT', '/v1/model-feedback', rating({ rating: 'up', comment: '' }));
        expect(changed.body.feedback).toMatchObject({ id: first.body.feedback.id, rating: 'up', comment: null });
        expect(await db.modelFeedback.count()).toBe(1);
        for (let i = 0; i < 40 && forwarded.length < 2; i++) await sleep(25);
        expect(forwarded.length).toBeGreaterThanOrEqual(1);
        const last = forwarded[forwarded.length - 1];
        expect(last.url).toBe('https://collector.example.com/feedback');
        expect(last.headers.Authorization).toBe('Bearer fwd-secret');
        expect(last.body).toMatchObject({ type: 'model-feedback', record: { id: first.body.feedback.id, accountId: userId, account: { username: 'ada' }, sessionId, turnId: 'turn-1', requestIds: ['req-a', 'req-b'], model: 'custom-model' } });
        for (let i = 0; i < 40; i++) {
            const row = await db.modelFeedback.findFirstOrThrow();
            if (row.forwardStatus === 'sent') break;
            await sleep(25);
        }
        expect((await db.modelFeedback.findFirstOrThrow()).forwardStatus).toBe('sent');
        expect((await call('GET', `/v1/model-feedback?sessionId=${sessionId}`)).body.items).toHaveLength(1);
    });

    it('a failed forward stays pending and the sweep retries it', async () => {
        forwardStatus = 503; forwarded.length = 0;
        await call('PUT', '/v1/model-feedback', rating({ turnId: 'turn-2' }));
        for (let i = 0; i < 40 && forwarded.length < 1; i++) await sleep(25);
        await sleep(50);
        const row = await db.modelFeedback.findFirstOrThrow({ where: { turnId: 'turn-2' } });
        expect(row).toMatchObject({ forwardStatus: 'pending', forwardAttempts: 1, forwardError: 'http 503' });
        forwardStatus = 200;
        const { forwardPendingModelFeedback } = await import('./modelFeedbackStore');
        await forwardPendingModelFeedback(Date.now() + 10 * 60_000);
        expect((await db.modelFeedback.findFirstOrThrow({ where: { turnId: 'turn-2' } })).forwardStatus).toBe('sent');
    });

    it('only accounts that can read the session may rate it', async () => {
        expect((await call('PUT', '/v1/model-feedback', rating(), strangerToken)).body).toEqual({ error: 'session_not_found' });
        expect((await call('PUT', '/v1/model-feedback', { ...rating(), rating: 'meh' })).status).toBe(400);
    });

    it('exports JSONL and CSV to admins only, with the ids gateways join on', async () => {
        expect((await call('GET', '/v1/model-feedback/export')).status).toBe(404);
        const jsonl = await call('GET', '/v1/model-feedback/export', undefined, adminToken);
        expect(jsonl.status).toBe(200);
        expect(jsonl.headers.get('content-type')).toContain('ndjson');
        const lines = String(jsonl.body).trim().split('\n').map(l => JSON.parse(l));
        expect(lines.map(l => l.turnId).sort()).toEqual(['turn-1', 'turn-2']);
        expect(lines[0]).toMatchObject({ sessionId, requestIds: ['req-a', 'req-b'], accountProfile: { id: 'acct-1' } });
        const csv = await call('GET', '/v1/model-feedback/export?format=csv&rating=up', undefined, adminToken);
        const rows = String(csv.body).trim().split('\n');
        expect(rows[0]).toContain('sessionId,turnId,requestIds');
        expect(rows).toHaveLength(2);
        expect(rows[1]).toContain('req-a req-b');
    });

    it('lets the rater take a rating back', async () => {
        expect((await call('DELETE', `/v1/model-feedback?sessionId=${sessionId}&turnId=turn-2`)).body).toEqual({ deleted: true });
        expect(await db.modelFeedback.count({ where: { turnId: 'turn-2' } })).toBe(0);
    });
});
