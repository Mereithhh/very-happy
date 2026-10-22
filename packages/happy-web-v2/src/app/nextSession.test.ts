import { describe, it, expect } from 'vitest';
import { nextPathAfterClose, pickNextSessionId } from './nextSession';
import type { SessionPlacement } from './sessionPlacement';
import type { Session } from '@/sync/storageTypes';

const s = (id: string, over: Partial<Session> = {}): Session => ({
    id,
    active: true,
    activeAt: 0,
    updatedAt: 0,
    metadata: null,
    ...over,
}) as unknown as Session;

describe('pickNextSessionId (B-111)', () => {
    it('picks the most recently active other session', () => {
        const out = pickNextSessionId([
            s('closed', { activeAt: 999 }),
            s('older', { activeAt: 100 }),
            s('newest', { activeAt: 300 }),
        ], 'closed');
        expect(out).toBe('newest');
    });

    it('never lands on archived or hidden sessions', () => {
        const out = pickNextSessionId([
            s('archived', { active: false, activeAt: 900 }),
            s('mirror', { activeAt: 800, metadata: { flavor: 'terminal-mirror' } as never }),
            s('assistant', { activeAt: 700, metadata: { variant: 'assistant' } as never }),
            s('plain', { activeAt: 10 }),
        ], 'closed');
        expect(out).toBe('plain');
    });

    it('returns null when nothing else is left (caller falls back to /)', () => {
        expect(pickNextSessionId([s('closed')], 'closed')).toBeNull();
        expect(pickNextSessionId([], 'closed')).toBeNull();
    });
});

describe('nextPathAfterClose (B-774: stay in the closed session\'s place)', () => {
    const placements: Record<string, SessionPlacement> = {
        lead: { projectId: 'p1', teamId: 't1' },
        worker: { projectId: 'p1', teamId: 't1' },
        otherTeamLead: { projectId: null, teamId: 't2' },
        p1a: { projectId: 'p1' },
        p1b: { projectId: 'p1' },
        p2: { projectId: 'p2' },
        loose: { projectId: null },
        loose2: { projectId: null },
    };
    const ctx = {
        placementOf: (id: string): SessionPlacement => placements[id] ?? { projectId: null },
        teamHref: (id: string) => `/teams/${id}`,
        projectHref: (id: string) => `/projects/${id}`,
    };

    it('a team conversation lands on its team page, never on another member or team (QA5 O5)', () => {
        const sessions = [s('worker', { activeAt: 900 }), s('otherTeamLead', { activeAt: 999 }), s('p1a', { activeAt: 800 })];
        expect(nextPathAfterClose(sessions, 'lead', ctx)).toBe('/teams/t1');
    });

    it('a project session picks only from the same project, team members excluded', () => {
        const sessions = [s('p1a'), s('p1b', { activeAt: 50 }), s('p2', { activeAt: 999 }), s('lead', { activeAt: 998 }), s('loose', { activeAt: 997 })];
        expect(nextPathAfterClose(sessions, 'p1a', ctx)).toBe('/session/p1b');
        expect(nextPathAfterClose([s('p1a'), s('p2', { activeAt: 9 }), s('worker', { activeAt: 9 })], 'p1a', ctx)).toBe('/projects/p1');
    });

    it('a session in no project picks from the no-project, no-team pool, else home', () => {
        const sessions = [s('loose'), s('loose2', { activeAt: 5 }), s('p1a', { activeAt: 999 }), s('otherTeamLead', { activeAt: 999 })];
        expect(nextPathAfterClose(sessions, 'loose', ctx)).toBe('/session/loose2');
        expect(nextPathAfterClose([s('loose'), s('p2', { activeAt: 9 })], 'loose', ctx)).toBe('/');
    });

    it('never lands on a session shared with this account', () => {
        const sessions = [s('loose'), s('loose2', { activeAt: 9, share: { accessLevel: 'driver' } as never })];
        expect(nextPathAfterClose(sessions, 'loose', ctx)).toBe('/');
        expect(pickNextSessionId(sessions, 'loose')).toBeNull();
    });

    it('unknown placement (projects not loaded) goes home instead of guessing', () => {
        expect(nextPathAfterClose([s('loose'), s('loose2', { activeAt: 9 })], 'loose', { ...ctx, placementOf: null })).toBe('/');
    });
});
