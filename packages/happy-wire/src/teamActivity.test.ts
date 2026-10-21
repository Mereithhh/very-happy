import { describe, expect, it } from 'vitest';
import { teamBotActivity, teamMemberCounts } from './teamActivity';
import type { TeamBot, TeamOperation, TeamState, TeamTask } from './teams';

const bot = (patch: Partial<TeamBot> = {}): TeamBot => ({ id: 'b', name: 'Dev', sessionId: null, generation: 1, root: false, managed: true, assistant: 'claude', directory: '/r', ...patch });
const task = (status: TeamTask['status']): TeamTask => ({ id: 't', parentTaskId: null, goal: 'g', acceptance: ['a'], goalVersion: 1, ownerBotId: null, assigneeBotId: 'b', status, attempts: [], currentAttemptId: 'a1', cleanup: 'none' });
const op = (type: 'spawn' | 'stop', status: TeamOperation['status'], patch: Partial<TeamOperation> = {}): TeamOperation => ({ id: `${type}-${status}`, teamId: 'x', machineId: 'm', taskId: 't', botId: 'b', attemptId: 'a1', generation: 1, type, status, claimId: null, claimedAt: null, error: null, sessionId: null, directory: '/r', assistant: 'claude', prompt: '', createdAt: 1, ...patch });
const team = (tasks: TeamTask[], operations: TeamOperation[]) => ({ tasks, operations });

describe('B-692 team member activity', () => {
    it('a worker whose task was accepted and whose cleanup finished is inactive (已停用)', () => {
        expect(teamBotActivity(team([task('done')], [op('spawn', 'completed'), op('stop', 'completed')]), bot())).toBe('inactive');
        expect(teamBotActivity(team([task('cancelled')], []), bot())).toBe('inactive');
    });
    it('unfinished work or a launch in progress keeps it active', () => {
        for (const s of ['queued', 'running', 'submitted'] as const) expect(teamBotActivity(team([task(s)], []), bot())).toBe('active');
        expect(teamBotActivity(team([task('done')], [op('spawn', 'failed')]), bot())).toBe('active');
        // an older generation's stuck launch does not
        expect(teamBotActivity(team([task('done')], [op('spawn', 'unknown', { generation: 0 })]), bot())).toBe('inactive');
        expect(teamBotActivity(team([task('done')], [op('spawn', 'failed', { error: 'task_closed_before_spawn' })]), bot())).toBe('inactive');
    });
    it('a cleanup that has not completed — including one retained for the owner — is stopping', () => {
        for (const s of ['pending', 'claimed', 'failed', 'unknown'] as const) expect(teamBotActivity(team([task('done')], [op('stop', s)]), bot({ sessionId: 's1' }))).toBe('stopping');
    });
    it('the lead and user-linked sessions are always members; a bound managed bot with nothing to do is idle', () => {
        expect(teamBotActivity(team([], []), bot({ root: true }))).toBe('active');
        expect(teamBotActivity(team([], []), bot({ managed: false, sessionId: 's' }))).toBe('active');
        expect(teamBotActivity(team([], []), bot({ sessionId: 's' }))).toBe('idle');
    });
    it('counts members without the inactive ones', () => {
        const state = { bots: [bot({ id: 'lead', root: true }), bot({ id: 'b' }), bot({ id: 'c' })], tasks: [task('running')], operations: [] } as Pick<TeamState, 'bots' | 'tasks' | 'operations'>;
        expect(teamMemberCounts(state)).toEqual({ active: 2, stopping: 0, idle: 0, inactive: 1 });
    });
});
