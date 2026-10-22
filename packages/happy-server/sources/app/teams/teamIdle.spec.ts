import { describe, it, expect } from 'vitest';
import type { TeamAction, TeamState } from '@slopus/happy-wire';
import { reduceTeam, teamView, type TeamActor } from './reducer';
import { escalateIdleMembers, TEAM_IDLE_ESCALATE_MS } from './teamIdle';

const owner: TeamActor = { kind: 'owner' };
const MIN = 60_000;
/** A lead (root) delegating to two members, each bound to a session. */
function team() {
    let state: TeamState = { id: 'team', name: 'Team', machineId: 'machine', version: 0, bots: [], tasks: [], messages: [], operations: [], createdAt: 1 };
    let next = 0; let now = 1000;
    const act = (action: TeamAction, actor: TeamActor = owner) => { state = reduceTeam(state, actor, action, { now, id: () => `id-${++next}` }).team; return state; };
    act({ type: 'join', name: 'Lead', sessionId: 'lead' });
    act({ type: 'join', name: 'A', sessionId: 'a' });
    act({ type: 'join', name: 'B', sessionId: 'b' });
    const [lead, a, b] = state.bots;
    const asLead: TeamActor = { kind: 'agent', botId: lead.id, generation: lead.generation };
    act({ type: 'delegate', goal: 'ga', acceptance: ['x'], assigneeBotId: a.id }, asLead);
    act({ type: 'delegate', goal: 'gb', acceptance: ['x'], assigneeBotId: b.id }, asLead);
    const [ta, tb] = state.tasks;
    return {
        act, lead, a, b, ta, tb, asLead,
        asBot: (id: string): TeamActor => ({ kind: 'agent', botId: id, generation: state.bots.find(x => x.id === id)!.generation }),
        at: (t: number) => { now = t; },
        get state() { return state; }, set state(v: TeamState) { state = v; },
        toLead: () => state.messages.filter(m => m.recipientBotId === lead.id),
        id: () => `esc-${++next}`,
    };
}

describe('B-769: member idle does not wake the task owner', () => {
    it('an idle turn end creates no message; blocked and exited still wake the owner', () => {
        const f = team();
        f.act({ type: 'session-event', sessionId: 'a', event: 'idle' });
        expect(f.toLead()).toHaveLength(0);
        expect(f.state.bots.find(b => b.id === f.a.id)).toMatchObject({ lastEvent: 'idle', lastEventAt: 1000 });
        f.act({ type: 'session-event', sessionId: 'a', event: 'blocked' });
        f.act({ type: 'session-event', sessionId: 'b', event: 'exited' });
        expect(f.toLead().map(m => m.body.split('.')[0])).toEqual(['Agent A: blocked', 'Agent B: exited']);
        expect(f.toLead().every(m => m.source === 'system')).toBe(true);
    });

    it('a submit still wakes the owner and carries a digest of idles since its previous message', () => {
        const f = team();
        f.at(1000); f.act({ type: 'session-event', sessionId: 'a', event: 'idle' });
        f.at(1000 + 5 * MIN);
        f.act({ type: 'submit', taskId: f.tb.id, attemptId: f.tb.currentAttemptId, goalVersion: 1, result: 'done' }, f.asBot(f.b.id));
        const [submitted] = f.toLead();
        expect(submitted.body).toMatch(/^Task .* submitted:\ndone\n\nMeanwhile idle/);
        expect(submitted.body).toContain(`A (5 min; task ${f.ta.id} not yet submitted)`);
        // Each idle stretch is told once: the next message to the lead does not repeat A.
        f.at(1000 + 6 * MIN);
        f.act({ type: 'message', taskId: f.tb.id, recipientBotId: f.lead.id, body: 'ping' }, f.asBot(f.b.id));
        expect(f.toLead()[1].body).toBe('ping');
    });

    it('the digest skips the sender, submitted tasks, and members woken since their idle', () => {
        const f = team();
        f.at(1000); f.act({ type: 'session-event', sessionId: 'a', event: 'idle' });
        f.act({ type: 'session-event', sessionId: 'b', event: 'idle' });
        f.at(2000);
        // B is the sender: its own idle is stale (it is mid-turn), never listed.
        f.act({ type: 'message', taskId: f.tb.id, recipientBotId: f.lead.id, body: 'q' }, f.asBot(f.b.id));
        expect(f.toLead()[0].body).toContain('A (0 min');
        expect(f.toLead()[0].body).not.toContain('B (');
        expect(teamView(f.state, f.asLead).idleMembers?.map(m => m.name)).toEqual(['A']);
        // A submits (mid-turn) then idles: a submitted task is awaiting review, not idle work.
        f.act({ type: 'submit', taskId: f.ta.id, attemptId: f.ta.currentAttemptId, goalVersion: 1, result: 'r' }, f.asBot(f.a.id));
        f.at(3000); f.act({ type: 'session-event', sessionId: 'a', event: 'idle' });
        expect(teamView(f.state, f.asLead).idleMembers).toEqual([]);
    });

    it('team_inspect lists the reader\'s idle members; the owner view and member views are unchanged', () => {
        const f = team();
        f.act({ type: 'session-event', sessionId: 'a', event: 'idle' });
        expect(teamView(f.state, f.asLead).idleMembers).toEqual([{ botId: f.a.id, name: 'A', since: 1000, taskIds: [f.ta.id] }]);
        expect(teamView(f.state, f.asBot(f.a.id)).idleMembers).toEqual([]);
        expect(teamView(f.state, owner).idleMembers).toBeUndefined();
    });

    it('a long idle without submission wakes the owner once per idle stretch', () => {
        const f = team();
        f.at(1000); f.act({ type: 'session-event', sessionId: 'a', event: 'idle' });
        expect(escalateIdleMembers(f.state, 1000 + TEAM_IDLE_ESCALATE_MS - 1, f.id).fired).toBe(0);
        const first = escalateIdleMembers(f.state, 1000 + TEAM_IDLE_ESCALATE_MS, f.id);
        expect(first.fired).toBe(1);
        expect(first.team.version).toBe(f.state.version + 1);
        const wake = first.team.messages.at(-1)!;
        expect(wake).toMatchObject({ recipientBotId: f.lead.id, taskId: f.ta.id, source: 'system', deliveredAt: null });
        expect(wake.body).toBe(`Agent A: idle for 30 min. Task ${f.ta.id} is still not submitted and requires explicit submission and acceptance.`);
        f.state = first.team;
        expect(escalateIdleMembers(f.state, 1000 + 3 * TEAM_IDLE_ESCALATE_MS, f.id).fired).toBe(0);
        // A new idle stretch (another turn ended) can escalate again.
        f.at(5000 + TEAM_IDLE_ESCALATE_MS); f.act({ type: 'session-event', sessionId: 'a', event: 'idle' });
        expect(escalateIdleMembers(f.state, 5000 + 2 * TEAM_IDLE_ESCALATE_MS, f.id).fired).toBe(1);
    });

    it('no escalation once the member was woken by a delivered message, submitted, or blocked', () => {
        const f = team();
        f.at(1000); f.act({ type: 'session-event', sessionId: 'a', event: 'idle' });
        f.act({ type: 'session-event', sessionId: 'b', event: 'idle' });
        f.at(2000);
        f.act({ type: 'message', taskId: f.ta.id, recipientBotId: f.a.id, body: 'go on' }, f.asLead);
        const toA = f.state.messages.at(-1)!;
        f.act({ type: 'message-delivered', messageId: toA.id, recipientBotId: f.a.id, generation: f.a.generation, sessionId: 'a' }, owner);
        f.act({ type: 'submit', taskId: f.tb.id, attemptId: f.tb.currentAttemptId, goalVersion: 1, result: 'r' }, f.asBot(f.b.id));
        expect(escalateIdleMembers(f.state, 1000 + 10 * TEAM_IDLE_ESCALATE_MS, f.id).fired).toBe(0);
        f.at(3000); f.act({ type: 'session-event', sessionId: 'a', event: 'blocked' });
        expect(escalateIdleMembers(f.state, 3000 + 10 * TEAM_IDLE_ESCALATE_MS, f.id).fired).toBe(0);
    });

    it('escalation never throws inside the schedule tick and leaves archived teams alone', () => {
        const f = team();
        f.act({ type: 'session-event', sessionId: 'a', event: 'idle' });
        const full = structuredClone(f.state);
        full.messages = Array.from({ length: 2000 }, (_, i) => ({ id: `m${i}`, taskId: null, senderBotId: null, recipientBotId: f.b.id, body: '', deliveredAt: 1, createdAt: 1 }));
        expect(escalateIdleMembers(full, 1000 + TEAM_IDLE_ESCALATE_MS, f.id)).toEqual({ team: full, fired: 0 });
        expect(escalateIdleMembers({ ...f.state, archivedAt: 1 }, 1000 + TEAM_IDLE_ESCALATE_MS, f.id).fired).toBe(0);
    });
});

describe('B-769b: new work restarts the idle clock', () => {
    const H4 = 4 * 60 * MIN;
    /** A idle 4 h after its task was accepted (B keeps its own task running). */
    function idleAfterAccept() {
        const f = team();
        f.act({ type: 'submit', taskId: f.ta.id, attemptId: f.ta.currentAttemptId, goalVersion: 1, result: 'r' }, f.asBot(f.a.id));
        f.act({ type: 'accept', taskId: f.ta.id, attemptId: f.ta.currentAttemptId, goalVersion: 1 }, f.asLead);
        f.at(1000); f.act({ type: 'session-event', sessionId: 'a', event: 'idle' });
        f.at(1000 + H4);
        return f;
    }
    const escalate = (f: ReturnType<typeof team>, now: number) => escalateIdleMembers(f.state, now, f.id).fired;

    it('a delegate to an idle member neither escalates the old idle nor digests it before the task reaches the member', () => {
        const f = idleAfterAccept();
        f.act({ type: 'delegate', goal: 'next', acceptance: ['x'], assigneeBotId: f.a.id }, f.asLead);
        expect(escalate(f, 1000 + H4)).toBe(0);
        expect(teamView(f.state, f.asLead).idleMembers).toEqual([]);
        f.act({ type: 'message', taskId: f.tb.id, recipientBotId: f.lead.id, body: 'ping' }, f.asBot(f.b.id));
        expect(f.toLead().at(-1)!.body).toBe('ping');
        // Still undelivered 30 min after the new attempt: that stretch escalates, once.
        expect(escalate(f, 1000 + H4 + TEAM_IDLE_ESCALATE_MS - 1)).toBe(0);
        const fired = escalateIdleMembers(f.state, 1000 + H4 + TEAM_IDLE_ESCALATE_MS, f.id);
        expect(fired.fired).toBe(1);
        expect(fired.team.messages.at(-1)!.body).toMatch(/^Agent A: idle for 30 min\. Task (?!.*\b220\b)/);
        expect(escalateIdleMembers(fired.team, 1000 + H4 + 2 * TEAM_IDLE_ESCALATE_MS, f.id).fired).toBe(0);
    });

    it('return, handoff and a rebinding join restart the clock and clear idleEscalatedAt', () => {
        const ret = team();
        ret.at(1000); ret.act({ type: 'session-event', sessionId: 'a', event: 'idle' });
        ret.state = escalateIdleMembers(ret.state, 1000 + TEAM_IDLE_ESCALATE_MS, ret.id).team;
        ret.act({ type: 'submit', taskId: ret.ta.id, attemptId: ret.ta.currentAttemptId, goalVersion: 1, result: 'r' }, ret.asBot(ret.a.id));
        ret.at(1000 + H4);
        ret.act({ type: 'return', taskId: ret.ta.id, attemptId: ret.ta.currentAttemptId, goalVersion: 1, reason: 'again' }, ret.asLead);
        expect(ret.state.bots.find(b => b.id === ret.a.id)).toMatchObject({ workAssignedAt: 1000 + H4 });
        expect(ret.state.bots.find(b => b.id === ret.a.id)!.idleEscalatedAt).toBeUndefined();
        expect(escalate(ret, 1000 + H4)).toBe(0);

        const hand = idleAfterAccept();
        hand.act({ type: 'handoff', taskId: hand.tb.id, attemptId: hand.tb.currentAttemptId, goalVersion: 1, assigneeBotId: hand.a.id }, hand.asLead);
        expect(escalate(hand, 1000 + H4)).toBe(0);

        const join = team();
        join.at(1000); join.act({ type: 'session-event', sessionId: 'a', event: 'idle' });
        join.at(1000 + H4); join.act({ type: 'join', name: 'A', sessionId: 'a2', botId: join.a.id });
        expect(escalate(join, 1000 + H4)).toBe(0);
    });

    it('a completed launch restarts the clock even when it resumes the same session', () => {
        const f = idleAfterAccept();
        f.act({ type: 'delegate', goal: 'next', acceptance: ['x'], assigneeBotId: f.a.id }, f.asLead);
        f.at(1000 + H4 + TEAM_IDLE_ESCALATE_MS);
        // A launch that resumes the bound session (no B-761 turn-event reset).
        const op = { id: 'op-same', teamId: 'team', machineId: 'machine', taskId: f.state.tasks.at(-1)!.id, botId: f.a.id, attemptId: f.state.tasks.at(-1)!.currentAttemptId, generation: f.a.generation, type: 'spawn' as const, status: 'claimed' as const, claimId: 'c', claimedAt: 1, error: null, sessionId: 'a', directory: null, assistant: 'claude' as const, prompt: '', createdAt: 1 };
        f.state = { ...f.state, operations: [...f.state.operations, op] };
        f.act({ type: 'complete-operation', operationId: 'op-same', machineId: 'machine', claimId: 'c', sessionId: 'a' });
        expect(f.state.bots.find(b => b.id === f.a.id)).toMatchObject({ lastEvent: 'idle', workAssignedAt: 1000 + H4 + TEAM_IDLE_ESCALATE_MS });
        expect(escalate(f, 1000 + H4 + TEAM_IDLE_ESCALATE_MS)).toBe(0);
    });

    it('a member whose session was stopped has no idle while its next launch is pending', () => {
        const f = idleAfterAccept();
        f.state = { ...f.state, bots: f.state.bots.map(b => b.id === f.a.id ? { ...b, sessionId: null, workAssignedAt: undefined } : b) };
        f.state = { ...f.state, tasks: [...f.state.tasks, { ...f.ta, id: 'queued', status: 'queued' }] };
        expect(escalate(f, 1000 + H4)).toBe(0);
        expect(teamView(f.state, f.asLead).idleMembers).toEqual([]);
    });

    it('a turn end on the new work is digested and escalates from that turn end', () => {
        const f = idleAfterAccept();
        f.act({ type: 'delegate', goal: 'next', acceptance: ['x'], assigneeBotId: f.a.id }, f.asLead);
        f.at(1000 + H4 + 5 * MIN); f.act({ type: 'session-event', sessionId: 'a', event: 'idle' });
        f.at(1000 + H4 + 7 * MIN);
        f.act({ type: 'message', taskId: f.tb.id, recipientBotId: f.lead.id, body: 'ping' }, f.asBot(f.b.id));
        expect(f.toLead().at(-1)!.body).toContain('A (2 min; task');
        expect(escalate(f, 1000 + H4 + 5 * MIN + TEAM_IDLE_ESCALATE_MS - 1)).toBe(0);
        expect(escalate(f, 1000 + H4 + 5 * MIN + TEAM_IDLE_ESCALATE_MS)).toBe(1);
    });
});
