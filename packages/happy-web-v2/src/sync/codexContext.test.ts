import { describe, expect, it } from 'vitest';
import { CODEX_CONTEXT_CAPABILITY } from '@slopus/happy-wire';
import { AgentStateSchema } from './storageTypes';
import { codexChildContext, sessionCodexContext } from './codexContext';
import { composerContextUsage, contextPercentOf, subagentContextWindow } from '@/screens/session/contextWindow';

const usage = { threadId: 't1', tokens: 14_991, contextWindow: 258_400, updatedAt: 1, children: [{ threadId: 'kid', tokens: 24_000, contextWindow: 258_400 }, { threadId: 'new', tokens: null }] };
const session = (over: Record<string, unknown> = {}, codexContextUsage: unknown = usage) => ({
    metadata: { flavor: 'codex', capabilities: [CODEX_CONTEXT_CAPABILITY], codexThreadId: 't1', ...over },
    agentState: { codexContextUsage },
});

describe('sessionCodexContext', () => {
    it('reads Codex’s figure for the thread the session is on', () => {
        expect(sessionCodexContext(session())).toEqual(usage);
        expect(sessionCodexContext(session({ codexThreadId: 'forked' }))).toBeNull();
        expect(sessionCodexContext(session({ codexThreadId: undefined }))).toBeNull();
    });
    it('ignores a figure left behind by a newer wrapper, other agents and malformed data', () => {
        expect(sessionCodexContext(session({ capabilities: [] }))).toBeNull();
        expect(sessionCodexContext(session({ flavor: 'claude' }))).toBeNull();
        expect(sessionCodexContext(session({}, { tokens: 'x' }))).toBeNull();
        expect(sessionCodexContext(null)).toBeNull();
    });
    it('a malformed field never costs the rest of agentState', () => {
        expect(AgentStateSchema.parse({ controlledByUser: true, codexContextUsage: { tokens: -1 } })).toMatchObject({ controlledByUser: true });
    });
    it('gives each sub-agent thread its own figure', () => {
        expect(codexChildContext(session(), 'kid')).toEqual({ tokens: 24_000, contextWindow: 258_400 });
        expect(codexChildContext(session(), 'new')).toBeNull();
        expect(codexChildContext(session(), 'absent')).toBeNull();
    });
});

describe('composer meter for Codex', () => {
    it('uses Codex’s tokens and window, never message usage or a guessed window', () => {
        const stale = { contextSize: 900_000, model: 'claude-opus-5-5' };
        const read = composerContextUsage(false, null, stale, 'gpt-5', 1_000_000, sessionCodexContext(session()));
        expect(read).toMatchObject({ tokens: 14_991, window: 258_400 });
        expect(contextPercentOf(read.tokens!, read.window)).toBe(6);
        expect(composerContextUsage(false, null, stale, 'gpt-5', 1_000_000, null)).toMatchObject({ tokens: null, window: null });
    });
    it('a rewound thread reads unknown, not 0%', () => {
        expect(composerContextUsage(false, null, null, null, null, sessionCodexContext(session({}, { ...usage, tokens: null }))).tokens).toBeNull();
    });
    it('leaves Claude and pi as they were', () => {
        expect(composerContextUsage(false, null, { contextSize: 50_000 }, 'claude-opus-5-5', 1_000_000)).toMatchObject({ tokens: 50_000, window: 1_000_000 });
        expect(composerContextUsage(true, { source: 'pi', tokens: 5, contextWindow: 10, updatedAt: 1 }, null)).toMatchObject({ tokens: 5, window: 10 });
    });
});

describe('subagentContextWindow', () => {
    it('takes the session’s reported window only for the session’s own model', () => {
        const running = { currentModelCode: 'claude-opus-5-5[1m]', currentContextWindow: 967_000 };
        expect(subagentContextWindow(['claude-opus-5-5'], running, 1)).toBe(967_000);
        expect(subagentContextWindow([], running, 1)).toBe(967_000);
        expect(subagentContextWindow(['claude-haiku-4-5'], running, 1)).toBe(200_000);
        expect(subagentContextWindow(['some-other-model'], running, 1)).toBeNull();
        expect(subagentContextWindow([], null, 1)).toBeNull();
    });
});
