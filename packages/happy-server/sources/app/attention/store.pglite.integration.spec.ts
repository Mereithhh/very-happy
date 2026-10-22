import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { attentionBoardLocalId } from '@slopus/happy-wire';
import type * as Store from './store';
import type * as Teams from '@/app/teams/store';

const { pushed } = vi.hoisted(() => ({ pushed: [] as { sessionId: string; data?: Record<string, unknown> }[] }));
// No socket server in tests: keep the payload builders, record the emits.
const { emitted } = vi.hoisted(() => ({ emitted: [] as { userId: string; payload: { body?: { t?: string; item?: { id: string } } } }[] }));
vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    return { ...actual, eventRouter: { emitUpdate: (p: (typeof emitted)[number]) => { emitted.push(p); }, emitEphemeral: () => undefined } };
});
vi.mock('@/app/push/pushDispatch', () => ({
    dispatchSessionEventPush: vi.fn(async (params: { sessionId: string; data?: Record<string, unknown> }) => { pushed.push(params); }),
}));

const MIGRATION = 'prisma/migrations/20261022120000_attention_items/migration.sql';
const options = [{ id: 'A', label: 'Ship now', recommended: true }, { id: 'B', label: 'Wait a day' }];
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

describe('attention items store (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/attention-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'db-'));
    let db: PrismaClient; let store: typeof Store; let teams: typeof Teams;
    let accountId: string; let otherAccountId: string; let machineId: string; let sessionId: string;
    const newSession = async (owner = accountId) => (await db.session.create({ data: { accountId: owner, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
    const pushesFor = (itemId: string) => pushed.filter(p => p.data?.itemId === itemId).length;

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'attention-integration-test-only';
        process.env.VH_AGENT_TEAMS_ENABLED = 'true'; process.env.VH_OWNER_BOARD_ENABLED = 'true';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        const { initEncrypt } = await import('@/modules/encrypt'); await initEncrypt();
        store = await import('./store');
        teams = await import('@/app/teams/store');
        accountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        otherAccountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        machineId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId, metadata: 'm' } });
    }, 60000);
    beforeEach(async () => { sessionId = await newSession(); process.env.VH_OWNER_BOARD_ENABLED = 'true'; });
    afterAll(async () => { await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });

    it('is off unless VH_OWNER_BOARD_ENABLED=true: routes 404, hooks no-op', async () => {
        delete process.env.VH_OWNER_BOARD_ENABLED;
        await expect(store.listItems(accountId, {})).rejects.toMatchObject({ code: 'owner_board_disabled', status: 404 });
        await expect(store.postItem(accountId, { sessionId, source: 'agent', kind: 'blocked', title: 'x' })).rejects.toMatchObject({ code: 'owner_board_disabled', status: 404 });
        expect(await store.noteAttentionSessionArchived(accountId, sessionId)).toEqual([]);
        expect(await db.attentionItem.count({ where: { sessionId } })).toBe(0);
    });

    it('creates, dedupes a repost by (sessionId, key), and treats a same-request retry as a no-op', async () => {
        const first = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'decision', title: 'Pick the window', options, key: 'window', requestId: 'r1' });
        expect(first.created).toBe(true);
        expect(first.item).toMatchObject({ needsOwner: true, state: 'open', repostCount: 0, version: 1, teamId: null });
        await settle();
        expect(emitted.filter(e => e.payload.body?.t === 'attention-item' && e.payload.body.item?.id === first.item.id).map(e => e.userId)).toEqual([accountId]);
        const retry = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'decision', title: 'Pick the window', options, key: 'window', requestId: 'r1' });
        expect(retry).toMatchObject({ item: { id: first.item.id, version: 1, repostCount: 0 }, created: false });
        const repost = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'decision', title: 'Pick the window (again)', options, key: 'window', requestId: 'r2' });
        expect(repost.created).toBe(false);
        expect(repost.item).toMatchObject({ id: first.item.id, title: 'Pick the window (again)', repostCount: 1, version: 2 });
        await expect(store.postItem(accountId, { sessionId, source: 'lead', kind: 'report', title: 'x', key: 'window', requestId: 'r3' }))
            .rejects.toMatchObject({ code: 'attention_key_kind_mismatch' });
        // Key-less posts are idempotent on the request id.
        const a = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'report', title: 'Merged', requestId: 'r-report' });
        const b = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'report', title: 'Merged', requestId: 'r-report' });
        expect(b.item.id).toBe(a.item.id);
        expect(await db.attentionItem.count({ where: { sessionId } })).toBe(2);
    });

    it('collapses concurrent first posts of one key into one row and pushes once', async () => {
        const posts = Array.from({ length: 8 }, (_, i) => store.postItem(accountId, { sessionId, source: 'agent', kind: 'blocked', title: 'Need a login', key: 'login', requestId: `c${i}` }));
        const results = await Promise.all(posts);
        const ids = new Set(results.map(r => r.item.id));
        expect(ids.size).toBe(1);
        expect(results.filter(r => r.created)).toHaveLength(1);
        const row = await db.attentionItem.findFirstOrThrow({ where: { sessionId, key: 'login' } });
        expect(row.repostCount).toBe(7);
        await settle();
        expect(pushesFor(row.id)).toBe(1);
        expect(row.pushedAt).not.toBeNull();
    });

    it('pushes at most once per item: reposts and replays never re-push; a reopen of a closed item may push again', async () => {
        const { item } = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'todo', title: 'Approve the device', key: 'device', requestId: 'p1' });
        await settle();
        await store.postItem(accountId, { sessionId, source: 'lead', kind: 'todo', title: 'Approve the device', key: 'device', requestId: 'p2' });
        await Promise.all([store.pushOnce({ ...item, accountId }), store.pushOnce({ ...item, accountId })]);
        await settle();
        expect(pushesFor(item.id)).toBe(1);
        expect(pushed.find(p => p.data?.itemId === item.id)?.data).toMatchObject({ kind: 'attention', url: `/session/${sessionId}?panel=board&item=${item.id}` });
        await store.resolveItem(accountId, item.id, { outcome: 'done' });
        const reopened = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'todo', title: 'Approve the device again', key: 'device', requestId: 'p3' });
        expect(reopened.item).toMatchObject({ state: 'open', resolvedBy: null, resolvedAt: null, repostCount: 2 });
        await settle();
        expect(pushesFor(item.id)).toBe(2);
        // Reports and pins never push.
        const report = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'report', title: 'Released', requestId: 'p4' });
        await settle();
        expect(pushesFor(report.item.id)).toBe(0);
    });

    it('D5 drafts (inferred) never push; the lead posting the same key confirms and pushes once; drafts never downgrade', async () => {
        const draft = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'decision', title: 'Pick a region', options, key: 'region', inferred: true, requestId: 'i1' });
        expect(draft.item).toMatchObject({ inferred: true, needsOwner: true, state: 'open' });
        await store.postItem(accountId, { sessionId, source: 'lead', kind: 'decision', title: 'Pick a region', options, key: 'region', inferred: true, requestId: 'i2' });
        await settle();
        expect(pushesFor(draft.item.id)).toBe(0);
        const confirmed = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'decision', title: 'Pick a region', options, key: 'region', requestId: 'i3' });
        expect(confirmed.item).toMatchObject({ id: draft.item.id, inferred: false, repostCount: 2 });
        await settle();
        expect(pushesFor(draft.item.id)).toBe(1);
        const again = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'decision', title: 'Pick a region', options, key: 'region', inferred: true, requestId: 'i4' });
        expect(again.item.inferred).toBe(false);
        await settle();
        expect(pushesFor(draft.item.id)).toBe(1);
    });

    it('answers and reports settle the item they reply to; an answer to an owner question pushes as question', async () => {
        const question = await store.postItem(accountId, { sessionId, source: 'owner', kind: 'question', title: 'Who writes the notes?', anchor: { localId: 'l1' }, requestId: 'q1' });
        expect(question.item.needsOwner).toBe(false);
        const answer = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'answer', title: 'Dev-A writes them', replyToId: question.item.id, requestId: 'a1' });
        expect((await db.attentionItem.findUniqueOrThrow({ where: { id: question.item.id } })).state).toBe('answered');
        await settle();
        expect(pushed.find(p => p.data?.itemId === answer.item.id)?.data).toMatchObject({ kind: 'question' });
        const request = await store.postItem(accountId, { sessionId, source: 'owner', kind: 'question', title: 'Fix the footer', requestId: 'q2' });
        await store.patchItem(accountId, request.item.id, { kind: 'request', state: 'in_progress' });
        await store.postItem(accountId, { sessionId, source: 'lead', kind: 'report', title: 'Footer fixed', replyToId: request.item.id, requestId: 'a2' });
        expect(await db.attentionItem.findUniqueOrThrow({ where: { id: request.item.id } })).toMatchObject({ kind: 'request', state: 'resolved', resolvedBy: 'lead' });
    });

    it('patch / resolve / owner-respond lifecycle and account isolation', async () => {
        const { item } = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'decision', title: 'Pick one', options, requestId: 'd1' });
        await expect(store.patchItem(otherAccountId, item.id, { title: 'x' })).rejects.toMatchObject({ code: 'attention_item_not_found', status: 404 });
        await expect(store.postItem(otherAccountId, { sessionId, source: 'lead', kind: 'report', title: 'x' })).rejects.toMatchObject({ code: 'session_not_found' });
        const patched = await store.patchItem(accountId, item.id, { appendMd: 'More context', firstReply: { messageId: 'm1' } });
        expect(patched.item).toMatchObject({ bodyMd: 'More context', firstReply: { messageId: 'm1' }, version: 2 });
        await expect(store.patchItem(accountId, item.id, { kind: 'request' })).rejects.toMatchObject({ code: 'attention_kind_change_refused' });
        await expect(store.ownerRespond(accountId, item.id, { action: 'choose', choice: 'Z' })).rejects.toMatchObject({ code: 'attention_unknown_choice' });
        const chosen = await store.ownerRespond(accountId, item.id, { action: 'choose', choice: 'B', note: 'next week' });
        expect(chosen.item).toMatchObject({ state: 'resolved', resolvedBy: 'owner', ownerChoice: 'B', ownerNote: 'next week' });
        expect((await store.ownerRespond(accountId, item.id, { action: 'choose', choice: 'B' })).item.version).toBe(chosen.item.version);
        await expect(store.ownerRespond(accountId, item.id, { action: 'choose', choice: 'A' })).rejects.toMatchObject({ code: 'attention_item_closed' });
        await expect(store.patchItem(accountId, item.id, { state: 'in_progress' })).rejects.toMatchObject({ code: 'attention_item_closed' });
        const reopened = await store.ownerRespond(accountId, item.id, { action: 'reopen', note: 'follow-up' });
        expect(reopened.item).toMatchObject({ state: 'open', ownerChoice: null, ownerNote: 'follow-up' });
        const dropped = await store.resolveItem(accountId, item.id, { outcome: 'superseded', note: 'merged into #2' });
        expect(dropped.item).toMatchObject({ state: 'dismissed', resolvedBy: 'lead', resolveNote: 'merged into #2' });
    });

    it('lists open / active / all, filtering by session and needsOwner, capping answered at two per session', async () => {
        const s = await newSession();
        const open = await store.postItem(accountId, { sessionId: s, source: 'agent', kind: 'blocked', title: 'b', requestId: 'l1' });
        await store.postItem(accountId, { sessionId: s, source: 'lead', kind: 'report', title: 'r', requestId: 'l2' });
        for (let i = 0; i < 3; i++) {
            const q = await store.postItem(accountId, { sessionId: s, source: 'owner', kind: 'question', title: `q${i}`, requestId: `lq${i}` });
            await store.patchItem(accountId, q.item.id, { state: 'answered' });
        }
        expect((await store.listItems(accountId, { sessionId: s })).items.map(i => i.title).sort()).toEqual(['b', 'r']);
        expect((await store.listItems(accountId, { sessionId: s, needsOwner: 'true' })).items.map(i => i.id)).toEqual([open.item.id]);
        expect((await store.listItems(accountId, { sessionId: s, state: 'active' })).items.map(i => i.title)).toEqual(['q2', 'q1', 'r', 'b']);
        expect((await store.listItems(accountId, { sessionId: s, state: 'all' })).items).toHaveLength(5);
        expect((await store.listItems(otherAccountId, { sessionId: s, state: 'all' })).items).toHaveLength(0);
    });

    it('owner reply settles the only open decision; board messages, agents and ambiguity do not', async () => {
        const one = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'decision', title: 'One', options, requestId: 'o1' });
        await store.postItem(accountId, { sessionId, source: 'agent', kind: 'blocked', title: 'Blocked', requestId: 'o2' });
        expect(await store.noteAttentionOwnerMessage({ accountId, sessionId, localId: 'teams-abc' })).toEqual([]);
        expect(await store.noteAttentionOwnerMessage({ accountId, sessionId, localId: attentionBoardLocalId(one.item.id, 'n') })).toEqual([]);
        expect(await store.noteAttentionOwnerMessage({ accountId, sessionId, localId: 'l-1', connectionType: 'session-scoped' })).toEqual([]);
        expect(await store.noteAttentionOwnerMessage({ accountId, sessionId, localId: 'l-2' })).toEqual([one.item.id]);
        expect(await db.attentionItem.findUniqueOrThrow({ where: { id: one.item.id } })).toMatchObject({ state: 'resolved', resolvedBy: 'owner-replied' });
        await store.postItem(accountId, { sessionId, source: 'lead', kind: 'decision', title: 'Two', options, requestId: 'o3' });
        await store.postItem(accountId, { sessionId, source: 'lead', kind: 'decision', title: 'Three', options, requestId: 'o4' });
        expect(await store.noteAttentionOwnerMessage({ accountId, sessionId, localId: 'l-3' })).toEqual([]);
    });

    it('archiving a session dismisses its open items', async () => {
        const a = await store.postItem(accountId, { sessionId, source: 'agent', kind: 'blocked', title: 'x', requestId: 'ar1' });
        const b = await store.postItem(accountId, { sessionId, source: 'lead', kind: 'report', title: 'y', requestId: 'ar2' });
        expect((await store.noteAttentionSessionArchived(accountId, sessionId)).sort()).toEqual([a.item.id, b.item.id].sort());
        expect(await db.attentionItem.findMany({ where: { sessionId }, select: { state: true, resolvedBy: true } }))
            .toEqual([{ state: 'dismissed', resolvedBy: 'session-archived' }, { state: 'dismissed', resolvedBy: 'session-archived' }]);
    });

    describe('root-task submit (reducer msg() drops it: ownerBotId=null)', () => {
        const startRootTask = async (name: string) => {
            const team = await teams.createTeam(accountId, { name, machineId });
            const delegated = await teams.actOnTeam(team.id, { accountId }, { requestId: `${name}-delegate`, action: { type: 'delegate', goal: 'Ship the release notes\nwith screenshots', acceptance: ['notes merged'] } });
            const operationId = delegated.team.operations.find(o => o.taskId === delegated.taskId && o.type === 'spawn')!.id;
            const claimed = await teams.actOnTeam(team.id, { accountId }, { requestId: `${name}-claim`, action: { type: 'claim-operation', operationId, machineId, teamLaunchVersion: 1 } });
            const claimId = claimed.team.operations.find(o => o.id === operationId)!.claimId!;
            await teams.actOnTeam(team.id, { accountId }, { requestId: `${name}-complete`, action: { type: 'complete-operation', operationId, machineId, claimId, sessionId } });
            const task = (await teams.readTeam(team.id, { accountId })).tasks.find(t => t.id === delegated.taskId)!;
            expect(task).toMatchObject({ ownerBotId: null, status: 'running' });
            return { teamId: team.id, task };
        };
        const submit = (teamId: string, task: { id: string; currentAttemptId: string; goalVersion: number }, requestId: string) =>
            teams.actOnTeam(teamId, { accountId }, { requestId, action: { type: 'submit', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: task.goalVersion, result: 'PR #1 merged; screenshots attached.' } });

        it('writes one「待你验收」decision in the assignee session; accept from the board settles the task and the item', async () => {
            const { teamId, task } = await startRootTask('root-accept');
            const submitted = await submit(teamId, task, 'root-accept-submit');
            expect(submitted.team.messages.filter(m => m.taskId === task.id && m.body.includes('submitted'))).toHaveLength(0);
            const row = await db.attentionItem.findFirstOrThrow({ where: { sessionId, key: `team-submit:${task.id}` } });
            expect(row).toMatchObject({ source: 'team', kind: 'decision', needsOwner: true, state: 'open', teamId, bodyMd: 'PR #1 merged; screenshots attached.' });
            expect(row.title).toBe('根目标已提交，等你验收 · Ship the release notes');
            await settle();
            expect(pushesFor(row.id)).toBe(1);
            // The owner's chat does not accept work.
            expect(await store.noteAttentionOwnerMessage({ accountId, sessionId, localId: 'l-chat' })).toEqual([]);
            const accepted = await store.ownerRespond(accountId, row.id, { action: 'choose', choice: 'accept' });
            expect(accepted.item).toMatchObject({ state: 'resolved', resolvedBy: 'owner', ownerChoice: 'accept' });
            expect((await teams.readTeam(teamId, { accountId })).tasks.find(t => t.id === task.id)!.status).toBe('done');
            await expect(store.ownerRespond(accountId, row.id, { action: 'choose', choice: 'return' })).rejects.toMatchObject({ code: 'attention_item_stale' });
        });

        it('a return reopens the same item on resubmit (one row per task); a team-page accept closes it too', async () => {
            const { teamId, task } = await startRootTask('root-return');
            await submit(teamId, task, 'root-return-submit-1');
            const row = await db.attentionItem.findFirstOrThrow({ where: { sessionId, key: `team-submit:${task.id}` } });
            await store.ownerRespond(accountId, row.id, { action: 'choose', choice: 'return', note: 'add the zh copy' });
            const returned = (await teams.readTeam(teamId, { accountId })).tasks.find(t => t.id === task.id)!;
            expect(returned.status).toBe('running');
            expect(await db.attentionItem.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: 'resolved', ownerChoice: 'return' });
            await submit(teamId, returned, 'root-return-submit-2');
            expect(await db.attentionItem.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: 'open', ownerChoice: null, repostCount: 1 });
            await settle();
            expect(pushesFor(row.id)).toBe(2);
            const resubmitted = (await teams.readTeam(teamId, { accountId })).tasks.find(t => t.id === task.id)!;
            await teams.actOnTeam(teamId, { accountId }, { requestId: 'root-return-accept', action: { type: 'accept', taskId: task.id, attemptId: resubmitted.currentAttemptId, goalVersion: resubmitted.goalVersion } });
            expect(await db.attentionItem.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: 'resolved', resolvedBy: 'owner', ownerChoice: 'accept' });
            expect(await db.attentionItem.count({ where: { key: `team-submit:${task.id}` } })).toBe(1);
        });

        it('with the board off the submit still succeeds and writes nothing', async () => {
            const { teamId, task } = await startRootTask('root-off');
            delete process.env.VH_OWNER_BOARD_ENABLED;
            await submit(teamId, task, 'root-off-submit');
            expect(await db.attentionItem.count({ where: { key: `team-submit:${task.id}` } })).toBe(0);
        });
    });

    it('migration is expand-only and reversible: rollback drops just the table, re-applying restores it', async () => {
        const sql = readFileSync(join(process.cwd(), MIGRATION), 'utf8');
        expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
        expect(sql).not.toMatch(/ALTER TABLE "(?!AttentionItem")/);
        expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\b/m);
        const rollback = sql.match(/-- Rollback[^:]*:\s*(.+)$/m)![1];
        await db.$executeRawUnsafe(rollback);
        expect(await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM information_schema.tables WHERE table_name='AttentionItem'`)).toEqual([{ n: 0n }]);
        // Everything else keeps working without the table (the previous image's view of the schema).
        expect(await db.session.count({ where: { id: sessionId } })).toBe(1);
        for (const statement of sql.split(/;\s*$/m).map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
        const again = await store.postItem(accountId, { sessionId, source: 'agent', kind: 'blocked', title: 'after re-apply', requestId: 'm1' });
        expect(again.created).toBe(true);
    });
});
