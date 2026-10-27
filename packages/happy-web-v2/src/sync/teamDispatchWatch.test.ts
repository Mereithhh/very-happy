// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamBot, TeamOperation, TeamState, TeamTask } from '@slopus/happy-wire';

const h = vi.hoisted(() => ({ teams: [] as unknown[], dispatched: [] as unknown[], failed: [] as unknown[] }));
vi.mock('./teams', () => ({ getTeam: async () => ({ team: h.teams.length > 1 ? h.teams.shift() : h.teams[0] }) }));
vi.mock('./dispatchFeedback', () => ({
    announceDispatched: (o: unknown) => { h.dispatched.push(o); },
    announceDispatchFailed: (o: unknown) => { h.failed.push(o); },
}));
vi.mock('@/screens/sessions/useTeamNavigation', () => ({ refreshTeamNavigation: async () => {} }));

import { TEAM_DISPATCH_POLL_MS, resetTeamDispatchWatchForTests, teamDispatchTargets, teamFailureSummary, watchedOperationOutcome, watchTeamDispatch } from './teamDispatchWatch';

const bot = (id: string, sessionId: string | null): TeamBot => ({ id, name: `N-${id}`, sessionId, generation: 1, root: false, managed: true, assistant: 'claude', directory: '/r' });
const op = (id: string, taskId: string, patch: Partial<TeamOperation> = {}): TeamOperation => ({ id, teamId: 't', machineId: 'm', taskId, botId: 'b1', attemptId: 'a', generation: 1, type: 'spawn', status: 'pending', claimId: null, claimedAt: null, error: null, sessionId: null, directory: '/r', assistant: 'claude', prompt: '', createdAt: 1, ...patch });
const task = (id: string, assigneeBotId: string, currentAttemptId = 'a1'): TeamTask => ({ id, assigneeBotId, currentAttemptId } as unknown as TeamTask);
const team = (bots: TeamBot[], tasks: TeamTask[], operations: TeamOperation[]): TeamState => ({ id: 't', name: 'T', machineId: 'm', bots, tasks, operations, messages: [], createdAt: 1 } as unknown as TeamState);
const delegate = { type: 'delegate', goal: 'g', acceptance: [] } as never;

describe('teamDispatchTargets', () => {
    it('新任务 to an unbound member: waits for the new spawn only (not older unfinished launches)', () => {
        const before = team([bot('b0', null)], [task('k0', 'b0')], [op('old', 'k0')]);
        const after = team([bot('b0', null), bot('b1', null)], [task('k0', 'b0'), task('k1', 'b1')], [op('old', 'k0'), op('new', 'k1')]);
        expect(teamDispatchTargets(before, after, delegate)).toEqual({ operationIds: ['new'], delivered: [] });
    });
    it('新任务 to a member with a live session is a delivery to that session', () => {
        const before = team([bot('b1', 's1')], [], []);
        const after = team([bot('b1', 's1')], [task('k1', 'b1')], []);
        expect(teamDispatchTargets(before, after, delegate)).toEqual({ operationIds: [], delivered: [{ sessionId: 's1', name: 'N-b1' }] });
    });
    it('重试 watches the retried operation even though it existed before', () => {
        const before = team([bot('b1', null)], [task('k1', 'b1')], [op('x', 'k1', { status: 'failed' })]);
        const after = team([bot('b1', null)], [task('k1', 'b1')], [op('x', 'k1')]);
        expect(teamDispatchTargets(before, after, { type: 'retry-operation', operationId: 'x', claimId: 'c' } as never).operationIds).toEqual(['x']);
    });
    it('QA17 P1-1: 重试 watches the retried op while the server still says failed / unknown (retry only stamps retryRequestedAt)', () => {
        const retry = { type: 'retry-operation', operationId: 'x', claimId: 'c' } as never;
        for (const status of ['failed', 'unknown'] as const) {
            const failed = op('x', 'k1', { status, error: 'boom' });
            const after = team([bot('b1', null)], [task('k1', 'b1')], [{ ...failed, retryRequestedAt: 5 }, op('other', 'k0', { status: 'failed' })]);
            // also after a reload: no 'before' snapshot at all
            expect(teamDispatchTargets(team([bot('b1', null)], [task('k1', 'b1')], [failed]), after, retry).operationIds).toEqual(['x']);
            expect(teamDispatchTargets(null, after, retry).operationIds).toEqual(['x']);
        }
    });
    it('转交 to a live member (new attempt) is a delivery', () => {
        const before = team([bot('b1', 's1')], [task('k1', 'b1', 'a1')], []);
        const after = team([bot('b1', 's1')], [task('k1', 'b1', 'a2')], []);
        expect(teamDispatchTargets(before, after, { type: 'handoff' } as never).delivered).toEqual([{ sessionId: 's1', name: 'N-b1' }]);
    });
    it('other actions start nothing', () => {
        const after = team([bot('b1', null)], [task('k1', 'b1')], [op('new', 'k1')]);
        expect(teamDispatchTargets(null, after, { type: 'archive' } as never)).toEqual({ operationIds: [], delivered: [] });
    });
});

describe('watchedOperationOutcome', () => {
    const t = (o: TeamOperation) => team([bot('b1', null)], [], [o]);
    it('QA17 P2-2: unknown (failed while spawning) is a failure too', () => {
        expect(watchedOperationOutcome(t(op('x', 'k', { status: 'unknown', error: 'EACCES' })), 'x')).toEqual({ kind: 'failed', name: 'N-b1', error: 'EACCES', unknown: true });
    });
    it('a retry\'s baseline failure is not reported again; a changed failure is', () => {
        const baseline = 'failed\nold';
        expect(watchedOperationOutcome(t(op('x', 'k', { status: 'failed', error: 'old' })), 'x', baseline)).toEqual({ kind: 'pending' });
        expect(watchedOperationOutcome(t(op('x', 'k', { status: 'failed', error: 'new' })), 'x', baseline)).toMatchObject({ kind: 'failed', error: 'new' });
        expect(watchedOperationOutcome(t(op('x', 'k', { status: 'completed', sessionId: 's' })), 'x', baseline)).toMatchObject({ kind: 'created' });
    });
    it('created once completed with a session; failed carries the error; else pending', () => {
        expect(watchedOperationOutcome(t(op('x', 'k', { status: 'completed', sessionId: 's9' })), 'x')).toEqual({ kind: 'created', sessionId: 's9', name: 'N-b1' });
        expect(watchedOperationOutcome(t(op('x', 'k', { status: 'failed', error: 'machine_offline' })), 'x')).toEqual({ kind: 'failed', name: 'N-b1', error: 'machine_offline', unknown: false });
        expect(watchedOperationOutcome(t(op('x', 'k', { status: 'claimed' })), 'x')).toEqual({ kind: 'pending' });
        expect(watchedOperationOutcome(t(op('x', 'k', { status: 'completed' })), 'x')).toEqual({ kind: 'pending' });
        expect(watchedOperationOutcome(t(op('x', 'k')), 'missing')).toEqual({ kind: 'pending' });
    });
});

describe('teamFailureSummary (QA17 P2-1)', () => {
    it('is the board\'s localized sentence, not the daemon\'s raw English', () => {
        const raw = 'Team repository is unavailable: /home/x/later-x is missing or not a Git checkout. Restore the folder or choose another repository (automatic retry 2/5 in 10s)';
        expect(teamFailureSummary(raw, false, 'zh-Hans')).toBe('团队仓库不存在，或不是 Git 仓库。恢复后重试启动。');
        expect(teamFailureSummary(raw, false, 'en')).toBe('The team repository is missing or is not a Git checkout. Restore it, then retry the launch.');
        expect(teamFailureSummary('EACCES: permission denied, mkdir', true, 'zh-Hans')).toBe('无法确认成员是否已启动。请确认它的会话没有在运行，再标记为已处理。');
        expect(teamFailureSummary('weird', false, 'zh-Hans')).toBe('操作没有完成。');
    });
});

describe('watchTeamDispatch: failed → 重试 → completed (QA17 P1-1)', () => {
    beforeEach(() => { vi.useFakeTimers(); resetTeamDispatchWatchForTests(); h.teams = []; h.dispatched = []; h.failed = []; });
    afterEach(() => { vi.useRealTimers(); });
    const retry = { type: 'retry-operation', operationId: 'x', claimId: 'c' } as never;
    const failed = op('x', 'k1', { status: 'failed', error: 'Team repository is unavailable: /r (automatic retries exhausted after 5 attempts; use Retry launch after fixing the cause)' });
    const at = (o: TeamOperation) => team([bot('b1', null)], [task('k1', 'b1')], [o]);
    const tickTo = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };

    it('after a reload (no before), the still-failed retried op is watched; its old failure is not re-toasted; success is', async () => {
        const after = at({ ...failed, retryRequestedAt: 5 });
        h.teams = [after, at({ ...failed, status: 'claimed', retryRequestedAt: 5 }), at({ ...failed, status: 'completed', error: null, sessionId: 's9' })];
        watchTeamDispatch(null, after, retry);
        await tickTo(TEAM_DISPATCH_POLL_MS);
        expect(h.failed).toEqual([]);
        expect(h.dispatched).toEqual([]);
        await tickTo(TEAM_DISPATCH_POLL_MS * 2);
        expect(h.dispatched).toEqual([{ sessionId: 's9', name: 'N-b1' }]);
        expect(h.failed).toEqual([]);
    });
    it('a retry that fails again is reported once (localized, with the board as 详情)', async () => {
        const after = at({ ...failed, retryRequestedAt: 6 });
        const again = at({ ...failed, error: 'Team repository is unavailable: /r (automatic retry 2/5 in 10s)', retryRequestedAt: 6 });
        h.teams = [after, again];
        watchTeamDispatch(null, after, retry);
        await tickTo(TEAM_DISPATCH_POLL_MS * 3);
        expect(h.failed).toEqual([{ name: 'N-b1', reason: 'The team repository is missing or is not a Git checkout. Restore it, then retry the launch.', href: '/teams/t' }]);
    });
    it('QA17 P2-2: a new launch that ends unknown (failed while spawning) is reported, asking to verify it', async () => {
        const delegate = { type: 'delegate', goal: 'g', acceptance: [] } as never;
        const after = at(op('x', 'k1'));
        h.teams = [after, at(op('x', 'k1', { status: 'unknown', claimId: 'c', error: 'EACCES: permission denied, mkdir \'/r/.wt\'' }))];
        watchTeamDispatch(team([], [], []), after, delegate);
        await tickTo(TEAM_DISPATCH_POLL_MS * 3);
        expect(h.failed).toEqual([{ name: 'N-b1', reason: 'It is not known whether the member started. Check that its session is not running, then mark this as handled.', href: '/teams/t' }]);
    });
});
