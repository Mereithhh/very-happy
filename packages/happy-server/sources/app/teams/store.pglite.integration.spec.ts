import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type * as Store from './store';

describe('agent teams persistent transactions and scoped credentials', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/agent-teams-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'db-'));
    let db: PrismaClient; let store: typeof Store; let accountId: string; let machineId: string; let sessionId: string;
    beforeAll(async () => {
        process.env.VH_AGENT_TEAMS_ENABLED = 'true';
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'team-integration-test-only';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        const { initEncrypt } = await import('@/modules/encrypt'); await initEncrypt();
        store = await import('./store');
        accountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        machineId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId, metadata: 'metadata' } });
        sessionId = (await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
    }, 60000);
    afterAll(async () => { await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });
    it('creates idempotently and rejects cross-account reads', async () => {
        const input = { name: 'T', machineId, requestId: 'create-1' };
        const t = await store.createTeam(accountId, input);
        expect((await store.createTeam(accountId, input)).id).toBe(t.id);
        await expect(store.readTeam(t.id, { accountId: 'someone-else' })).rejects.toMatchObject({ code: 'team_not_found' });
    });
    it('persists one dispatch under concurrent retries and rejects payload replacement', async () => {
        const t = await store.createTeam(accountId, { name: 'Concurrent', machineId });
        const req = { requestId: 'dispatch', action: { type: 'delegate' as const, goal: 'g', acceptance: ['a'] } };
        const results = await Promise.all([store.actOnTeam(t.id, { accountId }, req), store.actOnTeam(t.id, { accountId }, req)]);
        expect(results[0].team.tasks[0].id).toBe(results[1].team.tasks[0].id);
        expect((await store.readTeam(t.id, { accountId })).operations).toHaveLength(1);
        await expect(store.actOnTeam(t.id, { accountId }, { ...req, action: { ...req.action, goal: 'changed' } })).rejects.toMatchObject({ code: 'request_id_conflict' });
    });
    it('commits independent concurrent mutations without lost updates', async () => {
        const t = await store.createTeam(accountId, { name: 'CAS', machineId });
        await Promise.all(['a', 'b'].map(requestId => store.actOnTeam(t.id, { accountId }, { requestId, action: { type: 'delegate', goal: requestId, acceptance: ['a'] } })));
        const saved = await store.readTeam(t.id, { accountId });
        expect(saved.tasks.map(task => task.goal).sort()).toEqual(['a', 'b']); expect(saved.version).toBe(2);
    });
    it('scopes opaque credentials and preserves same-request recovery without public secrets', async () => {
        const t = await store.createTeam(accountId, { name: 'Auth', machineId });
        const req = { requestId: 'join', action: { type: 'join' as const, sessionId, name: 'root' } };
        const joined = await store.actOnTeam(t.id, { accountId }, req);
        const token = joined.credential!.token;
        expect((await store.actOnTeam(t.id, { accountId }, req)).credential!.token).toBe(token);
        expect(JSON.stringify(await store.readTeam(t.id, { accountId }))).not.toContain(token);
        expect((await store.readTeam(t.id, { token })).id).toBe(t.id);
        const other = await store.createTeam(accountId, { name: 'Other', machineId });
        await expect(store.readTeam(other.id, { token })).rejects.toMatchObject({ code: 'invalid_team_token' });
        await expect(store.actOnTeam(t.id, { token }, { requestId: 'forge', action: { type: 'join', name: 'evil', sessionId } })).rejects.toMatchObject({ code: 'owner_required' });
        await store.actOnTeam(t.id, { accountId }, { requestId: 'rebind', action: { type: 'join', name: 'root', sessionId, botId: joined.credential!.botId } });
        expect((await store.readTeam(t.id, { token })).bots[0].generation).toBe(1);
    });
    it('rejects team credentials at generic account API authentication', async () => {
        const t = await store.createTeam(accountId, { name: 'Route auth', machineId });
        const joined = await store.actOnTeam(t.id, { accountId }, { requestId: 'join', action: { type: 'join', sessionId, name: 'root' } });
        const { auth } = await import('@/app/auth/auth'); await auth.init();
        const { default: fastify } = await import('fastify');
        const { enableAuthentication } = await import('@/app/api/utils/enableAuthentication');
        const app = fastify(); enableAuthentication(app as any);
        app.get('/account-test', { preHandler: (app as any).authenticate }, async () => ({ ok: true }));
        const response = await app.inject({ method: 'GET', url: '/account-test', headers: { authorization: `Bearer ${joined.credential!.token}` } });
        expect(response.statusCode).toBe(401);
        await app.close();
    });
    it('is disabled by default and respects the account allowlist', async () => {
        delete process.env.VH_AGENT_TEAMS_ENABLED;
        await expect(store.listTeams(accountId)).rejects.toMatchObject({ code: 'teams_disabled' });
        process.env.VH_AGENT_TEAMS_ENABLED = 'true'; process.env.VH_AGENT_TEAMS_ACCOUNT_IDS = 'different-account';
        await expect(store.listTeams(accountId)).rejects.toMatchObject({ code: 'teams_disabled' });
        delete process.env.VH_AGENT_TEAMS_ACCOUNT_IDS;
    });

    it('requires the previous session to stop before rebinding a bot', async () => {
        const t = await store.createTeam(accountId, { name: 'Rebind', machineId });
        const joined = await store.actOnTeam(t.id, { accountId }, { requestId: 'join', action: { type: 'join', name: 'Root', sessionId } });
        const successor = await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata' } });
        const request = { requestId: 'rebind', action: { type: 'join' as const, name: 'Root', sessionId: successor.id, botId: joined.credential!.botId } };
        await expect(store.actOnTeam(t.id, { accountId }, request)).rejects.toMatchObject({ code: 'old_session_still_active' });
        await db.session.update({ where: { id: sessionId }, data: { active: false } });
        expect((await store.actOnTeam(t.id, { accountId }, request)).team.bots[0].sessionId).toBe(successor.id);
        await expect(store.readTeam(t.id, { token: joined.credential!.token })).rejects.toMatchObject({ code: 'invalid_team_token' });
        await db.session.update({ where: { id: sessionId }, data: { active: true } });
    });

});
