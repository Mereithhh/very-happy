import { describe, it, expect } from 'vitest';
import type { TeamAction, TeamState } from '@slopus/happy-wire';
import { reduceTeam, teamView, occupiedTeamWorkSlots, otherTeamBinding, transferSessionOut, type TeamActor } from './reducer';

const owner: TeamActor = { kind: 'owner' };
const empty = (): TeamState => ({ id: 'team', name: 'Team', machineId: 'machine', version: 0, bots: [], tasks: [], messages: [], operations: [], createdAt: 1 });
function fixture() {
    let state = empty(); let next = 0;
    const act = (action: TeamAction, actor = owner) => { const r = reduceTeam(state, actor, action, { now: 1000, id: () => `id-${++next}` }); state = r.team; return r; };
    return { act, get state() { return state; } };
}
describe('team coordination invariants', () => {
    it('only account owner changes policy; operation snapshots survive later policy changes', () => {
        const f = fixture();
        f.act({ type: 'join', name: 'Root', sessionId: 'root-session' });
        const root = f.state.bots[0];
        expect(() => f.act({ type: 'set-permission-mode', permissionMode: 'bypassPermissions' }, { kind: 'agent', botId: root.id, generation: 1 })).toThrow('owner_required');
        f.act({ type: 'delegate', goal: 'legacy', acceptance: ['done'] });
        expect(f.state.operations[0].permissionMode).toBe('default');
        f.act({ type: 'set-permission-mode', permissionMode: 'bypassPermissions' });
        for (const assistant of ['claude', 'codex', 'pi-acp'] as const) f.act({ type: 'delegate', assistant, goal: assistant, acceptance: ['done'] });
        expect(f.state.operations.slice(1).map(o => o.permissionMode)).toEqual(['bypassPermissions', 'bypassPermissions', 'bypassPermissions']);
        f.act({ type: 'set-permission-mode', permissionMode: 'default' });
        expect(f.state.operations.slice(1).every(o => o.permissionMode === 'bypassPermissions')).toBe(true);
        f.act({ type: 'delegate', goal: 'new-default', acceptance: ['done'] });
        expect(f.state.operations.at(-1)?.permissionMode).toBe('default');
    });

    it('B-689: owner retry marks a stuck launch once per request and only while its attempt waits', () => {
        const f = fixture();
        f.act({ type: 'delegate', goal: 'g', acceptance: ['a'] });
        const op = f.state.operations[0];
        expect(() => f.act({ type: 'retry-operation', operationId: op.id, claimId: 'x' })).toThrow('stale_claim');
        f.act({ type: 'claim-operation', operationId: op.id, machineId: 'machine', teamLaunchVersion: 1 });
        const claimId = f.state.operations[0].claimId!;
        expect(() => f.act({ type: 'retry-operation', operationId: op.id, claimId })).toThrow('stale_claim'); // still running, not failed
        f.act({ type: 'fail-operation', operationId: op.id, machineId: 'machine', claimId, error: 'Agent process exited during startup (code 1): ECONNRESET' });
        const worker = f.state.bots[0];
        expect(() => f.act({ type: 'retry-operation', operationId: op.id, claimId }, { kind: 'agent', botId: worker.id, generation: worker.generation })).toThrow('owner_required');
        f.act({ type: 'retry-operation', operationId: op.id, claimId });
        expect(f.state.operations[0]).toMatchObject({ status: 'failed', claimId, retryRequestedAt: 1000 });
        f.act({ type: 'retry-operation', operationId: op.id, claimId });
        expect(f.state.operations[0].retryRequestedAt).toBe(1001); // a second request is distinguishable
        const task = f.state.tasks[0];
        f.act({ type: 'cancel', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: 1, reason: 'stop' });
        expect(() => f.act({ type: 'retry-operation', operationId: op.id, claimId })).toThrow('operation_task_not_waiting');
    });

    it('B-706: reactivating a bot launches from its source repository, never the removed worktree', () => {
        const f = fixture();
        f.act({ type: 'delegate', goal: 'first', acceptance: ['a'], directory: '/repo' });
        const first = f.state.operations[0];
        expect(first.directory).toBe('/repo');
        f.act({ type: 'claim-operation', operationId: first.id, machineId: 'machine', teamLaunchVersion: 1 });
        f.act({ type: 'complete-operation', operationId: first.id, machineId: 'machine', claimId: f.state.operations[0].claimId!, sessionId: 's1', workingDirectory: '/home/.happy/teams/worktrees/op1' });
        const bot = f.state.bots[0];
        expect(bot.directory).toBe('/home/.happy/teams/worktrees/op1'); // the member's live worktree
        const task = f.state.tasks[0];
        f.act({ type: 'submit', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: 1, result: 'ok' });
        f.act({ type: 'accept', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: 1 });
        const stop = f.state.operations.at(-1)!;
        f.act({ type: 'claim-operation', operationId: stop.id, machineId: 'machine' });
        f.act({ type: 'complete-operation', operationId: stop.id, machineId: 'machine', claimId: f.state.operations.at(-1)!.claimId! });
        f.act({ type: 'delegate', goal: 'second', acceptance: ['a'], assigneeBotId: bot.id });
        const relaunch = f.state.operations.at(-1)!;
        expect(relaunch).toMatchObject({ type: 'spawn', generation: 2, directory: '/repo' });

        // A launch queued before the fix carries the old worktree; the owner's retry repairs it.
        f.act({ type: 'claim-operation', operationId: relaunch.id, machineId: 'machine', teamLaunchVersion: 1 });
        f.state.operations.at(-1)!.directory = '/home/.happy/teams/worktrees/op1';
        const claimId = f.state.operations.at(-1)!.claimId!;
        f.act({ type: 'fail-operation', operationId: relaunch.id, machineId: 'machine', claimId, error: 'Team repository is missing' });
        f.act({ type: 'retry-operation', operationId: relaunch.id, claimId });
        expect(f.state.operations.at(-1)).toMatchObject({ directory: '/repo', retryRequestedAt: 1000 });
        f.act({ type: 'complete-operation', operationId: relaunch.id, machineId: 'machine', claimId, sessionId: 's2', workingDirectory: '/home/.happy/teams/worktrees/op3' });
        expect(f.state.operations.at(-1)).toMatchObject({ status: 'completed', error: null });
    });

    it('B-761: a reused member\'s new session starts without the previous generation\'s turn event', () => {
        const f = fixture();
        f.act({ type: 'delegate', goal: 'first', acceptance: ['a'], directory: '/repo' });
        const first = f.state.operations[0];
        f.act({ type: 'claim-operation', operationId: first.id, machineId: 'machine', teamLaunchVersion: 1 });
        f.act({ type: 'complete-operation', operationId: first.id, machineId: 'machine', claimId: f.state.operations[0].claimId!, sessionId: 's1' });
        f.act({ type: 'session-event', sessionId: 's1', event: 'idle' });
        expect(f.state.bots[0]).toMatchObject({ lastEvent: 'idle', lastEventAt: 1000 });
        const task = f.state.tasks[0];
        f.act({ type: 'submit', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: 1, result: 'ok' });
        f.act({ type: 'accept', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: 1 });
        const stop = f.state.operations.at(-1)!;
        f.act({ type: 'claim-operation', operationId: stop.id, machineId: 'machine' });
        f.act({ type: 'complete-operation', operationId: stop.id, machineId: 'machine', claimId: f.state.operations.at(-1)!.claimId! });
        f.act({ type: 'delegate', goal: 'second', acceptance: ['a'], assigneeBotId: f.state.bots[0].id });
        const relaunch = f.state.operations.at(-1)!;
        f.act({ type: 'claim-operation', operationId: relaunch.id, machineId: 'machine', teamLaunchVersion: 1 });
        f.act({ type: 'complete-operation', operationId: relaunch.id, machineId: 'machine', claimId: f.state.operations.at(-1)!.claimId!, sessionId: 's2' });
        expect(f.state.bots[0].sessionId).toBe('s2');
        expect(f.state.bots[0].lastEvent).toBeUndefined();
        expect(f.state.bots[0].lastEventAt).toBeUndefined();
        f.act({ type: 'session-event', sessionId: 's2', event: 'idle' });
        expect(f.state.bots[0]).toMatchObject({ lastEvent: 'idle' });
    });

    it('B-729: a rebind (adopt) or cleanup keeps the unbound conversation in previousSessionIds', () => {
        const f = fixture(); f.act({ type: 'join', name: 'Root', sessionId: 's1' }); const root = f.state.bots[0];
        expect(root.previousSessionIds).toBeUndefined();
        f.act({ type: 'join', name: 'Root', sessionId: 's2', botId: root.id });
        expect(f.state.bots[0]).toMatchObject({ sessionId: 's2', previousSessionIds: ['s1'] });
        f.act({ type: 'join', name: 'Root', sessionId: 's2', botId: root.id }); // same binding: no duplicate history
        expect(f.state.bots[0].previousSessionIds).toEqual(['s1']);
        f.act({ type: 'delegate', goal: 'g', acceptance: ['a'] });
        const spawn = f.state.operations[0];
        f.act({ type: 'claim-operation', operationId: spawn.id, machineId: 'machine', teamLaunchVersion: 1 });
        f.act({ type: 'complete-operation', operationId: spawn.id, machineId: 'machine', claimId: f.state.operations[0].claimId!, sessionId: 'w1' });
        const task = f.state.tasks[0];
        f.act({ type: 'submit', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: 1, result: 'ok' });
        f.act({ type: 'accept', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: 1 });
        const stop = f.state.operations.at(-1)!;
        f.act({ type: 'claim-operation', operationId: stop.id, machineId: 'machine' });
        f.act({ type: 'complete-operation', operationId: stop.id, machineId: 'machine', claimId: f.state.operations.at(-1)!.claimId! });
        expect(f.state.bots[1]).toMatchObject({ sessionId: null, previousSessionIds: ['w1'] });
    });
    it('fences old bot credentials after rebind', () => {
        const f = fixture(); f.act({ type: 'join', name: 'Root', sessionId: 's1' }); const bot = f.state.bots[0];
        f.act({ type: 'join', name: 'Root', sessionId: 's2', botId: bot.id });
        expect(() => f.act({ type: 'delegate', goal: 'g', acceptance: ['a'] }, { kind: 'agent', botId: bot.id, generation: 1 })).toThrow('stale_agent');
    });
    it('does not expose sibling goals or permit sibling control to a worker', () => {
        const f = fixture(); f.act({ type: 'delegate', goal: 'secret-a', acceptance: ['a'] }); f.act({ type: 'delegate', goal: 'secret-b', acceptance: ['b'] });
        const actor: TeamActor = { kind: 'agent', botId: f.state.bots[0].id, generation: 1 };
        expect(teamView(f.state, actor).tasks.map(t => t.goal)).toEqual(['secret-a']);
        expect(teamView(f.state, actor).operations.map(o => o.taskId)).toEqual([f.state.tasks[0].id]);
        expect(teamView(f.state, actor).operations[0].status).toBe('pending');
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
        f.act({ type: 'claim-operation', teamLaunchVersion: 1, operationId: op.id, machineId: 'machine' }); const claimId = f.state.operations[0].claimId!;
        f.act({ type: 'fail-operation', operationId: op.id, machineId: 'machine', claimId, error: 'lost', unknown: true });
        expect(() => f.act({ type: 'claim-operation', teamLaunchVersion: 1, operationId: op.id, machineId: 'machine' })).toThrow('operation_not_pending');
        f.act({ type: 'complete-operation', operationId: op.id, machineId: 'machine', claimId, sessionId: 's' });
        expect(f.state.tasks[0].status).toBe('running');
    });
    it('schedules cleanup for a spawn that returns after cancellation', () => {
        const f = fixture(); f.act({ type: 'delegate', goal: 'g', acceptance: ['a'] }); const op = f.state.operations[0];
        f.act({ type: 'claim-operation', teamLaunchVersion: 1, operationId: op.id, machineId: 'machine' }); const claimId = f.state.operations[0].claimId!;
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
    it('turn idle events never complete a task', () => {
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

    it('archives active work and settles a late spawn without stranding its process', () => {
        const f = fixture();
        f.act({ type: 'join', name: 'Attached', sessionId: 'user-session' });
        f.act({ type: 'delegate', goal: 'g', acceptance: ['a'] });
        const op = f.state.operations[0];
        f.act({ type: 'claim-operation', teamLaunchVersion: 1, operationId: op.id, machineId: 'machine' });
        const claimId = f.state.operations[0].claimId!;
        f.act({ type: 'archive' });
        expect(f.state.tasks[0].status).toBe('cancelled');
        expect(f.state.tasks[0].cleanup).toBe('pending');
        expect(f.state.bots[0].sessionId).toBe('user-session');
        expect(() => f.act({type:'delegate', goal:'hidden work', acceptance:['a']})).toThrow('team_archived');
        f.act({type:'complete-operation', operationId:op.id, claimId, machineId:'machine', sessionId:'late-session'});
        const stop = f.state.operations.find(o => o.type === 'stop')!;
        expect(stop.sessionId).toBe('late-session');
        f.act({type:'claim-operation', operationId:stop.id, machineId:'machine'});
        f.act({type:'complete-operation', operationId:stop.id, claimId:f.state.operations.at(-1)!.claimId!, machineId:'machine'});
        expect(f.state.tasks[0].cleanup).toBe('done');
        expect(f.state.bots.find(b => b.id === op.botId)?.sessionId).toBeNull();
        expect(f.state.bots[0].sessionId).toBe('user-session');
    });

    it('cancels queued launches and deduplicates stops when archiving', () => {
        const f = fixture(); f.act({type:'delegate', goal:'g', acceptance:['a']});
        f.act({type:'archive'});
        expect(f.state.operations[0]).toMatchObject({status:'failed',error:'task_closed_before_spawn'});
        const count = f.state.operations.length;
        f.act({type:'archive'});
        expect(f.state.operations).toHaveLength(count);
    });

    it('cannot bind a spawned bot to another bot existing session', () => {
        const f = fixture(); f.act({ type: 'join', name: 'Root', sessionId: 'root' });
        f.act({ type: 'delegate', goal: 'g', acceptance: ['a'] });
        const op = f.state.operations[0]; f.act({ type: 'claim-operation', teamLaunchVersion: 1, operationId: op.id, machineId: 'machine' });
        expect(() => f.act({ type: 'complete-operation', operationId: op.id, machineId: 'machine', claimId: f.state.operations[0].claimId!, sessionId: 'root' })).toThrow('session_already_bound');
    });

    it('allows only explicit owner reconciliation after work ends and preserves its audit note', () => {
        const f = fixture(); f.act({ type: 'delegate', goal: 'g', acceptance: ['a'] });
        const pending = f.state.operations[0];
        expect(() => f.act({ type: 'reconcile-operation', operationId: pending.id, claimId: 'none', note: 'Checked stopped' })).toThrow('stale_claim');
        f.act({ type: 'claim-operation', teamLaunchVersion: 1, operationId: pending.id, machineId: 'machine' });
        const op = f.state.operations[0];
        const reconcile: TeamAction = { type: 'reconcile-operation', operationId: op.id, claimId: op.claimId!, note: 'Verified process stopped; worktree preserved manually.' };
        expect(() => f.act(reconcile)).toThrow('operation_task_still_active');
        expect(() => f.act(reconcile, { kind: 'agent', botId: op.botId, generation: 1 })).toThrow('owner_required');
        const task = f.state.tasks[0];
        f.act({ type: 'cancel', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: 1, reason: 'stop' });
        f.act(reconcile);
        expect(f.state.operations[0]).toMatchObject({ status: 'completed', manualResolution: { note: reconcile.note, at: 1000 } });
        expect(f.state.tasks[0].cleanup).toBe('done');
        f.act({ type: 'archive' });
        expect(f.state.archivedAt).toBe(1000);
    });

    it('blocks rebinding a bot while old cleanup is unresolved', () => {
        const f = fixture(); f.act({ type: 'delegate', goal: 'g', acceptance: ['a'] });
        const op = f.state.operations[0]; f.act({ type: 'claim-operation', teamLaunchVersion: 1, operationId: op.id, machineId: 'machine' });
        f.act({ type: 'complete-operation', operationId: op.id, claimId: f.state.operations[0].claimId!, machineId: 'machine', sessionId: 'old-session' });
        const task = f.state.tasks[0];
        f.act({ type: 'cancel', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: 1, reason: 'stop' });
        expect(() => f.act({ type: 'join', botId: task.assigneeBotId, sessionId: 'new-session', name: 'new' })).toThrow('bot_has_unresolved_operations');
        // Merely refreshing the same binding remains idempotent.
        const generation = f.state.bots[0].generation;
        f.act({ type: 'join', botId: task.assigneeBotId, sessionId: 'old-session', name: 'old' });
        expect(f.state.bots[0].generation).toBe(generation);
    });
    it('rejects an old-session delivery acknowledgement after rebinding', () => {
        const f = fixture(); f.act({ type: 'join', name: 'worker', sessionId: 'old' }); const bot = f.state.bots[0];
        f.act({ type: 'delegate', goal: 'g', acceptance: ['a'], assigneeBotId: bot.id });
        const message = f.state.messages[0];
        f.act({ type: 'join', botId: bot.id, name: 'worker', sessionId: 'new' });
        expect(() => f.act({ type: 'message-delivered', messageId: message.id, recipientBotId: bot.id, generation: 1, sessionId: 'old' })).toThrow('stale_delivery');
        expect(f.state.messages[0].deliveredAt).toBeNull();
        f.act({ type: 'message-delivered', messageId: message.id, recipientBotId: bot.id, generation: 2, sessionId: 'new' });
        expect(f.state.messages[0].deliveredAt).toBe(1000);
    });

});

describe('first team launch and member configuration', () => {
    it('starts a managed lead with a durable goal and rejects a second launch', () => {
        const f = fixture();
        const launch = { goal: 'Ship the requested feature', directory: '/repo', assistant: 'codex' as const, model: 'gpt-5' };
        f.act({ type: 'start', launch });
        expect(f.state.bots[0]).toMatchObject({ root: true, managed: true, directory: '/repo', model: 'gpt-5' });
        expect(f.state.tasks[0]).toMatchObject({ goal: launch.goal, ownerBotId: null, status: 'queued' });
        expect(f.state.operations[0]).toMatchObject({ teamLaunchVersion: 1, model: 'gpt-5', type: 'spawn' });
        expect(() => f.act({ type: 'start', launch })).toThrow('team_already_started');
        expect(() => f.act({ type: 'claim-operation', operationId: f.state.operations[0].id, machineId: 'machine' })).toThrow('team_launch_upgrade_required');
    });
    it('inherits defaults for new members, clears cross-agent model, and freezes existing operations', () => {
        const f = fixture();
        f.act({ type: 'start', launch: { goal: 'g', directory: '/repo', assistant: 'codex', model: 'gpt-5' } });
        f.act({ type: 'delegate', goal: 'child', acceptance: ['a'] });
        expect(f.state.bots[1]).toMatchObject({ assistant: 'codex', model: 'gpt-5', directory: '/repo' });
        f.act({ type: 'delegate', goal: 'other', acceptance: ['a'], assistant: 'claude' });
        expect(f.state.bots[2].model).toBeUndefined();
        f.act({ type: 'set-defaults', defaults: { assistant: 'pi-acp', model: 'provider/model', maxParallel: 2 } });
        expect(f.state.operations[1]).toMatchObject({ assistant: 'codex', model: 'gpt-5' });
    });
    it('counts claimed members but excludes the lead and leaves capacity-blocked work unchanged', () => {
        const f = fixture();
        f.act({ type: 'start', launch: { goal: 'g', directory: '/repo', assistant: 'codex' } });
        f.act({ type: 'set-defaults', defaults: { maxParallel: 1 } });
        for (const goal of ['a', 'b']) f.act({ type: 'delegate', goal, acceptance: ['a'] });
        const claim = (operationId: string) => f.act({ type: 'claim-operation', teamLaunchVersion: 1, operationId, machineId: 'machine' });
        claim(f.state.operations[0].id); claim(f.state.operations[1].id);
        expect(f.state.messages.some(m => m.source === 'system' && m.body.includes('queued for a member slot'))).toBe(true);
        const occupied = f.state.operations[1];
        f.act({ type: 'fail-operation', operationId: occupied.id, machineId: 'machine', claimId: occupied.claimId!, error: 'message delivery failed after spawn' });
        const before = structuredClone(f.state);
        expect(() => claim(f.state.operations[2].id)).toThrow('team_parallel_limit');
        expect(f.state).toEqual(before);
        f.act({ type: 'set-defaults', defaults: { maxParallel: 2 } });
        claim(f.state.operations[2].id);
        expect(f.state.operations[2].status).toBe('claimed');
    });
});


describe('leaf task work slots', () => {
    function startTask(f: ReturnType<typeof fixture>, taskId: string, directory?: string) {
        const operation = f.state.operations.find(op => op.taskId === taskId && op.type === 'spawn')!;
        f.act({ type: 'claim-operation', teamLaunchVersion: 1, operationId: operation.id, machineId: 'machine' });
        f.act({ type: 'complete-operation', operationId: operation.id, machineId: 'machine', claimId: f.state.operations.find(op => op.id === operation.id)!.claimId!, sessionId: `session-${taskId}`, ...(directory ? { workingDirectory: directory } : {}) });
    }
    it('lets three parents delegate three children at the full limit, then counts parents again after acceptance', () => {
        const f = fixture();
        f.act({ type: 'set-defaults', defaults: { maxParallel: 3 } });
        const parents = Array.from({ length: 3 }, (_, i) => {
            const result = f.act({ type: 'delegate', goal: `parent-${i}`, acceptance: ['done'] });
            startTask(f, result.taskId!);
            return f.state.tasks.find(task => task.id === result.taskId)!;
        });
        expect(occupiedTeamWorkSlots(f.state).size).toBe(3);
        const children = parents.map(parent => {
            const result = f.act({ type: 'delegate', parentTaskId: parent.id, goal: 'child', acceptance: ['done'] }, { kind: 'agent', botId: parent.assigneeBotId, generation: 1 });
            startTask(f, result.taskId!);
            return f.state.tasks.find(task => task.id === result.taskId)!;
        });
        expect([...occupiedTeamWorkSlots(f.state)].sort()).toEqual(children.map(task => task.assigneeBotId).sort());
        for (const child of children) {
            f.act({ type: 'submit', taskId: child.id, attemptId: child.currentAttemptId, goalVersion: 1, result: 'done' });
            f.act({ type: 'accept', taskId: child.id, attemptId: child.currentAttemptId, goalVersion: 1 });
        }
        expect([...occupiedTeamWorkSlots(f.state)].sort()).toEqual(parents.map(task => task.assigneeBotId).sort());
        expect(f.state.tasks.filter(task => children.some(child => child.id === task.id)).every(task => task.cleanup === 'pending')).toBe(true);
    });
    it('supports deep delegation at limit one without releasing uncertain effects', () => {
        const f = fixture();
        f.act({ type: 'set-defaults', defaults: { maxParallel: 1 } });
        let result = f.act({ type: 'delegate', goal: 'parent', acceptance: ['done'] });
        startTask(f, result.taskId!);
        for (let depth = 0; depth < 6; depth++) {
            const parent = f.state.tasks.find(task => task.id === result.taskId)!;
            result = f.act({ type: 'delegate', parentTaskId: parent.id, goal: 'deeper', acceptance: ['done'] }, { kind: 'agent', botId: parent.assigneeBotId, generation: 1 });
            startTask(f, result.taskId!);
            expect(occupiedTeamWorkSlots(f.state).size).toBe(1);
        }
        const leaf = f.state.tasks.find(task => task.id === result.taskId)!;
        const deeper = f.act({ type: 'delegate', parentTaskId: leaf.id, goal: 'uncertain', acceptance: ['done'] }, { kind: 'agent', botId: leaf.assigneeBotId, generation: 1 });
        const operation = f.state.operations.find(op => op.taskId === deeper.taskId)!;
        f.act({ type: 'claim-operation', operationId: operation.id, teamLaunchVersion: 1, machineId: 'machine' });
        f.act({ type: 'fail-operation', operationId: operation.id, claimId: f.state.operations.find(op => op.id === operation.id)!.claimId!, machineId: 'machine', error: 'unknown wrapper outcome', unknown: true });
        const other = f.act({ type: 'delegate', goal: 'other', acceptance: ['done'] });
        expect(() => startTask(f, other.taskId!)).toThrow('team_parallel_limit');
        expect(occupiedTeamWorkSlots(f.state).size).toBe(1);
    });
    it('releases accepted work slots while safely preserving unmerged resources', () => {
        const f = fixture();
        f.act({ type: 'set-defaults', defaults: { maxParallel: 1 } });
        const first = f.act({ type: 'delegate', goal: 'first', acceptance: ['done'] });
        startTask(f, first.taskId!);
        const task = f.state.tasks.find(task => task.id === first.taskId)!;
        f.act({ type: 'submit', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: 1, result: 'done' });
        f.act({ type: 'accept', taskId: task.id, attemptId: task.currentAttemptId, goalVersion: 1 });
        const stop = f.state.operations.find(op => op.type === 'stop')!;
        f.act({ type: 'claim-operation', operationId: stop.id, machineId: 'machine' });
        f.act({ type: 'fail-operation', operationId: stop.id, machineId: 'machine', claimId: f.state.operations.find(op => op.id === stop.id)!.claimId!, error: 'Unmerged work retained' });
        expect(occupiedTeamWorkSlots(f.state).size).toBe(0);
        const second = f.act({ type: 'delegate', goal: 'second', acceptance: ['done'] });
        startTask(f, second.taskId!);
        expect(f.state.bots.find(bot => bot.id === task.assigneeBotId)?.sessionId).toBeTruthy();
        expect(f.state.tasks.find(candidate => candidate.id === task.id)?.cleanup).toBe('failed');
    });
    it('inherits the actual parent worktree without rewriting the original spawn base', () => {
        const f = fixture();
        const result = f.act({ type: 'start', launch: { goal: 'goal', assistant: 'codex', directory: '/source' } });
        startTask(f, result.taskId!, '/isolated/lead');
        const lead = f.state.bots[0];
        f.act({ type: 'delegate', goal: 'child', acceptance: ['done'], parentTaskId: result.taskId }, { kind: 'agent', botId: lead.id, generation: 1 });
        expect(f.state.bots[0].directory).toBe('/isolated/lead');
        expect(f.state.operations[0].directory).toBe('/source');
        expect(f.state.operations[1].directory).toBe('/isolated/lead');
    });
});

describe('B-692 member lifecycle', () => {
    const launch = (f: ReturnType<typeof fixture>, taskId: string, sessionId: string) => {
        const op = f.state.operations.filter(o => o.taskId === taskId && o.type === 'spawn').pop()!;
        f.act({ type: 'claim-operation', teamLaunchVersion: 1, operationId: op.id, machineId: 'machine' });
        f.act({ type: 'complete-operation', operationId: op.id, machineId: 'machine', claimId: f.state.operations.find(o => o.id === op.id)!.claimId!, sessionId, workingDirectory: `/home/.happy/teams/worktrees/${op.id}` }); // as the daemon reports it
    };
    const finish = (f: ReturnType<typeof fixture>, taskId: string) => {
        const t = f.state.tasks.find(t => t.id === taskId)!;
        f.act({ type: 'cancel', taskId, attemptId: t.currentAttemptId, goalVersion: t.goalVersion, reason: 'done here' });
        return f.state.operations.filter(o => o.type === 'stop' && o.taskId === taskId).pop()!;
    };
    const completeStop = (f: ReturnType<typeof fixture>, stopId: string) => {
        f.act({ type: 'claim-operation', operationId: stopId, machineId: 'machine' });
        f.act({ type: 'complete-operation', operationId: stopId, machineId: 'machine', claimId: f.state.operations.find(o => o.id === stopId)!.claimId! });
    };

    it('queues a delegation to a bot whose cleanup is still running instead of answering 409', () => {
        const f = fixture();
        const first = f.act({ type: 'delegate', goal: 'one', acceptance: ['a'], botName: 'Dev-B2' });
        launch(f, first.taskId!, 'old-session');
        const stop = finish(f, first.taskId!);
        const bot = f.state.bots[0];
        expect(bot.sessionId).toBe('old-session');
        const second = f.act({ type: 'delegate', goal: 'two', acceptance: ['a'], assigneeBotId: bot.id });
        const queued = f.state.tasks.find(t => t.id === second.taskId)!;
        expect(queued.status).toBe('queued');
        expect(f.state.messages.some(m => m.taskId === queued.id)).toBe(false); // never sent to the stopping session
        const spawn = f.state.operations.find(o => o.taskId === queued.id && o.type === 'spawn')!;
        expect(spawn.sessionId).toBeNull();
        expect(() => f.act({ type: 'claim-operation', teamLaunchVersion: 1, operationId: spawn.id, machineId: 'machine' })).toThrow('bot_cleanup_pending');
        completeStop(f, stop.id);
        expect(f.state.bots[0].sessionId).toBeNull(); // released although the generation moved on
        launch(f, queued.id, 'new-session');
        expect(f.state.bots[0]).toMatchObject({ id: bot.id, sessionId: 'new-session', generation: bot.generation + 1 });
        expect(f.state.tasks.find(t => t.id === queued.id)?.status).toBe('running');
    });
    it('a retained cleanup that the owner reconciles releases the queued launch too', () => {
        const f = fixture();
        const first = f.act({ type: 'delegate', goal: 'one', acceptance: ['a'] });
        launch(f, first.taskId!, 'old-session');
        const stop = finish(f, first.taskId!);
        f.act({ type: 'claim-operation', operationId: stop.id, machineId: 'machine' });
        const claimId = f.state.operations.find(o => o.id === stop.id)!.claimId!;
        f.act({ type: 'fail-operation', operationId: stop.id, machineId: 'machine', claimId, error: 'Unmerged work retained' });
        const second = f.act({ type: 'delegate', goal: 'two', acceptance: ['a'], assigneeBotId: f.state.bots[0].id });
        f.act({ type: 'reconcile-operation', operationId: stop.id, claimId, note: 'pushed by hand' });
        expect(f.state.bots[0].sessionId).toBeNull();
        launch(f, second.taskId!, 'new-session');
        expect(f.state.bots[0].sessionId).toBe('new-session');
    });
    it('reuses a stopped member of the same shape instead of adding one-shot bots', () => {
        const f = fixture();
        const first = f.act({ type: 'delegate', goal: 'one', acceptance: ['a'], botName: 'Dev-B2', directory: '/repo' });
        launch(f, first.taskId!, 's1');
        completeStop(f, finish(f, first.taskId!).id);
        const reuse = f.act({ type: 'delegate', goal: 'two', acceptance: ['a'], botName: 'Dev-C2', directory: '/repo' });
        expect(f.state.bots).toHaveLength(1);
        expect(f.state.bots[0]).toMatchObject({ name: 'Dev-C2', previousNames: ['Dev-B2'], generation: 2, sessionId: null });
        expect(f.state.tasks.find(t => t.id === reuse.taskId)?.assigneeBotId).toBe(f.state.bots[0].id);
        // a different agent or folder is a different member
        f.act({ type: 'delegate', goal: 'three', acceptance: ['a'], assistant: 'codex', directory: '/repo' });
        f.act({ type: 'delegate', goal: 'four', acceptance: ['a'], directory: '/other' });
        expect(f.state.bots).toHaveLength(3);
    });
    it('counts only members toward the limit and reports activity in the view', () => {
        const f = fixture();
        for (let i = 0; i < 31; i++) {
            const d = f.act({ type: 'delegate', goal: `g${i}`, acceptance: ['a'], directory: `/repo/${i}` });
            const t = f.state.tasks.find(t => t.id === d.taskId)!;
            f.act({ type: 'cancel', taskId: t.id, attemptId: t.currentAttemptId, goalVersion: 1, reason: 'unused' });
        }
        for (let i = 0; i < 32; i++) f.act({ type: 'delegate', goal: `live${i}`, acceptance: ['a'], directory: `/live/${i}` });
        expect(() => f.act({ type: 'delegate', goal: 'one more', acceptance: ['a'], directory: '/live/x' })).toThrow('team_bot_limit');
        const view = teamView(f.state, owner);
        expect(view.memberCounts).toEqual({ active: 32, stopping: 0, idle: 0, inactive: 31 });
        // a bot that still holds a session is never picked for reuse (it would be messaged, not relaunched)
        expect(f.state.bots.filter(b => b.sessionId)).toHaveLength(0);
        expect(view.bots.filter(b => b.activity === 'inactive')).toHaveLength(31);
        // derived fields are response-only
        expect('memberCounts' in f.state).toBe(false);
        expect(f.state.bots.some(b => 'activity' in b)).toBe(false);
    });
});

describe('B-730 one live team per session', () => {
    const team = (id: string, bots: { id: string; sessionId: string | null; root?: boolean }[], archivedAt?: number): TeamState =>
        ({ ...empty(), id, name: `T-${id}`, ...(archivedAt ? { archivedAt } : {}), bots: bots.map(b => ({ name: b.id, generation: 1, root: b.root ?? false, managed: !b.root, assistant: 'claude' as const, directory: null, ...b })) });
    it('finds a lead or member binding in another live team, never the target or an archived team', () => {
        const teams = [team('archived', [{ id: 'x', sessionId: 's' }], 5), team('target', [{ id: 'y', sessionId: 's' }]), team('home', [{ id: 'lead', sessionId: 's', root: true }])];
        expect(otherTeamBinding(teams, 's', 'target')).toEqual({ teamId: 'home', teamName: 'T-home', botId: 'lead', root: true });
        expect(otherTeamBinding(teams.slice(0, 2), 's', 'target')).toBeNull();
        expect(otherTeamBinding([team('home', [{ id: 'm', sessionId: 's' }])], 's')).toMatchObject({ botId: 'm', root: false });
        expect(otherTeamBinding([team('home', [{ id: 'm', sessionId: 'other' }])], 's')).toBeNull();
    });
    it('a transfer releases only that session, revokes its generation and records the destination', () => {
        const before = team('home', [{ id: 'lead', sessionId: 's', root: true }, { id: 'm', sessionId: 'kept' }]);
        const after = transferSessionOut(before, 's', 'next', 42);
        expect(after.bots[0]).toMatchObject({ sessionId: null, generation: 2, previousSessionIds: ['s'], transferredTo: { teamId: 'next', sessionId: 's', at: 42 } });
        expect(after.bots[1]).toEqual(before.bots[1]);
        expect(after.version).toBe(before.version + 1);
        expect(before.bots[0].sessionId).toBe('s');
    });
});
