import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { Session } from '@/sync/storageTypes';

let storage: typeof import('@/sync/storage').storage;
let apiSocket: typeof import('@/sync/apiSocket').apiSocket;
let sync: typeof import('@/sync/sync').sync;
let flow: typeof import('./forkFlow');
beforeAll(async () => {
    installBrowserTestGlobals();
    // spawn records its entry route (spawnOrigin.ts)
    const w = globalThis.window as unknown as { location?: { pathname?: string } };
    w.location = { ...(w.location ?? {}), pathname: '/session/parent' };
    ({ storage } = await import('@/sync/storage'));
    ({ apiSocket } = await import('@/sync/apiSocket'));
    ({ sync } = await import('@/sync/sync'));
    flow = await import('./forkFlow');
});

const parent = { id: 'parent', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, presence: 'online', thinking: false, metadataVersion: 1, agentState: null, agentStateVersion: 0, permissionMode: 'plan', modelMode: 'opus', effortLevel: 'high', metadata: { path: '/repo', host: 'h', machineId: 'm', flavor: 'claude', claudeSessionId: '11111111-1111-4111-8111-111111111111' } } as unknown as Session;
const prompt = (id: string, seq: number, text: string) => ({ kind: 'user-text', id, localId: null, createdAt: seq, seq, text });
let calls: { method: string; params: Record<string, unknown> }[];
function stubMachine(answers: Record<string, unknown>) {
    vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async (_m: string, method: string, params: unknown) => {
        calls.push({ method, params: params as Record<string, unknown> });
        const answer = answers[method];
        if (answer instanceof Error) throw answer;
        return answer as never;
    });
}
beforeEach(() => {
    calls = [];
    vi.restoreAllMocks();
    // A refresh lands the new row, as the server would.
    vi.spyOn(sync, 'refreshSessions').mockImplementation(async () => {
        storage.getState().applySessions([{ ...parent, id: 'branch', permissionMode: undefined, modelMode: undefined, effortLevel: undefined } as Session]);
    });
    storage.setState((state) => ({
        ...state,
        machines: { m: { id: 'm', active: true } as never },
        sessionMessages: { parent: { messages: [prompt('b', 3, 'second'), prompt('a', 1, 'first')], messagesMap: {} } as never },
    }));
    storage.getState().applySessions([parent]);
});

describe('B-851 fork from a prompt sent from the Web (no claude uuid)', () => {
    it('cuts before that prompt in the machine transcript and prefills its text in the new composer', async () => {
        stubMachine({
            'claude-list-rewind-points': { type: 'success', points: [{ uuid: 'u-first', text: 'first' }, { uuid: 'u-second', text: 'second' }] },
            'claude-rewind-before-message': { type: 'success', newClaudeSessionId: '22222222-2222-4222-8222-222222222222' },
            'spawn-happy-session': { type: 'success', sessionId: 'branch' },
        });
        const session = storage.getState().sessions.parent;
        const target = flow.messageForkTarget(session, prompt('b', 3, 'second') as never, false);
        expect(typeof target).toBe('object');
        expect(await flow.forkFromMessage(session, target as never, 'second')).toBe('branch');
        expect(calls.find((c) => c.method === 'claude-rewind-before-message')?.params).toMatchObject({ cutBeforeUuid: 'u-second' });
        expect(calls.find((c) => c.method === 'spawn-happy-session')?.params).toMatchObject({ parentSessionId: 'parent', forkedFromMessageId: 'b', resumeClaudeSessionId: '22222222-2222-4222-8222-222222222222', permissionMode: 'plan' });
        const branch = storage.getState().sessions.branch;
        expect(branch.draft).toBe('second');
        expect([branch.permissionMode, branch.modelMode, branch.effortLevel]).toEqual(['plan', 'opus', 'high']);
    });
    it('uses a prompt’s own claude uuid without asking the machine', async () => {
        stubMachine({
            'claude-rewind-before-message': { type: 'success', startFresh: true },
            'spawn-happy-session': { type: 'success', sessionId: 'branch' },
        });
        const session = storage.getState().sessions.parent;
        const target = flow.messageForkTarget(session, { ...prompt('a', 1, 'first'), claudeUuid: 'u-own' } as never, false);
        expect(target).toMatchObject({ pointId: 'u-own' });
        await flow.forkFromMessage(session, target as never, 'first');
        expect(calls.map((c) => c.method)).toEqual(['claude-rewind-before-message', 'spawn-happy-session']);
        expect(calls[0].params).toMatchObject({ cutBeforeUuid: 'u-own' });
    });
    it('refuses to guess when the transcript has no such prompt', async () => {
        stubMachine({ 'claude-list-rewind-points': { type: 'success', points: [{ uuid: 'u-x', text: 'unrelated' }] } });
        const session = storage.getState().sessions.parent;
        await expect(flow.forkFromMessage(session, { source: { kind: 'claude', sessionId: 'parent', machineId: 'm', directory: '/repo', claudeSessionId: 'c' }, messageId: 'b' }, 'second'))
            .rejects.toMatchObject({ kind: 'missingPoint' });
        expect(calls.map((c) => c.method)).toEqual(['claude-list-rewind-points']);
    });
    it('blocks a running session and an offline machine before any RPC', () => {
        const session = storage.getState().sessions.parent;
        expect(flow.messageForkTarget(session, prompt('b', 3, 'second') as never, true)).toBe('attachments');
        storage.setState((state) => ({ ...state, machines: { m: { id: 'm', active: false } as never } }));
        expect(flow.messageForkTarget(session, prompt('b', 3, 'second') as never, false)).toBe('offline');
    });
});

describe('B-851 whole-session fork failures are explained', () => {
    const source = { kind: 'claude' as const, sessionId: 'parent', machineId: 'm', directory: '/repo', claudeSessionId: 'c' };
    it('a daemon without the RPC needs a newer CLI', async () => {
        stubMachine({ 'claude-fork-session': { error: 'Method not found' } });
        await expect(flow.forkWholeSession(storage.getState().sessions.parent, source)).rejects.toMatchObject({ kind: 'outdated' });
    });
    it('an unregistered method on a machine still shown online names both causes', async () => {
        stubMachine({ 'claude-fork-session': new Error('RPC method not available') });
        await expect(flow.forkWholeSession(storage.getState().sessions.parent, source)).rejects.toMatchObject({ kind: 'unreachable' });
    });
    it('a machine that went offline meanwhile says offline', async () => {
        stubMachine({ 'claude-fork-session': new Error('RPC method not available') });
        storage.setState((state) => ({ ...state, machines: { m: { id: 'm', active: false } as never } }));
        await expect(flow.forkWholeSession(storage.getState().sessions.parent, source)).rejects.toMatchObject({ kind: 'offline' });
    });
    it('keeps the machine’s own reason otherwise', async () => {
        stubMachine({ 'claude-fork-session': { error: 'Claude session file not found on this machine' } });
        await expect(flow.forkWholeSession(storage.getState().sessions.parent, source)).rejects.toMatchObject({ kind: 'failed', message: 'Claude session file not found on this machine' });
    });
});
