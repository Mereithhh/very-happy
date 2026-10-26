import { describe, expect, it } from 'vitest';
import type { TeamMessage, TeamOperation, TeamState, TeamTask } from '@slopus/happy-wire';
import { TEAM_VIEW_RECENT_MESSAGES, teamTaskToolView, teamToolView } from './toolView';

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
    it('keeps what a decision needs and summarizes the rest', () => {
        const view = teamToolView(team()) as any;
        const open = view.tasks.find((t: any) => t.id === 'open');
        expect(open.currentAttemptId).toBe('open-cur');
        expect(open.goalVersion).toBe(2);
        expect(open.goal).toHaveLength(5000);
        expect(open.attempts[1].result).toBe('evidence'.repeat(500)); // the submission to review
        expect(open.attempts[0].result).toBeUndefined();
        const done = view.tasks.find((t: any) => t.id === 'done');
        expect(done.goal.length).toBeLessThan(250);
        expect(done.attempts).toBe(2);
        expect(view.messages.map((m: any) => m.id)).toContain('m99'); // undelivered always shown
        expect(view.messages).toHaveLength(TEAM_VIEW_RECENT_MESSAGES + 1);
        expect(view.operations.map((o: any) => o.id)).toEqual(['stuck']);
        expect(view.operations[0].prompt).toBeUndefined();
        expect(view.defaults).toEqual({ maxParallel: 3 });
        expect(view.capacity.metrics.messages.used).toBe(51);
        expect(view.bots[0].previousSessionIds).toBeUndefined();
        expect(view.omitted).toMatchObject({ closedTaskDetails: 1, olderMessages: 30, finishedOperations: 1 });
        expect(JSON.stringify(view).length).toBeLessThan(JSON.stringify(team()).length / 3);
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
