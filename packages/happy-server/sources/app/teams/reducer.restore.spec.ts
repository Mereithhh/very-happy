import { describe, it, expect } from 'vitest';
import { TEAM_RESTORE_WINDOW_MS, type TeamAction, type TeamState } from '@slopus/happy-wire';
import { reduceTeam, TeamError, type TeamActor } from './reducer';
import { compactTeam } from './compaction';

/**
 * B-962: a lead agent asked to "restart a new team" ran `very-happy teams exit`; its daemon archived a
 * 16-member team (keepLeadSession) and every task was cancelled. Agents can no longer archive, every
 * archive records who did it from where, and the owner can restore what an archive cancelled.
 */
const owner: TeamActor = { kind: 'owner' };
const empty = (): TeamState => ({ id: 'team', name: 'Team', machineId: 'machine', version: 0, bots: [], tasks: [], messages: [], operations: [], createdAt: 1 });

function fixture(start = 1000) {
    let state = empty(); let next = 0; let now = start;
    const act = (action: TeamAction, actor: TeamActor = owner, ownerBy?: 'owner-login' | 'machine') => { const r = reduceTeam(state, actor, action, { now, id: () => `id-${++next}`, ownerBy }); state = r.team; return r; };
    const claimId = (opId: string) => state.operations.find(o => o.id === opId)!.claimId!;
    const launch = (opId: string, sessionId: string, workingDirectory?: string) => {
        act({ type: 'claim-operation', operationId: opId, machineId: 'machine', teamLaunchVersion: 1 });
        act({ type: 'complete-operation', operationId: opId, machineId: 'machine', claimId: claimId(opId), sessionId, ...(workingDirectory ? { workingDirectory } : {}) });
    };
    const stopAll = () => {
        for (const op of state.operations.filter(o => o.type === 'stop' && o.status === 'pending')) {
            act({ type: 'claim-operation', operationId: op.id, machineId: 'machine' });
            act({ type: 'complete-operation', operationId: op.id, machineId: 'machine', claimId: claimId(op.id) });
        }
    };
    return { act, launch, stopAll, claimId, get state() { return state; }, set now(v: number) { now = v; }, get now() { return now; } };
}

/** Lead (`lead-1`) with three members: one running, one submitted, one queued (not launched yet); a schedule; an undelivered message. */
function liveTeam() {
    const f = fixture();
    f.act({ type: 'start', launch: { goal: 'Ship it', directory: '/repo', assistant: 'claude' } });
    const lead = f.state.bots[0];
    f.launch(f.state.operations[0].id, 'lead-1', '/wt/lead');
    const asLead = (): TeamActor => ({ kind: 'agent', botId: lead.id, generation: f.state.bots.find(b => b.id === lead.id)!.generation });
    const delegate = (name: string) => f.act({ type: 'delegate', goal: name, acceptance: ['a'], botName: name }, asLead()).taskId!;
    const running = delegate('running');
    f.launch(f.state.operations.find(o => o.taskId === running)!.id, 's-running', '/wt/running');
    const submitted = delegate('submitted');
    f.launch(f.state.operations.find(o => o.taskId === submitted)!.id, 's-submitted', '/wt/submitted');
    const st = f.state.tasks.find(t => t.id === submitted)!;
    f.act({ type: 'submit', taskId: st.id, attemptId: st.currentAttemptId, goalVersion: 1, result: 'done' }, { kind: 'agent', botId: st.assigneeBotId, generation: f.state.bots.find(b => b.id === st.assigneeBotId)!.generation });
    const queued = delegate('queued');
    const rt = f.state.tasks.find(t => t.id === running)!;
    f.act({ type: 'message', taskId: running, body: 'please also check X' }, asLead());
    const pending = f.state.messages.find(m => m.taskId === running && m.deliveredAt === null && m.body.startsWith('please'))!;
    f.act({ type: 'schedule-create', name: 'tick', botId: lead.id, body: 'status?', runAt: 5000, intervalMs: 60_000 }, asLead());
    return { f, lead, asLead, running, submitted, queued, rt, pending };
}

describe('B-962 archive is the person\'s, and recorded', () => {
    it('an agent credential cannot archive (also not keepLeadSession); the refusal says to confirm on the Web', () => {
        const { f, asLead } = liveTeam();
        for (const action of [{ type: 'archive' }, { type: 'archive', keepLeadSession: true }] as TeamAction[]) {
            try { f.act(action, asLead()); expect.unreachable(); } catch (e) {
                expect(e).toBeInstanceOf(TeamError);
                expect((e as TeamError).code).toBe('owner_required');
                expect(String((e as TeamError).details?.hint)).toContain('退出团队模式');
            }
        }
        expect(f.state.archivedAt).toBeUndefined();
    });
    it('records source, who and what it cancelled with the state before', () => {
        const { f, running, submitted, queued, pending } = liveTeam();
        f.act({ type: 'archive', keepLeadSession: true, source: 'web' }, owner, 'owner-login');
        expect(f.state.archive).toMatchObject({ at: f.now, source: 'web', by: 'owner-login', keepLeadSession: true });
        const tasks = Object.fromEntries(f.state.archive!.restorable!.tasks.map(t => [t.id, t.status]));
        expect(tasks[running]).toBe('running'); expect(tasks[submitted]).toBe('submitted'); expect(tasks[queued]).toBe('queued');
        expect(f.state.archive!.restorable!.schedules).toEqual([expect.objectContaining({ status: 'active', nextRunAt: 5000 })]);
        expect(f.state.archive!.restorable!.messageIds).toContain(pending.id);
    });
    it('an archive with no source/ownerBy says unknown (old clients)', () => {
        const { f } = liveTeam();
        f.act({ type: 'archive' });
        expect(f.state.archive).toMatchObject({ source: 'unknown', by: 'unknown' });
    });
});

describe('B-962 restore', () => {
    function archivedTeam(keepLeadSession = true) {
        const t = liveTeam();
        t.f.now = 2000;
        t.f.act({ type: 'archive', ...(keepLeadSession ? { keepLeadSession: true as const } : {}), source: 'web' }, owner, 'owner-login');
        t.f.stopAll();
        t.f.now = 3000;
        return t;
    }
    it('brings back what the archive cancelled: tasks (new attempts / review), schedule, undelivered message; members continue their own sessions', () => {
        const { f, lead, running, submitted, queued, pending } = archivedTeam();
        const doneBefore = f.state.tasks.filter(t => t.status === 'done').length;
        f.act({ type: 'restore' });
        const s = f.state;
        expect(s.archivedAt).toBeUndefined();
        expect(s.archive).toBeUndefined();
        expect(s.archiveHistory?.[0]).toMatchObject({ at: 2000, source: 'web', restoredAt: 3000 });
        const task = (id: string) => s.tasks.find(t => t.id === id)!;
        expect(task(running).status).toBe('queued');
        expect(task(running).attempts.at(-1)).toMatchObject({ status: 'pending' });
        expect(task(running).closedAt).toBeUndefined();
        expect(task(queued).status).toBe('queued');
        expect(task(submitted).status).toBe('submitted');
        expect(task(submitted).attempts.find(a => a.id === task(submitted).currentAttemptId)!.status).toBe('submitted');
        expect(s.tasks.filter(t => t.status === 'done').length).toBe(doneBefore);
        expect(s.schedules![0]).toMatchObject({ status: 'active' });
        expect(s.schedules![0].finishedAt).toBeUndefined();
        expect(s.messages.find(m => m.id === pending.id)!.cancelledAt).toBeUndefined();
        const restores = s.operations.filter(o => o.restoreVersion === 1);
        const bySession = Object.fromEntries(restores.map(o => [s.bots.find(b => b.id === o.botId)!.name, o.resumeSessionId ?? null]));
        // The lead kept by 「退出团队模式」 continues its live session; stopped members continue their last one; the queued one never ran.
        expect(bySession).toEqual({ Lead: 'lead-1', running: 's-running', submitted: 's-submitted', queued: null });
        expect(restores.every(o => o.type === 'spawn' && o.status === 'pending')).toBe(true);
        expect(s.bots.find(b => b.id === lead.id)!.sessionId).toBeNull();
        expect(restores.find(o => o.resumeSessionId === 's-running')!.prompt).toContain('[Very Happy: team restored]');
    });
    it('a restored launch binds the same session; a submitted task\'s member is bound for its review, not stopped', () => {
        const { f, submitted, running } = archivedTeam();
        f.act({ type: 'restore' });
        const op = (sessionId: string) => f.state.operations.find(o => o.restoreVersion === 1 && o.resumeSessionId === sessionId)!;
        f.launch(op('s-submitted').id, 's-submitted', '/wt/submitted');
        f.launch(op('s-running').id, 's-running', '/wt/running');
        expect(f.state.tasks.find(t => t.id === submitted)!.status).toBe('submitted');
        expect(f.state.tasks.find(t => t.id === running)!.status).toBe('running');
        expect(f.state.operations.filter(o => o.type === 'stop' && o.status === 'pending')).toEqual([]);
        expect(f.state.bots.find(b => b.name === 'submitted')!.sessionId).toBe('s-submitted');
    });
    it('only the owner restores; not after the window; not while a member is still stopping; not a live team', () => {
        const { f, asLead } = archivedTeam();
        expect(() => f.act({ type: 'restore' }, asLead())).toThrow();
        f.now = 2000 + TEAM_RESTORE_WINDOW_MS + 1;
        expect(() => f.act({ type: 'restore' })).toThrow('restore_expired');
        const live = liveTeam();
        expect(() => live.f.act({ type: 'restore' })).toThrow('team_not_archived');
        const stopping = liveTeam();
        stopping.f.act({ type: 'archive' });
        expect(() => stopping.f.act({ type: 'restore' })).toThrow('restore_cleanup_pending');
    });
    it('a skipped member (its session is in another team) starts fresh and its old session stays untouched', () => {
        const { f, lead } = archivedTeam();
        f.act({ type: 'restore', skipBotIds: [lead.id] });
        const op = f.state.operations.find(o => o.restoreVersion === 1 && o.botId === lead.id)!;
        expect(op.resumeSessionId).toBeUndefined();
        expect(op.prompt).toContain('fresh session');
        expect(f.state.bots.find(b => b.id === lead.id)!.previousSessionIds).toContain('lead-1');
    });
    it('an archive from before B-962 (no record) is inferred from closedAt == archivedAt; schedules come back paused', () => {
        const { f, running, queued } = archivedTeam(false);
        const legacy = structuredClone(f.state); delete legacy.archive;
        // A task cancelled before the archive must stay cancelled.
        legacy.tasks.push({ id: 'old', parentTaskId: null, goal: 'g', acceptance: ['a'], goalVersion: 1, ownerBotId: null, assigneeBotId: legacy.bots[1].id, status: 'cancelled', closedAt: 1500, attempts: [{ id: 'oa', botId: legacy.bots[1].id, generation: 1, goalVersion: 1, status: 'cancelled', result: null }], currentAttemptId: 'oa', cleanup: 'none' });
        const r = reduceTeam(legacy, owner, { type: 'restore' }, { now: 3000, id: (() => { let n = 0; return () => `L-${++n}`; })() }).team;
        expect(r.tasks.find(t => t.id === running)!.status).toBe('queued');
        expect(r.tasks.find(t => t.id === queued)!.status).toBe('queued');
        expect(r.tasks.find(t => t.id === 'old')!.status).toBe('cancelled');
        expect(r.schedules![0].status).toBe('paused');
        expect(r.archiveHistory![0]).toMatchObject({ at: 2000, source: 'unknown', by: 'unknown' });
    });
    it('compaction keeps what the archive cancelled while the team can be restored, and moves it after', () => {
        const { f } = archivedTeam();
        const full = { ...f.state, tasks: f.state.tasks };
        const cancelled = full.tasks.filter(t => t.closedAt === 2000).map(t => t.id);
        const within = compactTeam(full, 2000 + 3 * 24 * 3600 * 1000);
        expect(cancelled.every(id => within.tasks.some(t => t.id === id))).toBe(true);
        const after = compactTeam(full, 2000 + TEAM_RESTORE_WINDOW_MS + 25 * 3600 * 1000);
        expect(cancelled.some(id => after.tasks.some(t => t.id === id))).toBe(false);
    });
});
