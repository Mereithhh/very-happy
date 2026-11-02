import { describe, expect, it, vi } from 'vitest';
import type { IssueCommentView, IssueSessionContext, IssueView } from '@slopus/happy-wire';
import { createIssuesClient, issueConflictBackoffMs, IssueRequestError, IssuesUnsupportedError, ISSUE_CONFLICT_MAX_RETRIES, ISSUES_UNSUPPORTED_BACKOFF_MS } from './client';
import { createIssueToolExecutor, ISSUE_TOOL_NAMES, ISSUE_TOOL_SCHEMAS, registerIssueTools } from './tools';
import { describeIssueError } from './format';
import { buildIssueDigestLine, createIssueDigest } from './digest';
import { issueSessionMetadata } from './sessionMetadata';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const issue = (over: Partial<IssueView> = {}): IssueView => ({
    id: 'i1', number: 12, key: 'VH-12', title: 'Fix it', description: 'desc', status: 'in_progress', priority: 'none',
    assignee: { kind: 'agent', agent: 'codex', machineId: 'm1' }, projectId: null, labels: [], dueAt: null, parentId: null, sortOrder: 0,
    createdBy: { kind: 'user' }, statusRunId: null, latestRunId: null, legacyTodoId: null, createdAt: 1, updatedAt: 1, statusChangedAt: 1,
    startedAt: null, completedAt: null, deletedAt: null, version: 1, ...over,
});
const entry = (over: Partial<IssueCommentView>): IssueCommentView => ({
    id: 'c', issueId: 'i1', kind: 'comment', author: { kind: 'user' }, body: '', data: null, mentions: [], refSessionId: null,
    routedRunIds: [], ownerAckedAt: null, createdAt: 1, editedAt: null, deletedAt: null, ...over,
});
const ctx = (over: Partial<IssueSessionContext> = {}): IssueSessionContext => ({ issue: issue(), run: null, current: true, comments: [], asOf: 100, ...over });

describe('issues client compatibility (spec §9 compat matrix)', () => {
    it('an old server (unknown route) and the switch off (issues_disabled) both disable the client for 10 minutes', async () => {
        for (const body of [{ message: 'Route GET:/v1/issues not found', error: 'Not Found', statusCode: 404 }, { error: 'issues_disabled' }]) {
            let t = 0;
            const fetch = vi.fn(async () => res(404, body));
            const c = createIssuesClient({ serverUrl: 'http://x', token: async () => 't', fetch: fetch as any, now: () => t });
            await expect(c.poll('m')).rejects.toBeInstanceOf(IssuesUnsupportedError);
            await expect(c.list()).rejects.toBeInstanceOf(IssuesUnsupportedError);
            expect(fetch).toHaveBeenCalledTimes(1);
            t = ISSUES_UNSUPPORTED_BACKOFF_MS - 1;
            expect(c.isDisabled()).toBe(true);
            t = ISSUES_UNSUPPORTED_BACKOFF_MS + 1;
            expect(c.isDisabled()).toBe(false);
        }
    });
    it('a 404 naming an issue object and 409/400/429 keep the server code', async () => {
        const c = createIssuesClient({ serverUrl: 'http://x', token: async () => 't', fetch: (async () => res(404, { error: 'issue_not_found' })) as any });
        await expect(c.get('VH-9')).rejects.toMatchObject({ status: 404, code: 'issue_not_found' });
        expect(c.isDisabled()).toBe(false);
        for (const [status, code] of [[409, 'issue_status_forbidden'], [409, 'issue_closed'], [409, 'issue_not_bound'], [409, 'issue_run_not_current'], [400, 'issue_comment_required'], [429, 'issue_comment_quota_exceeded']] as const) {
            const d = createIssuesClient({ serverUrl: 'http://x', token: async () => 't', fetch: (async () => res(status, { error: code })) as any });
            await expect(d.agentUpdate({ sessionId: 's', status: 'done' })).rejects.toMatchObject({ status, code });
        }
    });
    it('409 transaction_conflict is resent with the same body (same requestId) after ~200ms·2ⁿ + jitter, then succeeds (spec §9 B-872c)', async () => {
        const bodies: string[] = [];
        let calls = 0;
        const fetch = vi.fn(async (_url: string, init: RequestInit) => {
            bodies.push(String(init.body));
            return ++calls <= 3 ? res(409, { error: 'transaction_conflict' }) : res(200, { issue: issue(), version: 1 });
        });
        const sleep = vi.fn(async (_ms: number) => {});
        const c = createIssuesClient({ serverUrl: 'http://x', token: async () => 't', fetch: fetch as any, sleep, random: () => 0.5 });
        await expect(c.agentComment({ sessionId: 's', body: 'hi', requestId: 'req-1' })).resolves.toMatchObject({ version: 1 });
        expect(fetch).toHaveBeenCalledTimes(4);
        expect(new Set(bodies)).toEqual(new Set([JSON.stringify({ sessionId: 's', body: 'hi', requestId: 'req-1' })]));
        expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1000]);
        expect(issueConflictBackoffMs(0, () => 0)).toBe(200);
        expect(issueConflictBackoffMs(2, () => 0.999)).toBeLessThan(1200);
    });
    it('transaction_conflict gives up after 5 retries and surfaces the code; other 409s are never retried', async () => {
        const conflict = vi.fn(async () => res(409, { error: 'transaction_conflict' }));
        const c = createIssuesClient({ serverUrl: 'http://x', token: async () => 't', fetch: conflict as any, sleep: async () => {} });
        await expect(c.create({ title: 'x', requestId: 'r' } as any)).rejects.toMatchObject({ status: 409, code: 'transaction_conflict' });
        expect(conflict).toHaveBeenCalledTimes(1 + ISSUE_CONFLICT_MAX_RETRIES);
        for (const code of ['issue_version_conflict', 'issue_dispatch_claim_mismatch', 'attention_item_stale', 'issue_status_forbidden']) {
            const fetch = vi.fn(async () => res(409, { error: code }));
            const sleep = vi.fn(async () => {});
            const d = createIssuesClient({ serverUrl: 'http://x', token: async () => 't', fetch: fetch as any, sleep });
            await expect(d.update('i1', { ifVersion: 1, status: 'done' } as any)).rejects.toMatchObject({ status: 409, code });
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        }
    });
    it('daemon routes: poll carries machineId + workerVersion, claim/complete/fail/session-event post the wire bodies', async () => {
        const fetch = vi.fn(async (_url: string, _init: RequestInit) => res(200, { ok: true, dispatches: [], dispatch: {} }));
        const c = createIssuesClient({ serverUrl: 'http://x', token: async () => 'tok', fetch: fetch as any });
        await c.poll('m 1');
        await c.claim('d1', 'm1');
        await c.complete('d1', { machineId: 'm1', claimId: 'k', sessionId: 's' });
        await c.fail('d1', { machineId: 'm1', claimId: 'k', error: 'e', unknown: true });
        await c.sessionEvent('r1', { machineId: 'm1', sessionId: 's', event: 'idle' });
        expect(fetch.mock.calls.map(([url, init]) => [init.method, url, init.body ? JSON.parse(String(init.body)) : null])).toEqual([
            ['GET', 'http://x/v1/issues/dispatch?machineId=m+1&workerVersion=1', null],
            ['POST', 'http://x/v1/issues/dispatch/d1/claim', { machineId: 'm1' }],
            ['POST', 'http://x/v1/issues/dispatch/d1/complete', { machineId: 'm1', claimId: 'k', sessionId: 's' }],
            ['POST', 'http://x/v1/issues/dispatch/d1/fail', { machineId: 'm1', claimId: 'k', error: 'e', unknown: true }],
            ['POST', 'http://x/v1/issues/runs/r1/session-event', { machineId: 'm1', sessionId: 's', event: 'idle' }],
        ]);
        expect((fetch.mock.calls[0][1].headers as any).authorization).toBe('Bearer tok');
    });
});

describe('issue_* MCP tools (spec §4)', () => {
    const fake = () => ({
        session: vi.fn(async () => ctx()), get: vi.fn(async () => ({ issue: issue(), comments: [], runs: [], children: [] })),
        agentUpdate: vi.fn(async (input: any) => ({ issue: issue({ status: input.status ?? 'in_progress' }) })),
        agentComment: vi.fn(async () => ({ issue: issue(), comment: entry({}) })),
        list: vi.fn(async () => ({ issues: [issue()], nextCursor: null, asOf: 1 })),
    });
    it('are the four spec tools; issue_update.status is a free string so done reaches the server', () => {
        expect([...ISSUE_TOOL_NAMES]).toEqual(['issue_get', 'issue_update', 'issue_comment', 'issue_list']);
        expect(ISSUE_TOOL_SCHEMAS.issue_update.inputSchema.status.safeParse('done').success).toBe(true);
    });
    it('writes are stamped with the wrapper session id (the agent cannot choose it)', async () => {
        const client = fake();
        const run = createIssueToolExecutor(() => 'sess-1', { client: client as any, scoped: () => false });
        await run('issue_update', { status: 'in_review', comment: 'done + verified', sessionId: 'other' });
        await run('issue_comment', { body: 'hi', mention_owner: true });
        expect(client.agentUpdate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1', status: 'in_review', comment: 'done + verified' }));
        expect(client.agentComment).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1', body: 'hi', mentionOwner: true }));
    });
    it('a refused done comes back as an MCP error carrying the server code', async () => {
        const client = { ...fake(), agentUpdate: vi.fn(async () => { throw new IssueRequestError(409, 'issue_status_forbidden', {}); }) };
        const tools = new Map<string, (args: any) => Promise<any>>();
        registerIssueTools({ registerTool: (name: string, _spec: unknown, fn: any) => tools.set(name, fn) } as any, createIssueToolExecutor(() => 's', { client: client as any, scoped: () => false }));
        const out = await tools.get('issue_update')!({ status: 'done' });
        expect(out.isError).toBe(true);
        expect(out.content[0].text).toMatch(/^issue_status_forbidden: .*Only the owner sets done/);
        expect(client.agentUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }));
    });
    it('issue_get: bound issue by default; unbound without an argument is issue_not_bound; scoped sessions read only their own', async () => {
        const client = fake();
        const run = createIssueToolExecutor(() => 's', { client: client as any, scoped: () => false });
        expect((await run('issue_get', {})).text).toContain('VH-12: Fix it');
        client.session.mockResolvedValue(ctx({ issue: null }));
        await expect(run('issue_get', {})).rejects.toThrow(/^issue_not_bound/);
        expect((await run('issue_get', { issue: 'VH-3' })).text).toContain('VH-12');
        const scoped = createIssueToolExecutor(() => 's', { client: client as any, scoped: () => true });
        await expect(scoped('issue_get', { issue: 'VH-3' })).rejects.toThrow(/^issue_not_bound/);
        await expect(scoped('issue_list', {})).rejects.toThrow(/^issue_not_bound/);
    });
    it('error text: every agent-facing code is `<code>: <sentence>`; unsupported says so', () => {
        for (const code of ['issue_status_forbidden', 'issue_closed', 'issue_comment_required', 'issue_not_bound', 'issue_run_not_current', 'issue_comment_quota_exceeded']) {
            expect(describeIssueError(new IssueRequestError(409, code, {}))).toMatch(new RegExp(`^${code}: \\S`));
        }
        expect(describeIssueError(new IssueRequestError(409, 'issue_run_not_current', { message: 'This issue has moved to a newer run; stop changing it.' }))).toBe('issue_run_not_current: This issue has moved to a newer run; stop changing it.');
        expect(describeIssueError(new IssueRequestError(429, null, {}))).toMatch(/^rate_limited:/);
        expect(describeIssueError(new IssuesUnsupportedError())).toMatch(/^issues_unsupported:/);
    });
});

describe('next-turn issue digest (spec §5 layer 3)', () => {
    it('only owner changes count: status (first from → now), assignee, fields; comments and agent entries never', () => {
        const line = buildIssueDigestLine(issue({ status: 'todo' }), [
            entry({ kind: 'status', data: { from: 'in_review', to: 'blocked' } }),
            entry({ kind: 'status', data: { from: 'blocked', to: 'todo' } }),
            entry({ kind: 'field', data: { fields: ['description'] } }),
            entry({ kind: 'assign' }),
            entry({ kind: 'comment', body: 'hello' }),
            entry({ kind: 'status', author: { kind: 'agent' }, data: { from: 'x', to: 'y' } }),
        ]);
        expect(line).toBe('[Issue VH-12 now todo (in_review → todo by owner); assignee changed; description updated]');
        expect(buildIssueDigestLine(issue(), [entry({ kind: 'comment' }), entry({ kind: 'status', author: { kind: 'agent' } })])).toBeNull();
    });
    it('first turn only sets the cursor; later turns fetch since it and prepend ≤1 line; failures send unchanged', async () => {
        const session = vi.fn(async (_sid: string, since?: number) => since === undefined ? ctx({ asOf: 100 }) : ctx({ asOf: 200, issue: issue({ status: 'todo' }), comments: [entry({ kind: 'status', data: { from: 'in_review', to: 'todo' } })] }));
        const d = createIssueDigest({ sessionId: () => 's', enabled: () => true, client: { session, isDisabled: () => false } as any });
        expect(await d.decorate('first')).toBe('first');
        expect(await d.decorate('second')).toBe('[Issue VH-12 now todo (in_review → todo by owner)]\nsecond');
        expect(session).toHaveBeenLastCalledWith('s', 100, 1500);
        session.mockRejectedValueOnce(new Error('timeout'));
        expect(await d.decorate('third')).toBe('third');
        const off = createIssueDigest({ sessionId: () => 's', enabled: () => false, client: { session, isDisabled: () => false } as any });
        session.mockClear();
        expect(await off.decorate('x')).toBe('x');
        expect(session).not.toHaveBeenCalled();
    });
});

describe('metadata.issue from the spawn env', () => {
    it('takes id / runId / key, ignoring malformed values', () => {
        expect(issueSessionMetadata({ VH_ISSUE_ID: 'i-1', VH_ISSUE_RUN_ID: 'r-1', VH_ISSUE_KEY: 'VH-7' })).toEqual({ issue: { id: 'i-1', runId: 'r-1', key: 'VH-7' } });
        expect(issueSessionMetadata({ VH_ISSUE_ID: 'i-1', VH_ISSUE_KEY: 'rm -rf' })).toEqual({ issue: { id: 'i-1' } });
        expect(issueSessionMetadata({})).toEqual({});
    });
});
