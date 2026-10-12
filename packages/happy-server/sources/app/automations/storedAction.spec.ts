import { describe, expect, it } from 'vitest';
import { GATED_ACTION_HINT, GATED_ACTION_KIND, decodeStoredAction, encodeStoredAction, foldSkipCount, occurrenceOf, recordMerge, shouldMergeSkip } from './storedAction';

const spawn = { kind: 'spawn' as const, agent: 'claude', directory: '/repo', prompt: 'go' };
const precheck = { shell: 'test -s inbox.json', includeOutput: true };

describe('B-548 stored action', () => {
    it('stores an action without precheck byte-for-byte as before', () => {
        expect(encodeStoredAction({ action: spawn, precheck: null, skipCounts: {} })).toEqual(spawn);
        expect(decodeStoredAction(spawn)).toEqual({ action: spawn, precheck: null, skipCounts: {}, mergedInto: {} });
    });

    it('wraps a gated action so an old daemon cannot run it and an old web can still render it', () => {
        const stored = encodeStoredAction({ action: spawn, precheck, skipCounts: {} });
        // Old daemon: unknown kind → spawn branch with no agent → invalid_action. Old web: script branch reads `command`.
        expect(stored.kind).toBe(GATED_ACTION_KIND);
        expect(stored.command).toEqual(GATED_ACTION_HINT);
        expect(stored).not.toHaveProperty('agent');
        expect(stored).not.toHaveProperty('prompt');
        expect(decodeStoredAction(stored)).toEqual({ action: spawn, precheck, skipCounts: {}, mergedInto: {} });
    });

    it('keeps skip counts beside either shape and never leaks them into the action', () => {
        for (const p of [null, precheck]) {
            const stored = encodeStoredAction({ action: spawn, precheck: p, skipCounts: { r1: 3 } });
            expect(stored.skipCounts).toEqual({ r1: 3 });
            const decoded = decodeStoredAction(stored);
            expect(decoded.skipCounts).toEqual({ r1: 3 });
            expect(decoded.action).toEqual(spawn);
        }
        // Junk counts (old rows, hand edits) are dropped.
        expect(decodeStoredAction({ ...spawn, skipCounts: { a: 1, b: 'x', c: 2.5, d: 4 } }).skipCounts).toEqual({ d: 4 });
    });

    it('folds the older skip into the newest one and caps the bookkeeping', () => {
        let counts = foldSkipCount({}, 'a', 'b');
        expect(counts).toEqual({ b: 2 });
        counts = foldSkipCount(counts, 'b', 'c');
        expect(counts).toEqual({ c: 3 });
        expect(occurrenceOf(counts, 'c')).toBe(3);
        expect(occurrenceOf(counts, 'zz')).toBe(1);
        let many: Record<string, number> = {};
        for (let i = 0; i < 5; i++) many = foldSkipCount(many, `x${i}`, `y${i}`, 3);
        expect(Object.keys(many)).toEqual(['y2', 'y3', 'y4']);
    });

    it('remembers where folded runs went, one hop, capped, and never inside the action', () => {
        let m = recordMerge({}, 'a', 'b');
        m = recordMerge(m, 'b', 'c');
        expect(m).toEqual({ a: 'c', b: 'c' });
        expect(Object.keys(recordMerge({ x: 'y', z: 'w' }, 'p', 'q', 2))).toEqual(['z', 'p']);
        for (const p of [null, precheck]) {
            const decoded = decodeStoredAction(encodeStoredAction({ action: spawn, precheck: p, skipCounts: {}, mergedInto: m }));
            expect(decoded.mergedInto).toEqual(m);
            expect(decoded.action).toEqual(spawn);
        }
    });

    it('merges only consecutive non-manual skips of the same source and reason', () => {
        const prev = { status: 'skipped', error: 'precheck_failed', source: 'schedule' };
        expect(shouldMergeSkip(prev, { source: 'schedule', reason: 'precheck_failed' })).toBe(true);
        expect(shouldMergeSkip(prev, { source: 'schedule', reason: 'precheck_timeout' })).toBe(false);
        expect(shouldMergeSkip(prev, { source: 'fire', reason: 'precheck_failed' })).toBe(false);
        // Each fired event keeps its own run (payload / dedupeKey / linked sessions stay traceable).
        expect(shouldMergeSkip({ ...prev, source: 'fire' }, { source: 'fire', reason: 'precheck_failed' })).toBe(false);
        expect(shouldMergeSkip({ ...prev, status: 'done' }, { source: 'schedule', reason: 'precheck_failed' })).toBe(false);
        expect(shouldMergeSkip({ ...prev, source: 'manual' }, { source: 'manual', reason: 'precheck_failed' })).toBe(false);
        expect(shouldMergeSkip(null, { source: 'schedule', reason: 'precheck_failed' })).toBe(false);
    });
});
