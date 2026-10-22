import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // B-730: a session leads or works in one live team, so every test binds its own.
    beforeEach(async () => { sessionId = (await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata' } })).id; });
    afterAll(async () => { await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });
    it('creates idempotently and rejects cross-account reads', async () => {
        const input = { name: 'T', machineId, requestId: 'create-1' };
        const t = await store.createTeam(accountId, input);
        expect((await store.createTeam(accountId, input)).id).toBe(t.id);
        expect((await store.readTeam(t.id, { accountId })).permissionMode).toBe('bypassPermissions');
        await expect(store.readTeam(t.id, { accountId: 'someone-else' })).rejects.toMatchObject({ code: 'team_not_found' });
    });
    it('atomically creates one lead, goal, and operation and compares the full launch on retry', async () => {
        const input = { name: 'Launch', machineId, requestId: 'launch-atomic', launch: { goal: 'Build a page', directory: '/repo', assistant: 'codex' as const, model: 'gpt-5' } };
        const [first, retry] = await Promise.all([store.createTeam(accountId, input), store.createTeam(accountId, input)]);
        expect(retry).toEqual(first);
        expect(first.bots).toHaveLength(1); expect(first.tasks).toHaveLength(1); expect(first.operations).toHaveLength(1);
        expect((await store.readTeam(first.id, { accountId })).operations[0].id).toBe(first.operations[0].id);
        await expect(store.createTeam(accountId, { ...input, launch: { ...input.launch, directory: '/different' } })).rejects.toMatchObject({ code: 'request_id_conflict' });
        await expect(store.createTeam(accountId, { ...input, launch: undefined })).rejects.toMatchObject({ code: 'request_id_conflict' });
    });
    it.each(['claude', 'codex', 'pi-acp'] as const)('persists no-approval startup for %s and preserves explicit choices on retries', async assistant => {
        const input = { name: `Default ${assistant}`, machineId, requestId: `default-${assistant}`, launch: { goal: 'Check the project', directory: '/repo', assistant } };
        const team = await store.createTeam(accountId, input);
        const stored = await store.readTeam(team.id, { accountId });
        expect(stored.permissionMode).toBe('bypassPermissions');
        expect(stored.operations[0]).toMatchObject({ assistant, permissionMode: 'bypassPermissions' });
        await store.actOnTeam(team.id, { accountId }, { requestId: 'delegate-auto', action: { type: 'delegate', goal: 'Check tests', acceptance: ['Tests checked'], directory: '/repo' } });
        expect((await store.readTeam(team.id, { accountId })).operations.at(-1)?.permissionMode).toBe('bypassPermissions');
        await store.actOnTeam(team.id, { accountId }, { requestId: 'choose-approval', action: { type: 'set-permission-mode', permissionMode: 'default' } });
        const retry = await store.createTeam(accountId, input);
        expect(retry.permissionMode).toBe('default');
        expect(retry.operations.every(op => op.permissionMode === 'bypassPermissions')).toBe(true);
        await store.actOnTeam(team.id, { accountId }, { requestId: 'delegate-confirmed', action: { type: 'delegate', goal: 'Review results', acceptance: ['Results reviewed'], directory: '/repo' } });
        expect((await store.readTeam(team.id, { accountId })).operations.at(-1)?.permissionMode).toBe('default');
    });
    it('does not memoize a full member queue and permits the exact claim once capacity increases', async () => {
        const team = await store.createTeam(accountId, { name: 'Queue', machineId });
        await store.actOnTeam(team.id, { accountId }, { requestId: 'limit', action: { type: 'set-defaults', defaults: { maxParallel: 1 } } });
        for (const goal of ['first', 'second']) await store.actOnTeam(team.id, { accountId }, { requestId: goal, action: { type: 'delegate', goal, acceptance: ['a'] } });
        const state = await store.readTeam(team.id, { accountId });
        const claim = (i: number) => ({ requestId: `claim-${i}`, action: { type: 'claim-operation' as const, teamLaunchVersion: 1 as const, operationId: state.operations.find(op => op.taskId === state.tasks[i].id)!.id, machineId } });
        await store.actOnTeam(team.id, { accountId }, claim(0));
        await expect(store.actOnTeam(team.id, { accountId }, claim(1))).rejects.toMatchObject({ code: 'team_parallel_limit' });
        const memo = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM "TeamRequest" WHERE "teamId"=${team.id} AND "requestId"='claim-1'`;
        expect(Number(memo[0].count)).toBe(0);
        await store.actOnTeam(team.id, { accountId }, { requestId: 'increase', action: { type: 'set-defaults', defaults: { maxParallel: 2 } } });
        expect((await store.actOnTeam(team.id, { accountId }, claim(1))).operation?.status).toBe('claimed');
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
    it('is disabled by default; B-502: the switch is server-wide and a leftover account allowlist is ignored', async () => {
        delete process.env.VH_AGENT_TEAMS_ENABLED;
        await expect(store.listTeams(accountId)).rejects.toMatchObject({ code: 'teams_disabled' });
        process.env.VH_AGENT_TEAMS_ENABLED = 'true'; process.env.VH_AGENT_TEAMS_ACCOUNT_IDS = 'different-account';
        await expect(store.listTeams(accountId)).resolves.toBeDefined();
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
    it('keeps archived in-flight operations visible to the owning daemon', async () => {
        const team = await store.createTeam(accountId, {name:'Archive in flight', machineId});
        const delegated = await store.actOnTeam(team.id,{accountId},{requestId:'delegate',action:{type:'delegate',goal:'g',acceptance:['a']}});
        const operationId = delegated.team.operations[0].id;
        await store.actOnTeam(team.id,{accountId},{requestId:'claim',action:{type:'claim-operation',operationId,machineId,teamLaunchVersion:1}});
        await store.actOnTeam(team.id,{accountId},{requestId:'archive',action:{type:'archive'}});
        expect((await store.listTeams(accountId)).some(t => t.id === team.id)).toBe(false);
        expect((await store.listTeams(accountId,machineId)).some(t => t.id === team.id)).toBe(true);
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
        // Seed the retention boundary, then exercise the real tick/ACK transaction.
        // Replaying 70 periods here tested the same branch repeatedly and scanned every
        // earlier fixture Team; under full-suite load it timed out and leaked a clock spy.
        const retentionAccountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        const retentionMachineId = crypto.randomUUID();
        await db.machine.create({ data: { id: retentionMachineId, accountId: retentionAccountId, metadata: 'metadata' } });
        const retentionSessionId = (await db.session.create({ data: { accountId: retentionAccountId, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
        const owner = { accountId: retentionAccountId };
        const team = await store.createTeam(retentionAccountId, { name: 'Retention', machineId: retentionMachineId });
        const joined = await store.actOnTeam(team.id, owner, { requestId: 'join', action: { type: 'join', name: 'Root', sessionId: retentionSessionId } });
        const botId = joined.credential!.botId;
        await store.actOnTeam(team.id, owner, { requestId: 'normal', action: { type: 'delegate', goal: 'Normal retained', acceptance: ['a'], assigneeBotId: botId } });
        const made = await store.actOnTeam(team.id, owner, { requestId: 'schedule', action: { type: 'schedule-create', botId, name: 'Repeated', body: 'Inspect', runAt: 1, intervalMs: 60000 } });
        const scheduleId = made.scheduleId!;
        const schedules = JSON.stringify([{ ...made.team.schedules![0], fireCount: 64 }]);
        await db.$executeRaw`UPDATE "AgentTeam" SET "state"=jsonb_set("state", '{schedules}', ${schedules}::jsonb) WHERE "id"=${team.id}`;
        await db.$executeRaw`INSERT INTO "TeamMessage" ("id", "teamId", "state")
            SELECT ${scheduleId} || '-' || i, ${team.id}, jsonb_build_object('id', ${scheduleId} || '-' || i, 'taskId', null, 'scheduleId', ${scheduleId}::text, 'senderBotId', null, 'recipientBotId', ${botId}::text, 'body', 'historical reminder', 'deliveredAt', i, 'createdAt', i)
            FROM generate_series(1, 64) i`;
        expect((await store.tickTeamSchedules(retentionAccountId, retentionMachineId)).fired).toBe(1);
        const current = await store.readTeam(team.id, owner);
        const messageId = current.schedules![0].pendingMessageId!;
        expect(messageId).toBe(`${scheduleId}-65`);
        await store.actOnTeam(team.id, owner, { requestId: 'ack-boundary', action: { type: 'message-delivered', messageId, recipientBotId: botId, generation: 1, sessionId: retentionSessionId } });
        const saved = await store.readTeam(team.id, owner);
        expect(saved.schedules![0].fireCount).toBe(65);
        expect(saved.messages.filter(m => m.scheduleId)).toHaveLength(64);
        expect(saved.messages.some(m => m.id === `${scheduleId}-1`)).toBe(false);
        expect(saved.messages.some(m => !m.scheduleId && m.body.includes('Normal retained'))).toBe(true);
    });

    it('does not recreate a schedule when its idempotent receipt outlives bounded terminal history', async () => {
        const team = await store.createTeam(accountId, { name: 'Schedule history', machineId });
        const joined = await store.actOnTeam(team.id, { accountId }, { requestId: 'join', action: { type: 'join', name: 'Root', sessionId } });
        const firstRequest = { requestId: 'first-schedule', action: { type: 'schedule-create' as const, botId: joined.credential!.botId, name: 'First', body: 'Inspect', runAt: Date.now() + 60000 } };
        const made = await store.actOnTeam(team.id, { accountId }, firstRequest);
        const firstId = made.scheduleId!;
        const cancelled = await store.actOnTeam(team.id, { accountId }, { requestId: 'cancel-first', action: { type: 'schedule-cancel', scheduleId: firstId, version: 1 } });
        const first = { ...cancelled.team.schedules![0], finishedAt: 1 };
        const historical = [first, ...Array.from({ length: 63 }, (_, index) => ({ ...first, id: crypto.randomUUID(), name: `Historical ${index}`, finishedAt: index + 2 }))];
        const state = JSON.stringify(historical);
        await db.$executeRaw`UPDATE "AgentTeam" SET "state"=jsonb_set("state", '{schedules}', ${state}::jsonb) WHERE "id"=${team.id}`;
        const newest = await store.actOnTeam(team.id, { accountId }, { requestId: 'newest', action: { ...firstRequest.action, name: 'Newest' } });
        await store.actOnTeam(team.id, { accountId }, { requestId: 'cancel-newest', action: { type: 'schedule-cancel', scheduleId: newest.scheduleId!, version: 1 } });
        const retry = await store.actOnTeam(team.id, { accountId }, firstRequest);
        expect(retry.scheduleId).toBe(firstId); expect(retry.scheduleRecordRetained).toBe(false);
        expect(retry.team.schedules).toHaveLength(64); expect(retry.team.schedules!.every(s => s.status === 'cancelled')).toBe(true);
    });

    it('B-769: a member idle wakes the lead only after a long unsubmitted stretch, once under duplicate polls', async () => {
        const team = await store.createTeam(accountId, { name: 'Idle digest', machineId });
        const lead = await store.actOnTeam(team.id, { accountId }, { requestId: 'join-lead', action: { type: 'join', name: 'Lead', sessionId } });
        const memberSession = (await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
        const member = await store.actOnTeam(team.id, { accountId }, { requestId: 'join-member', action: { type: 'join', name: 'Member', sessionId: memberSession } });
        const leadToken = { token: lead.credential!.token };
        await store.actOnTeam(team.id, leadToken, { requestId: 'delegate', action: { type: 'delegate', goal: 'g', acceptance: ['a'], assigneeBotId: member.credential!.botId } });
        await store.actOnTeam(team.id, { accountId }, { requestId: 'idle', action: { type: 'session-event', sessionId: memberSession, event: 'idle' } });
        const toLead = async () => (await store.readTeam(team.id, { accountId })).messages.filter(m => m.recipientBotId === lead.credential!.botId);
        expect(await toLead()).toHaveLength(0);
        expect((await store.readTeam(team.id, leadToken)).idleMembers?.map(m => m.name)).toEqual(['Member']);
        expect((await store.tickTeamSchedules(accountId, machineId)).errors).toEqual([]);
        expect(await toLead()).toHaveLength(0);
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(Date.now() + 31 * 60_000);
            await Promise.all([store.tickTeamSchedules(accountId, machineId), store.tickTeamSchedules(accountId, machineId)]);
            await store.tickTeamSchedules(accountId, machineId);
        } finally { vi.useRealTimers(); }
        const woken = await toLead();
        expect(woken).toHaveLength(1);
        expect(woken[0]).toMatchObject({ source: 'system', deliveredAt: null });
        expect(woken[0].body).toMatch(/^Agent Member: idle for 31 min\./);
    });
    it('B-769b: a member idle 4 h before its new task is not escalated on the new attempt; 30 min of it is, once', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const H4 = 4 * 60 * 60_000; const M30 = 30 * 60_000;
            const team = await store.createTeam(accountId, { name: 'Idle reset', machineId });
            const lead = await store.actOnTeam(team.id, { accountId }, { requestId: 'join-lead', action: { type: 'join', name: 'Lead', sessionId } });
            const leadToken = { token: lead.credential!.token }; const leadId = lead.credential!.botId;
            const read = () => store.readTeam(team.id, { accountId });
            const toLead = async () => (await read()).messages.filter(m => m.recipientBotId === leadId);
            const tick = async () => { await Promise.all([store.tickTeamSchedules(accountId, machineId), store.tickTeamSchedules(accountId, machineId)]); };
            const finish = async (key: string) => {
                const t = (await read()).tasks.find(x => x.status === 'running')!;
                await store.actOnTeam(team.id, { accountId }, { requestId: `submit-${key}`, action: { type: 'submit', taskId: t.id, attemptId: t.currentAttemptId, goalVersion: 1, result: 'ok' } });
                await store.actOnTeam(team.id, leadToken, { requestId: `accept-${key}`, action: { type: 'accept', taskId: t.id, attemptId: t.currentAttemptId, goalVersion: 1 } });
            };
            const op = async (key: string, sessionId?: string) => {
                const o = (await read()).operations.find(x => x.status === 'pending')!;
                const { team: claimed } = await store.actOnTeam(team.id, { accountId }, { requestId: `claim-${key}`, action: { type: 'claim-operation', operationId: o.id, machineId, teamLaunchVersion: 1 } });
                const claimId = claimed.operations.find(x => x.id === o.id)!.claimId!;
                await store.actOnTeam(team.id, { accountId }, { requestId: `complete-${key}`, action: { type: 'complete-operation', operationId: o.id, machineId, claimId, ...(sessionId ? { sessionId } : {}) } });
            };

            // Path 1, the incident: a bound member, idle 4 h after its previous task, gets a new one.
            const qaSession = (await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
            const qa = (await store.actOnTeam(team.id, { accountId }, { requestId: 'join-qa', action: { type: 'join', name: 'QA', sessionId: qaSession } })).credential!.botId;
            await store.actOnTeam(team.id, leadToken, { requestId: 'qa-1', action: { type: 'delegate', goal: 'first', acceptance: ['a'], assigneeBotId: qa } });
            await finish('qa-1');
            await store.actOnTeam(team.id, { accountId }, { requestId: 'qa-idle', action: { type: 'session-event', sessionId: qaSession, event: 'idle' } });
            vi.setSystemTime(Date.now() + H4);
            await store.actOnTeam(team.id, leadToken, { requestId: 'qa-2', action: { type: 'delegate', goal: 'second', acceptance: ['a'], assigneeBotId: qa } });
            const before = (await toLead()).length;
            await tick();
            expect((await toLead()).length).toBe(before);
            expect((await store.readTeam(team.id, leadToken)).idleMembers).toEqual([]);
            vi.setSystemTime(Date.now() + M30 - 60_000); await tick();
            expect((await toLead()).length).toBe(before);
            vi.setSystemTime(Date.now() + 60_000); await tick(); await tick();
            const woken = (await toLead()).slice(before);
            expect(woken).toHaveLength(1);
            expect(woken[0].body).toMatch(/^Agent QA: idle for 30 min\./);
            await finish('qa-2');

            // Path 2: a managed member whose session was stopped is relaunched for its next task.
            await store.actOnTeam(team.id, leadToken, { requestId: 'w-1', action: { type: 'delegate', goal: 'first', acceptance: ['a'], botName: 'Worker', directory: '/repo' } });
            const w1 = (await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
            await op('w-1', w1);
            const worker = (await read()).bots.find(b => b.name === 'Worker')!.id;
            await finish('w-1');
            await store.actOnTeam(team.id, { accountId }, { requestId: 'w-idle', action: { type: 'session-event', sessionId: w1, event: 'idle' } });
            await op('w-stop');
            vi.setSystemTime(Date.now() + H4);
            await store.actOnTeam(team.id, leadToken, { requestId: 'w-2', action: { type: 'delegate', goal: 'second', acceptance: ['a'], assigneeBotId: worker } });
            const queued = (await toLead()).length;
            await tick();
            expect((await toLead()).length).toBe(queued);
            const w2 = (await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
            await op('w-2', w2);
            await tick();
            expect((await toLead()).length).toBe(queued);
        } finally { vi.useRealTimers(); }
    });
    it('withholds schedule messages from daemons without the delivery capability', async () => {
        const { default: fastify } = await import('fastify');
        const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
        const { teamRoutes } = await import('@/app/api/routes/teamRoutes');
        const app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        app.decorate('authenticate', async (request: any) => { request.userId = accountId; }); teamRoutes(app as any);
        const legacy = await app.inject({ method: 'GET', url: `/v1/teams/operations?machineId=${machineId}` });
        expect(legacy.statusCode).toBe(200);
        expect(legacy.json().operations.every((op: any) => !op.teamLaunchVersion)).toBe(true);
        expect(legacy.json().teams.flatMap((t: any) => t.messages).every((m: any) => !m.scheduleId)).toBe(true);
        const current = await app.inject({ method: 'GET', url: `/v1/teams/operations?machineId=${machineId}&schedulesVersion=1` });
        expect(current.statusCode).toBe(200);
        expect(current.json().teams.flatMap((t: any) => t.messages).some((m: any) => m.scheduleId)).toBe(true);
        const launchCapable = await app.inject({ method: 'GET', url: `/v1/teams/operations?machineId=${machineId}&teamLaunchVersion=1` });
        expect(launchCapable.json().operations.some((op: any) => op.teamLaunchVersion === 1)).toBe(true);
        await app.close();
    });

    it('keeps a capacity-blocked Team from stopping other Teams schedule recovery', async () => {
        const makeScheduled = async (name: string) => {
            const team = await store.createTeam(accountId, { name, machineId });
            const lead = (await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
            const joined = await store.actOnTeam(team.id, { accountId }, { requestId: 'join', action: { type: 'join', name: 'Root', sessionId: lead } });
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

    describe('B-730: a session belongs to at most one live team', () => {
        const join = (teamId: string, requestId: string, sid: string, extra: { transfer?: true } = {}) =>
            store.actOnTeam(teamId, { accountId }, { requestId, action: { type: 'join', name: 'Lead', sessionId: sid, ...extra } });
        it('refuses create and join for a session bound in another live team, naming that team and team_delegate', async () => {
            const home = await store.createTeam(accountId, { name: 'atlas-pay-ops', machineId, sessionId });
            await join(home.id, 'join-home', sessionId);
            const refusal = { code: 'session_in_other_team', status: 409, details: { teamId: home.id, teamName: 'atlas-pay-ops' } };
            await expect(store.createTeam(accountId, { name: 'atlas-pay', machineId, requestId: 'self-create', sessionId })).rejects.toMatchObject(refusal);
            // A pre-B-730 CLI sends no sessionId, only the session it inherits its project from.
            await expect(store.createTeam(accountId, { name: 'atlas-pay', machineId, requestId: 'old-cli', project: { inheritFromSessionId: sessionId } })).rejects.toMatchObject(refusal);
            const [created] = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM "AgentTeam" WHERE "accountId"=${accountId} AND "state"->>'name'='atlas-pay'`;
            expect(Number(created.count)).toBe(0);
            const other = await store.createTeam(accountId, { name: 'Other', machineId });
            const error = await join(other.id, 'join-other', sessionId).catch(e => e);
            expect(error).toMatchObject(refusal);
            expect(error.details.message).toContain('team_delegate');
            expect(error.details.message).toContain('atlas-pay-ops');
            // Nothing was recorded: the same request can be retried once the owner decides.
            const memo = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM "TeamRequest" WHERE "teamId"=${other.id} AND "requestId"='join-other'`;
            expect(Number(memo[0].count)).toBe(0);
            // Re-joining the team it already belongs to stays idempotent.
            expect((await join(home.id, 'join-home-again', sessionId)).credential?.botId).toBe(home.bots[0]?.id ?? (await store.readTeam(home.id, { accountId })).bots[0].id);
        });
        it('lets the owner transfer after confirming: old binding released, revoked and marked transferred', async () => {
            const home = await store.createTeam(accountId, { name: 'Home', machineId });
            const joined = await join(home.id, 'join-home', sessionId);
            const oldToken = joined.credential!.token;
            const next = await store.createTeam(accountId, { name: 'Next', machineId, sessionId, transfer: true });
            const moved = await join(next.id, 'join-next', sessionId, { transfer: true });
            expect(moved.team.bots.find(b => b.sessionId === sessionId)?.root).toBe(true);
            const old = (await store.readTeam(home.id, { accountId })).bots[0];
            expect(old.sessionId).toBeNull();
            expect(old.previousSessionIds).toContain(sessionId);
            expect(old.transferredTo).toMatchObject({ teamId: next.id, sessionId });
            expect(old.generation).toBe(2);
            await expect(store.readTeam(home.id, { token: oldToken })).rejects.toMatchObject({ code: 'stale_agent' });
        });
        it('never blocks on an archived team', async () => {
            const old = await store.createTeam(accountId, { name: 'Archived', machineId });
            await join(old.id, 'join-old', sessionId);
            await store.actOnTeam(old.id, { accountId }, { requestId: 'archive', action: { type: 'archive' } });
            const next = await store.createTeam(accountId, { name: 'Fresh', machineId, sessionId });
            expect((await join(next.id, 'join-fresh', sessionId)).credential?.botId).toBeTruthy();
            expect((await store.readTeam(old.id, { accountId })).bots[0].sessionId).toBe(sessionId);
        });
    });
});
