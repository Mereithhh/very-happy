import { describe, expect, it } from 'vitest';
import {
    buildIssueCommentPrompt, buildIssueInitialPrompt, checkAgentStatusChange, chooseIssueDelivery, formatIssueKey,
    IssueAgentCommentSchema, IssueAgentUpdateSchema, IssueAssigneeSchema, IssueCommentCreateSchema, IssueCreateSchema,
    issueFromLegacyTodo, issueShouldRun, issueStatusAfterRunFailure, issueStatusOnRunStart, IssueUpdateSchema,
    IssueUpdateToolInputSchema, ISSUE_STATUS_RULES, legacyTodoReimportAction, parseIssueRef, routeIssueComment,
    UpdateIssueBodySchema, type IssueAssigneeView,
} from './issues';

const codex: IssueAssigneeView = { kind: 'agent', machineId: 'm1', agent: 'codex' };

describe('issue keys', () => {
    it('formats and parses VH-N, bare numbers and ids', () => {
        expect(formatIssueKey(12)).toBe('VH-12');
        expect(parseIssueRef('VH-12')).toEqual({ number: 12 });
        expect(parseIssueRef('vh-7')).toEqual({ number: 7 });
        expect(parseIssueRef('#3')).toEqual({ number: 3 });
        expect(parseIssueRef('0')).toBeNull();
        expect(parseIssueRef('cmvzkq00v0hr3s22u6lxpnvo9')).toEqual({ id: 'cmvzkq00v0hr3s22u6lxpnvo9' });
        expect(parseIssueRef('not an id')).toBeNull();
    });
});

describe('agent status rules', () => {
    it('only in_progress / in_review / blocked, never on a closed issue', () => {
        expect(checkAgentStatusChange('todo', 'in_progress', null)).toEqual({ ok: true });
        expect(checkAgentStatusChange('in_progress', 'done', 'x')).toEqual({ ok: false, code: 'issue_status_forbidden' });
        expect(checkAgentStatusChange('in_progress', 'cancelled', 'x')).toEqual({ ok: false, code: 'issue_status_forbidden' });
        expect(checkAgentStatusChange('in_progress', 'todo', 'x')).toEqual({ ok: false, code: 'issue_status_forbidden' });
        expect(checkAgentStatusChange('done', 'in_progress', null)).toEqual({ ok: false, code: 'issue_closed' });
        expect(checkAgentStatusChange('cancelled', 'in_review', 'x')).toEqual({ ok: false, code: 'issue_closed' });
    });
    it('in_review and blocked need a comment', () => {
        expect(checkAgentStatusChange('in_progress', 'in_review', '  ')).toEqual({ ok: false, code: 'issue_comment_required' });
        expect(checkAgentStatusChange('in_progress', 'blocked', undefined)).toEqual({ ok: false, code: 'issue_comment_required' });
        expect(checkAgentStatusChange('in_progress', 'in_review', 'shipped, tests green')).toEqual({ ok: true });
    });
    it('agent request schemas cannot carry done', () => {
        expect(IssueAgentUpdateSchema.safeParse({ sessionId: 's1', status: 'done' }).success).toBe(false);
        expect(IssueUpdateToolInputSchema.safeParse({ status: 'cancelled' }).success).toBe(false);
        expect(IssueAgentUpdateSchema.safeParse({ sessionId: 's1' }).success).toBe(false);
        expect(IssueAgentUpdateSchema.safeParse({ sessionId: 's1', status: 'in_review', comment: 'done: x' }).success).toBe(true);
    });
});

describe('runs', () => {
    it('backlog only records ownership; self/none never run', () => {
        expect(issueShouldRun('backlog', codex)).toBe(false);
        expect(issueShouldRun('todo', codex)).toBe(true);
        expect(issueShouldRun('blocked', codex)).toBe(true);
        expect(issueShouldRun('done', codex)).toBe(false);
        expect(issueShouldRun('todo', { kind: 'self' })).toBe(false);
        expect(issueShouldRun('todo', { kind: 'future-kind', x: 1 })).toBe(false);
    });
    it('run start moves todo to in_progress only', () => {
        expect(issueStatusOnRunStart('todo')).toBe('in_progress');
        expect(issueStatusOnRunStart('in_review')).toBe('in_review');
    });
    it('failure returns in_progress to todo only when this run set it', () => {
        expect(issueStatusAfterRunFailure({ status: 'in_progress', statusRunId: 'r1' }, 'r1')).toBe('todo');
        expect(issueStatusAfterRunFailure({ status: 'in_progress', statusRunId: null }, 'r1')).toBe('in_progress');
        expect(issueStatusAfterRunFailure({ status: 'in_review', statusRunId: 'r1' }, 'r1')).toBe('in_review');
        expect(issueStatusAfterRunFailure({ status: 'blocked', statusRunId: 'r1' }, 'r1')).toBe('blocked');
    });
});

describe('comment routing', () => {
    const base = { authorKind: 'user', mentions: [], status: 'in_progress', assignee: codex } as const;
    it('without @ goes to the agent assignee while runnable', () => {
        expect(routeIssueComment({ ...base, body: 'please also fix X' })).toEqual({ kind: 'route', targets: [{ agent: 'codex', machineId: 'm1', viaMention: false }] });
        expect(routeIssueComment({ ...base, body: 'x', status: 'backlog' })).toEqual({ kind: 'none', reason: 'inactive-status' });
        expect(routeIssueComment({ ...base, body: 'x', status: 'done' })).toEqual({ kind: 'none', reason: 'inactive-status' });
        expect(routeIssueComment({ ...base, body: 'x', assignee: { kind: 'self' } })).toEqual({ kind: 'none', reason: 'no-agent-assignee' });
    });
    it('/note and agent comments never route', () => {
        expect(routeIssueComment({ ...base, body: '/note remember this' })).toEqual({ kind: 'none', reason: 'note' });
        expect(routeIssueComment({ ...base, body: '  /note\nmulti' })).toEqual({ kind: 'none', reason: 'note' });
        expect(routeIssueComment({ ...base, body: '/notebook is fine' }).kind).toBe('route');
        expect(routeIssueComment({ ...base, authorKind: 'agent', body: 'x' })).toEqual({ kind: 'none', reason: 'not-human' });
    });
    it('@ routes to each mentioned agent, even on a closed issue, deduped', () => {
        const r = routeIssueComment({ ...base, status: 'done', body: '@claude look', mentions: [{ kind: 'agent', agent: 'claude' }, { kind: 'agent', agent: 'claude' }, { kind: 'agent', agent: 'codex' }] });
        expect(r).toEqual({ kind: 'route', targets: [{ agent: 'claude', machineId: null, viaMention: true }, { agent: 'codex', machineId: 'm1', viaMention: true }] });
    });
    it('human comment schema refuses owner mentions', () => {
        expect(IssueCommentCreateSchema.safeParse({ body: 'hi', mentions: [{ kind: 'owner' }] }).success).toBe(false);
        expect(IssueCommentCreateSchema.safeParse({ body: '  ' }).success).toBe(false);
        expect(IssueAgentCommentSchema.safeParse({ sessionId: 's', body: 'need a key', mentionOwner: true }).success).toBe(true);
    });
});

describe('merge vs new session', () => {
    const target = { agent: 'codex', machineId: 'm1', viaMention: false };
    const run = (id: string, status: string, sessionId: string | null, createdAt: number) => ({ id, status, agent: 'codex', machineId: 'm1', sessionId, createdAt });
    it('joins the newest live active run as a message', () => {
        expect(chooseIssueDelivery(target, [run('a', 'idle', 's1', 1), run('b', 'running', 's2', 2)], () => true)).toEqual({ mode: 'message', runId: 'b' });
    });
    it('a queued run absorbs the comment', () => {
        expect(chooseIssueDelivery(target, [run('a', 'queued', null, 1)], () => true)).toEqual({ mode: 'absorbed', runId: 'a' });
    });
    it('spawns when no active run is live or the agent differs', () => {
        expect(chooseIssueDelivery(target, [run('a', 'idle', 's1', 1)], () => false)).toEqual({ mode: 'spawn' });
        expect(chooseIssueDelivery(target, [run('a', 'ended', 's1', 1), run('b', 'superseded', 's2', 2)], () => true)).toEqual({ mode: 'spawn' });
        expect(chooseIssueDelivery({ ...target, agent: 'claude' }, [run('a', 'running', 's1', 1)], () => true)).toEqual({ mode: 'spawn' });
    });
});

describe('schemas', () => {
    it('assignee: agent needs a machine and an assignable agent; team is parseable (refused by the server)', () => {
        expect(IssueAssigneeSchema.safeParse({ kind: 'agent', machineId: 'm', agent: 'codex', agentProfile: null, model: 'gpt-5.5' }).success).toBe(true);
        expect(IssueAssigneeSchema.safeParse({ kind: 'agent', machineId: 'm', agent: 'openclaw' }).success).toBe(false);
        expect(IssueAssigneeSchema.safeParse({ kind: 'agent', agent: 'codex' }).success).toBe(false);
        expect(IssueAssigneeSchema.safeParse({ kind: 'team', teamId: 't' }).success).toBe(true);
    });
    it('create / update are strict about values, open about absence', () => {
        expect(IssueCreateSchema.safeParse({ title: 'x' }).success).toBe(true);
        expect(IssueCreateSchema.safeParse({ title: ' ' }).success).toBe(false);
        expect(IssueCreateSchema.safeParse({ title: 'x', status: 'review' }).success).toBe(false);
        expect(IssueCreateSchema.safeParse({ title: 'x', labels: Array(17).fill('a') }).success).toBe(false);
        expect(IssueUpdateSchema.safeParse({ status: 'done', ifVersion: 3 }).success).toBe(true);
        expect(IssueCreateSchema.safeParse({ title: 'x', description: '字'.repeat(11000) }).success).toBe(false);
    });
    it('update body tolerates fields a newer server adds', () => {
        expect(UpdateIssueBodySchema.safeParse({ t: 'issue', issue: { id: 'i', version: 2, futureField: 1 } }).success).toBe(true);
    });
});

describe('prompts', () => {
    const issue = { key: 'VH-3', title: 'Fix login', description: 'Steps…', status: 'todo', priority: 'high', labels: ['web'], dueAt: null };
    it('initial prompt carries the issue, recent comments and the rules', () => {
        const text = buildIssueInitialPrompt({ issue, trigger: 'assign', comments: [{ kind: 'status', author: { kind: 'system' }, body: 'todo', createdAt: 1 }, { kind: 'comment', author: { kind: 'user' }, body: 'use the staging db', createdAt: 2 }] });
        expect(text).toContain('VH-3: Fix login');
        expect(text).toContain('[owner] use the staging db');
        expect(text).not.toContain('[system]');
        expect(text.endsWith(ISSUE_STATUS_RULES)).toBe(true);
        expect(ISSUE_STATUS_RULES).toContain('Never try to set "done"');
    });
    it('comment prompt ends with the one-line reminder', () => {
        expect(buildIssueCommentPrompt({ issue, comment: { kind: 'comment', author: { kind: 'user' }, body: 'also X', createdAt: 1 } })).toMatch(/also X\n\nReply on the issue/);
    });
});

describe('legacy todo import', () => {
    const todo = { schemaVersion: 1 as const, id: '0b5c1d2e-1111-4222-8333-944455556666', title: 'Buy milk', note: 'oat', status: 'done' as const, order: 2, createdAt: 10, updatedAt: 20 };
    it('maps open → todo, done → done, unassigned', () => {
        expect(issueFromLegacyTodo(todo, 4)).toMatchObject({ legacyTodoId: todo.id, legacyTodoVersion: 4, status: 'done', completedAt: 20, assignee: { kind: 'none' }, description: 'oat' });
        expect(issueFromLegacyTodo({ ...todo, status: 'open' }, 1)).toMatchObject({ status: 'todo', completedAt: null });
    });
    it('re-run: skip unchanged, update untouched, conflict when both changed', () => {
        expect(legacyTodoReimportAction({ kvVersion: 3, importedVersion: 3, issueChangedSinceImport: true })).toBe('skip');
        expect(legacyTodoReimportAction({ kvVersion: 4, importedVersion: 3, issueChangedSinceImport: false })).toBe('update');
        expect(legacyTodoReimportAction({ kvVersion: 4, importedVersion: 3, issueChangedSinceImport: true })).toBe('conflict');
    });
});
