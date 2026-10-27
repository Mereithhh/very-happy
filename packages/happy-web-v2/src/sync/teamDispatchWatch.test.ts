// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { TeamBot, TeamOperation, TeamState, TeamTask } from '@slopus/happy-wire';
import { teamDispatchTargets, watchedOperationOutcome } from './teamDispatchWatch';

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
    it('created once completed with a session; failed carries the error; else pending', () => {
        expect(watchedOperationOutcome(t(op('x', 'k', { status: 'completed', sessionId: 's9' })), 'x')).toEqual({ kind: 'created', sessionId: 's9', name: 'N-b1' });
        expect(watchedOperationOutcome(t(op('x', 'k', { status: 'failed', error: 'machine_offline' })), 'x')).toEqual({ kind: 'failed', name: 'N-b1', error: 'machine_offline' });
        expect(watchedOperationOutcome(t(op('x', 'k', { status: 'claimed' })), 'x')).toEqual({ kind: 'pending' });
        expect(watchedOperationOutcome(t(op('x', 'k', { status: 'completed' })), 'x')).toEqual({ kind: 'pending' });
        expect(watchedOperationOutcome(t(op('x', 'k')), 'missing')).toEqual({ kind: 'pending' });
    });
});
