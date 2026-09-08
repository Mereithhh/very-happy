import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

    it('archives inactive teams without losing history or idempotent receipts', async () => {
        const team = await store.createTeam(accountId, { name: 'Archive', machineId });
        const archive = { requestId: 'archive', action: { type: 'archive' as const } };
        const archived = await store.actOnTeam(team.id, { accountId }, archive);
        expect(archived.team.archivedAt).toBeTypeOf('number');
        expect((await store.listTeams(accountId)).some(t => t.id === team.id)).toBe(false);
        expect((await store.listTeams(accountId, machineId)).some(t => t.id === team.id)).toBe(false);
        expect((await store.readTeam(team.id, { accountId })).archivedAt).toBe(archived.team.archivedAt);
        expect((await store.actOnTeam(team.id, { accountId }, archive)).team.archivedAt).toBe(archived.team.archivedAt);
        await expect(store.actOnTeam(team.id, { accountId }, { requestId: 'after-archive', action: { type: 'delegate', goal: 'g', acceptance: ['a'] } })).rejects.toMatchObject({ code: 'team_archived' });
    });
    it('counts only active teams toward the creation quota', async () => {
        const isolated = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        const machine = crypto.randomUUID();
        await db.machine.create({ data: { id: machine, accountId: isolated, metadata: 'metadata' } });
        const teams = [];
        for (let i = 0; i < 32; i++) teams.push(await store.createTeam(isolated, { name: `Team ${i}`, machineId: machine }));
        await expect(store.createTeam(isolated, { name: 'Over quota', machineId: machine })).rejects.toMatchObject({ code: 'team_limit' });
        await store.actOnTeam(teams[0].id, { accountId: isolated }, { requestId: 'archive', action: { type: 'archive' } });
        expect((await store.createTeam(isolated, { name: 'Replacement', machineId: machine })).id).toBeTruthy();
    });

    it('returns the stable delegated task id after later unrelated changes', async () => {
        const team = await store.createTeam(accountId, { name: 'Task receipt', machineId });
        const request = { requestId: 'delegation', action: { type: 'delegate' as const, goal: 'first', acceptance: ['a'] } };
        const first = await store.actOnTeam(team.id, { accountId }, request);
        await store.actOnTeam(team.id, { accountId }, { requestId: 'other', action: { type: 'delegate', goal: 'second', acceptance: ['a'] } });
        const retry = await store.actOnTeam(team.id, { accountId }, request);
        expect(first.taskId).toBe(first.team.tasks[0].id); expect(retry.taskId).toBe(first.taskId); expect(retry.team.tasks).toHaveLength(2);
    });
    it('advances schedules atomically under duplicate polls and keeps machine/account isolation', async () => {
        const team = await store.createTeam(accountId, { name: 'Schedules', machineId });
        const joined = await store.actOnTeam(team.id, { accountId }, { requestId: 'join', action: { type: 'join', name: 'Root', sessionId } });
        const request = { requestId: 'schedule', action: { type: 'schedule-create' as const, botId: joined.credential!.botId, name: 'Once', body: 'Inspect', runAt: Date.now() - 1000 } };
        const made = await store.actOnTeam(team.id, { token: joined.credential!.token }, request);
        expect((await store.actOnTeam(team.id, { token: joined.credential!.token }, request)).scheduleId).toBe(made.scheduleId);
        const polls = await Promise.all([store.tickTeamSchedules(accountId, machineId), store.tickTeamSchedules(accountId, machineId)]);
        expect(polls.reduce((sum, p) => sum + p.fired, 0)).toBe(1);
        const saved = await store.readTeam(team.id, { accountId }); expect(saved.messages).toHaveLength(1); expect(saved.schedules![0].fireCount).toBe(1);
        expect((await store.tickTeamSchedules(accountId, machineId)).fired).toBe(0);
        await expect(store.tickTeamSchedules('other-account', machineId)).rejects.toMatchObject({ code: 'machine_not_found' });
        const otherMachine = crypto.randomUUID(); await db.machine.create({ data: { id: otherMachine, accountId, metadata: 'metadata' } });
        expect((await store.tickTeamSchedules(accountId, otherMachine)).fired).toBe(0);
    });
    it('bounds persisted schedule history without pruning ordinary task messages', async () => {
        const team = await store.createTeam(accountId, { name: 'Retention', machineId });
        const joined = await store.actOnTeam(team.id, { accountId }, { requestId: 'join', action: { type: 'join', name: 'Root', sessionId } });
        const botId = joined.credential!.botId;
        await store.actOnTeam(team.id, { accountId }, { requestId: 'normal', action: { type: 'delegate', goal: 'Normal retained', acceptance: ['a'], assigneeBotId: botId } });
        const base = Date.now();
        await store.actOnTeam(team.id, { accountId }, { requestId: 'schedule', action: { type: 'schedule-create', botId, name: 'Repeated', body: 'Inspect', runAt: base, intervalMs: 60000 } });
        const clock = vi.spyOn(Date, 'now');
        try {
            for (let i = 0; i < 70; i++) {
                clock.mockReturnValue(base + i * 60000);
                await store.tickTeamSchedules(accountId, machineId);
                const current = await store.readTeam(team.id, { accountId });
                const messageId = current.schedules![0].pendingMessageId!;
                await store.actOnTeam(team.id, { accountId }, { requestId: `ack-${i}`, action: { type: 'message-delivered', messageId, recipientBotId: botId, generation: 1, sessionId } });
            }
        } finally { clock.mockRestore(); }
        const saved = await store.readTeam(team.id, { accountId });
        expect(saved.schedules![0].fireCount).toBe(70);
        expect(saved.messages.filter(m => m.scheduleId).length).toBeLessThanOrEqual(64);
        expect(saved.messages.some(m => !m.scheduleId && m.body.includes('Normal retained'))).toBe(true);
    });

    it('does not recreate a schedule when its idempotent receipt outlives bounded terminal history', async () => {
        const team = await store.createTeam(accountId, { name: 'Schedule history', machineId });
        const joined = await store.actOnTeam(team.id, { accountId }, { requestId: 'join', action: { type: 'join', name: 'Root', sessionId } });
        const firstRequest = { requestId: 'first-schedule', action: { type: 'schedule-create' as const, botId: joined.credential!.botId, name: 'First', body: 'Inspect', runAt: Date.now() + 60000 } };
        const base = Date.now(); const clock = vi.spyOn(Date, 'now'); let firstId: string | undefined;
        try {
            for (let i = 0; i < 66; i++) {
                clock.mockReturnValue(base + i);
                const request = i === 0 ? firstRequest : { requestId: `schedule-${i}`, action: { ...firstRequest.action, name: `Schedule ${i}` } };
                const made = await store.actOnTeam(team.id, { accountId }, request);
                firstId ??= made.scheduleId;
                await store.actOnTeam(team.id, { accountId }, { requestId: `cancel-schedule-${i}`, action: { type: 'schedule-cancel', scheduleId: made.scheduleId!, version: 1 } });
            }
        } finally { clock.mockRestore(); }
        const retry = await store.actOnTeam(team.id, { accountId }, firstRequest);
        expect(retry.scheduleId).toBe(firstId); expect(retry.scheduleRecordRetained).toBe(false);
        expect(retry.team.schedules).toHaveLength(64); expect(retry.team.schedules!.every(s => s.status === 'cancelled')).toBe(true);
    });

    it('withholds schedule messages from daemons without the delivery capability', async () => {
        const { default: fastify } = await import('fastify');
        const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
        const { teamRoutes } = await import('@/app/api/routes/teamRoutes');
        const app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        app.decorate('authenticate', async (request: any) => { request.userId = accountId; }); teamRoutes(app as any);
        const legacy = await app.inject({ method: 'GET', url: `/v1/teams/operations?machineId=${machineId}` });
        expect(legacy.statusCode).toBe(200);
        expect(legacy.json().teams.flatMap((t: any) => t.messages).every((m: any) => !m.scheduleId)).toBe(true);
        const current = await app.inject({ method: 'GET', url: `/v1/teams/operations?machineId=${machineId}&schedulesVersion=1` });
        expect(current.statusCode).toBe(200);
        expect(current.json().teams.flatMap((t: any) => t.messages).some((m: any) => m.scheduleId)).toBe(true);
        await app.close();
    });

    it('keeps a capacity-blocked Team from stopping other Teams schedule recovery', async () => {
        const makeScheduled = async (name: string) => {
            const team = await store.createTeam(accountId, { name, machineId });
            const joined = await store.actOnTeam(team.id, { accountId }, { requestId: 'join', action: { type: 'join', name: 'Root', sessionId } });
            await store.actOnTeam(team.id, { accountId }, { requestId: 'schedule', action: { type: 'schedule-create', name: 'Due', botId: joined.credential!.botId, body: 'Inspect', runAt: 1 } });
            return team;
        };
        const full = await makeScheduled('At message capacity');
        await db.$executeRaw`INSERT INTO "TeamMessage" ("id", "teamId", "state")
            SELECT ${full.id} || '-' || i, ${full.id}, jsonb_build_object('id', ${full.id} || '-' || i, 'taskId', 'retained-task', 'senderBotId', null, 'recipientBotId', 'unused', 'body', 'retained', 'deliveredAt', null, 'createdAt', 1)
            FROM generate_series(1, 2000) i`;
        const healthy = await makeScheduled('Healthy after capacity failure');
        const outcome = await store.tickTeamSchedules(accountId, machineId);
        expect(outcome.errors).toContainEqual({ teamId: full.id, error: 'team_message_limit' });
        expect((await store.readTeam(healthy.id, { accountId })).messages).toHaveLength(1);
        expect((await store.readTeam(full.id, { accountId })).schedules![0].fireCount).toBe(0);
    });

});
