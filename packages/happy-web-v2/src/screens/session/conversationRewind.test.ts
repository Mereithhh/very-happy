import { describe, expect, it, vi } from 'vitest';
vi.mock('@/sync/apiSocket', () => ({ apiSocket: {} }));
vi.mock('@/sync/storage', () => ({ storage: {} }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
import { deleteRange, rewindConversation, RewindFailure, type RewindDeps } from './conversationRewind';

const message = { seq: 10, localId: 'local-10', text: 'hello' };
function deps(overrides: Partial<RewindDeps> = {}): RewindDeps {
    return {
        rpc: vi.fn(async () => ({ ok: true, action: 'edit', freshConversation: false })),
        recordDrop: vi.fn(async () => {}),
        send: vi.fn(async () => 'receipt'),
        userSeqs: () => [2, 10, 14, 20],
        newRequestId: () => 'req-1',
        waitForRewindRecord: vi.fn(async () => false),
        ...overrides,
    };
}

describe('rewindConversation (B-528)', () => {
    it('edit: rewinds the agent, hides from this prompt on, then sends the new text', async () => {
        const d = deps();
        await rewindConversation('s', message, { action: 'edit', text: 'new' }, d);
        expect(d.rpc).toHaveBeenCalledWith('s', { action: 'edit', sourceId: 'local-10', text: 'hello', requestId: 'req-1' });
        expect(d.recordDrop).toHaveBeenCalledWith('s', { fromSeq: 10, reason: 'edit', requestId: 'req-1' });
        expect(d.send).toHaveBeenCalledWith('s', 'new');
        const order = [d.rpc, d.recordDrop, d.send].map((fn) => (fn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('delete: hides only this turn, up to the next prompt', async () => {
        const d = deps();
        await rewindConversation('s', message, { action: 'delete' }, d);
        expect(d.recordDrop).toHaveBeenCalledWith('s', { fromSeq: 10, toSeq: 14, reason: 'delete', requestId: 'req-1' });
        expect(d.send).not.toHaveBeenCalled();
        expect(deleteRange(20, [2, 10, 14, 20])).toEqual({ fromSeq: 20 });
    });

    it('never touches the transcript when the agent did not rewind', async () => {
        for (const rpc of [
            vi.fn(async () => ({ error: 'Method not found' })),
            vi.fn(async () => { throw new Error('RPC method not available'); }),
            vi.fn(async () => ({ ok: false, code: 'ambiguous', error: 'dup' })),
        ]) {
            const d = deps({ rpc });
            const failure = await rewindConversation('s', message, { action: 'edit', text: 'x' }, d).catch((e) => e);
            expect(failure).toBeInstanceOf(RewindFailure);
            expect(d.recordDrop).not.toHaveBeenCalled();
            expect(d.send).not.toHaveBeenCalled();
        }
        const unsupported = await rewindConversation('s', message, { action: 'delete' }, deps({ rpc: vi.fn(async () => ({ error: 'Method not found' })) })).catch((e) => e);
        expect(unsupported.kind).toBe('unsupported');
    });

    it('refuses an unconfirmed message and reports a failed send separately', async () => {
        expect((await rewindConversation('s', { ...message, seq: null }, { action: 'delete' }, deps()).catch((e) => e)).kind).toBe('unsent');
        const failed = await rewindConversation('s', message, { action: 'edit', text: 'x' }, deps({ send: vi.fn(async () => null) })).catch((e) => e);
        expect(failed.kind).toBe('send');
    });

    describe('B-544: lost ack falls back to the wrapper record', () => {
        const timeout = () => vi.fn(async () => { throw new Error('operation has timed out'); });

        it('RPC timed out but metadata.rewind carries this requestId → tombstone (with requestId) + send', async () => {
            const waitForRewindRecord = vi.fn(async () => true);
            const d = deps({ rpc: timeout(), waitForRewindRecord });
            await rewindConversation('s', message, { action: 'edit', text: 'new' }, d);
            expect(waitForRewindRecord).toHaveBeenCalledWith('s', 'req-1', 10_000);
            expect(d.recordDrop).toHaveBeenCalledWith('s', { fromSeq: 10, reason: 'edit', requestId: 'req-1' });
            expect(d.send).toHaveBeenCalledWith('s', 'new');
        });

        it('RPC timed out and no record within the window → fails without touching the transcript', async () => {
            const d = deps({ rpc: timeout(), waitForRewindRecord: vi.fn(async () => false) });
            const failure = await rewindConversation('s', message, { action: 'delete' }, d).catch((e) => e);
            expect(failure).toBeInstanceOf(RewindFailure);
            expect(failure.kind).toBe('agent');
            expect(d.recordDrop).not.toHaveBeenCalled();
            expect(d.send).not.toHaveBeenCalled();
        });

        it('a definitive refusal or an unsupported CLI never consults the record', async () => {
            for (const rpc of [
                vi.fn(async () => ({ ok: false, code: 'not-found', error: 'gone' })),
                vi.fn(async () => { throw new Error('RPC method not available'); }),
            ]) {
                const waitForRewindRecord = vi.fn(async () => true);
                const d = deps({ rpc, waitForRewindRecord });
                await expect(rewindConversation('s', message, { action: 'edit', text: 'x' }, d)).rejects.toBeInstanceOf(RewindFailure);
                expect(waitForRewindRecord).not.toHaveBeenCalled();
                expect(d.recordDrop).not.toHaveBeenCalled();
            }
        });

        it('each request gets its own id', async () => {
            let n = 0;
            const d = deps({ newRequestId: () => `req-${++n}` });
            await rewindConversation('s', message, { action: 'delete' }, d);
            await rewindConversation('s', message, { action: 'delete' }, d);
            expect((d.rpc as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[1] as { requestId: string }).requestId)).toEqual(['req-1', 'req-2']);
        });
    });
});
