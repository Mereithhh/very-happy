import { expect, it } from 'vitest';
import { createReducer, reducer } from './reducer/reducer';
import { normalizeRawMessage } from './typesRaw';

it('updates a live Codex collaboration with the receivers reported on completion', () => {
    const state = createReducer();
    let seq = 0;
    const receive = (id: string, ev: Record<string, unknown>, time?: number) => {
        const message = normalizeRawMessage(id, null, ++seq, {
            role: 'session', content: { type: 'session', data: {
                id, time: time ?? seq, role: 'agent', turn: 'turn-1', ev,
            } },
        } as any);
        expect(message).not.toBeNull();
        return reducer(state, [{ ...message!, seq }]).messages;
    };
    const start = (receiverThreadIds: string[]) => ({
        t: 'tool-call-start', call: 'spawn-1', name: 'CodexCollaboration',
        title: 'Codex · spawnAgent', description: 'Codex · spawnAgent',
        args: { operation: 'spawnAgent', receiverThreadIds, agentsStates: receiverThreadIds.length ? { 'child-1': { status: 'running' } } : {} },
    });
    receive('spawn-1:inProgress:start', start([]));
    const updated = receive('spawn-1:completed:start', start(['child-1']));
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ kind: 'tool-call', tool: {
        name: 'CodexCollaboration', input: { receiverThreadIds: ['child-1'] },
    } });
    const completed = receive('spawn-1:end', { t: 'tool-call-end', call: 'spawn-1', result: { text: 'Started child' } });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ kind: 'tool-call', tool: {
        state: 'completed', input: { receiverThreadIds: ['child-1'] },
    } });
    const backfilled = receive('spawn-1:old-snapshot', start([]), 1);
    expect(backfilled[0]).toMatchObject({ kind: 'tool-call', tool: {
        state: 'completed', startedAt: 1, input: { receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'running' } } },
    } });
    const conflicting = start(['child-1']);
    conflicting.args.agentsStates = { 'child-1': { status: 'pending' } };
    expect(receive('spawn-1:conflicting-old-snapshot', conflicting, 1)[0]).toMatchObject({ tool: {
        input: { agentsStates: { 'child-1': { status: 'running' } } },
    } });
});
