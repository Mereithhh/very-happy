import { describe, expect, it } from 'vitest';
import { AuthFailedError } from '@/auth/authLatch';
import {
    advanceLastSeq,
    ApiRequestError,
    assertResponseOk,
    beginSendAttempt,
    classifySendError,
    interpretSendResponse,
    mapWithConcurrency,
    removeByLocalId,
    SendDeadlines,
    settledOutboxRecords,
} from './outbox';

describe('B-513 advanceLastSeq', () => {
    it('advances through a contiguous run of acked seqs', () => {
        expect(advanceLastSeq(10, [11, 12])).toEqual({ next: 12, gap: false });
    });

    it('does not jump over an in-flight agent message (ack N+2 while N+1 unseen)', () => {
        expect(advanceLastSeq(10, [12])).toEqual({ next: 10, gap: true });
    });

    it('advances up to the gap and reports it', () => {
        expect(advanceLastSeq(10, [11, 13])).toEqual({ next: 11, gap: true });
    });

    it('ignores seqs already covered (echo applied first)', () => {
        expect(advanceLastSeq(12, [11, 12])).toEqual({ next: 12, gap: false });
    });

    it('leaves an unanchored session alone (initial load sets it)', () => {
        expect(advanceLastSeq(undefined, [5])).toEqual({ next: undefined, gap: false });
    });
});

describe('B-513 removeByLocalId', () => {
    it('removes only acknowledged items, keeping ones enqueued mid-flight', () => {
        const pending = [{ localId: 'a' }, { localId: 'b' }, { localId: 'c' }];
        // Batch was [a, b]; c arrived during the request; server acked a and b.
        removeByLocalId(pending, new Set(['a', 'b']));
        expect(pending).toEqual([{ localId: 'c' }]);
    });

    it('keeps an unacknowledged batch item instead of assuming the whole batch landed', () => {
        const pending = [{ localId: 'a' }, { localId: 'b' }];
        removeByLocalId(pending, new Set(['b']));
        expect(pending).toEqual([{ localId: 'a' }]);
    });
});

describe('B-513 classifySendError', () => {
    it.each([400, 404, 413])('%i is final and never stored', (status) => {
        expect(classifySendError(new ApiRequestError(status, null), true)).toEqual({ kind: 'rejected', mayHaveStored: false });
    });

    it('429 message count quota is final', () => {
        expect(classifySendError(new ApiRequestError(429, 'message_count_quota_exceeded'), true)).toEqual({ kind: 'rejected', mayHaveStored: false });
    });

    it('a plain 429 rate limit is retried', () => {
        expect(classifySendError(new ApiRequestError(429, null), true)).toEqual({ kind: 'retry', mayHaveStored: false });
    });

    it.each([401, 403])('%i is an auth failure', (status) => {
        expect(classifySendError(new ApiRequestError(status, null), true)).toEqual({ kind: 'auth', mayHaveStored: false });
        expect(classifySendError(new AuthFailedError(status), true).kind).toBe('auth');
    });

    it('5xx is retried and may have stored', () => {
        expect(classifySendError(new ApiRequestError(502, null), true)).toEqual({ kind: 'retry', mayHaveStored: true });
    });

    it('an aborted (deadline) request may have stored', () => {
        expect(classifySendError(new DOMException('x', 'AbortError'), true)).toEqual({ kind: 'retry', mayHaveStored: true });
    });

    it('a network error while offline could not have been sent', () => {
        expect(classifySendError(new TypeError('Failed to fetch'), false)).toEqual({ kind: 'retry', mayHaveStored: false });
        expect(classifySendError(new TypeError('Failed to fetch'), true)).toEqual({ kind: 'retry', mayHaveStored: true });
    });

    it('review: a request sent online that fails after the device went offline may have been stored', () => {
        let online = true;
        const attempt = beginSendAttempt(() => online);
        online = false; // dropped offline mid-flight
        expect(attempt.classify(new TypeError('Failed to fetch'))).toEqual({ kind: 'retry', mayHaveStored: true });
    });

    it('review: a request issued while already offline never left', () => {
        let online = false;
        const attempt = beginSendAttempt(() => online);
        online = true;
        expect(attempt.classify(new TypeError('Failed to fetch'))).toEqual({ kind: 'retry', mayHaveStored: false });
    });

    it('assertResponseOk carries status and server code', async () => {
        const response = new Response(JSON.stringify({ error: 'message_count_quota_exceeded' }), { status: 429 });
        const error = await assertResponseOk(response, 'send').catch((e) => e);
        expect(error).toBeInstanceOf(ApiRequestError);
        expect(error).toMatchObject({ status: 429, code: 'message_count_quota_exceeded' });
        await expect(assertResponseOk(new Response('nope', { status: 500 }), 'send')).rejects.toMatchObject({ status: 500, code: null });
        await expect(assertResponseOk(new Response('{}', { status: 200 }), 'send')).resolves.toBeUndefined();
    });
});

describe('B-513 SendDeadlines', () => {
    it('expires an item after 15s of wall clock', () => {
        const deadlines = new SendDeadlines();
        deadlines.start(['a'], 0);
        expect(deadlines.tick(14_500, true)).toEqual([]);
        expect(deadlines.tick(15_000, true)).toEqual(['a']);
        expect(deadlines.size).toBe(0);
    });

    it('pauses while offline', () => {
        const deadlines = new SendDeadlines();
        deadlines.start(['a'], 0);
        expect(deadlines.tick(10_000, true)).toEqual([]);
        expect(deadlines.tick(60_000, false)).toEqual([]);
        expect(deadlines.tick(64_000, true)).toEqual([]);
        expect(deadlines.tick(65_000, true)).toEqual(['a']);
    });

    it('a retry restarts the full budget', () => {
        const deadlines = new SendDeadlines();
        deadlines.start(['a'], 0);
        deadlines.tick(14_000, true);
        deadlines.start(['a'], 14_000);
        expect(deadlines.tick(28_000, true)).toEqual([]);
        expect(deadlines.tick(29_000, true)).toEqual(['a']);
    });

    it('a deleted (acked) item never expires', () => {
        const deadlines = new SendDeadlines();
        deadlines.start(['a', 'b'], 0);
        deadlines.delete('a');
        expect(deadlines.tick(20_000, true)).toEqual(['b']);
    });
});

describe('B-513 mapWithConcurrency', () => {
    it('caps parallelism and keeps input order', async () => {
        let active = 0;
        let peak = 0;
        const resolvers: Array<() => void> = [];
        const promise = mapWithConcurrency([1, 2, 3, 4, 5], 3, async (n) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise<void>((resolve) => resolvers.push(resolve));
            active -= 1;
            return n * 10;
        });
        for (let i = 0; i < 5; i += 1) {
            await Promise.resolve();
            await Promise.resolve();
            // Release in reverse to prove ordering does not depend on completion order.
            resolvers.pop()?.();
        }
        while (resolvers.length) resolvers.shift()!();
        await new Promise((r) => setTimeout(r, 0));
        while (resolvers.length) resolvers.shift()!();
        expect(await promise).toEqual([10, 20, 30, 40, 50]);
        expect(peak).toBe(3);
    });

    it('a failed item does not stop the rest', async () => {
        const results = await mapWithConcurrency(['a', 'bad', 'c'], 3, async (item) => {
            if (item === 'bad') return null;
            return item;
        });
        expect(results).toEqual(['a', null, 'c']);
    });
});

describe('B-513 review: interpretSendResponse', () => {
    const stored = [
        { id: 's-file', seq: 11, localId: 'file' },
        { id: 's-text', seq: 12, localId: 'text' },
        { id: 's-tomb', seq: 13, localId: 'tomb' },
    ];

    it('acks tracked items, removes every batch item, advances over applied seqs only', () => {
        const out = interpretSendResponse(stored, new Set(['file', 'text', 'tomb']), new Set(['file', 'text']));
        expect([...out.ackedIds]).toEqual(['file', 'text', 'tomb']);
        expect(out.acks.map((a) => a.localId)).toEqual(['file', 'text']);
        expect(out.lastSeqCandidates).toEqual([11, 12, 13]);
    });

    it('never advances lastSeq over a message that was not in the batch (its echo must still apply)', () => {
        const out = interpretSendResponse(stored, new Set(['text']), new Set(['text']));
        expect(out.lastSeqCandidates).toEqual([12]);
        expect(out.acks.map((a) => a.localId)).toEqual(['text']);
        expect(advanceLastSeq(10, out.lastSeqCandidates)).toEqual({ next: 10, gap: true });
    });

    it('acks a batch item tracked at dispatch even if its record is gone now (taken back → re-surfaces)', () => {
        const out = interpretSendResponse(stored, new Set(['text']), new Set(['text']));
        expect(out.acks).toEqual([{ localId: 'text', seq: 12, id: 's-text' }]);
    });
});

describe('B-513 review: settledOutboxRecords', () => {
    const records = [
        { localId: 'confirmed', sessionId: 's1' },
        { localId: 'failed', sessionId: 's1' },
        { localId: 'sending', sessionId: 's1' },
        { localId: 'queued', sessionId: 's1' },
        { localId: 'other', sessionId: 's2' },
    ];
    it('drops only records the reducer confirmed and nothing still needs', () => {
        const sendStates = new Map([['failed', 'failed'], ['sending', 'sending']]);
        expect(settledOutboxRecords(records, 's1', sendStates, (id) => id === 'queued')).toEqual(['confirmed']);
    });
    it('SendDeadlines.has reflects a running deadline', () => {
        const d = new SendDeadlines();
        d.start(['a'], 0);
        expect(d.has('a')).toBe(true);
        d.tick(20_000, true);
        expect(d.has('a')).toBe(false);
    });
});
