import { describe, expect, it } from 'vitest';
import type { IssueRunView, IssueView } from '@slopus/happy-wire';
import {
    agentIdleStillInProgress, commentTriggerPreview, EMPTY_FILTER, failedRunsNeedingYou, filterFromSearch, filterToSearch, groupByStatus,
    ISSUE_WORKER_FRESH_MS, machineWorkerState, matchesFilter, matchIssues, mentionCandidates, myIssues, sortOrderBetween, toggleMention,
    usedLabels, waitingOnMeCount, runIsWorking, findIssue, mentionQuery,
} from './issuesModel';

let n = 0;
export function issue(over: Partial<IssueView> = {}): IssueView {
    n += 1;
    return {
        id: `i${n}`, number: n, key: `VH-${n}`, title: `Issue ${n}`, description: '', status: 'todo', priority: 'none', assignee: { kind: 'none' },
        projectId: null, labels: [], dueAt: null, parentId: null, sortOrder: 0, createdBy: { kind: 'user' }, statusRunId: null, latestRunId: null,
        legacyTodoId: null, createdAt: n, updatedAt: n, statusChangedAt: n, startedAt: null, completedAt: null, deletedAt: null, version: 1, ...over,
    };
}
export function run(over: Partial<IssueRunView> = {}): IssueRunView {
    n += 1;
    return {
        id: `r${n}`, issueId: 'i1', seq: 1, trigger: 'assign', triggerCommentId: null, status: 'running', agent: 'codex', machineId: 'm1',
        agentProfile: undefined, model: null, permissionMode: null, directory: '/repo', sessionId: `s${n}`, error: null, failureAckedAt: null,
        createdAt: n, claimedAt: null, startedAt: null, endedAt: null, ...over,
    };
}
const codex = { kind: 'agent', machineId: 'm1', agent: 'codex' } as const;

describe('B-873 list / board grouping', () => {
    it('groups by status in wire order, unknown statuses under 「其他」 last, tombstones out', () => {
        const groups = groupByStatus([issue({ status: 'done' }), issue({ status: 'shipped' }), issue({ status: 'todo' }), issue({ status: 'todo', deletedAt: 5 })]);
        expect(groups.map((g) => g.status)).toEqual(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled', 'other']);
        expect(groups.find((g) => g.status === 'todo')!.issues).toHaveLength(1);
        expect(groups.find((g) => g.status === 'other')!.issues.map((i) => i.status)).toEqual(['shipped']);
    });
    it('board drop: fractional order between neighbours, before the first, after the last', () => {
        expect(sortOrderBetween(1, 2)).toBe(1.5);
        expect(sortOrderBetween(undefined, 4)).toBe(3);
        expect(sortOrderBetween(4, undefined)).toBe(5);
        expect(sortOrderBetween(null, null)).toBe(0);
    });
});

describe('B-873 filters', () => {
    const a = issue({ status: 'in_review', projectId: 'p1', assignee: codex, labels: ['bug'], priority: 'high', title: 'Fix login' });
    const b = issue({ status: 'backlog', assignee: { kind: 'self' }, labels: ['docs'] });
    it('every chip narrows, values within one chip are OR', () => {
        expect(matchesFilter(a, { ...EMPTY_FILTER, status: ['in_review'] })).toBe(true);
        expect(matchesFilter(a, { ...EMPTY_FILTER, projectId: ['none'] })).toBe(false);
        expect(matchesFilter(b, { ...EMPTY_FILTER, projectId: ['none'] })).toBe(true);
        expect(matchesFilter(a, { ...EMPTY_FILTER, assignee: ['agent:codex', 'self'] })).toBe(true);
        expect(matchesFilter(b, { ...EMPTY_FILTER, assignee: ['none'] })).toBe(false);
        expect(matchesFilter(a, { ...EMPTY_FILTER, label: ['docs'] })).toBe(false);
        expect(matchesFilter(a, { ...EMPTY_FILTER, priority: ['high'] })).toBe(true);
        expect(matchesFilter(a, { ...EMPTY_FILTER, q: 'login' })).toBe(true);
        expect(matchesFilter(a, { ...EMPTY_FILTER, q: a.key.toLowerCase() })).toBe(true);
    });
    it('the URL carries the filter; /todos lands on assignee=none', () => {
        const f = filterFromSearch('?assignee=none');
        expect(f.assignee).toEqual(['none']);
        expect(filterFromSearch(filterToSearch({ ...EMPTY_FILTER, status: ['todo', 'blocked'], label: ['a b'], q: 'x' }, { tab: 'waiting' }))).toEqual({ ...EMPTY_FILTER, status: ['todo', 'blocked'], label: ['a b'], q: 'x' });
        expect(filterToSearch(EMPTY_FILTER)).toBe('');
    });
    it('label candidates are the values in use', () => {
        expect(usedLabels([a, b, issue({ labels: ['bug'] })])).toEqual(['bug', 'docs']);
    });
});

describe('B-873 runs and markers', () => {
    it('Q7: agent idle (or its session ended) while the issue is still in_progress → 「agent 空闲 · 仍进行中」', () => {
        const r = run({ id: 'rx', status: 'idle' });
        expect(agentIdleStillInProgress(issue({ status: 'in_progress', latestRunId: 'rx' }), [r])).toBe(true);
        expect(agentIdleStillInProgress(issue({ status: 'in_progress', latestRunId: 'rx' }), [{ ...r, status: 'ended' }])).toBe(true);
        expect(agentIdleStillInProgress(issue({ status: 'in_progress', latestRunId: 'rx' }), [{ ...r, status: 'running' }])).toBe(false);
        expect(agentIdleStillInProgress(issue({ status: 'in_review', latestRunId: 'rx' }), [r])).toBe(false);
        expect(runIsWorking({ ...r, status: 'queued' })).toBe(true);
        expect(runIsWorking(r)).toBe(false);
    });
    it('Q8: only sessionless, unacknowledged failures on open issues wait on the owner', () => {
        const open = issue({ id: 'open', status: 'todo' });
        const closed = issue({ id: 'closed', status: 'done' });
        const runs = Object.fromEntries([
            run({ id: 'f1', issueId: 'open', status: 'failed', sessionId: null }),
            run({ id: 'f2', issueId: 'open', status: 'failed', sessionId: 'crashed-session' }),
            run({ id: 'f3', issueId: 'open', status: 'failed', sessionId: null, failureAckedAt: 9 }),
            run({ id: 'f4', issueId: 'closed', status: 'failed', sessionId: null }),
        ].map((r) => [r.id, r]));
        expect(failedRunsNeedingYou(runs, { open, closed }).map((r) => r.id)).toEqual(['f1']);
    });
    it('sidebar badge = in_review + blocked', () => {
        expect(waitingOnMeCount({ a: issue({ status: 'in_review' }), b: issue({ status: 'blocked' }), c: issue({ status: 'in_progress' }), d: issue({ status: 'blocked', deletedAt: 1 }) })).toBe(2);
    });
    it('My Issues tabs: 指派给我 / 等我处理 (with failed runs) / 我创建的', () => {
        const self = issue({ assignee: { kind: 'self' } });
        const review = issue({ status: 'in_review', assignee: codex });
        const failedOne = issue({ status: 'todo', assignee: codex });
        const imported = issue({ createdBy: { kind: 'import' } });
        const all = [self, review, failedOne, imported];
        expect(myIssues(all, 'assigned', new Set()).map((i) => i.id)).toEqual([self.id]);
        expect(myIssues(all, 'waiting', new Set([failedOne.id])).map((i) => i.id).sort()).toEqual([review.id, failedOne.id].sort());
        expect(myIssues(all, 'created', new Set()).map((i) => i.id)).not.toContain(imported.id);
    });
});

describe('B-873 comment trigger preview (same wire rules the server enforces)', () => {
    const live = run({ id: 'live', status: 'running', agent: 'codex', machineId: 'm1', sessionId: 'sess' });
    it('/note never wakes anyone', () => {
        expect(commentTriggerPreview({ body: '/note remember this', mentions: [], issue: { status: 'todo', assignee: codex }, runs: [live] })).toEqual({ kind: 'note' });
    });
    it('no @: goes to the agent assignee while runnable — queued into its live session', () => {
        const p = commentTriggerPreview({ body: 'add a test', mentions: [], issue: { status: 'in_progress', assignee: codex }, runs: [live] });
        expect(p).toEqual({ kind: 'targets', targets: [{ agent: 'codex', machineId: 'm1', mode: 'message', viaMention: false }] });
    });
    it('no @ on backlog / done, or no agent assignee: nothing is woken', () => {
        expect(commentTriggerPreview({ body: 'x', mentions: [], issue: { status: 'backlog', assignee: codex }, runs: [] })).toEqual({ kind: 'none', reason: 'inactive-status' });
        expect(commentTriggerPreview({ body: 'x', mentions: [], issue: { status: 'todo', assignee: { kind: 'self' } }, runs: [] })).toEqual({ kind: 'none', reason: 'no-agent-assignee' });
    });
    it('@ another agent starts a new run even on a closed issue (Q5); a starting run absorbs the comment', () => {
        const p = commentTriggerPreview({ body: 'look', mentions: [{ kind: 'agent', agent: 'claude', machineId: 'm1' }], issue: { status: 'done', assignee: codex }, runs: [live] });
        expect(p).toEqual({ kind: 'targets', targets: [{ agent: 'claude', machineId: 'm1', mode: 'spawn', viaMention: true }] });
        const starting = run({ id: 'q', status: 'queued', agent: 'codex', machineId: 'm1', sessionId: null });
        expect(commentTriggerPreview({ body: 'x', mentions: [], issue: { status: 'todo', assignee: codex }, runs: [starting] })).toMatchObject({ targets: [{ mode: 'absorbed' }] });
    });
    it('@ picker: assignable agents on the assignee machine, at most 3 picked, toggles', () => {
        expect(mentionCandidates({ assignee: codex }, null).map((m) => `${m.agent}@${m.machineId}`)).toEqual(['claude@m1', 'codex@m1', 'pi@m1']);
        expect(mentionCandidates({ assignee: { kind: 'none' } }, 'pm').every((m) => m.machineId === 'pm')).toBe(true);
        const one = toggleMention([], { kind: 'agent', agent: 'codex' });
        expect(toggleMention(one, { kind: 'agent', agent: 'codex' })).toEqual([]);
    });
});

describe('B-873 ⌘K and lookups', () => {
    const list = [issue({ number: 12, key: 'VH-12', title: 'Refund ledger' }), issue({ number: 3, key: 'VH-3', title: 'Ledger export', status: 'done' }), issue({ number: 4, key: 'VH-4', title: 'Ledger import' })];
    it('VH-12 / #12 / 12 jump straight to that issue', () => {
        for (const q of ['VH-12', 'vh-12', '#12', '12']) expect(matchIssues(list, q).map((i) => i.key)).toEqual(['VH-12']);
    });
    it('title match lists open issues first; empty query none', () => {
        expect(matchIssues(list, 'ledger').map((i) => i.key)).toEqual(['VH-4', 'VH-12', 'VH-3']);
        expect(matchIssues(list, '  ')).toEqual([]);
    });
    it('route param resolves by id or key', () => {
        const map = Object.fromEntries(list.map((i) => [i.id, i]));
        expect(findIssue(map, 'VH-3')?.title).toBe('Ledger export');
        expect(findIssue(map, list[0].id)?.key).toBe('VH-12');
    });
});

describe('B-873 assignee picker gate (spec §2 IssueWorker)', () => {
    const now = 1_000_000;
    it('offline machines and machines without a fresh issue worker are not pickable; an unknown list does not block', () => {
        expect(machineWorkerState({ online: false, machineId: 'm' }, null, now)).toBe('offline');
        expect(machineWorkerState({ online: true, machineId: 'm' }, null, now)).toBe('ok');
        expect(machineWorkerState({ online: true, machineId: 'm' }, [], now)).toBe('cli-old');
        expect(machineWorkerState({ online: true, machineId: 'm' }, [{ machineId: 'm', lastSeenAt: now - ISSUE_WORKER_FRESH_MS - 1 }], now)).toBe('cli-old');
        expect(machineWorkerState({ online: true, machineId: 'm' }, [{ machineId: 'm', lastSeenAt: now - 1000 }], now)).toBe('ok');
    });
});

describe('B-873 @ typed in the comment box', () => {
    it('only a trailing @word at the start or after a space opens the picker', () => {
        expect(mentionQuery('@')).toBe('');
        expect(mentionQuery('please @co')).toBe('co');
        expect(mentionQuery('mail me@host')).toBeNull();
        expect(mentionQuery('done @codex now')).toBeNull();
    });
});
