import { describe, expect, it } from 'vitest';
import { scanUndeliveredQueuedInputs, type StoredRecord } from './undeliveredQueuedInputs';

function userText(seq: number, localId: string, queuedAt = 1000): StoredRecord {
    return {
        seq,
        localId,
        body: { role: 'user', content: { type: 'text', text: 'hi' }, meta: { queuedAt } },
    };
}
function turnEnd(seq: number): StoredRecord {
    return { seq, localId: null, body: { role: 'session', content: { type: 'session', data: { id: 'x', time: 1, role: 'agent', ev: { t: 'turn-end', status: 'completed' } } } } };
}
function queueCancelTombstone(seq: number, keys: string[]): StoredRecord {
    return { seq, localId: null, body: { role: 'session', content: { type: 'session', data: { id: 'x', time: 1, role: 'user', ev: { t: 'queue-cancel', targetLocalKeys: keys, reason: 'cleared' } } } } };
}
function plainText(seq: number, localId: string): StoredRecord {
    // A message with no queuedAt was sent while idle → may have been consumed.
    return { seq, localId, body: { role: 'user', content: { type: 'text', text: 'hi' } } };
}

describe('scanUndeliveredQueuedInputs (B-332 site ③)', () => {
    it('marks queued inputs above the newest turn-end as undelivered', () => {
        // Newest-first input. seq 4,5 queued after the turn-end at seq 3 →
        // undelivered. seq 1,2 (queued) are below the boundary → delivered.
        const result = scanUndeliveredQueuedInputs([
            userText(5, 'b', 5000),
            userText(4, 'a', 4000),
            turnEnd(3),
            userText(2, 'c', 2000),
            userText(1, 'd', 1000),
        ]);
        expect(result.reachedBoundary).toBe(true);
        // newest-first (input order)
        expect(result.undeliveredLocalKeys).toEqual(['b', 'a']);
    });

    it('stops at the first turn-end and does not misclassify below it', () => {
        const result = scanUndeliveredQueuedInputs([
            userText(9, 'x', 9000),
            turnEnd(8),
            plainText(7, 'y'), // no queuedAt, below boundary → ignored
        ]);
        expect(result.reachedBoundary).toBe(true);
        expect(result.undeliveredLocalKeys).toEqual(['x']);
    });

    it('respects tombstones already emitted above the boundary', () => {
        // A tombstone is always newer than its target (created after it).
        const result = scanUndeliveredQueuedInputs([
            queueCancelTombstone(6, ['a']),
            userText(5, 'a', 5000),
            turnEnd(3),
        ]);
        expect(result.reachedBoundary).toBe(true);
        expect(result.undeliveredLocalKeys).toEqual([]);
    });

    it('returns reachedBoundary=false and the caller must not send a tombstone', () => {
        const result = scanUndeliveredQueuedInputs([userText(5, 'a', 5000), userText(4, 'b', 4000)]);
        expect(result.reachedBoundary).toBe(false);
        // The scan cannot prove these were never consumed, so cancelUndeliveredQueuedInputs
        // gates its tombstone on reachedBoundary and drops anything it could not classify.
    });
});
