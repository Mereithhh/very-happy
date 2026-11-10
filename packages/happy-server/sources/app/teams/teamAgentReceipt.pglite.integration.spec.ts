import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/**
 * B-911 through the production `startApi()` (real routes, auth, scoped team tokens) on PGlite:
 * every scoped write (`POST /v1/teams/:id/agent` — what team_* tools of every wrapper call, and what
 * ≤0.2.186 wrappers forward to the model verbatim) answers a bounded receipt with the task id,
 * while owner writes (`/actions`: Web, daemon worker, join) keep the full team.
 */
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
const RECEIPT_MAX_CHARS = 5000;

describe('B-911 scoped team writes answer a receipt (startApi, pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/agent-teams-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'receipt-'));
    let db: PrismaClient; let base: string; let token: string; let accountId: string; let machineId: string;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}` }) => {
        const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        return { status: res.status, chars: text.length, body: text ? JSON.parse(text) : null };
    };
    const newSession = async () => (await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
    const owner = async (teamId: string, requestId: string, action: Record<string, unknown>) => {
        const res = await call('POST', `/v1/teams/${teamId}/actions`, { requestId, action });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res;
    };
    const agent = async (teamId: string, scopeToken: string, requestId: string, action: Record<string, unknown>) => {
        const res = await call('POST', `/v1/teams/${teamId}/agent`, { requestId, action }, { 'x-happy-team-token': scopeToken });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.chars).toBeLessThan(RECEIPT_MAX_CHARS);
        expect(res.body).toMatchObject({ ok: true, receipt: 1, action: action.type });
        expect(res.body.team.tasks).toBeUndefined();
        expect(res.body.team.messages).toBeUndefined();
        expect(res.body.credential).toBeUndefined();
        return res;
    };

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'team-receipt-test-only';
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
        token = await auth.createToken(accountId);
        machineId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId, metadata: 'm' } });
    }, 60000);
    afterAll(async () => {
        for (const fn of shutdown.reverse()) await fn().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
    });

    it('every scoped write answers taskId + ids in < 5k chars on a large team; owner writes keep the team', async () => {
        const created = await call('POST', '/v1/teams', { name: 'Receipts', machineId });
        const teamId = created.body.team.id as string;
        const joined = await owner(teamId, 'join-lead', { type: 'join', name: 'Lead', sessionId: await newSession() });
        const lead = joined.body.credential as { botId: string; token: string };

        // A team past the incident's size (25 open tasks with long goals and messages: > 200k chars as a whole view; the bot limit is 32).
        const long = (n: number) => `Task ${n}: ${'make the board survive casual owner chat and long goals '.repeat(40)}`;
        let lastOwnerChars = 0;
        for (let i = 0; i < 25; i++) {
            const res = await owner(teamId, `seed-${i}`, { type: 'delegate', goal: long(i), acceptance: ['a'.repeat(2000), 'b'.repeat(2000)], botName: `Seed ${i}` });
            lastOwnerChars = res.chars;
            await owner(teamId, `seed-msg-${i}`, { type: 'message', taskId: res.body.taskId, body: 'x'.repeat(8000) });
        }
        // Owner route (Web / daemon) still returns the whole team.
        expect(lastOwnerChars).toBeGreaterThan(200_000);

        // delegate → the created task, its attempt and the spawn operation.
        const delegated = await agent(teamId, lead.token, 'd1', { type: 'delegate', goal: long(99), acceptance: ['done'], botName: 'Builder' });
        const taskId = delegated.body.taskId as string;
        expect(delegated.body.task).toMatchObject({ id: taskId, status: 'queued', goalVersion: 1, attempts: 1 });
        expect(delegated.body.task.goal.length).toBeLessThanOrEqual(201);
        expect(delegated.body.taskOperations).toEqual([expect.objectContaining({ type: 'spawn', status: 'pending' })]);
        expect(delegated.body.taskOperations[0].prompt).toBeUndefined();
        expect(delegated.body.team).toMatchObject({ id: teamId, name: 'Receipts' });
        expect(delegated.body.team.capacity.metrics.tasks.used).toBeGreaterThan(25);

        // Same requestId replays the same receipt (idempotent path).
        const replay = await agent(teamId, lead.token, 'd1', { type: 'delegate', goal: long(99), acceptance: ['done'], botName: 'Builder' });
        expect(replay.body.taskId).toBe(taskId);

        // Member starts: claim (owner/daemon) issues the member credential.
        const team = (await call('GET', `/v1/teams/${teamId}`)).body.team;
        const op = team.operations.find((o: { taskId: string; type: string }) => o.taskId === taskId && o.type === 'spawn');
        const claimed = await owner(teamId, 'claim', { type: 'claim-operation', operationId: op.id, machineId, teamLaunchVersion: 1 });
        const member = claimed.body.credential as { botId: string; token: string };
        const claimId = claimed.body.team.operations.find((o: { id: string }) => o.id === op.id).claimId;
        const started = await owner(teamId, 'complete', { type: 'complete-operation', operationId: op.id, machineId, claimId, sessionId: await newSession() });
        let task = started.body.team.tasks.find((t: { id: string }) => t.id === taskId);

        // message / submit / return / submit / accept: every receipt names the task (QA19 / project log #15).
        const message = await agent(teamId, lead.token, 'm1', { type: 'message', taskId, body: 'please also check mobile' });
        expect(message.body).toMatchObject({ taskId, task: { id: taskId, status: 'running' } });
        const submit = await agent(teamId, member.token, 's1', { type: 'submit', taskId, attemptId: task.currentAttemptId, goalVersion: task.goalVersion, result: 'PR #1' });
        expect(submit.body).toMatchObject({ taskId, task: { id: taskId, status: 'submitted' } });
        const returned = await agent(teamId, lead.token, 'r1', { type: 'return', taskId, attemptId: task.currentAttemptId, goalVersion: task.goalVersion, reason: 'fix tests' });
        expect(returned.body).toMatchObject({ taskId, task: { id: taskId } });
        // The receipt carries what the next write needs: the new attempt id.
        expect(returned.body.task.currentAttemptId).not.toBe(task.currentAttemptId);
        task = { ...task, currentAttemptId: returned.body.task.currentAttemptId, goalVersion: returned.body.task.goalVersion };

        await agent(teamId, member.token, 's2', { type: 'submit', taskId, attemptId: task.currentAttemptId, goalVersion: task.goalVersion, result: 'PR #1 fixed' });
        const accepted = await agent(teamId, lead.token, 'a1', { type: 'accept', taskId, attemptId: task.currentAttemptId, goalVersion: task.goalVersion });
        expect(accepted.body).toMatchObject({ taskId, task: { id: taskId, status: 'done' } });

        // cancel, then hand another task to the cancelled task's (now free) member.
        const d2 = await agent(teamId, lead.token, 'd2', { type: 'delegate', goal: 'second', acceptance: ['done'], botName: 'Second' });
        const t2 = d2.body.task;
        const d3 = await agent(teamId, lead.token, 'd3', { type: 'delegate', goal: 'third', acceptance: ['done'], botName: 'Third' });
        const t3 = d3.body.task;
        const cancel = await agent(teamId, lead.token, 'c1', { type: 'cancel', taskId: t3.id, attemptId: t3.currentAttemptId, goalVersion: t3.goalVersion, reason: 'not needed' });
        expect(cancel.body).toMatchObject({ taskId: t3.id, task: { id: t3.id, status: 'cancelled' } });
        const handoff = await agent(teamId, lead.token, 'h1', { type: 'handoff', taskId: t2.id, attemptId: t2.currentAttemptId, goalVersion: t2.goalVersion, assigneeBotId: t3.assigneeBotId });
        expect(handoff.body).toMatchObject({ taskId: t2.id, task: { id: t2.id, assigneeBotId: t3.assigneeBotId } });

        // schedule_* → the schedule id and record (no task).
        const sc = await agent(teamId, lead.token, 'sc1', { type: 'schedule-create', name: 'Ping', botId: lead.botId, body: 'y'.repeat(4000), runAt: Date.now() + 3_600_000 });
        expect(sc.body.scheduleId).toEqual(expect.any(String));
        expect(sc.body.schedule).toMatchObject({ id: sc.body.scheduleId, status: 'active', version: 1 });
        expect(sc.body.schedule.body.length).toBeLessThanOrEqual(201);
        const paused = await agent(teamId, lead.token, 'sp1', { type: 'schedule-pause', scheduleId: sc.body.scheduleId, version: 1 });
        expect(paused.body).toMatchObject({ scheduleId: sc.body.scheduleId, schedule: { status: 'paused', version: 2 } });
        await agent(teamId, lead.token, 'sr1', { type: 'schedule-resume', scheduleId: sc.body.scheduleId, version: 2 });
        await agent(teamId, lead.token, 'sx1', { type: 'schedule-cancel', scheduleId: sc.body.scheduleId, version: 3 });

        // Scoped reads are unchanged (new CLIs build their own compact view from it).
        const inspect = await call('GET', `/v1/teams/${teamId}/agent`, undefined, { 'x-happy-team-token': lead.token });
        expect(Array.isArray(inspect.body.team.tasks)).toBe(true);
    }, 120000);

    it('refusals keep their error shape', async () => {
        const created = await call('POST', '/v1/teams', { name: 'Refusals', machineId });
        const teamId = created.body.team.id as string;
        const lead = (await owner(teamId, 'join', { type: 'join', name: 'Lead', sessionId: await newSession() })).body.credential;
        const res = await call('POST', `/v1/teams/${teamId}/agent`, { requestId: 'x', action: { type: 'accept', taskId: 'missing', attemptId: 'a', goalVersion: 1 } }, { 'x-happy-team-token': lead.token });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'task_not_found' });
    });
});
