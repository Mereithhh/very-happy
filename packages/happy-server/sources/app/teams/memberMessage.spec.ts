import { describe, it, expect } from 'vitest';
import type { TeamAction, TeamState } from '@slopus/happy-wire';
import { reduceTeam, TeamError, type TeamActor } from './reducer';

/** B-912 (B-786): a member messaging another member is refused with the lead to send it to instead. */
describe('member-to-member team messages', () => {
    it('refuses with recipient_outside_task naming the task owner, and still lets the member reach its lead', () => {
        let state: TeamState = { id: 'team', name: 'Team', machineId: 'machine', version: 0, bots: [], tasks: [], messages: [], operations: [], createdAt: 1 };
        let next = 0;
        const act = (action: TeamAction, actor: TeamActor = { kind: 'owner' }) => { state = reduceTeam(state, actor, action, { now: 1000, id: () => `id-${++next}` }).team; };
        act({ type: 'join', name: 'Lead', sessionId: 'lead' });
        act({ type: 'join', name: 'A', sessionId: 'a' });
        act({ type: 'join', name: 'B', sessionId: 'b' });
        const [lead, a, b] = state.bots;
        const as = (id: string): TeamActor => ({ kind: 'agent', botId: id, generation: state.bots.find(x => x.id === id)!.generation });
        act({ type: 'delegate', goal: 'ga', acceptance: ['x'], assigneeBotId: a.id }, as(lead.id));
        act({ type: 'delegate', goal: 'gb', acceptance: ['x'], assigneeBotId: b.id }, as(lead.id));
        const [ta] = state.tasks;
        let error: unknown;
        try { act({ type: 'message', taskId: ta.id, recipientBotId: b.id, body: 'hi B' }, as(a.id)); } catch (e) { error = e; }
        expect(error).toBeInstanceOf(TeamError);
        expect(error).toMatchObject({ code: 'recipient_outside_task', status: 403, details: { ownerBotId: lead.id } });
        act({ type: 'message', taskId: ta.id, recipientBotId: lead.id, body: 'please tell B' }, as(a.id));
        expect(state.messages.at(-1)).toMatchObject({ senderBotId: a.id, recipientBotId: lead.id, body: expect.stringContaining('please tell B') });
    });
});
