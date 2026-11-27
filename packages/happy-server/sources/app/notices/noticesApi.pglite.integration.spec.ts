import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/**
 * B-982 end to end through the production `startApi()` on PGlite: the route
 * is registered, reads the operator's `notices` from the instance config file,
 * and each account gets only the notices addressed to it (by id or username)
 * inside their time window. No config = an empty list.
 */

const { shutdown } = vi.hoisted(() => ({ shutdown: [] as (() => Promise<void>)[] }));
vi.mock('@/utils/shutdown', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/shutdown')>()),
    onShutdown: (_name: string, fn: () => Promise<void>) => { shutdown.push(fn); return () => undefined; },
}));

async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise(resolve => server.close(resolve));
    return port;
}

describe('notices REST through startApi (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/notices-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'api-'));
    const configFile = join(root, 'instance.json');
    let db: PrismaClient; let base: string;
    let adaId: string; let adaToken: string; let bobToken: string;

    const get = async (bearer?: string) => {
        const res = await fetch(`${base}/v1/notices`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
        return { status: res.status, body: await res.json() as any };
    };

    const writeConfig = async (config: unknown) => {
        writeFileSync(configFile, JSON.stringify(config));
        const { setInstanceConfigSource, createInstanceConfigSource } = await import('@/app/instance/instanceConfig');
        setInstanceConfigSource(createInstanceConfigSource({ file: configFile, warn: () => undefined }));
    };

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'notices-api-test-only';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        const { initEncrypt } = await import('@/modules/encrypt'); await initEncrypt();
        const { auth } = await import('@/app/auth/auth'); await auth.init();
        const { startApi } = await import('@/app/api/api');
        const port = await freePort();
        await startApi({ port, host: '127.0.0.1' });
        base = `http://127.0.0.1:${port}`;
        adaId = (await db.account.create({ data: { publicKey: crypto.randomUUID(), username: 'ada' } })).id;
        const bobId = (await db.account.create({ data: { publicKey: crypto.randomUUID(), username: 'bob' } })).id;
        adaToken = await auth.createToken(adaId);
        bobToken = await auth.createToken(bobId);
    }, 60000);
    afterAll(async () => {
        const { setInstanceConfigSource } = await import('@/app/instance/instanceConfig');
        setInstanceConfigSource(null);
        for (const fn of shutdown.reverse()) await fn().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
    });

    it('requires sign-in and is empty without notices', async () => {
        await writeConfig({});
        expect((await get()).status).toBe(401);
        expect(await get(adaToken)).toEqual({ status: 200, body: { notices: [] } });
    });

    it('serves each account only its notices, inside the time window, newest first', async () => {
        await writeConfig({
            notices: [
                { id: 'welcome', title: 'Welcome', body: 'Docs at https://docs.example.com' },
                { id: 'for-ada', title: 'Hi Ada', audience: { accounts: [adaId] }, level: 'warning', dismissible: false, startsAt: '2026-01-01T00:00:00Z' },
                { id: 'for-bob', title: 'Hi Bob', audience: { accounts: ['bob'] } },
                { id: 'expired', title: 'Old', endsAt: '2020-01-01T00:00:00Z' },
                { id: 'future', title: 'Later', startsAt: '2999-01-01T00:00:00Z' },
                { id: 'broken', title: 'x', level: 'loud' },
            ],
        });
        expect((await get(adaToken)).body).toEqual({
            notices: [
                { id: 'for-ada', title: 'Hi Ada', body: '', level: 'warning', dismissible: false, startsAt: '2026-01-01T00:00:00Z' },
                { id: 'welcome', title: 'Welcome', body: 'Docs at https://docs.example.com', level: 'info', dismissible: true },
            ],
        });
        expect((await get(bobToken)).body.notices.map((n: { id: string }) => n.id)).toEqual(['for-bob', 'welcome']);
    });
});
