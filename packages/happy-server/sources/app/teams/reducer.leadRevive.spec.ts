import { describe, it, expect } from 'vitest';
import { teamLeadReviveBlock, teamOwnedOpenTasks, type TeamAction, type TeamState } from '@slopus/happy-wire';
import { reduceTeam, TeamError, type TeamActor } from './reducer';

/**
 * B-945: the owner accepted a team's root task while its lead still owned 31 open
 * top-level delegations (15 submitted, 15 queued, 1 running). The accept stopped the
 * lead, removed its worktree, and nothing could review or push those tasks again.
 */
const owner: TeamActor = { kind: 'owner' };
const empty = (): TeamState => ({ id: 'team', name: 'Team', machineId: 'machine', version: 0, bots: [], tasks: [], messages: [], operations: [], createdAt: 1 });

function fixture() {
    let state = empty(); let next = 0;
    const act = (action: TeamAction, actor: TeamActor = owner) => { const r = reduceTeam(state, actor, action, { now: 1000, id: () => `id-${++next}` }); state = r.team; return r; };
    const claimId = (opId: string) => state.operations.find(o => o.id === opId)!.claimId!;
    const launch = (opId: string, sessionId: string, workingDirectory?: string) => {
        act({ type: 'claim-operation', operationId: opId, machineId: 'machine', teamLaunchVersion: 1 });
        act({ type: 'complete-operation', operationId: opId, machineId: 'machine', claimId: claimId(opId), sessionId, ...(workingDirectory ? { workingDirectory } : {}) });
    };
    const task = (id: string) => state.tasks.find(t => t.id === id)!;
    return { act, launch, task, claimId, get state() { return state; }, set state(v: TeamState) { state = v; } };
}

/** A started team whose lead (session `lead-1`, worktree `/wt/lead-1`) delegated one task in each open state. */
function teamWithOpenDelegations() {
    const f = fixture();
    f.act({ type: 'start', launch: { goal: 'Ship the feature', directory: '/repo', assistant: 'claude' } });
    const lead = f.state.bots[0];
    const root = f.state.tasks[0];
    f.launch(f.state.operations[0].id, 'lead-1', '/wt/lead-1');
    const asLead = (): TeamActor => ({ kind: 'agent', botId: lead.id, generation: f.state.bots.find(b => b.id === lead.id)!.generation });
    const delegate = (name: string) => f.act({ type: 'delegate', goal: name, acceptance: ['a'], botName: name }, asLead()).taskId!;
    const submitted = delegate('submitted');
    f.launch(f.state.operations.find(o => o.taskId === submitted)!.id, 's-submitted');
    const st = f.task(submitted);
    f.act({ type: 'submit', taskId: st.id, attemptId: st.currentAttemptId, goalVersion: 1, result: 'done' });
    const running = delegate('running');
    f.launch(f.state.operations.find(o => o.taskId === running)!.id, 's-running');
    const queued = delegate('queued');
    return { f, lead, root, asLead, submitted, running, queued };
}

/**
 * The user's state, built the way the old server produced it: the root task was
 * submitted and accepted (done), the lead's stop completed (session unbound) and the
 * daemon removed its worktree — while its delegations stayed open.
 */
function userIncidentShape() {
    const t = teamWithOpenDelegations();
    const { f, root, lead } = t;
    const s = structuredClone(f.state);
    const r = s.tasks.find(x => x.id === root.id)!;
    r.status = 'done'; r.closedAt = 900; r.cleanup = 'pending';
    r.attempts.find(a => a.id === r.currentAttemptId)!.status = 'accepted';
    s.operations.push({ ...s.operations[0], id: 'stop-lead', type: 'stop', status: 'pending', claimId: null, claimedAt: null, sessionId: 'lead-1', directory: '/wt/lead-1', prompt: '', teamLaunchVersion: undefined });
    f.state = s;
    f.act({ type: 'claim-operation', operationId: 'stop-lead', machineId: 'machine' });
    f.act({ type: 'complete-operation', operationId: 'stop-lead', machineId: 'machine', claimId: f.claimId('stop-lead') });
    expect(f.state.bots.find(b => b.id === lead.id)).toMatchObject({ sessionId: null, directory: '/wt/lead-1', previousSessionIds: ['lead-1'] });
    expect(f.task(root.id)).toMatchObject({ status: 'done', cleanup: 'done' });
    return t;
}

const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof TeamError) return e; throw e; } throw new Error('expected a TeamError'); };

describe('B-945 a lead with open delegations is never accepted away', () => {
    it('counts the open tasks a bot owns by state', () => {
        const { f, lead } = teamWithOpenDelegations();
        expect(teamOwnedOpenTasks(f.state, lead.id)).toMatchObject({ total: 3, submitted: 1, queued: 1, running: 1 });
    });

    it('refuses the lead\'s submit of its root task while it owns open tasks, naming them; allows it once all are closed', () => {
        const { f, root, asLead, submitted, running, queued } = teamWithOpenDelegations();
        const e = refusal(() => f.act({ type: 'submit', taskId: root.id, attemptId: root.currentAttemptId, goalVersion: 1, result: 'all done' }, asLead()));
        expect(e).toMatchObject({ code: 'owned_tasks_unfinished', status: 409, details: { openTasks: 3, submitted: 1, queued: 1, running: 1, taskIds: [submitted, running, queued] } });
        expect(String(e.details!.hint)).toContain('Accept or return the submitted ones');
        expect(f.task(root.id).status).toBe('running');
        // Close every delegation: accept the submitted one, finish the running one, cancel the queued one.
        const s = f.task(submitted);
        f.act({ type: 'accept', taskId: s.id, attemptId: s.currentAttemptId, goalVersion: 1 }, asLead());
        const r = f.task(running);
        f.act({ type: 'submit', taskId: r.id, attemptId: r.currentAttemptId, goalVersion: 1, result: 'ok' });
        f.act({ type: 'accept', taskId: r.id, attemptId: r.currentAttemptId, goalVersion: 1 }, asLead());
        const q = f.task(queued);
        f.act({ type: 'cancel', taskId: q.id, attemptId: q.currentAttemptId, goalVersion: 1, reason: 'not needed' }, asLead());
        f.act({ type: 'submit', taskId: root.id, attemptId: root.currentAttemptId, goalVersion: 1, result: 'all done' }, asLead());
        f.act({ type: 'accept', taskId: root.id, attemptId: root.currentAttemptId, goalVersion: 1 });
        expect(f.task(root.id).status).toBe('done');
    });

    it('refuses the owner\'s accept of a root task submitted before the check, and keeps the lead running', () => {
        const { f, root, lead } = teamWithOpenDelegations();
        const s = structuredClone(f.state);
        const r = s.tasks.find(x => x.id === root.id)!;
        r.status = 'submitted'; r.attempts.find(a => a.id === r.currentAttemptId)!.status = 'submitted';
        f.state = s;
        const e = refusal(() => f.act({ type: 'accept', taskId: root.id, attemptId: root.currentAttemptId, goalVersion: 1 }));
        expect(e).toMatchObject({ code: 'owned_tasks_unfinished', details: { openTasks: 3 } });
        expect(f.task(root.id).status).toBe('submitted');
        expect(f.state.operations.some(o => o.type === 'stop' && o.botId === lead.id)).toBe(false);
        expect(f.state.bots.find(b => b.id === lead.id)!.sessionId).toBe('lead-1');
        // Return still works: the owner can send the lead back to finish.
        f.act({ type: 'return', taskId: root.id, attemptId: root.currentAttemptId, goalVersion: 1, reason: 'close your tasks first' });
        expect(f.task(root.id).status).toBe('running');
    });

    it('a member with no delegations submits and is accepted as before', () => {
        const { f, asLead, running } = teamWithOpenDelegations();
        const r = f.task(running);
        f.act({ type: 'submit', taskId: r.id, attemptId: r.currentAttemptId, goalVersion: 1, result: 'ok' });
        f.act({ type: 'accept', taskId: r.id, attemptId: r.currentAttemptId, goalVersion: 1 }, asLead());
        expect(f.task(r.id).status).toBe('done');
    });
});

describe('B-945 「接回负责人」 relaunches the stopped lead (revive-lead)', () => {
    it('on the user\'s state: same root bot, new generation, a new root task and a launch from the source repository', () => {
        const { f, lead, root, submitted } = userIncidentShape();
        expect(teamLeadReviveBlock(f.state, f.state.bots.find(b => b.id === lead.id)!)).toBeNull();
        const r = f.act({ type: 'revive-lead', botId: lead.id });
        const bot = f.state.bots.find(b => b.id === lead.id)!;
        expect(bot.generation).toBe(lead.generation + 1);
        expect(f.state.bots.filter(b => b.root)).toHaveLength(1);
        const revived = f.task(r.taskId!);
        expect(revived).toMatchObject({ parentTaskId: null, ownerBotId: null, assigneeBotId: lead.id, status: 'queued' });
        expect(revived.goal).toContain('3 task(s) you delegated were still open (1 submitted and waiting for your review, 1 queued, 1 running)');
        expect(revived.goal).toContain('The team\'s goal was: Ship the feature');
        const op = f.state.operations.find(o => o.id === r.operationId)!;
        // B-706: never the removed worktree; the lead's first launch keeps the repository.
        expect(op).toMatchObject({ type: 'spawn', botId: lead.id, generation: bot.generation, directory: '/repo', sessionId: null, status: 'pending', teamLaunchVersion: 1 });
        expect(op.prompt).toContain(revived.goal);
        // The daemon launches it like any lead launch; the root task closed long ago stays closed.
        f.launch(op.id, 'lead-2', '/wt/lead-2');
        expect(f.state.bots.find(b => b.id === lead.id)).toMatchObject({ sessionId: 'lead-2', directory: '/wt/lead-2' });
        expect(f.task(revived.id).status).toBe('running');
        expect(f.task(root.id).status).toBe('done');
        // The new lead reviews what waited: the submitted task is accepted under its own (still owned) identity.
        const newLead: TeamActor = { kind: 'agent', botId: lead.id, generation: bot.generation };
        const s = f.task(submitted);
        f.act({ type: 'accept', taskId: s.id, attemptId: s.currentAttemptId, goalVersion: 1 }, newLead);
        expect(f.task(submitted).status).toBe('done');
        // The old lead's credential is fenced.
        expect(refusal(() => f.act({ type: 'message', taskId: revived.id, body: 'x' }, { kind: 'agent', botId: lead.id, generation: lead.generation })).code).toBe('stale_agent');
        // And the new lead cannot submit its relaunch task while it still owns open tasks.
        const rv = f.task(revived.id);
        expect(refusal(() => f.act({ type: 'submit', taskId: rv.id, attemptId: rv.currentAttemptId, goalVersion: 1, result: 'x' }, newLead)).code).toBe('owned_tasks_unfinished');
    });

    it('only the owner can relaunch: an agent (the lead\'s own or a member\'s credential) is refused', () => {
        const { f, lead, running } = userIncidentShape();
        const member = f.state.bots.find(b => b.id === f.task(running).assigneeBotId)!;
        expect(refusal(() => f.act({ type: 'revive-lead', botId: lead.id }, { kind: 'agent', botId: member.id, generation: member.generation })).code).toBe('owner_required');
        expect(refusal(() => f.act({ type: 'revive-lead', botId: lead.id }, { kind: 'agent', botId: lead.id, generation: lead.generation })).code).toBe('owner_required');
    });

    it('refuses while the lead is online, for a member, with nothing open, twice, or on an archived team', () => {
        const online = teamWithOpenDelegations();
        expect(refusal(() => online.f.act({ type: 'revive-lead', botId: online.lead.id }))).toMatchObject({ code: 'lead_online', details: { openTasks: 3 } });

        const t = userIncidentShape();
        const member = t.f.state.bots.find(b => b.id === t.f.task(t.running).assigneeBotId)!;
        expect(refusal(() => t.f.act({ type: 'revive-lead', botId: member.id })).code).toBe('bot_not_root');
        expect(refusal(() => t.f.act({ type: 'revive-lead', botId: 'nope' })).code).toBe('bot_not_found');

        const before = t.f.state;
        t.f.act({ type: 'revive-lead', botId: t.lead.id });
        // A second click while the first relaunch waits is refused (its own task now holds the lead).
        expect(refusal(() => t.f.act({ type: 'revive-lead', botId: t.lead.id })).code).toBe('lead_has_task');
        t.f.state = before;

        // Nothing left for a lead to do: no relaunch.
        const closed = userIncidentShape();
        const s = structuredClone(closed.f.state);
        for (const task of s.tasks) if (task.ownerBotId === closed.lead.id) task.status = 'cancelled';
        closed.f.state = s;
        expect(refusal(() => closed.f.act({ type: 'revive-lead', botId: closed.lead.id })).code).toBe('lead_has_no_open_tasks');

        const archived = userIncidentShape();
        archived.f.state = { ...archived.f.state, archivedAt: 5 };
        expect(refusal(() => archived.f.act({ type: 'revive-lead', botId: archived.lead.id })).code).toBe('team_archived');
    });

    it('an unmanaged (adopted) lead or a lead whose cleanup still holds its session is refused with that reason', () => {
        const t = userIncidentShape();
        const s = structuredClone(t.f.state);
        s.bots.find(b => b.id === t.lead.id)!.managed = false;
        expect(teamLeadReviveBlock(s, s.bots.find(b => b.id === t.lead.id)!)).toBe('lead_not_managed');
        const held = structuredClone(t.f.state);
        const bot = held.bots.find(b => b.id === t.lead.id)!;
        bot.sessionId = 'lead-1';
        held.operations.push({ ...held.operations.find(o => o.id === 'stop-lead')!, id: 'stop-2', status: 'failed', claimId: 'c' });
        expect(teamLeadReviveBlock(held, bot)).toBe('lead_cleanup_pending');
    });
});
