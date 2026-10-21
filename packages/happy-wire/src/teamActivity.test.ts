import { describe, expect, it } from 'vitest';
import { TEAM_MEMBER_IDLE_MS, teamBotActivity, teamMemberCounts } from './teamActivity';
import type { TeamBot, TeamOperation, TeamState, TeamTask } from './teams';

const NOW = 10 * TEAM_MEMBER_IDLE_MS;
const bot = (patch: Partial<TeamBot> = {}): TeamBot => ({ id: 'b', name: 'Dev', sessionId: null, generation: 1, root: false, managed: true, assistant: 'claude', directory: '/r', ...patch });
const task = (status: TeamTask['status']): TeamTask => ({ id: 't', parentTaskId: null, goal: 'g', acceptance: ['a'], goalVersion: 1, ownerBotId: null, assigneeBotId: 'b', status, attempts: [], currentAttemptId: 'a1', cleanup: 'none' });
const op = (type: 'spawn' | 'stop', status: TeamOperation['status'], patch: Partial<TeamOperation> = {}): TeamOperation => ({ id: `${type}-${status}`, teamId: 'x', machineId: 'm', taskId: 't', botId: 'b', attemptId: 'a1', generation: 1, type, status, claimId: null, claimedAt: null, error: null, sessionId: null, directory: '/r', assistant: 'claude', prompt: '', createdAt: 1, ...patch });
const team = (tasks: TeamTask[], operations: TeamOperation[]) => ({ tasks, operations });
const at = { now: NOW };

describe('B-692 team member activity', () => {
    it('accepted/cancelled work whose cleanup finished (no session) is inactive (已停用)', () => {
        expect(teamBotActivity(team([task('done')], [op('spawn', 'completed'), op('stop', 'completed')]), bot(), at)).toBe('inactive');
        expect(teamBotActivity(team([task('cancelled')], []), bot(), at)).toBe('inactive');
        expect(teamBotActivity(team([], []), bot(), at)).toBe('inactive'); // never started
    });
    it('B-690: an archived session, an exited session or 7 days without events is inactive', () => {
        const bound = bot({ sessionId: 's1', lastEvent: 'idle', lastEventAt: NOW - 1000 });
        expect(teamBotActivity(team([], []), bound, at)).toBe('idle');
        expect(teamBotActivity(team([], []), bound, { ...at, sessionArchived: id => id === 's1' })).toBe('inactive');
        expect(teamBotActivity(team([], []), { ...bound, lastEvent: 'exited' }, at)).toBe('inactive');
        expect(teamBotActivity(team([], []), { ...bound, lastEventAt: NOW - TEAM_MEMBER_IDLE_MS - 1 }, at)).toBe('inactive');
        expect(teamBotActivity(team([], []), { ...bound, lastEventAt: undefined, lastEvent: undefined }, at)).toBe('idle'); // no evidence
    });
    it('an unfinished task or a launch in progress keeps a member active, whatever its session looks like', () => {
        for (const s of ['queued', 'running', 'submitted'] as const) {
            expect(teamBotActivity(team([task(s)], []), bot({ sessionId: 's', lastEvent: 'exited' }), { ...at, sessionArchived: () => true })).toBe('active');
        }
        expect(teamBotActivity(team([task('done')], [op('spawn', 'failed')]), bot(), at)).toBe('active');
        expect(teamBotActivity(team([task('done')], [op('spawn', 'unknown', { generation: 0 })]), bot(), at)).toBe('inactive');
        expect(teamBotActivity(team([task('done')], [op('spawn', 'failed', { error: 'task_closed_before_spawn' })]), bot(), at)).toBe('inactive');
    });
    it('an unfinished cleanup — including one retained for the owner — is stopping, never folded', () => {
        for (const s of ['pending', 'claimed', 'failed', 'unknown'] as const) {
            expect(teamBotActivity(team([task('done')], [op('stop', s)]), bot({ sessionId: 's1', lastEvent: 'exited' }), at)).toBe('stopping');
        }
    });
    it('the lead is always a member', () => {
        expect(teamBotActivity(team([], []), bot({ root: true }), at)).toBe('active');
    });
    it('counts members without the inactive ones', () => {
        const state = { bots: [bot({ id: 'lead', root: true }), bot({ id: 'b' }), bot({ id: 'c' }), bot({ id: 'd', sessionId: 's', lastEventAt: NOW })], tasks: [task('running')], operations: [] } as Pick<TeamState, 'bots' | 'tasks' | 'operations'>;
        expect(teamMemberCounts(state, at)).toEqual({ active: 2, stopping: 0, idle: 1, inactive: 1 });
    });
});
