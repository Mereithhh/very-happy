import { describe, it, expect } from 'vitest';
import type { TeamAction, TeamMessage, TeamOperation, TeamState, TeamTask } from '@slopus/happy-wire';
import { reduceTeam, teamBotRepository, teamView, TeamError, type TeamActor } from './reducer';
import { compactTeam, messageArchivable, operationArchivable, repositorySpawnIds, taskArchivable, teamCapacity, warnCapacity, TEAM_COMPACT_AGE_MS, TEAM_COMPACT_MIN_AGE_MS, TEAM_LIMITS } from './compaction';
import { TEAM_CAPACITY_HINT } from './errors';

const HOUR = 60 * 60 * 1000;
const owner: TeamActor = { kind: 'owner' };
const base = (): TeamState => ({ id: 'team', name: 'Team', machineId: 'machine', version: 0, bots: [], tasks: [], messages: [], operations: [], createdAt: 1 });
const task = (id: string, over: Partial<TeamTask> = {}): TeamTask => ({ id, parentTaskId: null, goal: 'g', acceptance: ['a'], goalVersion: 1, ownerBotId: 'lead', assigneeBotId: 'w', status: 'done', attempts: [], currentAttemptId: `${id}-a`, cleanup: 'done', closedAt: 0, ...over });
const message = (id: string, taskId: string | null, over: Partial<TeamMessage> = {}): TeamMessage => ({ id, taskId, senderBotId: null, recipientBotId: 'lead', body: 'b', deliveredAt: 1, createdAt: 1, ...over });
const operation = (id: string, taskId: string, over: Partial<TeamOperation> = {}): TeamOperation => ({ id, teamId: 'team', machineId: 'machine', taskId, botId: 'w', attemptId: `${taskId}-a`, generation: 1, type: 'stop', status: 'completed', claimId: 'c', claimedAt: 1, error: null, sessionId: null, directory: null, assistant: 'claude', prompt: '', createdAt: 1, ...over });

describe('B-822 compaction safety predicates', () => {
    it('never archives an undelivered message, a message of an open task, or a schedule message', () => {
        const team = { tasks: [task('done'), task('open', { status: 'running' })] };
        expect(messageArchivable(message('m', 'done'), team)).toBe(true);
        expect(messageArchivable(message('m', 'done', { deliveredAt: null }), team)).toBe(false);
        expect(messageArchivable(message('m', 'done', { deliveredAt: null, cancelledAt: 5 }), team)).toBe(true);
        expect(messageArchivable(message('m', 'open'), team)).toBe(false);
        expect(messageArchivable(message('m', null), team)).toBe(true);
        expect(messageArchivable(message('m', null, { deliveredAt: null }), team)).toBe(false);
        expect(messageArchivable(message('m', null, { scheduleId: 's' }), team)).toBe(false);
        expect(messageArchivable(message('m', 'archived-earlier'), team)).toBe(true);
    });

    it('never archives an operation that may still act, of an open task, or the bot\'s repository spawn', () => {
        const team = { bots: [], tasks: [task('done'), task('open', { status: 'submitted' })], operations: [operation('repo', 'done', { type: 'spawn', directory: '/repo' }), operation('later', 'done', { type: 'spawn', directory: '/repo' })] };
        const repository = repositorySpawnIds(team);
        expect([...repository]).toEqual(['repo']);
        expect(operationArchivable(team.operations[1], team, repository)).toBe(true);
        expect(operationArchivable(team.operations[0], team, repository)).toBe(false);
        for (const status of ['pending', 'claimed', 'unknown', 'failed'] as const) expect(operationArchivable(operation('o', 'done', { status }), team, repository)).toBe(false);
        expect(operationArchivable(operation('o', 'done', { status: 'failed', error: 'task_closed_before_spawn' }), team, repository)).toBe(true);
        expect(operationArchivable(operation('o', 'open'), team, repository)).toBe(false);
    });

    // P1 repro (review of #771): a reused managed bot's later spawn (not its repository spawn) ran > 24 h,
    // its task was just accepted and the stop waits — the daemon finds the worktree by exactly this spawn.
    const reused = (stop: Partial<TeamOperation>, bot: { sessionId: string | null; generation: number }): TeamState => ({
        ...base(),
        bots: [{ id: 'lead', name: 'Lead', root: true, managed: true, sessionId: 'L1', generation: 1, assistant: 'claude', directory: '/repo' }, { id: 'w', name: 'W', root: false, managed: true, assistant: 'claude', directory: '/wt2', ...bot }],
        tasks: [task('A', { closedAt: 10 * HOUR }), task('B', { closedAt: 100 * HOUR - 60_000, cleanup: 'pending' })],
        operations: [
            operation('spawn-gen1', 'A', { type: 'spawn', generation: 1, sessionId: 'S1', directory: '/repo', createdAt: HOUR }),
            operation('spawn-gen2', 'B', { type: 'spawn', generation: 2, sessionId: 'S2', directory: '/repo', createdAt: 50 * HOUR }),
            operation('stop-B', 'B', { type: 'stop', generation: 2, sessionId: 'S2', createdAt: 100 * HOUR - 60_000, ...stop }),
        ],
    });
    const origins = (team: TeamState) => team.operations.filter(c => c.type === 'spawn' && c.botId === 'w' && c.generation === 2 && c.sessionId === 'S2');
    it('keeps the spawn a bound wrapper or an unfinished stop still reads (worker.ts stop origins / recoverScope)', () => {
        const pending = reused({ status: 'pending', claimId: null, claimedAt: null }, { sessionId: 'S2', generation: 2 });
        expect(origins(compactTeam(pending, 100 * HOUR))).toHaveLength(1);
        // Bound, no stop at all (recoverScope rebuilds a running member's scope from it).
        const bound = { ...pending, tasks: [pending.tasks[0], task('B', { status: 'running', closedAt: undefined, cleanup: 'none' }), task('C', { closedAt: 60 * HOUR })], operations: pending.operations.slice(0, 2).map(o => ({ ...o, taskId: o.id === 'spawn-gen2' ? 'C' : o.taskId })) };
        expect(origins(compactTeam(bound, 100 * HOUR))).toHaveLength(1);
        // B-775: the session was released but its cleanup failed — the owner's retry still needs the spawn.
        for (const status of ['claimed', 'failed', 'unknown'] as const) expect(origins(compactTeam(reused({ status }, { sessionId: null, generation: 2 }), 100 * HOUR))).toHaveLength(1);
        expect(operationArchivable(pending.operations[1], pending, repositorySpawnIds(pending))).toBe(false);
        // Once the stop completed and the bot let go of that binding, the spawn is closed work again.
        const done = reused({ status: 'completed' }, { sessionId: null, generation: 2 });
        expect(origins(compactTeam({ ...done, tasks: [done.tasks[0], task('B', { closedAt: 70 * HOUR })] }, 100 * HOUR))).toHaveLength(0);
    });

    it('never archives an open task, one whose cleanup waits, one with an open descendant, a live operation or an undelivered message', () => {
        const team = { tasks: [task('parent'), task('child', { parentTaskId: 'parent' }), task('grandchild', { parentTaskId: 'child', status: 'running' })], messages: [], operations: [] };
        expect(taskArchivable(team.tasks[0], team)).toBe(false); // an open grandchild is read through it
        expect(taskArchivable(team.tasks[1], team)).toBe(false);
        expect(taskArchivable(team.tasks[2], team)).toBe(false);
        team.tasks[2].status = 'cancelled';
        expect(taskArchivable(team.tasks[0], team)).toBe(true);
        for (const status of ['queued', 'running', 'submitted'] as const) expect(taskArchivable(task('t', { status }), { tasks: [], messages: [], operations: [] })).toBe(false);
        for (const cleanup of ['pending', 'failed'] as const) expect(taskArchivable(task('t', { cleanup }), { tasks: [], messages: [], operations: [] })).toBe(false);
        expect(taskArchivable(task('t'), { tasks: [], messages: [message('m', 't', { deliveredAt: null })], operations: [] })).toBe(false);
        expect(taskArchivable(task('t'), { tasks: [], messages: [], operations: [operation('o', 't', { status: 'unknown' })] })).toBe(false);
        expect(taskArchivable(task('t'), { tasks: [], messages: [message('m', 't')], operations: [operation('o', 't')] })).toBe(true);
    });
});

describe('B-822 compaction policy', () => {
    it('archives closed work only after 24 h while the team is far from its limits', () => {
        const team = { ...base(), tasks: [task('old', { closedAt: 0 }), task('recent', { closedAt: 10 * HOUR })], messages: [message('m-old', 'old'), message('m-recent', 'recent', { deliveredAt: 10 * HOUR })], operations: [operation('o-old', 'old'), operation('o-recent', 'recent', { createdAt: 10 * HOUR })] };
        const now = TEAM_COMPACT_AGE_MS + 1;
        const compacted = compactTeam(team, now);
        expect(compacted.tasks.map(t => t.id)).toEqual(['recent']);
        expect(compacted.messages.map(m => m.id)).toEqual(['m-recent']);
        expect(compacted.operations.map(o => o.id)).toEqual(['o-recent']);
        expect(compacted.compacted).toEqual({ messages: 1, operations: 1, tasks: 1, at: now });
        expect(compactTeam(compacted, now)).toBe(compacted); // nothing left: no write
    });

    it('a task closed before B-822 (no closedAt) gets a full 24 h from when compaction first sees it', () => {
        const legacy = task('legacy', { closedAt: undefined });
        const team = { ...base(), tasks: [legacy], messages: [message('m', 'legacy', { createdAt: 5 * HOUR, deliveredAt: 6 * HOUR })] };
        const seen = 100 * HOUR;
        const first = compactTeam(team, seen);
        expect(first.tasks).toEqual([{ ...legacy, closedAt: seen }]);
        expect(compactTeam(first, seen + TEAM_COMPACT_AGE_MS - 1).tasks).toHaveLength(1);
        expect(compactTeam(first, seen + TEAM_COMPACT_AGE_MS).tasks).toHaveLength(0);
    });

    it('under pressure a legacy task ages from its last message or operation (the stuck team is unblocked at once)', () => {
        const tasks = Array.from({ length: 120 }, (_, i) => task(`t${i}`, { closedAt: undefined }));
        const team = { ...base(), tasks, messages: tasks.map(t => message(`m-${t.id}`, t.id, { createdAt: 5 * HOUR, deliveredAt: 6 * HOUR })) };
        const compacted = compactTeam(team, 6 * HOUR + TEAM_COMPACT_MIN_AGE_MS);
        expect(compacted.tasks).toHaveLength(0);
        expect(compacted.messages).toHaveLength(0);
    });

    it('under pressure (≥ 50% of a limit) takes younger closed work too, never open work', () => {
        const tasks = Array.from({ length: 120 }, (_, i) => task(`t${i}`, { closedAt: 100 * HOUR }));
        tasks.push(task('open', { status: 'running', closedAt: undefined }));
        const team = { ...base(), tasks, messages: [message('undelivered', 'open', { deliveredAt: null })] };
        // Even under pressure, a just-closed child stays for the grace (the lead reads what it accepted).
        expect(compactTeam(team, 100 * HOUR + TEAM_COMPACT_MIN_AGE_MS - 1).tasks).toHaveLength(121);
        const compacted = compactTeam(team, 100 * HOUR + TEAM_COMPACT_MIN_AGE_MS);
        expect(compacted.tasks.map(t => t.id)).toEqual(['open']);
        expect(compacted.messages.map(m => m.id)).toEqual(['undelivered']);
    });
});

describe('B-822 capacity', () => {
    it('reports usage per limit and warns the lead once per crossing of 80%', () => {
        let next = 0; const id = () => `w${++next}`;
        const team = { ...base(), bots: [{ id: 'lead', name: 'Lead', root: true, managed: false, sessionId: 's', generation: 1, assistant: 'claude' as const, directory: null }], tasks: Array.from({ length: 160 }, (_, i) => task(`t${i}`, { status: 'running' })) };
        expect(teamCapacity(team).metrics.tasks).toEqual({ used: 160, limit: TEAM_LIMITS.tasks });
        expect(teamCapacity(team).warning).toContain('tasks 160/200 (80%)');
        warnCapacity(team, JSON.stringify(team).length, 5, id);
        expect(team.messages).toHaveLength(1);
        expect(team.messages[0]).toMatchObject({ taskId: null, recipientBotId: 'lead', source: 'system', deliveredAt: null });
        expect(team.capacityWarned).toEqual(['tasks']);
        warnCapacity(team, JSON.stringify(team).length, 6, id);
        expect(team.messages).toHaveLength(1); // still above: told once
        team.tasks = team.tasks.slice(0, 150); // 75%: between the marks, still warned
        warnCapacity(team, JSON.stringify(team).length, 7, id);
        expect(team.capacityWarned).toEqual(['tasks']);
        team.tasks = team.tasks.slice(0, 100);
        warnCapacity(team, JSON.stringify(team).length, 8, id);
        expect(team.capacityWarned).toBeUndefined();
        team.tasks = Array.from({ length: 170 }, (_, i) => task(`u${i}`, { status: 'running' }));
        warnCapacity(team, JSON.stringify(team).length, 9, id);
        expect(team.messages).toHaveLength(2);
    });

    it('a full record is refused with 409, used / limit and a hint that says it is not rate limiting', () => {
        const team = { ...base(), tasks: Array.from({ length: 200 }, (_, i) => task(`t${i}`, { status: 'running' })) };
        let error: unknown;
        try { reduceTeam(team, owner, { type: 'delegate', goal: 'g', acceptance: ['a'] }, { now: 1, id: () => 'x' }); } catch (e) { error = e; }
        expect(error).toBeInstanceOf(TeamError);
        expect(error).toMatchObject({ code: 'team_task_limit', status: 409, details: { used: 200, limit: 200, hint: TEAM_CAPACITY_HINT } });
        expect(TEAM_CAPACITY_HINT).toContain('not rate limiting');
        expect(teamView(team, owner).capacity?.metrics.tasks.used).toBe(200);
    });
});

/**
 * The incident's shape, run through the reducer the way store.actOnTeam does (compact, then act):
 * a lead with one open root task delegates hundreds of children; each is launched, messaged both
 * ways, submitted, accepted and cleaned up, 30 min apart. Without compaction it fails at ~2 MB.
 */
describe('B-822 long-running team', () => {
    const big = (label: string, n: number) => `${label} `.padEnd(n, 'x');
    function run(cycles: number, compact: boolean) {
        let state = base(); let next = 0; let now = 1;
        const id = () => `id-${++next}`;
        const act = (action: TeamAction, actor: TeamActor = owner) => {
            const r = reduceTeam(compact ? compactTeam(state, now) : state, actor, action, { now, id }); state = r.team; return r;
        };
        const deliverAll = () => {
            for (const m of state.messages.filter(m => m.deliveredAt === null && m.recipientBotId !== 'never')) {
                const bot = state.bots.find(b => b.id === m.recipientBotId)!;
                if (bot.sessionId) act({ type: 'message-delivered', messageId: m.id, recipientBotId: bot.id, generation: bot.generation, sessionId: bot.sessionId });
            }
        };
        const leadId = act({ type: 'join', name: 'Lead', sessionId: 'lead-session' }).credentialBotId!;
        const lead: TeamActor = { kind: 'agent', botId: leadId, generation: 1 };
        // Work that stays open the whole run: the lead's root task and a stuck member with an undelivered message.
        const rootTask = act({ type: 'delegate', goal: 'Run the project', acceptance: ['done'], assigneeBotId: leadId }).taskId!;
        const stuckTask = act({ type: 'delegate', goal: 'Stuck', acceptance: ['a'], botName: 'Stuck', directory: '/stuck' }, lead).taskId!;
        const stuckSpawn = state.operations.at(-1)!;
        act({ type: 'claim-operation', operationId: stuckSpawn.id, machineId: 'machine', teamLaunchVersion: 1 });
        const peak = { bytes: 0, messages: 0, operations: 0, tasks: 0 };
        let total = { messages: 0, operations: 0, tasks: 0 };
        for (let cycle = 0; cycle < cycles; cycle++) {
            now += 30 * 60 * 1000;
            const taskId = act({ type: 'delegate', goal: big(`Goal ${cycle}`, 1500), acceptance: ['tested'], parentTaskId: rootTask, botName: 'Worker', directory: '/repo' }, lead).taskId!;
            const spawn = state.operations.at(-1)!;
            act({ type: 'claim-operation', operationId: spawn.id, machineId: 'machine', teamLaunchVersion: 1 });
            act({ type: 'complete-operation', operationId: spawn.id, machineId: 'machine', claimId: state.operations.find(o => o.id === spawn.id)!.claimId!, sessionId: `worker-${cycle}`, workingDirectory: `/worktrees/${spawn.id}` });
            const worker = state.bots.find(b => b.id === spawn.botId)!;
            const workerActor: TeamActor = { kind: 'agent', botId: worker.id, generation: worker.generation };
            act({ type: 'message', taskId, body: big('Please also check', 500) }, lead);
            act({ type: 'message', taskId, body: big('And the docs', 500) }, lead);
            act({ type: 'message', taskId, body: big('Question', 500), recipientBotId: leadId }, workerActor);
            deliverAll();
            const t = state.tasks.find(t => t.id === taskId)!;
            act({ type: 'submit', taskId, attemptId: t.currentAttemptId, goalVersion: 1, result: big('Evidence', 1500) }, workerActor);
            deliverAll();
            act({ type: 'accept', taskId, attemptId: t.currentAttemptId, goalVersion: 1 }, lead);
            const stop = state.operations.at(-1)!;
            expect(stop.type).toBe('stop');
            act({ type: 'claim-operation', operationId: stop.id, machineId: 'machine' });
            act({ type: 'complete-operation', operationId: stop.id, machineId: 'machine', claimId: state.operations.find(o => o.id === stop.id)!.claimId! });
            total = { messages: total.messages + 4, operations: total.operations + 2, tasks: total.tasks + 1 };
            const { metrics } = teamCapacity(state);
            for (const k of Object.keys(peak) as (keyof typeof peak)[]) peak[k] = Math.max(peak[k], metrics[k].used);
        }
        return { state, peak, total, rootTask, stuckTask, stuckSpawn, leadId };
    }

    it('without compaction the same run hits a limit (the incident)', () => {
        expect(() => run(200, false)).toThrow(/team_size_limit|team_task_limit/);
    }, 60_000);

    it('2000+ messages, 1000+ operations and 520 tasks over 11 days never reach a limit and keep all open state', () => {
        const { state, peak, total, rootTask, stuckTask, stuckSpawn, leadId } = run(520, true);
        expect(total.messages).toBeGreaterThan(2000);
        expect(total.operations).toBeGreaterThan(1000);
        expect(total.tasks).toBeGreaterThan(200);
        expect(peak.bytes).toBeLessThan(TEAM_LIMITS.bytes * 0.8);
        expect(peak.messages).toBeLessThan(TEAM_LIMITS.messages * 0.8);
        expect(peak.operations).toBeLessThan(TEAM_LIMITS.operations * 0.8);
        expect(peak.tasks).toBeLessThan(TEAM_LIMITS.tasks * 0.8);
        // Open work survives: the root task, the stuck task and its claimed launch.
        expect(state.tasks.find(t => t.id === rootTask)?.status).toBe('running');
        expect(state.tasks.find(t => t.id === stuckTask)?.status).toBe('queued');
        expect(state.operations.find(o => o.id === stuckSpawn.id)?.status).toBe('claimed');
        expect(state.messages.every(m => m.deliveredAt !== null)).toBe(true);
        // The worker's repository spawn is kept, so a reused worker still launches from /repo.
        const worker = state.bots.find(b => b.name === 'Worker')!;
        expect(teamBotRepository(state, worker)).toBe('/repo');
        expect(state.compacted!.tasks).toBeGreaterThan(450);
        expect(state.bots.find(b => b.id === leadId)).toBeDefined();
        expect(state.capacityWarned).toBeUndefined();
    }, 60_000);
});
