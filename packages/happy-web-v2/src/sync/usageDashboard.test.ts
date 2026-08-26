import { describe, expect, it } from 'vitest';
import { buildUsageDashboard } from './usageDashboard';

describe('buildUsageDashboard', () => {
    it('joins report agents with structured and terminal session facts', () => {
        const dashboard = buildUsageDashboard({
            usage: [],
            reports: [
                { key: 'claude-session', sessionId: 'chat', timestamp: 1, tokens: { total: 12, input: 10, output: 2 }, cost: { total: 0.1, input: 0.08, output: 0.02 } },
                { key: 'usage:codex:session', sessionId: 'mirror', timestamp: 1, tokens: { total: 20, input: 15, output: 5 }, cost: { total: 0 } },
            ],
            sessions: [
                { id: 'chat', createdAt: 1000, metadata: { flavor: 'claude' } },
                { id: 'mirror', createdAt: 1000, metadata: { flavor: 'terminal-mirror', terminalId: 'term-1' } },
                { id: 'gemini', createdAt: 1000, metadata: { flavor: 'gemini' } },
            ],
            terminals: [{ id: 'term-1', createdAt: 1000 }, { id: 'term-2', closedAt: 2000 }],
            startMs: 500,
        });
        expect(dashboard).toMatchObject({ totalTokens: 32, structuredSessions: 2, terminalSessions: 2, costKnown: true });
        expect(dashboard.agents).toEqual(expect.arrayContaining([
            { key: 'codex', tokens: 20, sessions: 1 },
            { key: 'claude', tokens: 12, sessions: 1 },
            { key: 'gemini', tokens: 0, sessions: 1 },
            { key: 'terminal-mirror', tokens: 0, sessions: 1 },
        ]));
    });

    it('still returns useful session counts when no token report exists', () => {
        const dashboard = buildUsageDashboard({ usage: [], sessions: [{ id: 'x', createdAt: 100, metadata: { flavor: 'openclaw' } }], terminals: [], startMs: 0 });
        expect(dashboard.totalTokens).toBe(0);
        expect(dashboard.structuredSessions).toBe(1);
        expect(dashboard.costKnown).toBe(false);
    });
});
