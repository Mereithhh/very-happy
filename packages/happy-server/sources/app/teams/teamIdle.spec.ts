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
