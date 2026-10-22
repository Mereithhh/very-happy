import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { TeamBot, TeamOperation, TeamState, TeamTask } from '@slopus/happy-wire';
import type { AgentExecution } from '@/sync/agentStatus';
import type { Session } from '@/sync/storageTypes';
import { TEAM_TASK_STATES, teamTaskLane, teamTaskNeedsOwner, teamTaskState, teamTaskTone, type TeamTaskState } from './teamTaskState';
import { en } from '@/text/_default';
import { zhHans as zh } from '@/text/translations/zh-Hans';

const bot = (id: string, extra: Partial<TeamBot> = {}): TeamBot => ({ id, name: id, root: false, managed: true, assistant: 'claude', directory: '/repo', sessionId: `s-${id}`, generation: 1, ...extra }) as TeamBot;
const task = (id: string, assigneeBotId: string, status: TeamTask['status'], extra: Partial<TeamTask> = {}): TeamTask => ({
    id, parentTaskId: 'root', goal: id, acceptance: [], goalVersion: 1, ownerBotId: 'lead', assigneeBotId, status,
    attempts: [{ id: `a-${id}`, botId: assigneeBotId, generation: 1, goalVersion: 1, status: 'running', result: null }], currentAttemptId: `a-${id}`, cleanup: 'none', ...extra,
});
const spawn = (t: TeamTask, status: TeamOperation['status'], extra: Partial<TeamOperation> = {}): TeamOperation => ({
    id: `op-${t.id}`, teamId: 'team', machineId: 'm', taskId: t.id, botId: t.assigneeBotId, attemptId: t.currentAttemptId, generation: 1, type: 'spawn', status,
    claimId: status === 'pending' ? null : 'c', claimedAt: null, error: null, sessionId: null, directory: '/repo', assistant: 'claude', prompt: '', createdAt: 1, ...extra,
});
const team = (bots: TeamBot[], operations: TeamOperation[] = []) => ({ bots, operations });
// The store-facing module pulls in storage, which needs browser globals first.
let memberSessionExecution: typeof import('./useMemberExecution').memberSessionExecution;
beforeAll(async () => { installBrowserTestGlobals(); ({ memberSessionExecution } = await import('./useMemberExecution')); });
const exec = (map: Record<string, AgentExecution>) => (sessionId: string) => map[sessionId];

describe('B-761 teamTaskState — every state from its rule', () => {
    const w = bot('w');
    const running = task('t', 'w', 'running');
    it.each<[AgentExecution | undefined, TeamTaskState]>([
        ['running', 'working'], ['background', 'working'], ['input', 'waiting'], ['idle', 'idle'],
        ['offline', 'stopped'], ['unknown', 'checking'], [undefined, 'checking'],
    ])('running task, member session %s → %s', (execution, state) => {
        expect(teamTaskState(team([w]), running, () => execution)).toBe(state);
    });

    it('「运行中」needs an active turn: a running task never shows working from task.status alone', () => {
        for (const execution of ['idle', 'input', 'offline', 'unknown', undefined] as const) {
            expect(teamTaskState(team([w]), running, () => execution)).not.toBe('working');
        }
    });

    it('a stale lease or unloaded session of an exited member is stopped, not checking', () => {
        expect(teamTaskState(team([bot('w', { lastEvent: 'exited' })]), running, () => undefined)).toBe('stopped');
        expect(teamTaskState(team([bot('w', { lastEvent: 'exited' })]), running, () => 'unknown')).toBe('stopped');
        // A live reading wins over the last event (a resumed wrapper after an infra exit, B-505).
        expect(teamTaskState(team([bot('w', { lastEvent: 'exited' })]), running, () => 'running')).toBe('working');
    });

    it('running without a session: starting while its launch is in flight, else stopped', () => {
        const unbound = bot('w', { sessionId: null });
        expect(teamTaskState(team([unbound], [spawn(running, 'claimed')]), running, () => 'running')).toBe('starting');
        expect(teamTaskState(team([unbound]), running, () => 'running')).toBe('stopped');
    });

    it('queued: waiting for a slot, starting, or launch failed', () => {
        const queued = task('q', 'w', 'queued');
        expect(teamTaskState(team([w]), queued, () => 'running')).toBe('queued');
        expect(teamTaskState(team([w], [spawn(queued, 'pending')]), queued, () => 'running')).toBe('starting');
        expect(teamTaskState(team([w], [spawn(queued, 'claimed')]), queued, () => 'running')).toBe('starting');
        expect(teamTaskState(team([w], [spawn(queued, 'failed', { error: 'x' })]), queued, () => 'running')).toBe('launchFailed');
        expect(teamTaskState(team([w], [spawn(queued, 'unknown')]), queued, () => 'running')).toBe('launchFailed');
        // Only the current attempt's launch counts.
        expect(teamTaskState(team([w], [spawn(queued, 'failed', { attemptId: 'older' })]), queued, () => 'running')).toBe('queued');
    });

    it('submitted / done / cancelled come from the protocol, whatever the session does', () => {
        for (const status of ['submitted', 'done', 'cancelled'] as const) {
            expect(teamTaskState(team([w]), task('x', 'w', status), () => 'running')).toBe(status);
        }
    });

    it('lanes, tones and owner attention are total over the state set', () => {
        expect(TEAM_TASK_STATES.map(s => [s, teamTaskLane(s)])).toEqual([
            ['queued', 'queued'], ['starting', 'queued'], ['launchFailed', 'queued'], ['cleanupBlocked', 'queued'],
            ['working', 'running'], ['waiting', 'running'], ['idle', 'running'], ['stopped', 'running'], ['checking', 'running'],
            ['submitted', 'submitted'], ['done', 'finished'], ['cancelled', 'finished'],
        ]);
        expect(TEAM_TASK_STATES.filter(s => teamTaskTone(s) === 'live')).toEqual(['working']);
        expect(TEAM_TASK_STATES.filter(teamTaskNeedsOwner)).toEqual(['launchFailed', 'cleanupBlocked', 'waiting', 'stopped']);
    });

    it('every state has an English and a Chinese label', () => {
        for (const state of TEAM_TASK_STATES) {
            expect(en.teams.taskState[state]).toBeTruthy();
            expect(zh.teams.taskState[state]).toBeTruthy();
        }
        expect(zh.teams.taskState.working).toBe('运行中');
        expect(zh.teams.taskState.idle).toBe('空闲待回复');
        expect(zh.teams.taskState.stopped).toBe('已停止 · 需要处理');
    });
});

describe('B-761 memberSessionExecution — the sidebar rule for a member session', () => {
    const session = (extra: Partial<Session>): Session => ({ id: 's', presence: 'online', active: true, thinking: false, archivedAt: null, agentState: null, ...extra }) as Session;
    const live = { fresh: true, runningSubagents: 0, backgroundTasks: 0 };
    it('maps session liveness to an execution', () => {
        expect(memberSessionExecution(undefined, live)).toBeUndefined();
        expect(memberSessionExecution(session({ archivedAt: 5 }), live)).toBe('offline');
        expect(memberSessionExecution(session({ presence: 12345 }), live)).toBe('offline');
        expect(memberSessionExecution(session({ active: false }), live)).toBe('offline');
        expect(memberSessionExecution(session({ thinking: true }), live)).toBe('running');
        // thinking is a lease: a stale heartbeat never reads as running (B-322).
        expect(memberSessionExecution(session({ thinking: true }), { ...live, fresh: false })).toBe('unknown');
        expect(memberSessionExecution(session({}), live)).toBe('idle');
        expect(memberSessionExecution(session({}), { ...live, runningSubagents: 1 })).toBe('running');
        expect(memberSessionExecution(session({}), { ...live, backgroundTasks: 2 })).toBe('background');
        expect(memberSessionExecution(session({ agentState: { requests: { r: { tool: 'Bash', arguments: {}, createdAt: 1 } } } as unknown as Session['agentState'] }), live)).toBe('input');
    });
});

/**
 * Production replay (veryhappy.dev, read-only, 2026-10-22 09:58:29Z): the
 * Owner's teams with every unfinished task. Shapes are the real records
 * (status, attempt, session binding, lastEvent); the member execution is what
 * the session actually did at that instant (its last message vs its last
 * turn-end event). Before B-761 the board showed `task.status` → all 运行中.
 */
describe('B-761 production replay', () => {
    const vh = {
        bots: [
            bot('lead-vh', { root: true, lastEvent: 'idle', lastEventAt: Date.parse('2026-10-22T09:55:24Z') }),
            bot('dev-e1', { lastEvent: 'idle', lastEventAt: Date.parse('2026-10-22T09:28:08Z') }),
            // Generation 3; its lastEvent is generation 2's turn end (fixed at the source by the server).
            bot('dev-k2', { generation: 3, lastEvent: 'idle', lastEventAt: Date.parse('2026-10-21T19:50:46Z') }),
            bot('release2', { lastEvent: 'idle', lastEventAt: Date.parse('2026-10-22T01:39:03Z') }),
            bot('ui-audit'),
            bot('dev-i1', { sessionId: null }),
        ],
        tasks: [
            task('1ae298ec', 'lead-vh', 'running', { parentTaskId: null }),
            task('e21ceb87', 'dev-e1', 'running'),
            task('47d883d3', 'dev-k2', 'running'),
            task('f9580aba', 'release2', 'running'),
            task('87ca10bf', 'ui-audit', 'running'),
            task('6d7b08f3', 'dev-i1', 'cancelled', { cleanup: 'pending' }),
        ],
    };
    const biz = {
        bots: [bot('lead-biz', { root: true, lastEvent: 'idle', lastEventAt: Date.parse('2026-10-22T07:45:12Z') }), bot('rank', { sessionId: null })],
        tasks: [task('94350e49', 'lead-biz', 'running', { parentTaskId: null }), task('ac3a68a7', 'rank', 'done', { cleanup: 'done' })],
    };
    const personal = { bots: [bot('lead-personal', { root: true, lastEvent: 'idle' })], tasks: [task('73c73b09', 'lead-personal', 'running', { parentTaskId: null })] };
    const actual = exec({
        's-lead-vh': 'idle', // turn ended 09:55:24, nothing since
        's-dev-e1': 'running', 's-dev-k2': 'running', 's-release2': 'running', 's-ui-audit': 'running',
        's-lead-biz': 'idle', // last message 07:45:12 — idle 2 h 13 min
        's-lead-personal': 'running',
    });
    const states = (t: { bots: TeamBot[]; tasks: TeamTask[] }, operations: TeamOperation[] = []) =>
        Object.fromEntries(t.tasks.map(k => [k.id, teamTaskState({ bots: t.bots, operations } as Pick<TeamState, 'bots' | 'operations'>, k, actual)]));

    it('shows 运行中 only for members with an active turn', () => {
        expect(states(vh, [spawn(vh.tasks[5], 'unknown')])).toEqual({
            '1ae298ec': 'idle', e21ceb87: 'working', '47d883d3': 'working', f9580aba: 'working', '87ca10bf': 'working', '6d7b08f3': 'cancelled',
        });
        expect(states(biz)).toEqual({ '94350e49': 'idle', ac3a68a7: 'done' });
        expect(states(personal)).toEqual({ '73c73b09': 'working' });
    });

    it('the idle leads stay in the 进行中 lane, labelled 空闲待回复 instead of 运行中', () => {
        const state = states(biz)['94350e49'];
        expect(teamTaskLane(state)).toBe('running');
        expect(zh.teams.taskState[state]).toBe('空闲待回复');
        expect(teamTaskTone(state)).toBeNull();
    });

    it('history: a member idle mid-task (Release, 10-21 02:00, 59 min before its next turn) read 空闲待回复, then 运行中', () => {
        const t = { bots: [bot('release')], tasks: [task('66d60530', 'release', 'running')] };
        expect(teamTaskState({ bots: t.bots, operations: [] }, t.tasks[0], () => 'idle')).toBe('idle');
        expect(teamTaskState({ bots: t.bots, operations: [] }, t.tasks[0], () => 'running')).toBe('working');
    });
});
