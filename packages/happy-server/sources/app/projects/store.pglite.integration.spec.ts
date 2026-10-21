import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type * as Store from './store';
import type * as Automations from '@/app/automations/store';
import type * as Teams from '@/app/teams/store';

describe('projects store (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/projects-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'db-'));
    let db: PrismaClient; let store: typeof Store; let automations: typeof Automations; let teams: typeof Teams;
    let accountId: string; let otherAccountId: string; let machineId: string; let otherMachineId: string;
    const newSession = async (owner = accountId) => (await db.session.create({ data: { accountId: owner, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
    const newProject = (name = `p-${crypto.randomUUID().slice(0, 6)}`, extra: Partial<Parameters<typeof Store.createProject>[1]> = {}) =>
        store.createProject(accountId, { name, folders: [{ machineId, path: '/repo' }], ...extra });

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'projects-integration-test-only';
        process.env.VH_AUTOMATIONS_ENABLED = 'true'; process.env.VH_AGENT_TEAMS_ENABLED = 'true';
        delete process.env.VH_PROJECTS_ENABLED;
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        store = await import('./store');
        automations = await import('@/app/automations/store');
        teams = await import('@/app/teams/store');
        accountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        otherAccountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        machineId = crypto.randomUUID(); otherMachineId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId, metadata: 'm' } });
        await db.machine.create({ data: { id: otherMachineId, accountId, metadata: 'm' } });
    }, 60000);
    afterAll(async () => { await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });

    it('kill switch answers the same 404 an older server gives', async () => {
        process.env.VH_PROJECTS_ENABLED = 'false';
        try { await expect(store.listProjects(accountId)).rejects.toMatchObject({ code: 'projects_disabled', status: 404 }); }
        finally { delete process.env.VH_PROJECTS_ENABLED; }
    });

    it('creates idempotently by requestId, normalizes folders to one primary, rejects foreign machines', async () => {
        const a = await store.createProject(accountId, { name: 'very-happy', requestId: 'req-1', folders: [{ machineId, path: '/repo/' }, { machineId, path: '/repo' }, { machineId: otherMachineId, path: '/b', primary: true }] });
        const b = await store.createProject(accountId, { name: 'ignored', requestId: 'req-1' });
        expect(b.id).toBe(a.id);
        expect(a.folders).toEqual([{ machineId, path: '/repo', primary: false }, { machineId: otherMachineId, path: '/b', primary: true }]);
        const foreignMachine = crypto.randomUUID();
        await db.machine.create({ data: { id: foreignMachine, accountId: otherAccountId, metadata: 'm' } });
        await expect(store.createProject(accountId, { name: 'x', folders: [{ machineId: foreignMachine, path: '/x' }] })).rejects.toMatchObject({ code: 'invalid_folders', status: 400 });
        const listed = await store.listProjects(accountId);
        expect(listed.projects.map(p => p.id)).toContain(a.id);
        const archived = await store.updateProject(accountId, a.id, { archived: true });
        expect(archived.archivedAt).not.toBeNull();
        expect((await store.listProjects(accountId)).projects.map(p => p.id)).not.toContain(a.id);
        expect((await store.listProjects(accountId, { includeArchived: true })).projects.map(p => p.id)).toContain(a.id);
        // Another account cannot see or touch it.
        await expect(store.getProject(otherAccountId, a.id)).rejects.toMatchObject({ code: 'project_not_found', status: 404 });
    });

    it('instructions are CAS-written: a stale ifVersion gets 409 with the latest project, history keeps every version', async () => {
        const p = await newProject();
        expect(p.instructionsVersion).toBe(0);
        const v1 = await store.putInstructions(accountId, p.id, { instructions: 'rule one', ifVersion: 0 });
        expect(v1.instructionsVersion).toBe(1);
        const conflict = await store.putInstructions(accountId, p.id, { instructions: 'stale', ifVersion: 0 }).catch(e => e);
        expect(conflict).toMatchObject({ code: 'instructions_version_conflict', status: 409 });
        expect(conflict.details.project).toMatchObject({ instructions: 'rule one', instructionsVersion: 1 });
        await store.putInstructions(accountId, p.id, { instructions: 'rule two', ifVersion: 1, summary: 'tighten' });
        const history = await store.listInstructionRevisions(accountId, p.id);
        expect(history.map(h => [h.version, h.instructions])).toEqual([[2, 'rule two'], [1, 'rule one']]);
        // Concurrent writers with the same base: exactly one wins.
        const results = await Promise.allSettled([1, 2, 3].map(n => store.putInstructions(accountId, p.id, { instructions: `race ${n}`, ifVersion: 2 })));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect((await store.getProject(accountId, p.id)).project.instructionsVersion).toBe(3);
    });

    it("only this account's sessions can join; joining another project moves the session", async () => {
        const p1 = await newProject(); const p2 = await newProject();
        const mine = await newSession();
        const theirs = await newSession(otherAccountId);
        await expect(store.addMembers(accountId, p1.id, { sessionIds: [mine, theirs] })).rejects.toMatchObject({ code: 'session_not_found', status: 404, details: { sessionIds: [theirs] } });
        expect((await store.getProject(accountId, p1.id)).members).toEqual([]);
        // A session shared TO this account is still someone else's row.
        await expect(store.addMembers(otherAccountId, p1.id, { sessionIds: [theirs] })).rejects.toMatchObject({ code: 'project_not_found' });
        await store.addMembers(accountId, p1.id, { sessionIds: [mine] });
        await store.putPresence(accountId, { machineId, sessions: [{ sessionId: mine, title: 'a' }] });
        await store.addMembers(accountId, p2.id, { sessionIds: [mine] });
        expect((await store.getProject(accountId, p1.id)).members).toEqual([]);
        expect((await store.getProject(accountId, p1.id)).presence).toEqual([]);
        expect((await store.getProject(accountId, p2.id)).members.map(m => m.sessionId)).toEqual([mine]);
        expect(await store.removeMember(accountId, p2.id, mine)).toEqual({ removed: true });
        expect(await store.sessionMembership(accountId, mine)).toEqual({ projectId: null, via: null });
    });

    it('attach-team checks the team machine, snapshots only unset defaults, derives bot members; explicit membership wins', async () => {
        const p = await newProject('teamed', { defaults: { agent: 'codex', model: 'gpt-x' } });
        const bot = await newSession(); const explicitElsewhere = await newSession();
        const teamId = crypto.randomUUID();
        const state = { id: teamId, name: 'B-640 重构', machineId, version: 0, defaults: { model: 'team-own-model' }, bots: [{ id: 'b1', sessionId: bot }, { id: 'b2', sessionId: explicitElsewhere }, { id: 'b3', sessionId: null }], tasks: [], createdAt: Date.now() };
        await db.agentTeam.create({ data: { id: teamId, accountId, machineId: otherMachineId, state } });
        await expect(store.attachTeam(accountId, p.id, teamId)).rejects.toMatchObject({ code: 'team_machine_not_in_project', status: 400 });
        await db.agentTeam.update({ where: { id: teamId }, data: { machineId } });
        await expect(store.attachTeam(otherAccountId, p.id, teamId)).rejects.toMatchObject({ code: 'project_not_found' });
        const other = await newProject();
        await store.addMembers(accountId, other.id, { sessionIds: [explicitElsewhere] });
        await store.attachTeam(accountId, p.id, teamId);
        const row = await db.agentTeam.findUniqueOrThrow({ where: { id: teamId } });
        expect(row.projectId).toBe(p.id);
        expect((row.state as any).defaults).toEqual({ model: 'team-own-model', assistant: 'codex' });
        expect(row.version).toBe(1);
        const detail = await store.getProject(accountId, p.id);
        expect(detail.project.teamIds).toEqual([teamId]);
        expect(detail.members).toEqual([expect.objectContaining({ sessionId: bot, via: 'team', teamId })]);
        expect(await store.sessionMembership(accountId, bot)).toEqual({ projectId: p.id, via: 'team' });
        expect(await store.sessionMembership(accountId, explicitElsewhere)).toEqual({ projectId: other.id, via: 'explicit' });
        const listed = await store.listProjects(accountId);
        expect(listed.members.filter(m => m.sessionId === explicitElsewhere)).toHaveLength(1);
        expect((await store.sessionContext(accountId, bot, { peek: true })).team).toEqual({ id: teamId, name: 'B-640 重构', lead: false });
        expect(await store.detachTeam(accountId, p.id, teamId)).toEqual({ detached: true });
        expect(await store.sessionMembership(accountId, bot)).toEqual({ projectId: null, via: null });
    });

    it('agent notes: members only, ≤5/hour with ≤2 decisions and an actionable refusal; user notes unbudgeted; revoke own only', async () => {
        const p = await newProject();
        const s = await newSession(); const outsider = await newSession();
        await store.addMembers(accountId, p.id, { sessionIds: [s] });
        await expect(store.createLogEntry(accountId, p.id, { kind: 'finding', title: 'x', authorSessionId: outsider })).rejects.toMatchObject({ code: 'not_a_project_member', status: 409 });
        const d1 = await store.createLogEntry(accountId, p.id, { kind: 'decision', title: 'use pnpm', authorSessionId: s });
        await store.createLogEntry(accountId, p.id, { kind: 'decision', title: 'no zod default', authorSessionId: s });
        const third = await store.createLogEntry(accountId, p.id, { kind: 'decision', title: 'one more', authorSessionId: s }).catch(e => e);
        expect(third).toMatchObject({ code: 'project_note_quota_exceeded', status: 429, details: { limit: 2, count: 2 } });
        expect(third.details.suggestion).toMatch(/finding|supersede/);
        await store.createLogEntry(accountId, p.id, { kind: 'finding', title: 'f1', authorSessionId: s });
        await store.createLogEntry(accountId, p.id, { kind: 'finding', title: 'f2', authorSessionId: s });
        await store.createLogEntry(accountId, p.id, { kind: 'handoff', title: 'h1', authorSessionId: s });
        await expect(store.createLogEntry(accountId, p.id, { kind: 'handoff', title: 'h2', authorSessionId: s })).rejects.toMatchObject({ code: 'project_note_quota_exceeded', details: { limit: 5 } });
        for (let i = 0; i < 7; i++) await store.createLogEntry(accountId, p.id, { kind: 'decision', title: `user ${i}` });
        // Supersede by #seq; superseded decision drops out of "in effect".
        const replacement = await store.createLogEntry(accountId, p.id, { kind: 'decision', title: 'use pnpm 10', supersedes: `#${d1.seq}` });
        expect(replacement.supersedes).toBe(d1.id);
        const log = await store.listLog(accountId, p.id);
        expect(log.find(e => e.id === d1.id)?.supersededBy).toBe(replacement.id);
        expect(new Set(log.map(e => e.seq)).size).toBe(log.length);
        const other = await newSession();
        await store.addMembers(accountId, p.id, { sessionIds: [other] });
        await expect(store.revokeLogEntry(accountId, p.id, d1.id, other)).rejects.toMatchObject({ code: 'log_entry_not_owned', status: 409 });
        const revoked = await store.revokeLogEntry(accountId, p.id, String(d1.seq), s);
        expect(revoked.revokedAt).not.toBeNull();
        expect((await store.revokeLogEntry(accountId, p.id, d1.id)).revokedAt).toBe(revoked.revokedAt);
        const ctx = await store.sessionContext(accountId, other, { peek: true });
        expect(ctx.decisions.map(d => d.title)).not.toContain('use pnpm');
        expect(ctx.decisions.map(d => d.title)).toContain('use pnpm 10');
    });

    it('presence has its own bucket: a spent session_state budget never blocks it, and its own limit answers a named 429', async () => {
        const p = await newProject();
        const s = await newSession(); const loose = await newSession(); const foreign = await newSession(otherAccountId);
        await store.addMembers(accountId, p.id, { sessionIds: [s] });
        // Exhaust the session_state write bucket for this account.
        await db.authRateLimitBucket.create({ data: { key: `resource-write:session_state:${accountId}`, count: 1_000_000, resetAt: new Date(Date.now() + 60_000) } });
        const res = await store.putPresence(accountId, { machineId, sessions: [
            { sessionId: s, title: 'fix sidebar', agent: 'claude', state: 'running', doing: 'writing tests', capabilities: ['project-v1'], injectedInstructionsVersion: 0 },
            { sessionId: loose, title: 'not in a project' },
            { sessionId: foreign, title: 'not mine' },
        ] });
        expect(res.memberships).toEqual({ [s]: p.id });
        const detail = await store.getProject(accountId, p.id);
        expect(detail.presence).toEqual([expect.objectContaining({ sessionId: s, doing: 'writing tests', capabilities: ['project-v1'], machineId })]);
        expect(detail.members[0].machineId).toBe(machineId);
        expect(await db.projectPresence.count({ where: { sessionId: { in: [loose, foreign] } } })).toBe(0);
        const bucketKeys = (await db.authRateLimitBucket.findMany({ where: { key: { contains: accountId } } })).map(b => b.key);
        expect(bucketKeys).toContain(`resource-write:project_presence:${accountId}`);
        // A coarse daemon write keeps the wrapper's richer fields.
        await store.putPresence(accountId, { machineId, sessions: [{ sessionId: s, state: 'idle' }] });
        expect((await store.getProject(accountId, p.id)).presence[0]).toMatchObject({ state: 'idle', doing: 'writing tests', title: 'fix sidebar', capabilities: ['project-v1'] });
        await store.putPresence(accountId, { machineId, sessions: [], gone: [s] });
        expect((await store.getProject(accountId, p.id)).presence[0].state).toBe('offline');
        process.env.MAX_PROJECT_PRESENCE_WRITES_PER_ACCOUNT_PER_MINUTE = '1';
        try {
            await expect(store.putPresence(accountId, { machineId, sessions: [] })).rejects.toMatchObject({ code: 'project_presence_rate_quota_exceeded', status: 429 });
        } finally { delete process.env.MAX_PROJECT_PRESENCE_WRITES_PER_ACCOUNT_PER_MINUTE; await db.authRateLimitBucket.deleteMany({ where: { key: { contains: accountId } } }); }
    });

    it('offline messages: both ends must be members; delivery is idempotent; bodies erased 7 days after delivery', async () => {
        const p = await newProject();
        const a = await newSession(); const b = await newSession(); const outsider = await newSession();
        await store.addMembers(accountId, p.id, { sessionIds: [a, b] });
        await expect(store.createMessage(accountId, p.id, { fromSessionId: a, toSessionId: outsider, body: 'hi' })).rejects.toMatchObject({ code: 'not_a_project_member' });
        const m = await store.createMessage(accountId, p.id, { fromSessionId: a, toSessionId: b, body: 'I changed the schema' });
        expect((await store.listUndelivered(accountId, b)).map(x => x.id)).toEqual([m.id]);
        expect((await store.sessionContext(accountId, b, { peek: true })).unread).toEqual([expect.objectContaining({ id: m.id, body: 'I changed the schema' })]);
        expect(await store.markDelivered(accountId, b, [m.id])).toEqual({ delivered: 1 });
        expect(await store.markDelivered(accountId, b, [m.id])).toEqual({ delivered: 0 });
        expect(await store.listUndelivered(accountId, b)).toEqual([]);
        await db.projectMessage.update({ where: { id: m.id }, data: { deliveredAt: new Date(Date.now() - 8 * 86400_000) } });
        await store.createMessage(accountId, p.id, { fromSessionId: b, toSessionId: a, body: 'ack' });
        const erased = await db.projectMessage.findUniqueOrThrow({ where: { id: m.id } });
        expect(erased.body).toBeNull();
        expect(erased.fromSessionId).toBe(a);
    });

    it('context moves the read cursor unless peek; digest reports only changes since the cursor; archived → no project', async () => {
        const p = await newProject('ctx');
        const me = await newSession(); const peer = await newSession();
        await store.addMembers(accountId, p.id, { sessionIds: [me, peer] });
        await store.putInstructions(accountId, p.id, { instructions: 'Be careful', ifVersion: 0 });
        await store.putPresence(accountId, { machineId, sessions: [{ sessionId: me, title: 'me' }, { sessionId: peer, title: 'peer', doing: 'refactor' }] });
        const peek = await store.sessionContext(accountId, me, { peek: true });
        expect(peek.previousReadAt).toBe(0);
        expect(peek.project).toMatchObject({ name: 'ctx', instructions: 'Be careful', instructionsVersion: 1 });
        expect(peek.sessions.map(s => s.sessionId)).toEqual([peer]);
        const first = await store.sessionContext(accountId, me);
        expect(first.previousReadAt).toBe(0);
        const second = await store.sessionContext(accountId, me);
        expect(second.previousReadAt).toBe(first.asOf);
        expect(second.log).toEqual([]);
        const quiet = await store.sessionDigest(accountId, me, second.asOf);
        expect(quiet).toMatchObject({ instructions: null, decisions: [], revoked: [], messages: [] });
        await new Promise(r => setTimeout(r, 5));
        await store.putInstructions(accountId, p.id, { instructions: 'Be careful v2', ifVersion: 1, summary: 'add rule' });
        await store.createLogEntry(accountId, p.id, { kind: 'decision', title: 'ship server first' });
        await store.createMessage(accountId, p.id, { fromSessionId: peer, toSessionId: me, body: 'heads up' });
        const digest = await store.sessionDigest(accountId, me, second.asOf);
        expect(digest.instructions).toEqual({ version: 2, summary: 'add rule' });
        expect(digest.decisions.map(d => d.title)).toEqual(['ship server first']);
        expect(digest.messages.map(m => m.body)).toEqual(['heads up']);
        await store.updateProject(accountId, p.id, { archived: true });
        expect((await store.sessionContext(accountId, me)).project).toBeNull();
        expect((await store.sessionDigest(accountId, me, 0)).projectId).toBeNull();
    });

    it('B-646: an instructions update, a decision or an offline message never writes into a session (never wakes one)', async () => {
        const p = await newProject();
        const idle = [await newSession(), await newSession(), await newSession()];
        await store.addMembers(accountId, p.id, { sessionIds: idle });
        const before = await db.sessionMessage.count({ where: { sessionId: { in: idle } } });
        const seqBefore = (await db.session.findMany({ where: { id: { in: idle } }, select: { seq: true } })).map(r => r.seq);
        await store.putInstructions(accountId, p.id, { instructions: 'new rule', ifVersion: 0 });
        await store.createLogEntry(accountId, p.id, { kind: 'decision', title: 'd' });
        await store.createMessage(accountId, p.id, { fromSessionId: idle[0], toSessionId: idle[1], body: 'later' });
        expect(await db.sessionMessage.count({ where: { sessionId: { in: idle } } })).toBe(before);
        expect((await db.session.findMany({ where: { id: { in: idle } }, select: { seq: true } })).map(r => r.seq)).toEqual(seqBefore);
        // …and each of them sees the change in its next-turn digest instead.
        for (const s of idle) expect((await store.sessionDigest(accountId, s, 0)).instructions?.version).toBe(1);
    });

    it('automations carry an optional projectId of the same account only', async () => {
        const p = await newProject();
        const action = { kind: 'spawn' as const, agent: 'claude', directory: '/repo', prompt: 'x' };
        const created = await automations.createAutomation(accountId, { name: `a-${crypto.randomUUID().slice(0, 6)}`, machineId, trigger: { kind: 'manual' }, action, projectId: p.id });
        expect(created.projectId).toBe(p.id);
        expect((await store.getProject(accountId, p.id)).project.automationIds).toEqual([created.id]);
        const detached = await automations.updateAutomation(accountId, created.id, { version: created.version, projectId: null });
        expect(detached.projectId).toBeNull();
        const foreign = (await db.project.create({ data: { id: crypto.randomUUID(), accountId: otherAccountId, name: 'theirs' } })).id;
        await expect(automations.createAutomation(accountId, { name: `b-${crypto.randomUUID().slice(0, 6)}`, machineId, trigger: { kind: 'manual' }, action, projectId: foreign })).rejects.toMatchObject({ code: 'project_not_found', status: 404 });
        // Deleting the project detaches (SET NULL), never deletes, the automation.
        await automations.updateAutomation(accountId, created.id, { version: detached.version, projectId: p.id });
        await store.deleteProject(accountId, p.id);
        expect((await automations.getAutomation(accountId, created.id)).projectId).toBeNull();
    });

    describe('B-726 team ↔ project', () => {
        const launch = (directory: string) => ({ goal: 'ship it', directory, assistant: 'claude' as const });
        const stateOf = async (teamId: string) => (await db.agentTeam.findUniqueOrThrow({ where: { id: teamId } }));

        it('a new team with project.create gets a same-name project at its launch folder; a retried create makes no second project', async () => {
            const input = { name: 'Team Alpha', machineId, requestId: 'tp-1', launch: launch('/work/alpha'), project: { create: true } };
            const team = await teams.createTeam(accountId, input);
            expect(team.projectId).toBeTruthy();
            const detail = await store.getProject(accountId, team.projectId!);
            expect(detail.project).toMatchObject({ name: 'Team Alpha', folders: [{ machineId, path: '/work/alpha', primary: true }], teamIds: [team.id] });
            const again = await teams.createTeam(accountId, input);
            expect(again.projectId).toBe(team.projectId);
            expect((await store.listProjects(accountId)).projects.filter(p => p.name === 'Team Alpha')).toHaveLength(1);
            // projectId is a column, never copied into the persisted JSON state.
            expect((await stateOf(team.id)).state).not.toHaveProperty('projectId');
            expect((await teams.readTeam(team.id, { accountId })).projectId).toBe(team.projectId);
        });

        it('an older client (no project field) gets no project; the kill switch also just skips the project', async () => {
            const plain = await teams.createTeam(accountId, { name: 'Old CLI team', machineId, requestId: 'tp-2' });
            expect(plain.projectId).toBeUndefined();
            process.env.VH_PROJECTS_ENABLED = 'false';
            try {
                const off = await teams.createTeam(accountId, { name: 'Off', machineId, requestId: 'tp-3', launch: launch('/w/off'), project: { create: true } });
                expect(off.projectId).toBeUndefined();
            } finally { delete process.env.VH_PROJECTS_ENABLED; }
        });

        it('choosing an existing project attaches the team and adds its folder when the machine is new to the project', async () => {
            const p = await store.createProject(accountId, { name: 'elsewhere', folders: [{ machineId: otherMachineId, path: '/other' }] });
            const team = await teams.createTeam(accountId, { name: 'Beta', machineId, requestId: 'tp-4', launch: launch('/work/beta'), project: { projectId: p.id } });
            expect(team.projectId).toBe(p.id);
            const detail = await store.getProject(accountId, p.id);
            expect(detail.project.folders).toEqual([{ machineId: otherMachineId, path: '/other', primary: true }, { machineId, path: '/work/beta', primary: false }]);
            await expect(teams.createTeam(accountId, { name: 'Gamma', machineId, requestId: 'tp-5', project: { projectId: 'missing' } })).rejects.toMatchObject({ code: 'project_not_found', status: 404 });
            expect((await teams.listTeams(accountId)).some(t => t.name === 'Gamma')).toBe(false);
        });

        it('inheritFromSessionId uses the creating session\'s project, else creates a same-name one at `directory`', async () => {
            const p = await newProject('inherit-me');
            const inside = await newSession();
            await store.addMembers(accountId, p.id, { sessionIds: [inside] });
            const a = await teams.createTeam(accountId, { name: 'Lead in project', machineId, requestId: 'tp-6', project: { inheritFromSessionId: inside, directory: '/repo' } });
            expect(a.projectId).toBe(p.id);
            const outside = await newSession();
            const b = await teams.createTeam(accountId, { name: 'Lead alone', machineId, requestId: 'tp-7', project: { inheritFromSessionId: outside, directory: '/work/lone' } });
            expect(b.projectId).not.toBe(p.id);
            expect((await store.getProject(accountId, b.projectId!)).project).toMatchObject({ name: 'Lead alone', folders: [{ machineId, path: '/work/lone', primary: true }] });
        });

        it('bindTeamProject: old team one-click create (idempotent), move to another project, detach; lead flag reaches the context', async () => {
            const lead = await newSession(); const member = await newSession();
            const team = await teams.createTeam(accountId, { name: 'Legacy', machineId, requestId: 'tp-8', launch: launch('/work/legacy') });
            const row = await stateOf(team.id);
            await db.agentTeam.update({ where: { id: team.id }, data: { state: { ...(row.state as object), bots: [{ id: 'r', root: true, sessionId: lead }, { id: 'm', root: false, sessionId: member }] } } });
            const created = await store.bindTeamProject(accountId, team.id, { create: true, requestId: 'one-click' });
            expect(created.project).toMatchObject({ name: 'Legacy', folders: [{ machineId, path: '/work/legacy', primary: true }], teamIds: [team.id] });
            expect((await store.bindTeamProject(accountId, team.id, { create: true, requestId: 'one-click' })).projectId).toBe(created.projectId);
            expect((await store.sessionContext(accountId, lead, { peek: true })).team).toEqual({ id: team.id, name: 'Legacy', lead: true });
            expect((await store.sessionContext(accountId, member, { peek: true })).team).toEqual({ id: team.id, name: 'Legacy', lead: false });
            // A lead decision is visible to a member reading the project.
            await store.createLogEntry(accountId, created.projectId!, { kind: 'decision', title: 'use pnpm', authorSessionId: lead });
            expect((await store.sessionContext(accountId, member, { peek: true })).decisions.map(d => d.title)).toContain('use pnpm');
            const other = await newProject('move-target');
            expect((await store.bindTeamProject(accountId, team.id, { projectId: other.id })).projectId).toBe(other.id);
            expect((await store.sessionMembership(accountId, member)).projectId).toBe(other.id);
            expect(await store.bindTeamProject(accountId, team.id, { projectId: null })).toEqual({ teamId: team.id, projectId: null, project: null });
            expect(await store.sessionMembership(accountId, member)).toEqual({ projectId: null, via: null });
            await expect(store.bindTeamProject(otherAccountId, team.id, { projectId: null })).rejects.toMatchObject({ code: 'team_not_found', status: 404 });
            // A team that never started (no directory anywhere) still gets its one-click same-name project.
            const bare = await teams.createTeam(accountId, { name: 'Never started', machineId, requestId: 'tp-9' });
            const linked = await store.bindTeamProject(accountId, bare.id, { create: true, requestId: 'bare' });
            expect(linked.project).toMatchObject({ name: 'Never started', folders: [], teamIds: [bare.id] });
        });
    });

    it('log seq stays unique under concurrent agent + user writes (serializable retries)', async () => {
        const p = await newProject();
        const writers = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.createLogEntry(accountId, p.id, { kind: 'finding', title: `c${i}` })));
        const ok = writers.filter((w): w is PromiseFulfilledResult<Awaited<ReturnType<typeof store.createLogEntry>>> => w.status === 'fulfilled');
        // Every write either landed with a unique seq or surfaced a retryable 409 — never a duplicate or a 500.
        for (const w of writers) if (w.status === 'rejected') expect(w.reason).toMatchObject({ code: 'transaction_conflict', status: 409 });
        expect(new Set(ok.map(w => w.value.seq)).size).toBe(ok.length);
        expect(ok.length).toBeGreaterThan(0);
    });
});
