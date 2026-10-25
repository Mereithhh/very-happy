import { describe, expect, it } from 'vitest';
import type { SyncMessage, SyncSubResultOk } from '@slopus/happy-wire';
import { applyAckBudget, buildSubResult, planSnapshot, syncMessageBytes } from './sessionSyncSnapshot';

const message = (seq: number, size = 10): SyncMessage => ({
    id: `m${seq}`, seq, content: { t: 'encrypted', c: 'x'.repeat(size) }, localId: null, createdAt: 1, updatedAt: 1,
});

describe('planSnapshot (spec §4.3)', () => {
    it('gap threshold boundary: 499 and 500 are increments, 501 is the latest page', () => {
        expect(planSnapshot(1000, 1000 - 499, 500)).toEqual({ kind: 'increment' });
        expect(planSnapshot(1000, 1000 - 500, 500)).toEqual({ kind: 'increment' });
        expect(planSnapshot(1000, 1000 - 501, 500)).toEqual({ kind: 'latest', gapTooLarge: true });
    });

    it('cold asks for the latest page; an empty session needs no statement', () => {
        expect(planSnapshot(7, null, 500)).toEqual({ kind: 'latest', gapTooLarge: false });
        expect(planSnapshot(0, null, 500)).toEqual({ kind: 'none' });
    });

    it('caught up (or ahead after a restore) answers from the head alone', () => {
        expect(planSnapshot(5, 5, 500)).toEqual({ kind: 'none' });
        expect(planSnapshot(5, 9, 500)).toEqual({ kind: 'none' });
    });
});

describe('buildSubResult', () => {
    it('none → empty, head echoed', () => {
        expect(buildSubResult('s', { kind: 'none' }, 9, null)).toEqual({ sid: 's', ok: true, headSeq: 9, messages: [], hasMore: false });
    });

    it('increment uses the snapshot head and hasMore', () => {
        const snapshot = { head: 12, messages: [message(11)], hasMore: true };
        expect(buildSubResult('s', { kind: 'increment' }, 11, snapshot)).toEqual({ sid: 's', ok: true, headSeq: 12, messages: [message(11)], hasMore: true });
    });

    it('latest page carries oldestSeq, and gapTooLarge only when it was a gap', () => {
        const snapshot = { head: 900, messages: [message(899), message(900)], hasMore: false };
        expect(buildSubResult('s', { kind: 'latest', gapTooLarge: true }, 900, snapshot)).toMatchObject({ gapTooLarge: true, oldestSeq: 899, hasMore: false });
        expect(buildSubResult('s', { kind: 'latest', gapTooLarge: false }, 900, snapshot)).not.toHaveProperty('gapTooLarge');
    });
});

describe('applyAckBudget (spec §4.4, §9.1-6)', () => {
    const inc = (sid: string, seqs: number[], size = 10): SyncSubResultOk => ({
        sid, ok: true, headSeq: seqs.at(-1) ?? 0, messages: seqs.map((s) => message(s, size)), hasMore: false,
    });

    it('leaves results that fit untouched', () => {
        const results = [inc('a', [1, 2]), inc('b', [3])];
        expect(applyAckBudget(results, 10_000)).toEqual(results);
    });

    it('cuts an increment at the tail and marks hasMore; later subs get nothing but hasMore', () => {
        const one = syncMessageBytes(message(1, 100));
        const results = [inc('a', [1, 2, 3], 100), inc('b', [4, 5], 100)];
        const out = applyAckBudget(results, one * 2 + 1);
        expect(out[0].messages.map((m) => m.seq)).toEqual([1, 2]);
        expect(out[0].hasMore).toBe(true);
        expect(out[1].messages).toEqual([]);
        expect(out[1].hasMore).toBe(true);
        // Truncated forward pages keep the snapshot head: client continues from the last seq.
        expect(out[0].headSeq).toBe(3);
    });

    it('a latest page keeps its newest messages and moves oldestSeq up', () => {
        const one = syncMessageBytes(message(10, 100));
        const page: SyncSubResultOk = { ...inc('a', [10, 11, 12], 100), oldestSeq: 10, gapTooLarge: true };
        const [out] = applyAckBudget([page], one * 2);
        expect(out.messages.map((m) => m.seq)).toEqual([11, 12]);
        expect(out.oldestSeq).toBe(11);
        expect(out.hasMore).toBe(false);
    });

    it('always ships the first message even when it alone exceeds the budget', () => {
        const [out] = applyAckBudget([inc('a', [1, 2], 2_000)], 100);
        expect(out.messages.map((m) => m.seq)).toEqual([1]);
        expect(out.hasMore).toBe(true);
    });

    it('a 512KB budget over 600KB of increments truncates at the right place', () => {
        const size = 10 * 1024;
        const seqs = Array.from({ length: 60 }, (_, i) => i + 1);
        const [out] = applyAckBudget([inc('a', seqs, size)], 512 * 1024);
        const bytes = out.messages.reduce((total, m) => total + syncMessageBytes(m), 0);
        expect(bytes).toBeLessThanOrEqual(512 * 1024);
        expect(bytes + syncMessageBytes(message(99, size))).toBeGreaterThan(512 * 1024);
        expect(out.hasMore).toBe(true);
        expect(out.messages.map((m) => m.seq)).toEqual(seqs.slice(0, out.messages.length));
    });
});
