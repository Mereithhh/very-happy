import { describe, expect, it } from 'vitest';
import {
    checkCacheAnchor,
    extendDownward,
    extendUpward,
    newestRows,
    validateSegment,
} from './segment';
import { CACHE_MAX_BYTES, pickEvictions, pickQuotaEvictions } from './lru';

const r = (seq: number, id = `m${seq}`) => ({ seq, id });
const run = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => r(from + i));
const seqs = (rows: Array<{ seq: number }>) => rows.map((row) => row.seq);
const valid = () => true;

describe('B-813 segment rules (spec r1)', () => {
    it('newestRows: sorted, deduped, the newest 300 — holes kept', () => {
        expect(seqs(newestRows([r(5), r(3), r(1), r(3)]))).toEqual([1, 3, 5]);
        expect(seqs(newestRows(run(1, 400)))).toEqual(seqs(run(101, 400)));
    });

    it('extendUpward: points only as lastSeq+1; a range reaching the run covers its max across holes', () => {
        expect(extendUpward(3, [r(5), r(4), r(7), r(2)])).toMatchObject({ append: [r(4), r(5)], cover: 5, waiting: [r(7)] });
        expect(extendUpward(3, [r(5)])).toMatchObject({ append: [], cover: 3, waiting: [r(5)] });
        expect(extendUpward(3, [], [{ afterSeq: 3, rows: [r(5), r(9)] }])).toMatchObject({ append: [r(5), r(9)], cover: 9, waitingRanges: [] });
        // a range starting above the run waits; a point bridging to it lets it in
        expect(extendUpward(3, [], [{ afterSeq: 4, rows: [r(6)] }])).toMatchObject({ append: [], cover: 3, waitingRanges: [{ afterSeq: 4, rows: [r(6)] }] });
        expect(extendUpward(3, [r(4)], [{ afterSeq: 4, rows: [r(6)] }])).toMatchObject({ append: [r(4), r(6)], cover: 6 });
    });

    it('extendDownward: an older page that reaches the run, nearest rows first, within the room left', () => {
        expect(seqs(extendDownward(10, [r(2), r(5), r(9)], 10, 2))).toEqual([5, 9]);
        expect(seqs(extendDownward(10, [r(2), r(5)], 8, 5))).toEqual([]); // does not reach 10
        expect(extendDownward(10, run(1, 9), 10, 0)).toEqual([]);
    });

    it('validateSegment: §5.4.2 (r1) — schema, out of range, duplicate, too many rows; fewer rows is fine', () => {
        const info = { oldestSeq: 1, lastSeq: 12, count: 9 };
        const holey = run(1, 12).filter((row) => ![3, 7, 11].includes(row.seq));
        expect(validateSegment(info, holey, valid)).toEqual({ ok: true });
        expect(validateSegment(info, holey, (row) => row.seq !== 2)).toEqual({ ok: false, reason: 'schema' });
        expect(validateSegment(info, [r(1), r(13)], valid)).toEqual({ ok: false, reason: 'range' });
        expect(validateSegment(info, [r(2), r(2)], valid)).toEqual({ ok: false, reason: 'duplicate' });
        expect(validateSegment({ oldestSeq: 1, lastSeq: 3, count: 3 }, run(1, 3), valid, { inRange: 4, total: 4 })).toEqual({ ok: false, reason: 'range' });
        expect(validateSegment(info, holey, valid, { inRange: 9, total: 10 })).toEqual({ ok: false, reason: 'range' });
        expect(validateSegment({ oldestSeq: 5, lastSeq: 3, count: 0 }, [], valid)).toEqual({ ok: false, reason: 'range' });
        // spec r2: the rows we wrote are all still there — one lost locally is corruption, a server hole is not
        expect(validateSegment(info, holey.filter((row) => row.seq !== 5), valid)).toEqual({ ok: false, reason: 'count' });
        expect(validateSegment({ ...info, count: 8 }, holey.filter((row) => row.seq !== 5), valid)).toEqual({ ok: true });
    });

    it('checkCacheAnchor: §5.4.2 rows 5–6', () => {
        expect(checkCacheAnchor([r(9), r(10), r(11)], 10, 'm10')).toBe('ok');
        expect(checkCacheAnchor([], 10, 'm10')).toBe('behind');
        expect(checkCacheAnchor([r(9)], 10, 'm10')).toBe('behind');
        expect(checkCacheAnchor([r(10, 'other')], 10, 'm10')).toBe('mismatch');
    });
});

describe('B-813 LRU picks', () => {
    const entry = (sid: string, lastAccessAt: number, bytes = 1) => ({ sid, lastAccessAt, bytes });

    it('oldest-viewed first until both limits hold, skipping protected sessions', () => {
        const entries = [entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4)];
        expect(pickEvictions(entries, () => false, { maxSessions: 2, maxBytes: 100 })).toEqual(['a', 'b']);
        expect(pickEvictions(entries, (sid) => sid === 'a', { maxSessions: 2, maxBytes: 100 })).toEqual(['b', 'c']);
        expect(pickEvictions(entries, () => false, { maxSessions: 10, maxBytes: 100 })).toEqual([]);
    });

    it('the 40MB budget evicts even below 30 sessions', () => {
        const big = CACHE_MAX_BYTES / 2;
        expect(pickEvictions([entry('a', 1, big), entry('b', 2, big), entry('c', 3, big)], () => false)).toEqual(['a']);
    });

    it('quota: the older half of the droppable sessions', () => {
        const entries = [entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4), entry('e', 5)];
        expect(pickQuotaEvictions(entries, (sid) => sid === 'a')).toEqual(['b', 'c']);
    });
});
