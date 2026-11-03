import { describe, expect, it } from 'vitest';
import type { TeamMessage, TeamOperation, TeamState, TeamTask } from '@slopus/happy-wire';
import { TEAM_VIEW_RECENT_MESSAGES, teamActionReceipt, teamTaskToolView, teamToolView } from './toolView';

const task = (id: string, status: TeamTask['status']): TeamTask => ({ id, parentTaskId: null, goal: 'g'.repeat(5000), acceptance: ['a'], goalVersion: 2, ownerBotId: 'lead', assigneeBotId: 'w', status, attempts: [{ id: `${id}-old`, botId: 'w', generation: 1, goalVersion: 1, status: 'superseded', result: 'r'.repeat(5000) }, { id: `${id}-cur`, botId: 'w', generation: 1, goalVersion: 2, status: status === 'done' ? 'accepted' : 'submitted', result: 'evidence'.repeat(500) }], currentAttemptId: `${id}-cur`, cleanup: 'done' });
const message = (i: number, delivered: boolean): TeamMessage => ({ id: `m${i}`, taskId: 'open', senderBotId: null, recipientBotId: 'lead', body: `body ${i}`, deliveredAt: delivered ? i : null, createdAt: i });
const op = (id: string, status: TeamOperation['status']): TeamOperation => ({ id, teamId: 't', machineId: 'm', taskId: 'open', botId: 'w', attemptId: 'a', generation: 1, type: 'spawn', status, claimId: null, claimedAt: null, error: null, sessionId: null, directory: '/repo', assistant: 'claude', prompt: 'p'.repeat(5000), createdAt: 1 });
const team = (): TeamState => ({ id: 't', name: 'T', machineId: 'm', version: 3, createdAt: 1, defaults: { maxParallel: 3 },
    bots: [{ id: 'w', name: 'W', root: false, managed: true, sessionId: 's', generation: 1, assistant: 'claude', directory: '/repo', previousSessionIds: ['x', 'y'] }],
    tasks: [task('done', 'done'), task('open', 'submitted')],
    messages: [...Array.from({ length: 50 }, (_, i) => message(i, true)), message(99, false)],
    operations: [op('finished', 'completed'), op('stuck', 'unknown')],
    capacity: { metrics: { bytes: { used: 1, limit: 2 }, messages: { used: 51, limit: 2000 }, operations: { used: 2, limit: 1000 }, tasks: { used: 2, limit: 200 } } } });

describe('B-822 compact team view for the team_* tools', () => {
    it('B-881: an index — open tasks clipped with the ids a write needs, closed counted, my recent messages clipped, no operations', () => {
        const state = team();
        state.messages.push({ id: 'other', taskId: 'open', senderBotId: 'w', recipientBotId: 'w2', body: 'between members', deliveredAt: 1, createdAt: 1 }, { ...message(100, true), body: 'x'.repeat(2000) });
        const view = teamToolView(state, { botId: 'lead' }) as any;
        expect(view.tasks).toHaveLength(1);
        expect(view.tasks[0]).toMatchObject({ id: 'open', status: 'submitted', currentAttemptId: 'open-cur', goalVersion: 2, assigneeBotId: 'w', attempts: 2 });
        expect(view.tasks[0].goal.length).toBeLessThan(250);
        expect(view.tasks[0].currentAttemptStatus).toBe('submitted');
        expect(JSON.stringify(view)).not.toContain('evidence'); // the submission is one taskId call away
        expect(view.closedTasks).toEqual({ done: 1, cancelled: 0 });
        expect(view.messages.map((m: any) => m.body)).toContain('body 99'); // undelivered to me: always shown
        expect(view.messages.find((m: any) => m.body === 'body 99').undelivered).toBe(true);
        expect(view.messages.map((m: any) => m.body)).not.toContain('between members'); // not mine
        expect(view.messages).toHaveLength(TEAM_VIEW_RECENT_MESSAGES + 1);
        expect(view.messages[0].id).toBeUndefined();
        expect(view.messages[0].deliveredAt).toBeUndefined();
        const long = view.messages.find((m: any) => m.body.startsWith('xxx'));
        expect(long.body.length).toBeLessThan(510);
        expect(long.bodyChars).toBe(2000);
        expect(view.operations).toBeUndefined();
        expect(JSON.stringify(view)).not.toContain('ppppp');
        expect(view.bots).toEqual([{ id: 'w', name: 'W', root: false }]);
        expect(view.defaults).toEqual({ maxParallel: 3 });
        expect(view.capacity.metrics.messages.used).toBe(51);
        expect(view.selfBotId).toBe('lead');
        expect(view.omitted).toMatchObject({ closedTaskDetails: 1, olderMessages: 31, otherMembersMessages: 1, operations: 2, unfinishedOperations: 1 });
        expect(view.omitted.hint).toContain('taskId');
    });
    it('B-881: includeClosed lists closed tasks, messagesLimit widens or narrows the messages; no botId lists everyone\'s', () => {
        const wide = teamToolView(team(), { includeClosed: true, messagesLimit: 100 }) as any;
        expect(wide.closedTasks).toMatchObject([{ id: 'done', status: 'done', attempts: 2 }]);
        expect(wide.closedTasks[0].goal.length).toBeLessThan(250);
        expect(wide.messages).toHaveLength(51);
        expect(wide.omitted.closedTaskDetails).toBe(0);
        const none = teamToolView(team(), { botId: 'lead', messagesLimit: 0 }) as any;
        expect(none.messages.map((m: any) => m.body)).toEqual(['body 99']);
        // Undelivered to someone else (a stopped member) is not pinned: it competes on recency.
        const sent = team();
        sent.messages = [{ ...message(1, false), senderBotId: 'lead', recipientBotId: 'gone' }, ...Array.from({ length: 30 }, (_, i) => message(i + 2, true))];
        expect((teamToolView(sent, { botId: 'lead' }) as any).messages.map((m: any) => m.body)).not.toContain('body 1');
    });
    it('returns one task in full on request', () => {
        const detail = teamTaskToolView(team(), 'open') as any;
        expect(detail.task.attempts[0].result).toHaveLength(5000);
        expect(detail.messages).toHaveLength(51);
        expect(detail.operations.map((o: any) => o.id)).toEqual(['finished', 'stuck']);
        expect(detail.operations[0].prompt).toHaveLength(5000);
        expect((teamTaskToolView(team(), 'gone') as any).error).toContain('archived');
    });
});

describe('B-840 receipt for team_* writes', () => {
    it('answers with the ids the caller needs next and the small team signals, not the team view', () => {
        const state = { ...team(), idleMembers: [{ botId: 'w', name: 'W', since: 1, taskIds: ['open'] }], cleanupIssues: [], schedules: [{ id: 'sch', name: 'S', botId: 'lead', machineId: 'm', body: 'b', status: 'active' as const, version: 4, nextRunAt: 9, fireCount: 0, createdAt: 1 }] };
        const receipt = teamActionReceipt({ team: state, taskId: 'open', operation: op('spawned', 'pending') }) as any;
        expect(receipt.taskId).toBe('open');
        expect(receipt.task).toMatchObject({ id: 'open', status: 'submitted', currentAttemptId: 'open-cur', goalVersion: 2, assigneeBotId: 'w', attempts: 2 });
        expect(receipt.task.currentAttempt).toEqual({ id: 'open-cur', botId: 'w', status: 'submitted', goalVersion: 2, generation: 1 });
        expect(receipt.task.goal.length).toBeLessThan(250); // the caller wrote it; no echo
        expect(JSON.stringify(receipt)).not.toContain('evidence'); // nor its submission
        expect(receipt.operation.id).toBe('spawned');
        expect(receipt.operation.prompt).toBeUndefined();
        expect(receipt.taskOperations.map((o: any) => o.id)).toEqual(['stuck']);
        expect(receipt.taskOperations[0].prompt).toBeUndefined();
        expect(receipt.team).toEqual({ id: 't', name: 'T', version: 3, openTasks: 1, capacity: state.capacity, idleMembers: state.idleMembers });
        expect(receipt.hint).toContain('team_inspect');
        expect(JSON.stringify(receipt).length).toBeLessThan(2000);
        const scheduled = teamActionReceipt({ team: state, scheduleId: 'sch', scheduleRecordRetained: true }) as any;
        expect(scheduled.schedule.version).toBe(4);
        expect(scheduled.scheduleRecordRetained).toBe(true);
        expect(scheduled.task).toBeUndefined();
    });
    it('stays small however large the team grows', () => {
        const big = team();
        big.tasks = Array.from({ length: 150 }, (_, i) => task(`t${i}`, i % 3 ? 'done' : 'running'));
        big.messages = Array.from({ length: 1500 }, (_, i) => message(i, i % 10 !== 0));
        const receipt = teamActionReceipt({ team: big, taskId: 't3' });
        expect(JSON.stringify(receipt).length).toBeLessThan(2000);
        expect(JSON.stringify(big).length).toBeGreaterThan(100_000);
    });
    it('passes through anything that is not a team view', () => {
        const forwarded = { taskId: 'x', team: { id: 't', name: 'T', version: 1, openTasks: 0 }, hint: 'Receipt only.' };
        expect(teamActionReceipt(forwarded)).toBe(forwarded);
        expect(teamActionReceipt(undefined)).toBeUndefined();
    });
});
