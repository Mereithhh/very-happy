import { describe, it, expect } from 'vitest';
import type { TeamAction, TeamState } from '@slopus/happy-wire';
import { reduceTeam, teamView, type TeamActor } from './reducer';

const owner: TeamActor = { kind: 'owner' };
const empty = (): TeamState => ({ id: 'team', name: 'Team', machineId: 'machine', version: 0, bots: [], tasks: [], messages: [], operations: [], createdAt: 1 });
function fixture() {
    let state = empty(); let next = 0;
    const act = (action: TeamAction, actor = owner) => { const r = reduceTeam(state, actor, action, { now: 1000, id: () => `id-${++next}` }); state = r.team; return r; };
    return { act, get state() { return state; } };
}
describe('team coordination invariants', () => {
    it('fences old bot credentials after rebind', () => {
        const f = fixture(); f.act({ type: 'join', name: 'Root', sessionId: 's1' }); const bot = f.state.bots[0];
        f.act({ type: 'join', name: 'Root', sessionId: 's2', botId: bot.id });
        expect(() => f.act({ type: 'delegate', goal: 'g', acceptance: ['a'] }, { kind: 'agent', botId: bot.id, generation: 1 })).toThrow('stale_agent');
    });
    it('does not expose sibling goals or permit sibling control to a worker', () => {
        const f = fixture(); f.act({ type: 'delegate', goal: 'secret-a', acceptance: ['a'] }); f.act({ type: 'delegate', goal: 'secret-b', acceptance: ['b'] });
        const actor: TeamActor = { kind: 'agent', botId: f.state.bots[0].id, generation: 1 };
        expect(teamView(f.state, actor).tasks.map(t => t.goal)).toEqual(['secret-a']);
        expect(() => f.act({ type: 'cancel', taskId: f.state.tasks[1].id, attemptId: f.state.tasks[1].currentAttemptId, goalVersion: 1, reason: 'x' }, actor)).toThrow('task_not_found');
    });
    it('blocks parent submission until children are explicitly accepted', () => {
        const f = fixture(); f.act({ type: 'join', name: 'Root', sessionId: 's' });
        f.act({ type: 'delegate', goal: 'parent', acceptance: ['a'], assigneeBotId: f.state.bots[0].id });
        const parent = f.state.tasks[0];
        f.act({ type: 'delegate', parentTaskId: parent.id, goal: 'child', acceptance: ['a'] }, { kind: 'agent', botId: parent.assigneeBotId, generation: 1 });
        expect(() => f.act({ type: 'submit', taskId: parent.id, attemptId: parent.currentAttemptId, goalVersion: 1, result: 'done' })).toThrow('children_unfinished');
    });
    it('cascades cancellation and suppresses unclaimed spawn operations', () => {
        const f = fixture(); f.act({ type: 'delegate', goal: 'parent', acceptance: ['a'] }); const parent = f.state.tasks[0];
        f.act({ type: 'delegate', parentTaskId: parent.id, goal: 'child', acceptance: ['a'] });
        f.act({ type: 'cancel', taskId: parent.id, attemptId: parent.currentAttemptId, goalVersion: 1, reason: 'stop' });
        expect(f.state.tasks.every(t => t.status === 'cancelled')).toBe(true);
        expect(f.state.operations.every(o => o.status === 'failed' && o.error === 'task_closed_before_spawn')).toBe(true);
    });
    it('does not reclaim an uncertain spawn but accepts same-claim reconciliation', () => {
        const f = fixture(); f.act({ type: 'delegate', goal: 'g', acceptance: ['a'] }); const op = f.state.operations[0];
        f.act({ type: 'claim-operation', operationId: op.id, machineId: 'machine' }); const claimId = f.state.operations[0].claimId!;
        f.act({ type: 'fail-operation', operationId: op.id, machineId: 'machine', claimId, error: 'lost', unknown: true });
        expect(() => f.act({ type: 'claim-operation', operationId: op.id, machineId: 'machine' })).toThrow('operation_not_pending');
        f.act({ type: 'complete-operation', operationId: op.id, machineId: 'machine', claimId, sessionId: 's' });
        expect(f.state.tasks[0].status).toBe('running');
    });
    it('schedules cleanup for a spawn that returns after cancellation', () => {
        const f = fixture(); f.act({ type: 'delegate', goal: 'g', acceptance: ['a'] }); const op = f.state.operations[0];
        f.act({ type: 'claim-operation', operationId: op.id, machineId: 'machine' }); const claimId = f.state.operations[0].claimId!;
        f.act({ type: 'cancel', taskId: f.state.tasks[0].id, attemptId: f.state.tasks[0].currentAttemptId, goalVersion: 1, reason: 'stop' });
        f.act({ type: 'complete-operation', operationId: op.id, machineId: 'machine', claimId, sessionId: 's' });
        expect(f.state.tasks[0].status).toBe('cancelled'); expect(f.state.operations[1].type).toBe('stop');
    });
    it('rejects stale attempt results after handoff', () => {
        const f = fixture(); f.act({ type: 'join', name: 'A', sessionId: 'a' }); f.act({ type: 'join', name: 'B', sessionId: 'b' });
        f.act({ type: 'delegate', goal: 'g', acceptance: ['a'], assigneeBotId: f.state.bots[0].id }); const old = f.state.tasks[0];
        f.act({ type: 'handoff', taskId: old.id, attemptId: old.currentAttemptId, goalVersion: 1, assigneeBotId: f.state.bots[1].id });
        expect(() => f.act({ type: 'submit', taskId: old.id, attemptId: old.currentAttemptId, goalVersion: 1, result: 'stale' })).toThrow('stale_attempt');
    });
    it('turn idle events notify owner without completing a task', () => {
        const f = fixture(); f.act({ type: 'join', name: 'Root', sessionId: 'root' }); const root = f.state.bots[0];
        f.act({ type: 'join', name: 'Worker', sessionId: 'worker' }); const worker = f.state.bots[1];
        f.act({ type: 'delegate', goal: 'g', acceptance: ['a'], assigneeBotId: worker.id });
        // Owner-created task has no bot recipient; user still sees task state unchanged.
        f.act({ type: 'session-event', sessionId: 'worker', event: 'idle' });
        expect(f.state.tasks[0].status).toBe('running');
        expect(() => f.act({ type: 'session-event', sessionId: 'old-worker', event: 'exited' })).toThrow('session_not_bound');
        expect(root.root).toBe(true);
    });
    it('fences delayed acceptance after a return and resubmission', () => {
        const f = fixture(); f.act({ type: 'join', name: 'A', sessionId: 'a' });
        f.act({ type: 'delegate', goal: 'g', acceptance: ['a'], assigneeBotId: f.state.bots[0].id });
        const first = f.state.tasks[0];
        f.act({ type: 'submit', taskId: first.id, attemptId: first.currentAttemptId, goalVersion: 1, result: 'v1' });
        f.act({ type: 'return', taskId: first.id, attemptId: first.currentAttemptId, goalVersion: 1, reason: 'fix' });
        const second = f.state.tasks[0];
        f.act({ type: 'submit', taskId: second.id, attemptId: second.currentAttemptId, goalVersion: 1, result: 'v2' });
        expect(() => f.act({ type: 'accept', taskId: first.id, attemptId: first.currentAttemptId, goalVersion: 1 })).toThrow('stale_attempt');
        expect(f.state.tasks[0].status).toBe('submitted');
    });

    it('refuses archival until active work and uncertain execution are resolved', () => {
        const f = fixture(); f.act({ type: 'delegate', goal: 'g', acceptance: ['a'] });
        expect(() => f.act({ type: 'archive' })).toThrow('team_has_active_tasks');
        const op = f.state.operations[0];
        f.act({ type: 'claim-operation', operationId: op.id, machineId: 'machine' });
        const task = f.state.tasks[0];
        f.act({ type: 'cancel', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: 1, reason: 'stop' });
        expect(() => f.act({ type: 'archive' })).toThrow('team_has_unresolved_operations');
    });

    it('cannot bind a spawned bot to another bot existing session', () => {
        const f = fixture(); f.act({ type: 'join', name: 'Root', sessionId: 'root' });
        f.act({ type: 'delegate', goal: 'g', acceptance: ['a'] });
        const op = f.state.operations[0]; f.act({ type: 'claim-operation', operationId: op.id, machineId: 'machine' });
        expect(() => f.act({ type: 'complete-operation', operationId: op.id, machineId: 'machine', claimId: f.state.operations[0].claimId!, sessionId: 'root' })).toThrow('session_already_bound');
    });

});
