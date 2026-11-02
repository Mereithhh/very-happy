import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BUILTIN_TODO_PREFIX, ISSUE_RULES_REMINDER, ISSUE_STATUS_RULES } from '@slopus/happy-wire';
import { startIssueTestServer } from './issueTestServer';

/**
 * B-872 end to end through the production `startApi()` on PGlite: real
 * routes, auth, the archive / owner-respond hooks and the attention store —
 * not the store functions directly (spec §12 "走真实路由").
 */

const { shutdown } = vi.hoisted(() => ({ shutdown: [] as (() => Promise<void>)[] }));
vi.mock('@/app/push/pushDispatch', () => ({ dispatchSessionEventPush: vi.fn(async () => undefined), dispatchDeviceEventPush: vi.fn(), sendTestWebPush: vi.fn() }));
vi.mock('@/utils/shutdown', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/shutdown')>()),
    onShutdown: (_name: string, fn: () => Promise<void>) => { shutdown.push(fn); return () => undefined; },
}));

type Server = Awaited<ReturnType<typeof startIssueTestServer>>;

describe('B-872 Issues REST through startApi (pglite)', () => {
    let s: Server;
    let machineId: string;
    let otherMachine: string;
    const DIR = '/work/repo';

    beforeAll(async () => {
        delete process.env.VH_ISSUES_ENABLED;
        process.env.VH_OWNER_BOARD_ENABLED = 'true';
        s = await startIssueTestServer('api');
        machineId = await s.newMachine();
        otherMachine = await s.newMachine();
    }, 60000);
    afterAll(async () => { await s.stop(shutdown); delete process.env.VH_ISSUES_ENABLED; delete process.env.VH_OWNER_BOARD_ENABLED; });

    const agent = (extra: Record<string, unknown> = {}) => ({ kind: 'agent', machineId, agent: 'codex', directory: DIR, ...extra });
    const issueRow = (id: string) => s.db.issue.findUniqueOrThrow({ where: { id } });
    const runsOf = (issueId: string) => s.db.issueRun.findMany({ where: { issueId }, orderBy: { seq: 'asc' } });
    const items = (key: string) => s.db.attentionItem.findMany({ where: { key } });
    /** The daemon side: poll this machine, claim + complete the first spawn with a fresh (live) session. */
    const daemonStart = async (issueId: string, machine = machineId) => {
        const polled = await s.call('GET', `/v1/issues/dispatch?machineId=${machine}&workerVersion=1`);
        expect(polled.status).toBe(200);
        const spawn = polled.body.dispatches.find((d: { kind: string; issueId: string }) => d.kind === 'spawn' && d.issueId === issueId);
        expect(spawn).toBeTruthy();
        const claimed = await s.call('POST', `/v1/issues/dispatch/${spawn.id}/claim`, { machineId: machine });
        expect(claimed.status).toBe(200);
        const sessionId = await s.newSession();
        expect((await s.call('POST', `/v1/issues/dispatch/${spawn.id}/complete`, { machineId: machine, claimId: claimed.body.dispatch.claimId, sessionId })).status).toBe(200);
        return { sessionId, dispatch: claimed.body.dispatch, runId: spawn.runId as string };
    };

    it('switch off: every /v1/issues* route is 404 issues_disabled before validation and auth; the archive hook does nothing', async () => {
        for (const [method, path, body] of [
            ['GET', '/v1/issues', undefined], ['POST', '/v1/issues', { title: '' }], ['GET', '/v1/issues/VH-1', undefined],
            ['GET', '/v1/issues/workers', undefined], ['POST', '/v1/issues/import-legacy-todos', undefined], ['GET', `/v1/issues/dispatch?machineId=${machineId}&workerVersion=1`, undefined],
            ['POST', '/v1/issues/agent/update', {}], ['GET', '/v1/issues/session/abc', undefined], ['POST', '/v1/issues/runs/r1/cancel', undefined],
        ] as const) {
            expect(await s.call(method, path, body), path).toEqual({ status: 404, body: { error: 'issues_disabled' } });
            expect(await s.call(method, path, body, null), `${path} (no auth)`).toEqual({ status: 404, body: { error: 'issues_disabled' } });
        }
        process.env.VH_ISSUES_ENABLED = 'false';
        expect((await s.call('GET', '/v1/issues')).body).toEqual({ error: 'issues_disabled' });
        const sessionId = await s.newSession();
        expect((await s.call('POST', `/v1/sessions/${sessionId}/archive`)).status).toBe(200);
        // Built-in Todos keep working exactly as before on the KV routes, and nothing is imported behind the owner's back.
        const todoId = crypto.randomUUID();
        const value = Buffer.from(JSON.stringify({ schemaVersion: 1, id: todoId, title: 'kv todo', note: '', status: 'open', order: 1, createdAt: 1, updatedAt: 1 })).toString('base64');
        const wrote = await s.call('POST', '/v1/kv', { mutations: [{ key: BUILTIN_TODO_PREFIX + todoId, value, version: -1 }] });
        expect(wrote.status).toBe(200);
        const listed = await s.call('GET', `/v1/kv?prefix=${encodeURIComponent(BUILTIN_TODO_PREFIX)}`);
        expect(listed.body.items.map((i: { key: string; value: string }) => [i.key, i.value])).toEqual([[BUILTIN_TODO_PREFIX + todoId, value]]);
        expect(await s.db.issue.count()).toBe(0);
        await s.db.userKVStore.deleteMany({ where: { key: BUILTIN_TODO_PREFIX + todoId } });
        process.env.VH_ISSUES_ENABLED = 'true';
    });

    it('creates, numbers concurrently without gaps or duplicates, reads by key, lists and filters; foreign accounts see nothing', async () => {
        expect((await s.call('GET', '/v1/issues', undefined, null)).status).toBe(401);
        const first = await s.call('POST', '/v1/issues', { title: 'First', description: 'd', requestId: 'c1' });
        expect(first.status).toBe(200);
        expect(first.body.issue).toMatchObject({ key: 'VH-1', number: 1, status: 'backlog', priority: 'none', assignee: { kind: 'none' }, version: 1, createdBy: { kind: 'user' } });
        expect(first.body.runs).toEqual([]);
        expect((await s.call('POST', '/v1/issues', { title: 'First', requestId: 'c1' })).body.issue.id).toBe(first.body.issue.id);

        const many = await Promise.all(Array.from({ length: 8 }, (_, i) => s.call('POST', '/v1/issues', { title: `Bulk ${i}`, labels: ['bulk'] })));
        expect(many.map(r => r.status)).toEqual(Array(8).fill(200));
        expect(many.map(r => r.body.issue.number).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);

        expect((await s.call('GET', '/v1/issues/VH-1')).body.issue.id).toBe(first.body.issue.id);
        expect((await s.call('GET', `/v1/issues/${first.body.issue.id}`)).body).toMatchObject({ issue: { key: 'VH-1' }, comments: [], runs: [], children: [] });
        expect((await s.call('GET', '/v1/issues?label=bulk&limit=5')).body).toMatchObject({ nextCursor: expect.any(String) });
        const page1 = await s.call('GET', '/v1/issues?label=bulk&limit=5');
        const page2 = await s.call('GET', `/v1/issues?label=bulk&limit=5&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
        expect([...page1.body.issues, ...page2.body.issues].map((i: { id: string }) => i.id).sort()).toEqual(many.map(r => r.body.issue.id).sort());
        expect((await s.call('GET', '/v1/issues?q=vh-1')).body.issues.map((i: { key: string }) => i.key)).toEqual(['VH-1']);
        expect((await s.call('GET', '/v1/issues?q=bulk%203')).body.issues.map((i: { title: string }) => i.title)).toEqual(['Bulk 3']);

        const other = await s.newAccount();
        expect((await s.call('GET', '/v1/issues/VH-1', undefined, other.token))).toEqual({ status: 404, body: { error: 'issue_not_found' } });
        expect((await s.call('GET', '/v1/issues', undefined, other.token)).body.issues).toEqual([]);
        expect((await s.call('POST', '/v1/issues', { title: 'mine' }, other.token)).body.issue.key).toBe('VH-1');
    });

    it('validates assignee / project / parent / CAS; team assignee is refused in phase 1', async () => {
        expect((await s.call('POST', '/v1/issues', { title: 'x', assignee: { kind: 'team', teamId: 't1' } }))).toEqual({ status: 400, body: { error: 'issue_assignee_unsupported' } });
        expect((await s.call('POST', '/v1/issues', { title: 'x', assignee: { kind: 'agent', machineId: 'nope-machine', agent: 'codex', directory: DIR } })).body.error).toBe('issue_machine_not_found');
        expect((await s.call('POST', '/v1/issues', { title: 'x', assignee: { kind: 'agent', machineId, agent: 'codex' } }))).toMatchObject({ status: 400, body: { error: 'issue_no_directory' } });
        expect((await s.call('POST', '/v1/issues', { title: 'x', assignee: { kind: 'agent', machineId, agent: 'gemini', directory: DIR } })).status).toBe(400);
        expect((await s.call('POST', '/v1/issues', { title: 'x', projectId: 'missing' })).body.error).toBe('issue_project_not_found');
        // Directory from the project's folder on that machine.
        const project = await s.db.project.create({ data: { id: crypto.randomUUID(), accountId: s.accountId, name: 'P', folders: [{ machineId, path: '/p/main', primary: true }] } });
        const viaProject = await s.call('POST', '/v1/issues', { title: 'P issue', projectId: project.id, status: 'backlog', assignee: { kind: 'agent', machineId, agent: 'claude' } });
        expect(viaProject.status).toBe(200);
        const parent = await s.call('POST', '/v1/issues', { title: 'Parent' });
        const child = await s.call('POST', '/v1/issues', { title: 'Child', parentId: parent.body.issue.id });
        expect((await s.call('GET', `/v1/issues/${parent.body.issue.key}`)).body.children.map((c: { key: string }) => c.key)).toEqual([child.body.issue.key]);
        expect((await s.call('PATCH', `/v1/issues/${parent.body.issue.id}`, { parentId: child.body.issue.id }))).toEqual({ status: 400, body: { error: 'issue_parent_cycle' } });
        const stale = await s.call('PATCH', `/v1/issues/${parent.body.issue.id}`, { title: 'Parent 2', ifVersion: 99 });
        expect(stale).toMatchObject({ status: 409, body: { error: 'issue_version_conflict', issue: { title: 'Parent' } } });
        const ok = await s.call('PATCH', `/v1/issues/${parent.body.issue.id}`, { title: 'Parent 2', ifVersion: 1, priority: 'high' });
        expect(ok.body.issue).toMatchObject({ title: 'Parent 2', priority: 'high', version: 2 });
        const detail = await s.call('GET', `/v1/issues/${parent.body.issue.id}`);
        expect(detail.body.comments).toMatchObject([{ kind: 'field', author: { kind: 'user' }, data: { fields: ['title', 'priority'] } }]);
        expect(detail.body.comments[0].body).not.toContain('Parent');
    });

    it('main path: assign → spawn dispatch → claim (one winner) → running + todo→in_progress → agent rules enforced → in_review item → 完成', async () => {
        const created = await s.call('POST', '/v1/issues', { title: 'Ship the thing', description: 'Do it well', assignee: agent() });
        const issue = created.body.issue;
        expect(issue.status).toBe('todo');
        expect(created.body.runs).toMatchObject([{ seq: 1, trigger: 'assign', status: 'queued', agent: 'codex', machineId, directory: DIR }]);

        const polled = await s.call('GET', `/v1/issues/dispatch?machineId=${machineId}&workerVersion=1`);
        const spawn = polled.body.dispatches.find((d: { issueId: string }) => d.issueId === issue.id);
        expect(spawn.spawn).toMatchObject({ agent: 'codex', directory: DIR, projectId: null });
        expect(spawn.spawn.prompt).toContain('You are assigned issue');
        expect(spawn.spawn.prompt).toContain('Ship the thing');
        expect(spawn.spawn.prompt).toContain(ISSUE_STATUS_RULES);
        expect((await s.call('GET', '/v1/issues/workers')).body.workers).toEqual([expect.objectContaining({ machineId, workerVersion: 1 })]);
        expect((await s.call('GET', `/v1/issues/dispatch?machineId=not-mine&workerVersion=1`)).body.error).toBe('issue_machine_not_found');

        // Concurrent claims: exactly one wins.
        const claims = await Promise.all([1, 2, 3].map(() => s.call('POST', `/v1/issues/dispatch/${spawn.id}/claim`, { machineId })));
        expect(claims.map(c => c.status).sort()).toEqual([200, 409, 409]);
        const won = claims.find(c => c.status === 200)!.body.dispatch;
        expect((await runsOf(issue.id))[0].status).toBe('claimed');
        expect((await s.call('POST', `/v1/issues/dispatch/${spawn.id}/complete`, { machineId, claimId: 'wrong', sessionId: 'x' })).body.error).toBe('issue_dispatch_claim_mismatch');
        const sessionId = await s.newSession();
        expect((await s.call('POST', `/v1/issues/dispatch/${spawn.id}/complete`, { machineId, claimId: won.claimId, sessionId })).status).toBe(200);
        expect((await s.call('POST', `/v1/issues/dispatch/${spawn.id}/complete`, { machineId, claimId: won.claimId, sessionId })).status).toBe(200);
        const run = (await runsOf(issue.id))[0];
        expect(run).toMatchObject({ status: 'running', sessionId });
        expect(await issueRow(issue.id)).toMatchObject({ status: 'in_progress', statusRunId: run.id });

        const ctx = await s.call('GET', `/v1/issues/session/${sessionId}`);
        expect(ctx.body).toMatchObject({ issue: { id: issue.id }, run: { id: run.id }, current: true });
        expect((await s.call('GET', `/v1/issues/session/${await s.newSession()}`)).body).toMatchObject({ issue: null, run: null, current: false });

        // checkAgentStatusChange is enforced by the server.
        expect(await s.call('POST', '/v1/issues/agent/update', { sessionId, status: 'done' })).toEqual({ status: 409, body: { error: 'issue_status_forbidden' } });
        expect(await s.call('POST', '/v1/issues/agent/update', { sessionId, status: 'cancelled', comment: 'x' })).toEqual({ status: 409, body: { error: 'issue_status_forbidden' } });
        expect(await s.call('POST', '/v1/issues/agent/update', { sessionId, status: 'in_review' })).toEqual({ status: 400, body: { error: 'issue_comment_required' } });
        expect((await s.call('POST', '/v1/issues/agent/update', { sessionId: await s.newSession(), status: 'in_progress' })).body.error).toBe('issue_not_bound');
        expect((await s.call('POST', '/v1/issues/agent/comment', { sessionId, body: 'working on it' })).body.comment).toMatchObject({ author: { kind: 'agent', sessionId, runId: run.id }, routedRunIds: [] });
        const review = await s.call('POST', '/v1/issues/agent/update', { sessionId, status: 'in_review', comment: 'Done; tests green', requestId: 'rv1' });
        expect(review.body.issue).toMatchObject({ status: 'in_review', statusRunId: run.id });
        expect((await s.call('POST', '/v1/issues/agent/update', { sessionId, status: 'in_review', comment: 'Done; tests green', requestId: 'rv1' })).body.comment.id).toBe(review.body.comment.id);
        const [item] = await items(`issue-review:${issue.id}`);
        expect(item).toMatchObject({ source: 'issue', kind: 'decision', state: 'open', sessionId, bodyMd: 'Done; tests green', links: [{ type: 'issue', ref: issue.id, label: issue.key }] });
        expect(item.title).toContain(`${issue.key} 待验收`);

        expect((await s.call('POST', `/v1/attention-items/${item.id}/owner-respond`, { action: 'choose', choice: 'done' })).body.item).toMatchObject({ state: 'resolved', resolvedBy: 'owner', ownerChoice: 'done' });
        expect(await issueRow(issue.id)).toMatchObject({ status: 'done', statusRunId: null });
        expect((await issueRow(issue.id)).completedAt).not.toBeNull();
        // A closed issue: the agent cannot change its status, but may still comment.
        expect((await s.call('POST', '/v1/issues/agent/update', { sessionId, status: 'in_progress' })).body.error).toBe('issue_closed');
        expect((await s.call('POST', '/v1/issues/agent/comment', { sessionId, body: 'fyi' })).status).toBe(200);
        const timeline = (await s.call('GET', `/v1/issues/${issue.key}`)).body.comments.map((c: { kind: string; author: { kind: string } }) => `${c.kind}:${c.author.kind}`);
        expect(timeline).toEqual(['status:system', 'comment:agent', 'comment:agent', 'status:agent', 'status:user', 'comment:agent']);
    });

    it('退回: the issue goes back to todo, the note becomes a human comment delivered to the live session as a queued message', async () => {
        const created = await s.call('POST', '/v1/issues', { title: 'Return me', assignee: agent() });
        const { sessionId, runId } = await daemonStart(created.body.issue.id);
        await s.call('POST', '/v1/issues/agent/update', { sessionId, status: 'in_review', comment: 'please check' });
        const [item] = await items(`issue-review:${created.body.issue.id}`);
        expect((await s.call('POST', `/v1/attention-items/${item.id}/owner-respond`, { action: 'choose', choice: 'return', note: 'Add tests' })).body.item).toMatchObject({ state: 'resolved', ownerChoice: 'return', ownerNote: 'Add tests' });
        expect((await issueRow(created.body.issue.id)).status).toBe('todo');
        const human = await s.db.issueComment.findFirstOrThrow({ where: { issueId: created.body.issue.id, kind: 'comment', authorKind: 'user' } });
        expect(human).toMatchObject({ body: 'Add tests', routedRunIds: [runId] });
        const polled = await s.call('GET', `/v1/issues/dispatch?machineId=${machineId}&workerVersion=1`);
        const message = polled.body.dispatches.find((d: { kind: string; runId: string }) => d.kind === 'message' && d.runId === runId);
        expect(message.message).toMatchObject({ sessionId, commentId: human.id });
        expect(message.message.text).toContain('Add tests');
        expect(message.message.text).toContain(ISSUE_RULES_REMINDER);
        // Agent delivers again: the same item reopens (one item per issue, not a new one).
        await s.call('POST', '/v1/issues/agent/update', { sessionId, status: 'in_progress' });
        await s.call('POST', '/v1/issues/agent/update', { sessionId, status: 'in_review', comment: 'tests added' });
        const again = await items(`issue-review:${created.body.issue.id}`);
        expect(again).toHaveLength(1);
        expect(again[0]).toMatchObject({ state: 'open', repostCount: 1, bodyMd: 'tests added' });
        // A human status move away from in_review resolves it (issue-status).
        await s.call('PATCH', `/v1/issues/${created.body.issue.id}`, { status: 'blocked' });
        expect((await items(`issue-review:${created.body.issue.id}`))[0]).toMatchObject({ state: 'resolved', resolvedBy: 'issue-status' });
    });

    it('backlog assignment records ownership only; moving to todo starts the run; another agent supersedes and the old session is refused', async () => {
        const created = await s.call('POST', '/v1/issues', { title: 'Later', status: 'backlog', assignee: agent() });
        expect(created.body.runs).toEqual([]);
        const toTodo = await s.call('PATCH', `/v1/issues/${created.body.issue.id}`, { status: 'todo' });
        expect(toTodo.body.runs).toMatchObject([{ trigger: 'assign', status: 'queued' }]);
        const { sessionId } = await daemonStart(created.body.issue.id);
        // Same configuration again: no new run.
        expect((await s.call('PATCH', `/v1/issues/${created.body.issue.id}`, { assignee: agent() })).body.runs).toEqual([]);
        const reassigned = await s.call('PATCH', `/v1/issues/${created.body.issue.id}`, { assignee: agent({ agent: 'claude' }) });
        expect(reassigned.body.runs).toMatchObject([{ seq: 2, agent: 'claude', trigger: 'assign' }]);
        expect((await runsOf(created.body.issue.id)).map(r => r.status)).toEqual(['superseded', 'queued']);
        expect(await s.call('POST', '/v1/issues/agent/comment', { sessionId, body: 'still here' })).toMatchObject({ status: 409, body: { error: 'issue_run_not_current' } });
        expect((await s.call('GET', `/v1/issues/session/${sessionId}`)).body.current).toBe(false);
        // Retry / 换 agent through POST runs: always a new run, the active one superseded.
        const retry = await s.call('POST', `/v1/issues/${created.body.issue.id}/runs`, { requestId: 'rt1' });
        expect(retry.body.runs).toMatchObject([{ seq: 3, trigger: 'retry', agent: 'claude' }]);
        expect((await s.call('POST', `/v1/issues/${created.body.issue.id}/runs`, { requestId: 'rt1' })).body.runs[0].id).toBe(retry.body.runs[0].id);
        const swap = await s.call('POST', `/v1/issues/${created.body.issue.id}/runs`, { assignee: agent({ agent: 'pi' }), reassign: true });
        expect(swap.body.runs).toMatchObject([{ seq: 4, trigger: 'retry', agent: 'pi' }]);
        expect((await issueRow(created.body.issue.id)).assignee).toMatchObject({ agent: 'pi' });
        expect((await runsOf(created.body.issue.id)).map(r => r.status)).toEqual(['superseded', 'superseded', 'superseded', 'queued']);
        // The list carries each issue's latest run so the Web needs no per-issue detail fetch.
        const listed = await s.call('GET', '/v1/issues?limit=100');
        expect(listed.body.latestRuns.filter((r: { issueId: string }) => r.issueId === created.body.issue.id)).toMatchObject([{ id: swap.body.runs[0].id, seq: 4, agent: 'pi' }]);
        const withRun = listed.body.issues.filter((i: { latestRunId: string | null }) => i.latestRunId).map((i: { latestRunId: string }) => i.latestRunId).sort();
        expect(listed.body.latestRuns.map((r: { id: string }) => r.id).sort()).toEqual(withRun);
        // Cancel stops the queued run and its dispatch.
        const cancel = await s.call('POST', `/v1/issues/runs/${swap.body.runs[0].id}/cancel`, {});
        expect(cancel.body.run.status).toBe('cancelled');
        expect(await s.db.issueDispatch.count({ where: { runId: swap.body.runs[0].id, status: 'queued' } })).toBe(0);
    });

    it('comment routing: no-@ to the live run (queued), /note stays, agent comments wake nobody, @another agent starts a run without changing the assignee', async () => {
        const created = await s.call('POST', '/v1/issues', { title: 'Talk', assignee: agent() });
        const id = created.body.issue.id;
        const { runId, sessionId } = await daemonStart(id);
        const plain = await s.call('POST', `/v1/issues/${id}/comments`, { body: 'Also update docs', requestId: 'cm1' });
        expect(plain.body.comment.routedRunIds).toEqual([runId]);
        expect((await s.call('POST', `/v1/issues/${id}/comments`, { body: 'Also update docs', requestId: 'cm1' })).body.comment.id).toBe(plain.body.comment.id);
        const note = await s.call('POST', `/v1/issues/${id}/comments`, { body: '/note just for me' });
        expect(note.body.comment.routedRunIds).toEqual([]);
        expect(await s.db.issueDispatch.count({ where: { runId, kind: 'message' } })).toBe(1);
        // @another agent: new run (mention), assignee unchanged.
        const mention = await s.call('POST', `/v1/issues/${id}/comments`, { body: 'Claude, review please', mentions: [{ kind: 'agent', agent: 'claude' }] });
        expect(mention.body.runs).toMatchObject([{ trigger: 'mention', agent: 'claude', machineId, triggerCommentId: mention.body.comment.id }]);
        expect((await issueRow(id)).assignee).toMatchObject({ agent: 'codex' });
        // A comment while that run is still queued is absorbed (no extra run), and the prompt built later contains it.
        const absorbed = await s.call('POST', `/v1/issues/${id}/comments`, { body: 'and check perf', mentions: [{ kind: 'agent', agent: 'claude' }] });
        expect(absorbed.body.runs).toEqual([]);
        expect(absorbed.body.comment.routedRunIds).toEqual([mention.body.runs[0].id]);
        const polled = await s.call('GET', `/v1/issues/dispatch?machineId=${machineId}&workerVersion=1`);
        const spawn = polled.body.dispatches.find((d: { runId: string }) => d.runId === mention.body.runs[0].id);
        expect(spawn.spawn.prompt).toContain('and check perf');
        expect(spawn.spawn.prompt).toContain('You were started by this comment');
        // Agent comment: no routing at all.
        expect((await s.call('POST', '/v1/issues/agent/comment', { sessionId, body: 'ack' })).body.comment.routedRunIds).toEqual([]);
        // The live session went away: a message dispatch fails → that run ends and the comment starts a new run.
        const msg = polled.body.dispatches.find((d: { kind: string; runId: string }) => d.kind === 'message' && d.runId === runId);
        const claim = await s.call('POST', `/v1/issues/dispatch/${msg.id}/claim`, { machineId });
        expect((await s.call('POST', `/v1/issues/dispatch/${msg.id}/fail`, { machineId, claimId: claim.body.dispatch.claimId, error: 'session not live' })).status).toBe(200);
        const runs = await runsOf(id);
        expect(runs.find(r => r.id === runId)?.status).toBe('ended');
        expect(runs.at(-1)).toMatchObject({ trigger: 'comment', agent: 'codex', triggerCommentId: plain.body.comment.id, status: 'queued' });
        // Other-account and agent-comment edits are refused; own comment edit / delete works.
        const agentComment = await s.db.issueComment.findFirstOrThrow({ where: { issueId: id, authorKind: 'agent' } });
        expect((await s.call('PATCH', `/v1/issues/${id}/comments/${agentComment.id}`, { body: 'x' })).body.error).toBe('issue_comment_not_editable');
        expect((await s.call('PATCH', `/v1/issues/${id}/comments/${note.body.comment.id}`, { body: '/note edited' })).body.comment).toMatchObject({ body: '/note edited', editedAt: expect.any(Number) });
        expect((await s.call('DELETE', `/v1/issues/${id}/comments/${note.body.comment.id}`)).body.comment).toMatchObject({ body: '', deletedAt: expect.any(Number) });
    });

    it('@我: an agent mention_owner becomes a todo item; the owner commenting handles it', async () => {
        const created = await s.call('POST', '/v1/issues', { title: 'Ask me', assignee: agent() });
        const { sessionId } = await daemonStart(created.body.issue.id);
        const asked = await s.call('POST', '/v1/issues/agent/comment', { sessionId, body: 'Which DB?\nmore', mentionOwner: true });
        expect(asked.body.comment.mentions).toEqual([{ kind: 'owner' }]);
        const [item] = await items(`issue-mention:${asked.body.comment.id}`);
        expect(item).toMatchObject({ kind: 'todo', state: 'open', source: 'issue' });
        expect(item.title).toContain('@你 · Which DB?');
        await s.call('POST', `/v1/issues/${created.body.issue.id}/comments`, { body: 'Postgres' });
        expect((await items(`issue-mention:${asked.body.comment.id}`))[0]).toMatchObject({ state: 'resolved', resolvedBy: 'owner-replied' });
        expect((await s.db.issueComment.findUniqueOrThrow({ where: { id: asked.body.comment.id } })).ownerAckedAt).not.toBeNull();
    });

    it('failures: spawn failure (no session) → failed, Web-merged, acked by retry; wrapper crash → in_progress back to todo + item; blocked item; archive ends the run', async () => {
        const a = await s.call('POST', '/v1/issues', { title: 'Will fail', assignee: agent({ machineId: otherMachine }) });
        const polled = await s.call('GET', `/v1/issues/dispatch?machineId=${otherMachine}&workerVersion=1`);
        const claim = await s.call('POST', `/v1/issues/dispatch/${polled.body.dispatches[0].id}/claim`, { machineId: otherMachine });
        // unknown outcome: the run stays claimed for an owner retry.
        expect((await s.call('POST', `/v1/issues/dispatch/${polled.body.dispatches[0].id}/fail`, { machineId: otherMachine, claimId: claim.body.dispatch.claimId, error: 'timeout', unknown: true })).status).toBe(200);
        expect((await runsOf(a.body.issue.id))[0].status).toBe('claimed');
        const retried = await s.call('POST', `/v1/issues/${a.body.issue.id}/runs`, {});
        const p2 = await s.call('GET', `/v1/issues/dispatch?machineId=${otherMachine}&workerVersion=1`);
        const d2 = p2.body.dispatches.find((d: { runId: string }) => d.runId === retried.body.runs[0].id);
        const c2 = await s.call('POST', `/v1/issues/dispatch/${d2.id}/claim`, { machineId: otherMachine });
        await s.call('POST', `/v1/issues/dispatch/${d2.id}/fail`, { machineId: otherMachine, claimId: c2.body.dispatch.claimId, error: 'agent-profile-unavailable:expired: login expired' });
        const failed = (await runsOf(a.body.issue.id))[1];
        expect(failed).toMatchObject({ status: 'failed', failureAckedAt: null });
        expect(await issueRow(a.body.issue.id)).toMatchObject({ status: 'todo' });
        expect(await s.db.attentionItem.count({ where: { key: `issue-run-failed:${failed.id}` } })).toBe(0);
        expect((await s.call('POST', `/v1/issues/runs/${failed.id}/ack-failure`, {})).body.run.failureAckedAt).toEqual(expect.any(Number));

        const b = await s.call('POST', '/v1/issues', { title: 'Will crash', assignee: agent() });
        const started = await daemonStart(b.body.issue.id);
        expect((await issueRow(b.body.issue.id)).status).toBe('in_progress');
        expect((await s.call('POST', `/v1/issues/runs/${started.runId}/session-event`, { machineId, sessionId: started.sessionId, event: 'idle' })).status).toBe(200);
        expect((await runsOf(b.body.issue.id))[0].status).toBe('idle');
        await s.call('POST', `/v1/issues/runs/${started.runId}/session-event`, { machineId, sessionId: started.sessionId, event: 'crashed' });
        expect((await runsOf(b.body.issue.id))[0]).toMatchObject({ status: 'failed', error: 'wrapper crashed' });
        expect(await issueRow(b.body.issue.id)).toMatchObject({ status: 'todo', statusRunId: null });
        const [crashItem] = await items(`issue-run-failed:${started.runId}`);
        expect(crashItem).toMatchObject({ kind: 'blocked', state: 'open', sessionId: started.sessionId });
        // A new run (retry) clears it.
        await s.call('POST', `/v1/issues/${b.body.issue.id}/runs`, {});
        expect((await items(`issue-run-failed:${started.runId}`))[0].state).toBe('resolved');
        expect((await runsOf(b.body.issue.id))[0].failureAckedAt).not.toBeNull();

        // Agent moved it to in_progress itself, then a crash: issueStatusAfterRunFailure only reverts this run's status.
        const c = await s.call('POST', '/v1/issues', { title: 'Blocked one', assignee: agent() });
        const run3 = await daemonStart(c.body.issue.id);
        await s.call('POST', '/v1/issues/agent/update', { sessionId: run3.sessionId, status: 'blocked', comment: 'need API key' });
        const [blocked] = await items(`issue-blocked:${c.body.issue.id}`);
        expect(blocked).toMatchObject({ kind: 'blocked', state: 'open', bodyMd: 'need API key' });
        // Owner comment does NOT close a blocked item (S-1d); leaving blocked does.
        await s.call('POST', `/v1/issues/${c.body.issue.id}/comments`, { body: '/note looking' });
        expect((await items(`issue-blocked:${c.body.issue.id}`))[0].state).toBe('open');
        await s.call('POST', `/v1/issues/runs/${run3.runId}/session-event`, { machineId, sessionId: run3.sessionId, event: 'crashed' });
        expect((await issueRow(c.body.issue.id)).status).toBe('blocked');
        // Delete dismisses everything open.
        await s.call('DELETE', `/v1/issues/${c.body.issue.id}`);
        expect((await items(`issue-blocked:${c.body.issue.id}`))[0]).toMatchObject({ state: 'dismissed', resolvedBy: 'issue-status' });
        expect((await s.call('GET', `/v1/issues/${c.body.issue.id}`)).body.issue.deletedAt).toEqual(expect.any(Number));
        expect((await s.call('GET', `/v1/issues?updatedSince=0&limit=500`)).body.issues.some((i: { id: string }) => i.id === c.body.issue.id)).toBe(true);
        expect((await s.call('GET', `/v1/issues?limit=500`)).body.issues.some((i: { id: string }) => i.id === c.body.issue.id)).toBe(false);

        // Archiving the session ends its run (user intent, not a failure).
        const d = await s.call('POST', '/v1/issues', { title: 'Archive me', assignee: agent() });
        const run4 = await daemonStart(d.body.issue.id);
        expect((await s.call('POST', `/v1/sessions/${run4.sessionId}/archive`)).status).toBe(200);
        await expect.poll(async () => (await runsOf(d.body.issue.id))[0].status).toBe('ended');
        expect((await issueRow(d.body.issue.id)).status).toBe('in_progress');
    });

    it('claim lease: an expired claim returns to the queue, the third expiry fails the run; each claim freezes its own prompt and the poll preview matches the next claim', async () => {
        const created = await s.call('POST', '/v1/issues', { title: 'Lease', assignee: agent({ machineId: otherMachine }) });
        const runId = created.body.runs[0].id;
        for (let i = 1; i <= 3; i++) {
            const polled = await s.call('GET', `/v1/issues/dispatch?machineId=${otherMachine}&workerVersion=1`);
            const d = polled.body.dispatches.find((x: { runId: string }) => x.runId === runId);
            expect(d, `round ${i}`).toBeTruthy();
            const claimed = await s.call('POST', `/v1/issues/dispatch/${d.id}/claim`, { machineId: otherMachine });
            // QA42 P2-3: the preview the poll showed is what this claim froze (after an expiry too).
            expect(claimed.body.dispatch.spawn.prompt, `round ${i}`).toBe(d.spawn.prompt);
            expect(claimed.body.dispatch.spawn.prompt).toContain(i === 1 ? 'Lease' : `Lease r${i - 1}`);
            // Edited while claimed: this claim's prompt stays frozen; the next claim (after the lease expires) picks it up.
            const version = (await issueRow(created.body.issue.id)).version;
            expect((await s.call('PATCH', `/v1/issues/${created.body.issue.id}`, { title: `Lease r${i}`, ifVersion: version })).status).toBe(200);
            expect(((await s.db.issueDispatch.findUniqueOrThrow({ where: { id: d.id } })).payload as { prompt: string }).prompt).not.toContain(`Lease r${i}`);
            await s.db.issueDispatch.update({ where: { id: d.id }, data: { claimedAt: new Date(Date.now() - 121_000) } });
        }
        await s.call('GET', `/v1/issues/dispatch?machineId=${otherMachine}&workerVersion=1`);
        expect((await s.db.issueRun.findUniqueOrThrow({ where: { id: runId } }))).toMatchObject({ status: 'failed' });
    });

    it('imports legacy Todos idempotently: open/done mapping, re-run adds nothing, KV-only change updates, both-sides change is a conflict, KV untouched', async () => {
        const acct = await s.newAccount();
        const put = async (id: string, todo: Record<string, unknown>, version: number) => {
            const value = Buffer.from(JSON.stringify({ schemaVersion: 1, id, note: '', order: 1, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000, ...todo }), 'utf8');
            await s.db.userKVStore.upsert({ where: { accountId_key: { accountId: acct.id, key: BUILTIN_TODO_PREFIX + id } }, create: { accountId: acct.id, key: BUILTIN_TODO_PREFIX + id, value, version }, update: { value, version } });
        };
        const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
        await put(ids[0], { title: 'Open one', status: 'open', note: 'n1' }, 1);
        await put(ids[1], { title: 'Done one', status: 'done', order: 2 }, 1);
        await put(ids[2], { title: 'Third', status: 'open', order: 3 }, 1);
        await s.db.userKVStore.create({ data: { accountId: acct.id, key: `${BUILTIN_TODO_PREFIX}bad`, value: Buffer.from('not json'), version: 1 } });
        const run = () => s.call('POST', '/v1/issues/import-legacy-todos', undefined, acct.token);
        expect((await run()).body).toEqual({ imported: 3, updated: 0, skipped: 0, conflicts: 0, invalid: 1 });
        const list = (await s.call('GET', '/v1/issues?limit=50', undefined, acct.token)).body.issues;
        expect(list).toHaveLength(3);
        const byLegacy = (id: string) => list.find((i: { legacyTodoId: string }) => i.legacyTodoId === id);
        expect(byLegacy(ids[0])).toMatchObject({ status: 'todo', description: 'n1', assignee: { kind: 'none' }, createdBy: { kind: 'import' }, completedAt: null, createdAt: 1_700_000_000_000 });
        expect(byLegacy(ids[1])).toMatchObject({ status: 'done', completedAt: 1_700_000_100_000 });
        expect((await run()).body).toEqual({ imported: 0, updated: 0, skipped: 3, conflicts: 0, invalid: 1 });
        // Old client wrote KV again: an untouched issue follows it.
        await put(ids[0], { title: 'Open one (edited)', status: 'done' }, 2);
        expect((await run()).body).toMatchObject({ imported: 0, updated: 1, skipped: 2 });
        expect((await s.call('GET', `/v1/issues/${byLegacy(ids[0]).id}`, undefined, acct.token)).body.issue).toMatchObject({ title: 'Open one (edited)', status: 'done' });
        // Both changed: the issue wins and a system entry keeps the KV text; the next run skips it.
        await s.call('PATCH', `/v1/issues/${byLegacy(ids[2]).id}`, { title: 'Third (issue side)' }, acct.token);
        await put(ids[2], { title: 'Third (kv side)', status: 'open', order: 3 }, 2);
        expect((await run()).body).toMatchObject({ conflicts: 1 });
        const detail = (await s.call('GET', `/v1/issues/${byLegacy(ids[2]).id}`, undefined, acct.token)).body;
        expect(detail.issue.title).toBe('Third (issue side)');
        expect(detail.comments.at(-1)).toMatchObject({ kind: 'field', author: { kind: 'import' }, data: { conflict: true } });
        expect(detail.comments.at(-1).body).toContain('Third (kv side)');
        expect((await run()).body).toMatchObject({ conflicts: 0, skipped: 3 });
        expect(await s.db.userKVStore.count({ where: { accountId: acct.id } })).toBe(4);
        // Concurrent imports never duplicate.
        const acct2 = await s.newAccount();
        for (const [i, id] of ids.entries()) {
            const value = Buffer.from(JSON.stringify({ schemaVersion: 1, id, title: `T${i}`, note: '', status: 'open', order: i, createdAt: 1, updatedAt: 2 }));
            await s.db.userKVStore.create({ data: { accountId: acct2.id, key: BUILTIN_TODO_PREFIX + id, value, version: 1 } });
        }
        const both = await Promise.all([1, 2].map(() => s.call('POST', '/v1/issues/import-legacy-todos', undefined, acct2.token)));
        expect(both.map(r => r.status)).toEqual([200, 200]);
        expect(await s.db.issue.count({ where: { accountId: acct2.id } })).toBe(3);
    });
});
