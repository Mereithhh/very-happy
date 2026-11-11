import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/**
 * Test-only: boots the production `startApi()` on PGlite (real route
 * registration, auth, hooks) for the B-872 integration specs. Callers mock
 * push dispatch and `onShutdown` (vi.mock is per file) and pass the collected
 * shutdown hooks to `stop`.
 */
export async function startIssueTestServer(name: string) {
    const parent = join(homedir(), 'code/github/skills/tmp/issue-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, `${name}-`));
    process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
    process.env.HANDY_MASTER_SECRET = 'issue-api-test-only';
    const { runMigrations } = await import('../../standalone');
    await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
    const { db } = await import('@/storage/db') as { db: PrismaClient };
    const { initEncrypt } = await import('@/modules/encrypt'); await initEncrypt();
    const { auth } = await import('@/app/auth/auth'); await auth.init();
    const { startApi } = await import('@/app/api/api');
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise(resolve => server.close(resolve));
    await startApi({ port, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${port}`;
    const accountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
    // A Web login: owner-respond requires one (B-921).
    const token = (await auth.createLoginToken(accountId)).token;

    const call = async (method: string, path: string, body?: unknown, bearer: string | null = token) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const newAccount = async () => {
        const id = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        return { id, token: (await auth.createLoginToken(id)).token };
    };
    const newMachine = async (owner = accountId) => (await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner, metadata: 'm' } })).id;
    const newSession = async (owner = accountId) => (await db.session.create({ data: { accountId: owner, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
    const stop = async (shutdown: (() => Promise<void>)[]) => {
        for (const fn of shutdown.reverse()) await fn().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
    };
    return { db, base, accountId, token, call, newAccount, newMachine, newSession, stop };
}
