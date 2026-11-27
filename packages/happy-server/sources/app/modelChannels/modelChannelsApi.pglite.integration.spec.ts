import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/**
 * B-981 end to end through the production `startApi()` on PGlite: the
 * instance config file lists channels, `GET /v1/model-channels` returns the
 * caller's visible ones, with the key for a machine token only.
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

describe('global model channels REST through startApi (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/model-channels-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'api-'));
    const configFile = join(root, 'instance.json');
    let db: PrismaClient; let base: string;
    let memberId: string; let machineToken: string; let webToken: string; let otherMachineToken: string;

    const get = async (bearer: string) => {
        const res = await fetch(`${base}/v1/model-channels`, { headers: { authorization: `Bearer ${bearer}` } });
        return { status: res.status, body: await res.json() as any, cache: res.headers.get('cache-control') };
    };
    const writeConfig = async (config: unknown) => {
        writeFileSync(configFile, JSON.stringify(config));
        const { setInstanceConfigSource, createInstanceConfigSource } = await import('@/app/instance/instanceConfig');
        setInstanceConfigSource(createInstanceConfigSource({ file: configFile }));
    };

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'model-channels-api-test-only';
        process.env.TEST_CHANNEL_KEY = 'sk-channel-test';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        const { initEncrypt } = await import('@/modules/encrypt'); await initEncrypt();
        const { auth } = await import('@/app/auth/auth'); await auth.init();
        const { startApi } = await import('@/app/api/api');
        const port = await freePort();
        await startApi({ port, host: '127.0.0.1' });
        base = `http://127.0.0.1:${port}`;
        memberId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        const otherId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        machineToken = await auth.createToken(memberId);
        webToken = (await auth.createLoginToken(memberId)).token;
        otherMachineToken = await auth.createToken(otherId);
    }, 60000);
    afterAll(async () => {
        const { setInstanceConfigSource } = await import('@/app/instance/instanceConfig');
        setInstanceConfigSource(null);
        delete process.env.TEST_CHANNEL_KEY;
        for (const fn of shutdown.reverse()) await fn().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
    });

    it('no config → no channels', async () => {
        await writeConfig({});
        const res = await get(machineToken);
        expect(res.status).toBe(200);
        expect(res.body.channels).toEqual([]);
        expect(typeof res.body.revision).toBe('string');
    });

    it('machine token gets its audience with the key; Web token never gets a key', async () => {
        await writeConfig({
            globalModelChannels: [
                { id: 'gw', label: 'Gateway', agent: 'claude', baseUrl: 'https://gw.example.com', apiKey: '${TEST_CHANNEL_KEY}', models: ['model-a'] },
                { id: 'off', enabled: false, label: 'Off', agent: 'claude', baseUrl: 'https://gw.example.com', apiKey: '${TEST_CHANNEL_KEY}', models: ['model-a'] },
                { id: 'mine', label: 'Mine', agent: 'codex', baseUrl: 'https://gw.example.com/v1', apiKey: '${TEST_CHANNEL_KEY}', models: ['model-c'], audience: { accounts: [memberId] } },
            ],
        });
        const machine = await get(machineToken);
        expect(machine.cache).toBe('no-store');
        expect(machine.body.channels).toEqual([
            { id: 'gw', label: 'Gateway', agent: 'claude', baseUrl: 'https://gw.example.com', models: ['model-a'], apiKey: 'sk-channel-test' },
            { id: 'mine', label: 'Mine', agent: 'codex', baseUrl: 'https://gw.example.com/v1', models: ['model-c'], apiKey: 'sk-channel-test' },
        ]);
        const web = await get(webToken);
        expect(web.body.channels.map((c: any) => c.id)).toEqual(['gw', 'mine']);
        expect(JSON.stringify(web.body)).not.toContain('sk-channel-test');
        expect((await get(otherMachineToken)).body.channels.map((c: any) => c.id)).toEqual(['gw']);
    });

    it('needs a signed-in caller', async () => {
        expect((await fetch(`${base}/v1/model-channels`)).status).toBe(401);
    });
});
