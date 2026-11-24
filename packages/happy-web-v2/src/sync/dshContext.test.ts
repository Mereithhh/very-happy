import { describe, expect, it } from 'vitest';
import { DSH_CONTEXT_CAPABILITY } from '@slopus/happy-wire';
import { AgentStateSchema } from './storageTypes';
import { sessionDshContext } from './dshContext';
import { composerContextUsage, contextPercentOf } from '@/screens/session/contextWindow';

const usage = { sessionId: 'd1', tokens: 23_456, contextWindow: 1_000_000, updatedAt: 1 };
const session = (over: Record<string, unknown> = {}, dshContextUsage: unknown = usage) => ({
    metadata: { flavor: 'dsh', capabilities: [DSH_CONTEXT_CAPABILITY], dshSessionId: 'd1', ...over },
    agentState: { dshContextUsage },
});

describe('sessionDshContext (B-970)', () => {
    it('reads dsh’s figure for the dsh session the session is on', () => {
        expect(sessionDshContext(session())).toEqual({ tokens: 23_456, contextWindow: 1_000_000 });
    });
    it('null once the session is on another dsh session, or nothing is measured yet', () => {
        expect(sessionDshContext(session({ dshSessionId: 'fresh' }))).toBeNull();
        expect(sessionDshContext(session({}, null))).toBeNull();
        expect(sessionDshContext(session({}, { tokens: 'x' }))).toBeNull();
    });
    it('undefined for an older dsh wrapper and every other agent (their meter reading is unchanged)', () => {
        expect(sessionDshContext(session({ capabilities: [] }))).toBeUndefined();
        for (const flavor of ['claude', 'codex', 'pi', 'gemini', undefined]) {
            expect(sessionDshContext(session({ flavor }))).toBeUndefined();
        }
        expect(sessionDshContext(null)).toBeUndefined();
    });
    it('a malformed field never costs the rest of agentState', () => {
        expect(AgentStateSchema.parse({ controlledByUser: true, dshContextUsage: { tokens: -1 } })).toMatchObject({ controlledByUser: true });
        expect(AgentStateSchema.parse({ dshContextUsage: usage }).dshContextUsage).toEqual(usage);
    });
});

describe('composer meter for dsh (B-970)', () => {
    it('uses dsh’s tokens and window', () => {
        const read = composerContextUsage(false, null, null, 'deepseek-v4-flash', null, sessionDshContext(session()));
        expect(read).toMatchObject({ tokens: 23_456, window: 1_000_000, estimated: false, windowSource: 'configured' });
        expect(contextPercentOf(read.tokens!, read.window)).toBe(2);
    });
    it('shows nothing measured before the first answer, not a guess', () => {
        expect(composerContextUsage(false, null, null, 'deepseek-v4-flash', null, sessionDshContext(session({}, null)))).toMatchObject({ tokens: null, window: null });
    });
    it('an older dsh wrapper keeps the pre-B-970 reading', () => {
        const message = { contextSize: 1200, model: 'deepseek-v4-flash' };
        expect(composerContextUsage(false, null, message, 'deepseek-v4-flash', null, sessionDshContext(session({ capabilities: [] }))))
            .toEqual(composerContextUsage(false, null, message, 'deepseek-v4-flash', null, undefined));
    });
});
