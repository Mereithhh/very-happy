import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiUpdateContainerSchema } from './apiTypes';

vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => ({ credentials: { token: 't' } }) }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://test.invalid' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'test' }));
const attention = vi.hoisted(() => ({ respond: vi.fn() }));
vi.mock('./apiAttention', () => ({ respondToAttentionItem: attention.respond, listAttentionItems: vi.fn(), isAttentionDisabled: () => false }));

import { setIssuesTransport, IssuesApiError, isIssuesUnavailable } from './apiIssues';
import { createFakeIssuesServer } from './issuesFake';
import { useAttentionStore } from './attentionStore';
import {
    _forTests, lookupSessionIssue, settleIssueReview, acceptIssue, applyIssueRunUpdate, applyIssueUpdate, createIssue, loadIssueDetail, loadIssues, mergeIssue, mergeRun, probeIssues,
    returnIssue, startIssueRun, updateIssue, useIssuesStore,
} from './issuesStore';

const codex = { kind: 'agent', machineId: 'm1', agent: 'codex' } as const;

beforeEach(() => { _forTests.reset(); });
afterEach(() => { setIssuesTransport(null); _forTests.reset(); });

function useFake(enabled = true, latestRuns = true) {
    const server = createFakeIssuesServer({ enabled, latestRuns });
    setIssuesTransport(server.transport);
    server.subscribe((u) => { if (u.t === 'issue') applyIssueUpdate(u.issue); else if (u.t === 'issue-run') applyIssueRunUpdate(u.run); });
    return server;
}

describe('B-873 gate (spec §9: GET /v1/issues?limit=1)', () => {
    it('answering = enabled', async () => {
        useFake(true);
        expect(await probeIssues()).toBe('enabled');
        expect(useIssuesStore.getState().availability).toBe('enabled');
    });
    it('404 issues_disabled = disabled; nothing loads', async () => {
        const server = useFake(false);
        const list = vi.spyOn(server, 'transport');
        expect(await probeIssues()).toBe('disabled');
        await loadIssues();
        expect(useIssuesStore.getState().issues).toEqual({});
        expect(list).not.toHaveBeenCalled();
    });
    it("an older server's unknown route (Fastify `Not Found`) = disabled too", async () => {
        setIssuesTransport(async () => ({ status: 404, data: { error: 'Not Found' } }));
        expect(await probeIssues()).toBe('disabled');
    });
    it('network trouble / 500 stays unknown: the old UI stays, the next resume asks again', async () => {
        setIssuesTransport(async () => ({ status: 503, data: { error: 'unavailable' } }));
        expect(await probeIssues()).toBe('unknown');
        expect(useIssuesStore.getState().availability).toBe('unknown');
    });
    it('object 404s are not "disabled"', () => {
        expect(isIssuesUnavailable(new IssuesApiError(404, 'issue_not_found'))).toBe(false);
        expect(isIssuesUnavailable(new IssuesApiError(404, 'issues_disabled'))).toBe(true);
    });
});

describe('B-873 merge rules', () => {
    it('keeps the highest issue version (socket snapshot racing a fetch)', () => {
        const v2 = { id: 'a', version: 2, title: 'new' } as never;
        const v1 = { id: 'a', version: 1, title: 'old' } as never;
        expect(mergeIssue(mergeIssue({}, v2), v1).a).toBe(v2);
        expect(mergeIssue(mergeIssue({}, v1), v2).a).toBe(v2);
    });
    it('a run snapshot behind on every server timestamp is stale', () => {
        const ended = { id: 'r', endedAt: 5, startedAt: 2, claimedAt: 1, failureAckedAt: null, status: 'ended' } as never;
        const running = { id: 'r', endedAt: null, startedAt: 2, claimedAt: 1, failureAckedAt: null, status: 'running' } as never;
        expect(mergeRun(mergeRun({}, ended), running).r).toBe(ended);
        expect(mergeRun(mergeRun({}, running), ended).r).toBe(ended);
    });
});

describe('B-873 load + mutations against the contract fake', () => {
    it('full load, then incremental with updatedSince=<asOf> including tombstones', async () => {
        const server = useFake();
        await probeIssues();
        await createIssue({ title: 'one' });
        await loadIssues({ full: true });
        const calls: string[] = [];
        setIssuesTransport(async (m, p, b) => { calls.push(`${m} ${p}`); return server.transport(m, p, b); });
        await loadIssues();
        expect(calls[0]).toMatch(/^GET \?limit=500&updatedSince=\d+&includeDeleted=1$/);
    });
    it('create with an agent assignee starts run 1 (wire issueShouldRun); backlog only records the owner', async () => {
        const server = useFake();
        await probeIssues();
        const a = await createIssue({ title: 'agent', assignee: codex });
        expect(a.status).toBe('todo');
        expect(Object.values(useIssuesStore.getState().runs).filter((r) => r.issueId === a.id)).toHaveLength(1);
        const b = await createIssue({ title: 'later', assignee: codex, status: 'backlog' });
        expect(server.runs().filter((r) => r.issueId === b.id)).toHaveLength(0);
        // moving it to todo starts the run (spec §3.1)
        await updateIssue(b.id, { status: 'todo' });
        expect(server.runs().filter((r) => r.issueId === b.id)).toHaveLength(1);
    });
    it('完成 → done; 退回 → todo plus my note as a comment routed back to the agent', async () => {
        const server = useFake();
        await probeIssues();
        const a = await createIssue({ title: 'agent', assignee: codex });
        const runId = server.runs()[0].id;
        server.agent.start(runId, 'sess');
        expect(server.agent.setStatus(runId, 'in_review')).toEqual({ ok: false, code: 'issue_comment_required' });
        expect(server.agent.setStatus(runId, 'done', 'x')).toEqual({ ok: false, code: 'issue_status_forbidden' });
        server.agent.setStatus(runId, 'in_review', 'delivered');
        await returnIssue(a.id, 'needs a test');
        const after = server.issues().find((i) => i.id === a.id)!;
        expect(after.status).toBe('todo');
        const note = server.comments(a.id).find((c) => c.kind === 'comment' && c.body === 'needs a test')!;
        expect(note.routedRunIds).toEqual([runId]);
        server.agent.setStatus(runId, 'in_review', 'test added');
        await acceptIssue(a.id);
        expect(server.issues().find((i) => i.id === a.id)!.status).toBe('done');
    });
    it('a failed spawn puts its in_progress back to todo; retry starts a new run and supersedes nothing live', async () => {
        const server = useFake();
        await probeIssues();
        const a = await createIssue({ title: 'agent', assignee: codex });
        const runId = server.runs()[0].id;
        server.agent.start(runId, 'sess');
        server.agent.fail(runId, 'boom');
        expect(server.issues().find((i) => i.id === a.id)!.status).toBe('todo');
        await startIssueRun(a.id, {});
        expect(server.runs().filter((r) => r.issueId === a.id).map((r) => r.status).sort()).toEqual(['failed', 'queued']);
    });
    it('detail by key fills comments and runs', async () => {
        useFake();
        await probeIssues();
        const a = await createIssue({ title: 'agent', assignee: codex });
        await loadIssueDetail(a.key);
        const state = useIssuesStore.getState();
        expect(state.details[a.id].status).toBe('ready');
        expect(Object.values(state.details[a.id].comments).some((c) => c.kind === 'run')).toBe(true);
    });
});

describe('B-873 socket updates reach the store (sync.ts → issuesStore)', () => {
    it('the three update bodies pass the update container schema (an unparsed update is dropped)', () => {
        for (const body of [
            { t: 'issue', issue: { id: 'i', version: 1, title: 'x' } },
            { t: 'issue-comment', comment: { id: 'c', issueId: 'i', body: 'x' } },
            { t: 'issue-run', run: { id: 'r', issueId: 'i', status: 'running' } },
        ]) expect(ApiUpdateContainerSchema.safeParse({ id: 'u', seq: 1, body, createdAt: 1 }).success).toBe(true);
    });
});

describe('B-872/B-873 完成 / 退回 go through the review item when the 汇报板 has it', () => {
    it('owner-respond choose done|return with the note; no direct PATCH', async () => {
        const server = useFake();
        await probeIssues();
        const a = await createIssue({ title: 'agent', assignee: codex });
        const item = { id: 'att1', sessionId: 's', key: `issue-review:${a.id}`, state: 'open', version: 1, links: [{ type: 'issue', ref: a.id, label: a.key }] };
        useAttentionStore.setState({ bySession: { s: [item as never] } });
        attention.respond.mockResolvedValue({ item: { ...item, state: 'resolved', version: 2 } });
        const patch = vi.spyOn(server, 'transport');
        setIssuesTransport(patch as never);
        await settleIssueReview(a.id, 'return', ' needs a test ');
        expect(attention.respond).toHaveBeenCalledWith('att1', { action: 'choose', choice: 'return', note: 'needs a test' });
        expect(patch.mock.calls.some(([m]) => m === 'PATCH')).toBe(false);
        expect(useAttentionStore.getState().bySession.s[0].state).toBe('resolved');
        useAttentionStore.setState({ bySession: {} });
    });
    it('without the item (board off): the same outcome written on the issue', async () => {
        const server = useFake();
        await probeIssues();
        attention.respond.mockReset();
        const a = await createIssue({ title: 'x', status: 'in_review' });
        await acceptIssue(a.id);
        expect(attention.respond).not.toHaveBeenCalled();
        expect(server.issues()[0].status).toBe('done');
    });
});

describe('B-873b list latestRuns (B-872 e1fabb3a) with an older-server fallback', () => {
    async function seed(latestRuns: boolean) {
        const server = useFake(true, latestRuns);
        await probeIssues();
        const a = await createIssue({ title: 'agent', assignee: codex });
        server.agent.start(server.runs()[0].id, 'sess');
        _forTests.reset();
        const calls: string[] = [];
        setIssuesTransport(async (m, p, b) => { calls.push(`${m} ${p}`); return server.transport(m, p, b); });
        await probeIssues();
        await loadIssues({ full: true });
        for (let i = 0; i < 5; i++) await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        return { a, calls, server };
    }
    it('a server that sends latestRuns: runs land from the list, no per-issue detail fetch', async () => {
        const { a, calls } = await seed(true);
        expect(Object.values(useIssuesStore.getState().runs).map((r) => [r.issueId, r.status])).toEqual([[a.id, 'running']]);
        expect(calls.filter((c) => /^GET \/[^?]/.test(c))).toEqual([]);
    });
    it('an older server without the field: the open issues still get their details fetched', async () => {
        const { a, calls } = await seed(false);
        expect(calls).toContain(`GET /${a.id}`);
        expect(Object.values(useIssuesStore.getState().runs).map((r) => r.issueId)).toEqual([a.id]);
    });
});

describe('B-873b session header lookup (GET /v1/issues/session/:sid)', () => {
    it('one request per session; the binding lands in the store; 「not bound」 is remembered', async () => {
        const server = useFake();
        await probeIssues();
        const a = await createIssue({ title: 'agent', assignee: codex });
        server.agent.start(server.runs()[0].id, 'sess');
        useIssuesStore.setState({ runs: {}, issues: {} });
        const calls: string[] = [];
        setIssuesTransport(async (m, p, b) => { calls.push(`${m} ${p}`); return server.transport(m, p, b); });
        await lookupSessionIssue('sess');
        await lookupSessionIssue('sess');
        await lookupSessionIssue('plain');
        await lookupSessionIssue('plain');
        expect(calls.map((c) => c.replace(/since=\d+/, 'since=N'))).toEqual(['GET /session/sess?since=N', 'GET /session/plain?since=N']);
        const state = useIssuesStore.getState();
        expect(state.issues[a.id]?.key).toBe(a.key);
        expect(Object.values(state.runs).map((r) => r.sessionId)).toEqual(['sess']);
    });
    it('switch off: nothing is asked', async () => {
        const server = useFake(false);
        await probeIssues();
        const spy = vi.spyOn(server, 'transport');
        setIssuesTransport(spy as never);
        await lookupSessionIssue('sess');
        expect(spy).not.toHaveBeenCalled();
    });
    it('network trouble is retried on the next open', async () => {
        useFake();
        await probeIssues();
        let calls = 0;
        setIssuesTransport(async () => { calls += 1; throw new Error('offline'); });
        await lookupSessionIssue('sess');
        await lookupSessionIssue('sess');
        expect(calls).toBe(2);
    });
});
