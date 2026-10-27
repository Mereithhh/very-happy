import { describe, expect, it } from 'vitest';
import type { TeamBot, TeamOperation, TeamState } from '@slopus/happy-wire';
import { freshRowCount, isFreshRow, planDispatchReveal, teamFreshCount } from './sidebarDispatchReveal';

const bot = (id: string, sessionId: string | null): TeamBot => ({ id, name: id, sessionId, generation: 1, root: false, managed: true, assistant: 'claude', directory: '/r' });
const op = (sessionId: string, status: TeamOperation['status'] = 'completed'): TeamOperation => ({ id: `op-${sessionId}`, teamId: 't', machineId: 'm', taskId: 'k', botId: 'b1', attemptId: 'a', generation: 1, type: 'spawn', status, claimId: null, claimedAt: null, error: null, sessionId, directory: '/r', assistant: 'claude', prompt: '', createdAt: 1 });
const team = (bots: TeamBot[], operations: TeamOperation[] = []): TeamState => ({ id: 't', name: 'T', machineId: 'm', bots, tasks: [], operations, messages: [], createdAt: 1 } as unknown as TeamState);

describe('sidebar 「新」 marks', () => {
    const fresh = { s1: 1, s2: 2 };
    it('only conversation rows count — not team nodes, history links or shared rows', () => {
        expect(isFreshRow({ sessionId: 's1' }, fresh)).toBe(true);
        expect(isFreshRow({ sessionId: 's9' }, fresh)).toBe(false);
        expect(isFreshRow({ sessionId: 's1', teamHistoryLink: true }, fresh)).toBe(false);
        expect(isFreshRow({ sessionId: 's1', team: {} }, fresh)).toBe(false);
        expect(isFreshRow({ sessionId: 's1', share: {} }, fresh)).toBe(false);
        expect(freshRowCount([{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }, {}], fresh)).toBe(2);
    });
    it('a folded team counts its members’ new conversations (live binding + completed launches)', () => {
        expect(teamFreshCount(team([bot('b1', 's1')], [op('s2'), op('s3', 'pending')]), fresh)).toBe(2);
        expect(teamFreshCount(team([bot('b1', 's1')], [op('s1')]), fresh)).toBe(1);
    });
});

describe('planDispatchReveal', () => {
    const teamGroupId = (id: string) => `team:${id}`;
    const sec = (id: string, open: boolean, ids: string[]) => ({ id, collapsible: true, open, allRows: ids.map((s) => ({ key: `k-${s}`, sessionId: s })) });
    it('opens a folded team first (member rows only exist under an open team)', () => {
        expect(planDispatchReveal({ sessionId: 's1', teams: [team([bot('b1', 's1')])], expandedTeams: new Set(), teamGroupId, sections: [] }))
            .toEqual({ kind: 'expand', groupId: 'team:t' });
    });
    it('then the folded section holding the row, then scrolls to it', () => {
        const teams = [team([bot('b1', 's1')])];
        const sections = [sec('a', true, ['x']), sec('b', false, ['s1'])];
        expect(planDispatchReveal({ sessionId: 's1', teams, expandedTeams: new Set(['t']), teamGroupId, sections })).toEqual({ kind: 'expand', groupId: 'b' });
        sections[1].open = true;
        expect(planDispatchReveal({ sessionId: 's1', teams, expandedTeams: new Set(['t']), teamGroupId, sections })).toEqual({ kind: 'scroll', key: 'k-s1' });
    });
    it('waits while the row has not reached the list; ignores a history link for the same session', () => {
        const sections = [{ id: 'a', collapsible: false, open: true, allRows: [{ key: 'h', sessionId: 's1', teamHistoryLink: true }] }];
        expect(planDispatchReveal({ sessionId: 's1', teams: [], expandedTeams: new Set(), teamGroupId, sections })).toEqual({ kind: 'wait' });
    });
});
