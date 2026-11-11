import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/**
 * B-927a through the production `startApi()` on PGlite: owner-only actions need a signed-in person.
 * Pins (1) the two attacks of the B-927 repro (a machine token acting as owner on `/actions`; deactivate +
 * join taking over the Lead seat), (2) every legitimate path that must keep working, (3) the switches.
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
const REFUSED = { status: 403, body: { error: 'owner_login_required' } };

describe('B-927a owner guard (startApi, pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/agent-teams-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'owner-guard-'));
    let db: PrismaClient; let base: string; let accountId: string; let machineId: string;
    let human: string; let machine: string; let pairing: string; let otherAccountId: string; let otherHuman: string;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${human}` }) => {
        const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    const scoped = (token: string) => ({ 'x-happy-team-token': token });
    let seq = 0;
    const rid = () => `og-${++seq}`;
    const newSession = async (active = false) => (await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata', active, dataEncryptionKey: Buffer.from('k') } })).id;
    const act = (teamId: string, action: Record<string, unknown>, token = human) => call('POST', `/v1/teams/${teamId}/actions`, { requestId: rid(), action }, as(token));
    const agent = (teamId: string, action: Record<string, unknown>, scope: string) => call('POST', `/v1/teams/${teamId}/agent`, { requestId: rid(), action }, scoped(scope));
    const readTeam = async (teamId: string) => (await call('GET', `/v1/teams/${teamId}`)).body.team;
    const withEnv = async (env: Record<string, string | undefined>, work: () => Promise<void>) => {
        const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
        for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        try { await work(); } finally { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    };

    /** A team the way a Lead creates it: machine token, no launch; the Lead joins with its own session. */
    const newTeam = async () => {
        const created = await call('POST', '/v1/teams', { name: `og-${rid()}`, machineId, requestId: rid() }, as(machine));
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const teamId = created.body.team.id as string;
        const leadSession = await newSession(true);
        const joined = await act(teamId, { type: 'join', name: 'Lead', sessionId: leadSession }, machine);
        expect(joined.status, JSON.stringify(joined.body)).toBe(200);
        return { teamId, leadSession, lead: joined.body.credential as { botId: string; token: string } };
    };
    /** Lead delegates a child task; the daemon (machine) claims + completes its spawn; the member submits. */
    const submittedChild = async (teamId: string, lead: { token: string }) => {
        const d = await agent(teamId, { type: 'delegate', goal: 'child', acceptance: ['done'], botName: `m-${rid()}` }, lead.token);
        expect(d.status, JSON.stringify(d.body)).toBe(200);
        const team = await readTeam(teamId);
        const op = team.operations.find((o: any) => o.taskId === d.body.taskId && o.type === 'spawn');
        const claimed = await act(teamId, { type: 'claim-operation', operationId: op.id, machineId, teamLaunchVersion: 1 }, machine);
        expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
        const claimId = claimed.body.team.operations.find((o: any) => o.id === op.id).claimId;
        const done = await act(teamId, { type: 'complete-operation', operationId: op.id, machineId, claimId, sessionId: await newSession(true) }, machine);
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        const task = done.body.team.tasks.find((t: any) => t.id === d.body.taskId);
        const sub = await agent(teamId, { type: 'submit', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: task.goalVersion, result: 'ok' }, claimed.body.credential.token);
        expect(sub.status, JSON.stringify(sub.body)).toBe(200);
        return (await readTeam(teamId)).tasks.find((t: any) => t.id === task.id) as { id: string; status: string; currentAttemptId: string; goalVersion: number };
    };
    /** A root task (no ownerBotId): only the owner may accept it. */
    const submittedRoot = async (teamId: string) => {
        const d = await act(teamId, { type: 'delegate', goal: 'root', acceptance: ['done'], botName: `r-${rid()}` });
        expect(d.status, JSON.stringify(d.body)).toBe(200);
        const team = await readTeam(teamId);
        const op = team.operations.find((o: any) => o.taskId === d.body.taskId && o.type === 'spawn');
        const claimed = await act(teamId, { type: 'claim-operation', operationId: op.id, machineId, teamLaunchVersion: 1 }, machine);
        const claimId = claimed.body.team.operations.find((o: any) => o.id === op.id).claimId;
        const done = await act(teamId, { type: 'complete-operation', operationId: op.id, machineId, claimId, sessionId: await newSession(true) }, machine);
        const task = done.body.team.tasks.find((t: any) => t.id === d.body.taskId);
        await agent(teamId, { type: 'submit', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: task.goalVersion, result: 'ok' }, claimed.body.credential.token);
        return (await readTeam(teamId)).tasks.find((t: any) => t.id === task.id) as { id: string; status: string; currentAttemptId: string; goalVersion: number };
    };
    const decision = (t: { id: string; currentAttemptId: string; goalVersion: number }) => ({ taskId: t.id, attemptId: t.currentAttemptId, goalVersion: t.goalVersion });

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'owner-guard-test-only';
        process.env.VH_AGENT_TEAMS_ENABLED = 'true';
        process.env.VH_OWNER_BOARD_ENABLED = 'true';
        delete process.env.OWNER_GUARD_MODE; delete process.env.OWNER_GUARD_PROJECT_PERMS;
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        const { initEncrypt } = await import('@/modules/encrypt'); await initEncrypt();
        const { auth } = await import('@/app/auth/auth'); await auth.init();
        const { startApi } = await import('@/app/api/api');
        const port = await freePort();
        await startApi({ port, host: '127.0.0.1' });
        base = `http://127.0.0.1:${port}`;
        accountId = (await db.account.create({ data: { publicKey: crypto.randomUUID(), username: 'ownerguard' } })).id;
        otherAccountId = (await db.account.create({ data: { publicKey: crypto.randomUUID(), username: 'guestguard' } })).id;
        human = (await auth.createLoginToken(accountId)).token;
        otherHuman = (await auth.createLoginToken(otherAccountId)).token;
        machine = await auth.createToken(accountId);
        pairing = await auth.createToken(accountId, { session: 'pairing-og' });
        machineId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId, metadata: 'm' } });
    }, 60000);
    afterAll(async () => {
        for (const fn of shutdown.reverse()) await fn().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
    });

    describe('teams: owner actions on /actions', () => {
        it('t7 path 1: a machine token cannot accept / return / cancel / delegate as the owner (enforce is the default)', async () => {
            const { teamId, lead } = await newTeam();
            const task = await submittedRoot(teamId);
            expect(task.status).toBe('submitted');
            for (const token of [machine, pairing]) {
                expect(await act(teamId, { type: 'accept', ...decision(task) }, token)).toEqual(REFUSED);
                expect(await act(teamId, { type: 'return', ...decision(task), reason: 'redo' }, token)).toEqual(REFUSED);
                expect(await act(teamId, { type: 'cancel', ...decision(task), reason: 'x' }, token)).toEqual(REFUSED);
                expect(await act(teamId, { type: 'delegate', goal: 'g', acceptance: ['a'] }, token)).toEqual(REFUSED);
                expect(await act(teamId, { type: 'handoff', ...decision(task), assigneeBotId: lead.botId }, token)).toEqual(REFUSED);
                expect(await act(teamId, { type: 'message', taskId: task.id, body: 'hi' }, token)).toEqual(REFUSED);
                expect(await act(teamId, { type: 'set-permission-mode', permissionMode: 'bypassPermissions' }, token)).toEqual(REFUSED);
                expect(await act(teamId, { type: 'archive' }, token)).toEqual(REFUSED);
                expect(await act(teamId, { type: 'schedule-create', name: 's', botId: lead.botId, body: 'b', runAt: Date.now() + 120_000 }, token)).toEqual(REFUSED);
            }
            expect((await readTeam(teamId)).tasks.find((t: any) => t.id === task.id).status).toBe('submitted');
            // Nothing else changed the team either (start / settings / project binding).
            expect(await act(teamId, { type: 'set-defaults', defaults: {} }, machine)).toEqual(REFUSED);
            expect(await call('POST', `/v1/teams/${teamId}/project`, { projectId: null }, as(machine))).toEqual(REFUSED);
        });

        it('the Web owner (a login) accepts and returns; so does the board「等你验收」button', async () => {
            const { teamId } = await newTeam();
            const a = await submittedRoot(teamId);
            expect((await act(teamId, { type: 'accept', ...decision(a) })).status).toBe(200);
            expect((await readTeam(teamId)).tasks.find((t: any) => t.id === a.id).status).toBe('done');
            const b = await submittedRoot(teamId);
            expect((await act(teamId, { type: 'return', ...decision(b), reason: 'again' })).status).toBe(200);
            // The board button: the briefing item is answered with owner-respond (a login); the server then acts as owner internally.
            const c = await submittedRoot(teamId);
            const items = (await call('GET', '/v1/attention-items?state=all')).body.items as { id: string; key: string }[];
            const item = items.find(i => i.key === `team-submit:${c.id}`)!;
            expect(item).toBeTruthy();
            expect(await call('POST', `/v1/attention-items/${item.id}/owner-respond`, { action: 'choose', choice: 'accept' }, as(machine))).toEqual(REFUSED);
            expect((await call('POST', `/v1/attention-items/${item.id}/owner-respond`, { action: 'choose', choice: 'accept' })).status).toBe(200);
            expect((await readTeam(teamId)).tasks.find((t: any) => t.id === c.id).status).toBe('done');
            const d = await submittedRoot(teamId);
            const ret = ((await call('GET', '/v1/attention-items?state=all')).body.items as { id: string; key: string }[]).find(i => i.key === `team-submit:${d.id}`)!;
            expect((await call('POST', `/v1/attention-items/${ret.id}/owner-respond`, { action: 'choose', choice: 'return' })).status).toBe(200);
            expect((await readTeam(teamId)).tasks.find((t: any) => t.id === d.id).status).toBe('running');
        });

        it('the Lead and members keep acting through /agent (x-happy-team-token): delegate, accept, return, cancel', async () => {
            const { teamId, lead } = await newTeam();
            const t1 = await submittedChild(teamId, lead);
            expect((await agent(teamId, { type: 'return', ...decision(t1), reason: 'fix' }, lead.token)).status).toBe(200);
            const t2 = await submittedChild(teamId, lead);
            expect((await agent(teamId, { type: 'accept', ...decision(t2) }, lead.token)).status).toBe(200);
            const d = await agent(teamId, { type: 'delegate', goal: 'later', acceptance: ['a'], botName: `x-${rid()}` }, lead.token);
            const later = (await readTeam(teamId)).tasks.find((t: any) => t.id === d.body.taskId);
            expect((await agent(teamId, { type: 'cancel', ...decision(later), reason: 'no' }, lead.token)).status).toBe(200);
        });

        it('the daemon and the CLI keep their own actions on /actions with a machine token', async () => {
            const { teamId, leadSession, lead } = await newTeam();
            // claim / complete / session-event / message-delivered ran inside submittedChild; here: the rest.
            await submittedChild(teamId, lead);
            expect((await act(teamId, { type: 'session-event', sessionId: leadSession, event: 'idle' }, machine)).status).toBe(200);
            // CLI `team create` (no launch) and a join of an own session.
            expect((await call('POST', '/v1/teams', { name: 'plain', machineId, requestId: rid() }, as(pairing))).status).toBe(200);
            // CLI `teams permissions default` tightens; bypassPermissions is the owner's.
            expect((await act(teamId, { type: 'set-permission-mode', permissionMode: 'default' }, machine)).status).toBe(200);
            expect(await act(teamId, { type: 'set-permission-mode', permissionMode: 'bypassPermissions' }, machine)).toEqual(REFUSED);
            expect((await act(teamId, { type: 'set-permission-mode', permissionMode: 'bypassPermissions' })).status).toBe(200);
            // `team exit`: archive that keeps the Lead session.
            expect((await act(teamId, { type: 'archive', keepLeadSession: true }, machine)).status).toBe(200);
            // A team create with a launch starts agents on a machine: the owner's.
            const launch = { goal: 'g', directory: '/tmp/x', assistant: 'claude' };
            expect(await call('POST', '/v1/teams', { name: 'l', machineId, requestId: rid(), launch }, as(machine))).toEqual(REFUSED);
            expect((await call('POST', '/v1/teams', { name: 'l', machineId, requestId: rid(), launch })).status).toBe(200);
        });
    });

    describe('teams: Lead seat takeover (t7 path 2)', () => {
        it('deactivate + join with the Lead botId from another session is refused; a person may still do it', async () => {
            const { teamId, leadSession, lead } = await newTeam();
            const attacker = await newSession(true);
            // Even while the Lead session is active a machine is refused (a person gets the store's old_session_still_active).
            expect(await act(teamId, { type: 'join', name: 'A', sessionId: attacker, botId: lead.botId }, machine)).toEqual(REFUSED);
            expect((await act(teamId, { type: 'join', name: 'A', sessionId: attacker, botId: lead.botId })).body).toEqual({ error: 'old_session_still_active' });
            // The route that lets any account token take another session offline cannot be closed (a wrapper deactivates itself on exit);
            // the seat is what is protected.
            expect((await call('POST', `/v1/sessions/${leadSession}/deactivate`, {}, as(machine))).status).toBe(200);
            expect(await act(teamId, { type: 'join', name: 'A', sessionId: attacker, botId: lead.botId }, machine)).toEqual(REFUSED);
            expect((await readTeam(teamId)).bots.find((b: any) => b.id === lead.botId).sessionId).toBe(leadSession);
            // The Web owner (a person) can still re-seat the Lead.
            const seated = await act(teamId, { type: 'join', name: 'Lead 2', sessionId: attacker, botId: lead.botId });
            expect(seated.status, JSON.stringify(seated.body)).toBe(200);
            expect((await readTeam(teamId)).bots.find((b: any) => b.id === lead.botId).sessionId).toBe(attacker);
        });

        it('legitimate joins stay open for a machine: same session re-attach (Lead restart / lost scope), the first root of a team, a plain join', async () => {
            const { teamId, leadSession, lead } = await newTeam();
            // Lead restarts: same session id, the credential is re-issued (the CLI does this when the scope file is gone).
            const again = await act(teamId, { type: 'join', name: 'Lead', sessionId: leadSession, botId: lead.botId }, machine);
            expect(again.status, JSON.stringify(again.body)).toBe(200);
            expect(again.body.credential.botId).toBe(lead.botId);
            // Same session without a botId (Web adopt, `team_join`): finds its own seat.
            expect((await act(teamId, { type: 'join', name: 'Lead', sessionId: leadSession }, machine)).status).toBe(200);
            // Member respawn goes through the daemon's claim, not join: covered by submittedChild in the /agent test.
        });

        it('a Lead seat with no bound session (released after the root task) cannot be taken by a machine either', async () => {
            const { teamId, lead } = await newTeam();
            // The state a launched Lead is left in once its root task is accepted and its session released.
            await db.$executeRaw`UPDATE "AgentTeam" SET "state" = jsonb_set("state", '{bots}', (SELECT jsonb_agg(CASE WHEN b->>'id' = ${lead.botId} THEN jsonb_set(b, '{sessionId}', 'null'::jsonb) ELSE b END) FROM jsonb_array_elements("state"->'bots') b)) WHERE "id" = ${teamId}`;
            const seat = () => readTeam(teamId).then((t: any) => t.bots.find((b: any) => b.id === lead.botId));
            expect((await seat()).sessionId ?? null).toBeNull();
            const attacker = await newSession(true);
            expect(await act(teamId, { type: 'join', name: 'A', sessionId: attacker, botId: lead.botId }, machine)).toEqual(REFUSED);
            expect((await seat()).sessionId ?? null).toBeNull();
            // The owner (a person) can still seat it.
            expect((await act(teamId, { type: 'join', name: 'Lead 2', sessionId: attacker, botId: lead.botId })).status).toBe(200);
        });

        it('a machine cannot add a second root bot, but the first root of a team (and a person) can', async () => {
            const created = await call('POST', '/v1/teams', { name: `og-${rid()}`, machineId, requestId: rid() }, as(machine));
            const bare = created.body.team.id as string;
            expect((await act(bare, { type: 'join', name: 'First', sessionId: await newSession(true) }, machine)).status).toBe(200);
            const { teamId } = await newTeam();
            expect(await act(teamId, { type: 'join', name: 'Second', sessionId: await newSession(true) }, machine)).toEqual(REFUSED);
            expect((await readTeam(teamId)).bots.filter((b: any) => b.root)).toHaveLength(1);
            expect((await act(teamId, { type: 'join', name: 'Second', sessionId: await newSession(true) })).status).toBe(200);
        });

        it('takeover is only observed in observe mode and unchanged in off mode', async () => {
            for (const mode of ['observe', 'off']) await withEnv({ OWNER_GUARD_MODE: mode }, async () => {
                const { teamId, leadSession, lead } = await newTeam();
                const attacker = await newSession(true);
                await call('POST', `/v1/sessions/${leadSession}/deactivate`, {}, as(machine));
                const taken = await act(teamId, { type: 'join', name: 'A', sessionId: attacker, botId: lead.botId }, machine);
                expect(taken.status, mode).toBe(200);
                expect((await readTeam(teamId)).bots.find((b: any) => b.id === lead.botId).sessionId, mode).toBe(attacker);
            });
        });
    });

    describe('shares: only a person creates or accepts', () => {
        const calls = (grantId = 'g1', sid = 's1', link = 'l1', pid = 'p1') => [
            ['POST', '/v1/terminal-shares', { machineId, terminalId: 'tt', accountId: otherAccountId, role: 'viewer', expiresInDays: 1 }],
            ['POST', '/v1/terminal-shares/batch-operate', { accountId: otherAccountId, terminals: [{ machineId, terminalId: 'tt' }], expiresInDays: 1, confirmOperator: true }],
            ['PATCH', `/v1/terminal-shares/${grantId}`, { role: 'viewer' }],
            ['POST', `/v1/terminal-shares/${grantId}/respond`, { accept: true }],
            ['POST', `/v1/sessions/${sid}/shares`, { accountId: otherAccountId, role: 'viewer', expiresInDays: 1 }],
            ['PATCH', `/v1/sessions/${sid}/shares/${otherAccountId}`, { role: 'viewer' }],
            ['POST', `/v1/shares/${grantId}/accept`, undefined],
            ['POST', `/v1/shares/${grantId}/decline`, undefined],
            ['POST', `/v1/sessions/${sid}/share-links`, { scope: 'live', expiresInDays: 1 }],
            ['PATCH', `/v1/sessions/${sid}/share-links/${link}`, { snapshotToNow: true }],
            ['POST', `/v1/sessions/${sid}/share-links/${link}/rotate`, undefined],
            ['POST', `/v1/projects/${pid}/shares`, { accountId: otherAccountId, role: 'viewer', expiresInDays: 1 }],
            ['PATCH', `/v1/projects/${pid}/shares/${otherAccountId}`, { role: 'viewer' }],
            ['POST', `/v1/project-shares/${grantId}/respond`, { accept: true }],
        ] as [string, string, unknown][];

        it('every machine token gets 403 owner_login_required; a person reaches the handler (not the guard)', async () => {
            for (const token of [machine, pairing]) for (const [method, path, body] of calls()) {
                expect(await call(method, path, body, as(token)), `${method} ${path}`).toEqual(REFUSED);
            }
            for (const [method, path, body] of calls()) {
                const res = await call(method, path, body);
                expect(res.body?.error, `${method} ${path}`).not.toBe('owner_login_required');
            }
        });

        it('revoking and reading stay open to machines (they only tighten)', async () => {
            expect((await call('DELETE', '/v1/terminal-shares/nope', undefined, as(machine))).body?.error).not.toBe('owner_login_required');
            expect((await call('DELETE', `/v1/sessions/nope/shares/${otherAccountId}`, undefined, as(machine))).body?.error).not.toBe('owner_login_required');
            expect((await call('GET', '/v1/terminal-shares/incoming', undefined, as(machine))).status).toBe(200);
        });

        it('off lets a machine through as before; observe lets it through and logs', async () => {
            for (const mode of ['off', 'observe']) await withEnv({ OWNER_GUARD_MODE: mode }, async () => {
                const res = await call('POST', '/v1/terminal-shares', { machineId, terminalId: 'tt', accountId: otherAccountId, role: 'viewer', expiresInDays: 1 }, as(machine));
                expect(res.body?.error, mode).not.toBe('owner_login_required');
            });
        });
    });

    describe('projects: instructions and permission loosening', () => {
        const project = async () => (await call('POST', '/v1/projects', { name: `p-${rid()}`, requestId: rid() })).body.project.id as string;

        it('instructions are human-only', async () => {
            const id = await project();
            expect(await call('PUT', `/v1/projects/${id}/instructions`, { instructions: 'x', ifVersion: 0 }, as(machine))).toEqual(REFUSED);
            expect((await call('PUT', `/v1/projects/${id}/instructions`, { instructions: 'x', ifVersion: 0 })).status).toBe(200);
        });

        it('loosening is observe-only by default (allowed), refused with OWNER_GUARD_PROJECT_PERMS=enforce; tightening stays open', async () => {
            const id = await project();
            const loosen = { defaults: { permissionMode: 'bypassPermissions' } };
            expect((await call('PATCH', `/v1/projects/${id}`, loosen, as(machine))).status).toBe(200);
            await withEnv({ OWNER_GUARD_PROJECT_PERMS: 'enforce' }, async () => {
                expect(await call('PATCH', `/v1/projects/${id}`, loosen, as(machine))).toEqual(REFUSED);
                expect(await call('PATCH', `/v1/projects/${id}`, { defaults: { permissionMode: 'yolo' } }, as(machine))).toEqual(REFUSED);
                expect(await call('PATCH', `/v1/projects/${id}`, { folders: [{ machineId, path: '/tmp/p', primary: true }] }, as(machine))).toEqual(REFUSED);
                expect(await call('POST', '/v1/projects', { name: 'n', requestId: rid(), defaults: loosen.defaults }, as(machine))).toEqual(REFUSED);
                expect((await call('PATCH', `/v1/projects/${id}`, { defaults: { permissionMode: 'default' } }, as(machine))).status).toBe(200);
                expect((await call('PATCH', `/v1/projects/${id}`, { name: 'renamed' }, as(machine))).status).toBe(200);
                expect((await call('PATCH', `/v1/projects/${id}`, loosen)).status).toBe(200);
            });
            // The top-level switch wins: observe / off never enforce the project switch.
            await withEnv({ OWNER_GUARD_PROJECT_PERMS: 'enforce', OWNER_GUARD_MODE: 'off' }, async () => {
                expect((await call('PATCH', `/v1/projects/${id}`, loosen, as(machine))).status).toBe(200);
            });
        });
    });

    describe('projects: one request must not do what the owner-only calls refuse', () => {
        it('create with instructions, and adding sessions to a project that has instructions, are human-only', async () => {
            expect(await call('POST', '/v1/projects', { name: 'n', requestId: rid(), instructions: 'INJECTED' }, as(machine))).toEqual(REFUSED);
            expect((await call('POST', '/v1/projects', { name: 'n', requestId: rid() }, as(machine))).status).toBe(200);
            const withText = (await call('POST', '/v1/projects', { name: 'n2', requestId: rid(), instructions: 'rules' })).body.project.id as string;
            const plain = (await call('POST', '/v1/projects', { name: 'n3', requestId: rid() })).body.project.id as string;
            const sid = await newSession(true);
            expect(await call('POST', `/v1/projects/${withText}/members`, { sessionIds: [sid] }, as(machine))).toEqual(REFUSED);
            expect(await call('POST', `/v1/projects/${withText}/members`, { sessionIds: [sid], via: 'explicit' }, as(machine))).toEqual(REFUSED);
            expect((await call('POST', `/v1/projects/${withText}/members`, { sessionIds: [sid], via: 'lineage' }, as(machine))).status).toBe(200);
            expect((await call('POST', `/v1/projects/${plain}/members`, { sessionIds: [sid] }, as(machine))).status).toBe(200);
            expect((await call('POST', `/v1/projects/${withText}/members`, { sessionIds: [sid] })).status).toBe(200);
        });

        it('create with folders follows OWNER_GUARD_PROJECT_PERMS; an unknown value of it is enforce', async () => {
            const body = () => ({ name: 'f', requestId: rid(), folders: [{ machineId, path: '/tmp/p', primary: true }] });
            expect((await call('POST', '/v1/projects', body(), as(machine))).status).toBe(200);
            for (const value of ['enforce', 'enfroce']) await withEnv({ OWNER_GUARD_PROJECT_PERMS: value }, async () => {
                expect(await call('POST', '/v1/projects', body(), as(machine)), value).toEqual(REFUSED);
                expect((await call('POST', '/v1/projects', body())).status, value).toBe(200);
            });
        });
    });

    describe('switches', () => {
        it('off: the machine token acts as the owner exactly as before (t7 path 1 and 2 succeed)', async () => {
            await withEnv({ OWNER_GUARD_MODE: 'off' }, async () => {
                const { teamId } = await newTeam();
                const task = await submittedRoot(teamId);
                expect((await act(teamId, { type: 'accept', ...decision(task) }, machine)).status).toBe(200);
                const other = await submittedRoot(teamId);
                expect((await act(teamId, { type: 'return', ...decision(other), reason: 'r' }, machine)).status).toBe(200);
            });
        });

        it('observe: allowed, and the log names token kind, account and route but no token or body value', async () => {
            const logs: unknown[][] = [];
            const logModule = await import('@/utils/log');
            const spy = vi.spyOn(logModule.logger, 'info').mockImplementation(((...args: unknown[]) => { logs.push(args); }) as never);
            try {
                await withEnv({ OWNER_GUARD_MODE: 'observe' }, async () => {
                    const { teamId } = await newTeam();
                    const task = await submittedRoot(teamId);
                    expect((await act(teamId, { type: 'accept', ...decision(task) }, machine)).status).toBe(200);
                });
            } finally { spy.mockRestore(); }
            const entry = logs.map(l => l[0] as Record<string, unknown>).find(o => o?.module === 'owner-guard' && o.operation === 'teams.actions.accept');
            expect(entry).toMatchObject({ mode: 'observe', kind: 'machine', operation: 'teams.actions.accept' });
            expect(typeof entry!.accountId).toBe('string');
            const text = JSON.stringify(logs.map(l => l[0]).filter((o: any) => o?.module === 'owner-guard'));
            expect(text).not.toContain(machine);
            expect(text).not.toContain(human);
        });

        it('an unknown mode value falls back to enforce', async () => {
            await withEnv({ OWNER_GUARD_MODE: 'bogus' }, async () => {
                const { teamId } = await newTeam();
                const task = await submittedRoot(teamId);
                expect(await act(teamId, { type: 'accept', ...decision(task) }, machine)).toEqual(REFUSED);
            });
        });
    });
});
