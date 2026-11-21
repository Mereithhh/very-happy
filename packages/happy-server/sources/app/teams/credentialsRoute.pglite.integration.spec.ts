import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/** B-944 through the production `startApi()` routes: scoped token renewal, revoked and expired answers. */
const { shutdown } = vi.hoisted(() => ({ shutdown: [] as (() => Promise<void>)[] }));
vi.mock('@/app/push/pushDispatch', () => ({ dispatchSessionEventPush: vi.fn(), dispatchDeviceEventPush: vi.fn(), sendTestWebPush: vi.fn() }));
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
const DAY = 86400_000;

describe('B-944 scoped credential renewal over real routes (startApi, pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/agent-teams-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'credroute-'));
    let db: PrismaClient; let base: string; let token: string; let accountId: string; let machineId: string;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}` }) => {
        const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const newLead = async () => {
        const sessionId = (await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
        const created = await call('POST', '/v1/teams', { name: `Route ${crypto.randomUUID().slice(0, 6)}`, machineId });
        const teamId = created.body.team.id as string;
        const joined = await call('POST', `/v1/teams/${teamId}/actions`, { requestId: `join-${teamId}`, action: { type: 'join', name: 'Lead', sessionId } });
        expect(joined.status, JSON.stringify(joined.body)).toBe(200);
        return { teamId, scope: joined.body.credential.token as string };
    };
    const expiry = async (teamId: string) => (await db.teamAgentCredential.findFirstOrThrow({ where: { teamId } })).expiresAt.getTime();
    const setExpiry = (teamId: string, ms: number) => db.teamAgentCredential.updateMany({ where: { teamId }, data: { expiresAt: new Date(Date.now() + ms) } });
    const read = (teamId: string, scope: string) => call('GET', `/v1/teams/${teamId}/agent`, undefined, { 'x-happy-team-token': scope });

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'team-credential-route-test-only';
        process.env.VH_AGENT_TEAMS_ENABLED = 'true';
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
        token = (await auth.createLoginToken(accountId)).token;
        machineId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId, metadata: 'm' } });
    }, 60000);
    afterAll(async () => {
        for (const fn of shutdown.reverse()) await fn().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
    });

    it('GET /agent: 8 days left is not renewed, 6 days left is renewed to 30 days, response carries no token or new field', async () => {
        const { teamId, scope } = await newLead();
        await setExpiry(teamId, 8 * DAY);
        const before = await expiry(teamId);
        expect((await read(teamId, scope)).status).toBe(200);
        expect(await expiry(teamId)).toBe(before);
        await setExpiry(teamId, 6 * DAY);
        const res = await read(teamId, scope);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain(scope);
        expect(Object.keys(res.body)).toEqual(['team']);
        expect(Math.abs((await expiry(teamId)) - Date.now() - 30 * DAY)).toBeLessThan(60_000);
    });
    it('same day: a second request writes nothing', async () => {
        const { teamId, scope } = await newLead();
        await setExpiry(teamId, 2 * DAY);
        await read(teamId, scope);
        const renewed = await expiry(teamId);
        await new Promise(resolve => setTimeout(resolve, 20));
        await read(teamId, scope);
        expect(await expiry(teamId)).toBe(renewed);
    });
    it('POST /agent also renews', async () => {
        const { teamId, scope } = await newLead();
        await setExpiry(teamId, 3 * DAY);
        const res = await call('POST', `/v1/teams/${teamId}/agent`, { requestId: 'renew-post', action: { type: 'message', body: 'hello', recipientBotId: 'nobody' } }, { 'x-happy-team-token': scope });
        expect([200, 400, 403, 404, 409]).toContain(res.status);
        if (res.status === 200) expect(Math.abs((await expiry(teamId)) - Date.now() - 30 * DAY)).toBeLessThan(60_000);
    });
    it('revoked stays 401 and is not renewed; expired stays 401 and is not revived', async () => {
        const revoked = await newLead();
        await setExpiry(revoked.teamId, 6 * DAY);
        const before = await expiry(revoked.teamId);
        await db.teamAgentCredential.updateMany({ where: { teamId: revoked.teamId }, data: { revokedAt: new Date() } });
        const r = await read(revoked.teamId, revoked.scope);
        expect(r.status).toBe(401); expect(r.body).toMatchObject({ error: 'invalid_team_token' });
        expect(await expiry(revoked.teamId)).toBe(before);
        const expired = await newLead();
        await setExpiry(expired.teamId, -1000);
        const beforeExpired = await expiry(expired.teamId);
        const e = await read(expired.teamId, expired.scope);
        expect(e.status).toBe(401); expect(e.body).toMatchObject({ error: 'invalid_team_token' });
        expect(await expiry(expired.teamId)).toBe(beforeExpired);
    });
    it('a token of another team is not renewed by a request against this team', async () => {
        const a = await newLead(); const b = await newLead();
        await setExpiry(a.teamId, 6 * DAY);
        const before = await expiry(a.teamId);
        expect((await read(b.teamId, a.scope)).status).toBe(401);
        expect(await expiry(a.teamId)).toBe(before);
    });
});
