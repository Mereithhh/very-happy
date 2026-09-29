/**
 * B-513: send confirmation state lives in the reducer (storage rebuilds every
 * Message from it), so every ordering of optimistic copy / HTTP ack / server
 * echo / local failure must converge on the same row.
 */
import { describe, expect, it } from 'vitest';
import { applySendStateUpdate, createReducer, reducer, type ReducerState } from './reducer';
import type { NormalizedMessage } from '../typesRaw';
import type { Message } from '../typesMessage';
import { compareMessagesNewestFirst } from '../messageOrder';

function userMessage(localId: string, opts: { id?: string; seq?: number; createdAt?: number; queuedAt?: number } = {}): NormalizedMessage {
    return {
        id: opts.id ?? localId,
        localId,
        createdAt: opts.createdAt ?? 1000,
        ...(opts.seq !== undefined ? { seq: opts.seq } : {}),
        role: 'user',
        content: { type: 'text', text: `text of ${localId}` },
        isSidechain: false,
        ...(opts.queuedAt !== undefined ? { meta: { queuedAt: opts.queuedAt } } : {}),
    };
}

function fileMessage(localId: string, envelopeId: string, opts: { seq?: number; createdAt?: number } = {}): NormalizedMessage {
    return {
        id: envelopeId,
        localId,
        createdAt: opts.createdAt ?? 1000,
        ...(opts.seq !== undefined ? { seq: opts.seq } : {}),
        role: 'agent',
        isSidechain: false,
        content: [
            { type: 'tool-call', id: envelopeId, name: 'file', input: { ref: 'r', name: 'a.png', size: 1, mimeType: 'image/png' }, description: null, uuid: envelopeId, parentUUID: null },
            { type: 'tool-result', tool_use_id: envelopeId, content: null, is_error: false, uuid: `${envelopeId}-r`, parentUUID: null },
        ],
    } as NormalizedMessage;
}

function turnEnd(id: string, createdAt: number, seq?: number): NormalizedMessage {
    return { id, localId: null, createdAt, ...(seq !== undefined ? { seq } : {}), role: 'event', content: { type: 'ready' }, isSidechain: false };
}

/** Mirrors storage.applyMessages for an optimistic batch: mark, then reduce. */
function sendOptimistic(state: ReducerState, message: NormalizedMessage): Message[] {
    applySendStateUpdate(state, { sending: [message.localId!] });
    return reducer(state, [message]).messages;
}

/** Latest converted view of one localId, the way storage's messagesMap holds it. */
class View {
    rows = new Map<string, Message>();
    constructor(private state: ReducerState) {}
    push(messages: Message[], removed: string[] = []) {
        for (const id of removed) this.rows.delete(id);
        for (const m of messages) this.rows.set(m.id, m);
    }
    reduce(messages: NormalizedMessage[]) { this.push(reducer(this.state, messages).messages); }
    update(update: Parameters<typeof applySendStateUpdate>[1]) {
        const result = applySendStateUpdate(this.state, update);
        this.push(result.messages, result.removed);
    }
    byLocalId(localId: string): Message | undefined {
        return [...this.rows.values()].find((m) => 'localId' in m && m.localId === localId);
    }
}

describe('B-513 send state in the reducer', () => {
    it('creates an optimistic user message as sending, and an ack confirms it without changing id or createdAt', () => {
        const state = createReducer();
        const view = new View(state);
        view.push(sendOptimistic(state, userMessage('l1', { createdAt: 1234 })));
        const sending = view.byLocalId('l1')!;
        expect(sending).toMatchObject({ kind: 'user-text', sendState: 'sending' });
        expect(sending.seq).toBeUndefined();

        view.update({ acks: [{ localId: 'l1', seq: 7, id: 'srv-1' }] });
        const confirmed = view.byLocalId('l1')!;
        expect(confirmed).not.toHaveProperty('sendState');
        expect(confirmed.seq).toBe(7);
        expect(confirmed.id).toBe(sending.id);
        expect(confirmed.createdAt).toBe(1234);
    });

    it('ack before the optimistic message reaches the reducer: created already confirmed', () => {
        const state = createReducer();
        const view = new View(state);
        view.update({ acks: [{ localId: 'l1', seq: 3, id: 'srv-1' }] });
        view.push(sendOptimistic(state, userMessage('l1')));
        const row = view.byLocalId('l1')!;
        expect(row).not.toHaveProperty('sendState');
        expect(row.seq).toBe(3);
        expect(state.acked.size).toBe(0);
    });

    it('echo before ack clears sending; the later ack is a no-op', () => {
        const state = createReducer();
        const view = new View(state);
        view.push(sendOptimistic(state, userMessage('l1')));
        view.reduce([userMessage('l1', { id: 'srv-1', seq: 9 })]);
        const row = view.byLocalId('l1')!;
        expect(row).not.toHaveProperty('sendState');
        expect(row.seq).toBe(9);
        const again = applySendStateUpdate(state, { acks: [{ localId: 'l1', seq: 9, id: 'srv-1' }] });
        expect(again.messages).toHaveLength(0);
        expect(view.rows.size).toBe(1);
    });

    it('ack before echo: echo is still deduplicated by localId', () => {
        const state = createReducer();
        const view = new View(state);
        view.push(sendOptimistic(state, userMessage('l1')));
        view.update({ acks: [{ localId: 'l1', seq: 4, id: 'srv-1' }] });
        view.reduce([userMessage('l1', { id: 'srv-1', seq: 4 })]);
        expect(view.rows.size).toBe(1);
        expect(view.byLocalId('l1')).not.toHaveProperty('sendState');
    });

    it('echo that arrives before the optimistic copy is never re-marked sending', () => {
        const state = createReducer();
        const view = new View(state);
        view.reduce([userMessage('l1', { id: 'srv-1', seq: 2 })]);
        view.push(sendOptimistic(state, userMessage('l1')));
        expect(view.byLocalId('l1')).not.toHaveProperty('sendState');
        expect(state.sendStates.size).toBe(0);
    });

    it('failure marks failed; a late echo (server did store it) clears the failure', () => {
        const state = createReducer();
        const view = new View(state);
        view.push(sendOptimistic(state, userMessage('l1')));
        view.update({ failures: [{ localId: 'l1', restorable: false }] });
        expect(view.byLocalId('l1')).toMatchObject({ sendState: 'failed' });
        expect(view.byLocalId('l1')).not.toHaveProperty('sendRestorable');

        view.reduce([userMessage('l1', { id: 'srv-1', seq: 11 })]);
        const row = view.byLocalId('l1')!;
        expect(row).not.toHaveProperty('sendState');
        expect(row.seq).toBe(11);
    });

    it('a failure cannot override an ack that already won', () => {
        const state = createReducer();
        const view = new View(state);
        view.push(sendOptimistic(state, userMessage('l1')));
        view.update({ acks: [{ localId: 'l1', seq: 5, id: 'srv' }], failures: [{ localId: 'l1', restorable: true }] });
        expect(view.byLocalId('l1')).not.toHaveProperty('sendState');
    });

    it('retry is idempotent: failed -> sending (twice) -> one confirmed row', () => {
        const state = createReducer();
        const view = new View(state);
        view.push(sendOptimistic(state, userMessage('l1')));
        view.update({ failures: [{ localId: 'l1', restorable: true }] });
        expect(view.byLocalId('l1')).toMatchObject({ sendState: 'failed', sendRestorable: true });
        view.update({ sending: ['l1'] });
        view.update({ sending: ['l1'] });
        expect(view.byLocalId('l1')).toMatchObject({ sendState: 'sending' });
        expect(view.byLocalId('l1')).not.toHaveProperty('sendRestorable');
        view.update({ acks: [{ localId: 'l1', seq: 6, id: 'srv' }] });
        view.reduce([userMessage('l1', { id: 'srv', seq: 6 })]);
        expect(view.rows.size).toBe(1);
        expect(view.byLocalId('l1')).not.toHaveProperty('sendState');
    });

    it('re-marking a confirmed message as sending is refused', () => {
        const state = createReducer();
        const view = new View(state);
        view.push(sendOptimistic(state, userMessage('l1')));
        view.update({ acks: [{ localId: 'l1', seq: 6, id: 'srv' }] });
        view.update({ sending: ['l1'] });
        expect(view.byLocalId('l1')).not.toHaveProperty('sendState');
    });

    it('a failed message taken back into the composer disappears, and a late echo brings it back', () => {
        const state = createReducer();
        const view = new View(state);
        view.push(sendOptimistic(state, userMessage('l1')));
        view.update({ failures: [{ localId: 'l1', restorable: true }] });
        view.update({ withdraw: ['l1'] });
        expect(view.byLocalId('l1')).toBeUndefined();
        // A later reducer pass (e.g. a turn-end) must not resurrect it.
        view.reduce([turnEnd('te', 5000, 20)]);
        expect(view.byLocalId('l1')).toBeUndefined();

        view.reduce([userMessage('l1', { id: 'srv', seq: 21 })]);
        expect(view.byLocalId('l1')).toMatchObject({ kind: 'user-text', seq: 21 });
        expect(view.byLocalId('l1')).not.toHaveProperty('sendState');
    });

    it('only a failed message can be withdrawn', () => {
        const state = createReducer();
        const view = new View(state);
        view.push(sendOptimistic(state, userMessage('l1')));
        view.update({ withdraw: ['l1'] });
        expect(view.byLocalId('l1')).toMatchObject({ sendState: 'sending' });
    });

    it('file inputs carry send state and are confirmed by their echo', () => {
        const state = createReducer();
        const view = new View(state);
        view.push(sendOptimistic(state, fileMessage('f1', 'env-1')));
        expect(view.byLocalId('f1')).toMatchObject({ kind: 'tool-call', sendState: 'sending' });
        view.reduce([fileMessage('f1', 'env-1', { seq: 8 })]);
        const row = view.byLocalId('f1')!;
        expect(row).not.toHaveProperty('sendState');
        expect(row.seq).toBe(8);
        expect(view.rows.size).toBe(1);
    });

    it('file inputs are confirmed by an ack', () => {
        const state = createReducer();
        const view = new View(state);
        view.push(sendOptimistic(state, fileMessage('f1', 'env-1')));
        view.update({ acks: [{ localId: 'f1', seq: 8, id: 'srv-f' }] });
        expect(view.byLocalId('f1')).not.toHaveProperty('sendState');
        expect(view.byLocalId('f1')!.seq).toBe(8);
    });

    it('an unconfirmed queued input stays queued even after a later turn-end by time', () => {
        const state = createReducer();
        const view = new View(state);
        view.push(sendOptimistic(state, userMessage('l1', { createdAt: 2000, queuedAt: 2000 })));
        view.reduce([turnEnd('te-1', 2100, 10)]);
        expect(view.byLocalId('l1')).toMatchObject({ inputState: 'queued', sendState: 'sending' });

        // Confirmed at seq 11: the turn-end at seq 10 precedes it, so it still waits.
        view.update({ acks: [{ localId: 'l1', seq: 11, id: 'srv' }] });
        expect(view.byLocalId('l1')).toMatchObject({ inputState: 'queued', seq: 11 });
        view.reduce([turnEnd('te-2', 2200, 12)]);
        const released = view.byLocalId('l1')!;
        expect(released).not.toHaveProperty('inputState');
        expect(released.displaySeq).toBe(12);
    });

    it('a failed queued input stays in the queue dock', () => {
        const state = createReducer();
        const view = new View(state);
        view.push(sendOptimistic(state, userMessage('l1', { createdAt: 2000, queuedAt: 2000 })));
        view.update({ failures: [{ localId: 'l1', restorable: false }] });
        view.reduce([turnEnd('te-1', 2100, 10)]);
        expect(view.byLocalId('l1')).toMatchObject({ inputState: 'queued', sendState: 'failed' });
    });

    it('a written-back seq orders the message by seq, as after a refresh', () => {
        const state = createReducer();
        const view = new View(state);
        // Agent reply stored at seq 5 but stamped with a LATER createdAt than our send.
        view.reduce([{ id: 'a1', localId: null, createdAt: 3000, seq: 5, role: 'agent', isSidechain: false, content: [{ type: 'text', text: 'hi', uuid: 'u', parentUUID: null }] } as NormalizedMessage]);
        view.push(sendOptimistic(state, userMessage('l1', { createdAt: 2000 })));
        const newestFirst = () => [...view.rows.values()].sort(compareMessagesNewestFirst).map((m) => m.kind);
        expect(newestFirst()).toEqual(['agent-text', 'user-text']);
        view.update({ acks: [{ localId: 'l1', seq: 6, id: 'srv' }] });
        expect(newestFirst()).toEqual(['user-text', 'agent-text']);
    });
});
