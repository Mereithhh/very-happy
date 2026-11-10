import { describe, expect, it } from 'vitest';
import { TURN_FAILURE_CAPABILITY } from '@slopus/happy-wire';
import { lastUserMessage, sessionTurnFailure } from './turnFailure';
import { AgentStateSchema } from './storageTypes';
import type { Message } from './typesMessage';

const failure = { at: 10, summary: 'API Error: 400 bad request', provider: 'claude', status: 400 };
const session = (over: Record<string, unknown> = {}) => ({
    metadata: { capabilities: ['prompt-queue-v1', TURN_FAILURE_CAPABILITY] },
    agentState: { turnFailure: failure },
    thinking: false,
    archivedAt: null,
    ...over,
});

describe('B-913 sessionTurnFailure', () => {
    it('shows the failure a turn-failure-v1 wrapper recorded', () => {
        expect(sessionTurnFailure(session())).toEqual(failure);
    });
    it('old CLI (no capability) → nothing, whatever agentState holds (AGENTS #14)', () => {
        expect(sessionTurnFailure(session({ metadata: { capabilities: ['prompt-queue-v1'] } }))).toBeNull();
        expect(sessionTurnFailure(session({ metadata: {} }))).toBeNull();
    });
    it('a running turn, an archived session, a cleared or malformed value → nothing', () => {
        expect(sessionTurnFailure(session({ thinking: true }))).toBeNull();
        expect(sessionTurnFailure(session({ archivedAt: 5 }))).toBeNull();
        expect(sessionTurnFailure(session({ agentState: { turnFailure: null } }))).toBeNull();
        expect(sessionTurnFailure(session({ agentState: { turnFailure: { at: 'x' } } }))).toBeNull();
        expect(sessionTurnFailure(null)).toBeNull();
    });
});

describe('B-913 agentState schema compat', () => {
    it('new fields parse; a malformed one drops only itself', () => {
        const ok = AgentStateSchema.safeParse({ turnFailure: failure, backgroundTasks: { updatedAt: 1, tasks: [{ id: 'a', type: 'local_bash', description: 'd', startedAt: 1, command: 'sleep 9', turn: { startedAt: 0, prompt: 'p' } }] } });
        expect(ok.success && ok.data.turnFailure).toEqual(failure);
        expect(ok.success && ok.data.backgroundTasks?.tasks[0]).toMatchObject({ command: 'sleep 9', turn: { startedAt: 0, prompt: 'p' } });
        const bad = AgentStateSchema.safeParse({ controlledByUser: true, turnFailure: { summary: 3 }, backgroundTasks: { updatedAt: 1, tasks: [{ id: 'a', turn: 'x' }] } });
        expect(bad.success).toBe(true);
        expect(bad.success && bad.data.controlledByUser).toBe(true);
        expect(bad.success && bad.data.turnFailure).toBeUndefined();
        expect(bad.success && bad.data.backgroundTasks?.tasks[0].id).toBe('a');
    });
});

describe('B-913 lastUserMessage (what 重试 sends)', () => {
    const user = (id: string, text: string): Message => ({ kind: 'user-text', id, localId: null, createdAt: 0, text } as Message);
    const agent = (id: string): Message => ({ kind: 'agent-text', id, localId: null, createdAt: 0, text: 'a' } as Message);
    it('newest-first and chronological orders give the same message; blank ones skipped', () => {
        const chronological = [user('u1', 'first'), agent('a1'), user('u2', 'second'), agent('a2'), user('u3', '  ')];
        expect(lastUserMessage(chronological, 'chronological')?.id).toBe('u2');
        expect(lastUserMessage([...chronological].reverse(), 'newest-first')?.id).toBe('u2');
        expect(lastUserMessage([agent('a')], 'newest-first')).toBeNull();
    });
});
