import { describe, expect, it } from 'vitest';
import { sortIncomingBySeq } from './messageOrder';
import { resolvePlanModeFromBatch } from './planModeBatch';
import type { NormalizedMessage } from './typesRaw';

function m(seq: number | null | undefined, id: string): { seq?: number | null; id: string } {
    return seq === undefined ? { id } : { seq, id };
}

describe('sortIncomingBySeq (B-261)', () => {
    it('sorts a fully seq-carrying DESC batch ascending, stably', () => {
        const batch = [m(13, 'd'), m(12, 'c'), m(12, 'c2'), m(10, 'a')];
        const sorted = sortIncomingBySeq(batch);
        expect(sorted.map((x) => x.id)).toEqual(['a', 'c', 'c2', 'd']);
        expect(batch.map((x) => x.id)).toEqual(['d', 'c', 'c2', 'a']); // input untouched
    });

    it('returns the same reference when already sorted', () => {
        const batch = [m(1, 'a'), m(2, 'b')];
        expect(sortIncomingBySeq(batch)).toBe(batch);
    });

    it('never reorders a mixed batch (optimistic messages have no seq — arrival order IS the order)', () => {
        const withNull = [m(9, 'b'), m(null, 'opt'), m(8, 'a')];
        expect(sortIncomingBySeq(withNull)).toBe(withNull);
        const withMissing = [m(9, 'b'), m(undefined, 'opt'), m(8, 'a')];
        expect(sortIncomingBySeq(withMissing)).toBe(withMissing);
    });
});

function planTool(name: string, seq: number): NormalizedMessage {
    return {
        id: `msg-${name}-${seq}`,
        localId: null,
        createdAt: seq * 100,
        seq,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'tool-call',
            id: `tool-${name}-${seq}`,
            name,
            input: {},
            description: null,
            uuid: `uuid-${seq}`,
            parentUUID: null,
        }],
    } as NormalizedMessage;
}

describe('resolvePlanModeFromBatch + sortIncomingBySeq (history replay must not re-enter plan mode)', () => {
    it('an ordered Enter→Exit replay resolves to false', () => {
        expect(resolvePlanModeFromBatch([planTool('EnterPlanMode', 8), planTool('ExitPlanMode', 9)])).toBe(false);
    });

    it('a DESC backfill page [Exit, Enter] read raw would re-enter plan mode; sorted it does not', () => {
        const descPage = [planTool('ExitPlanMode', 9), planTool('EnterPlanMode', 8)];
        expect(resolvePlanModeFromBatch(descPage)).toBe(true); // the bug shape
        expect(resolvePlanModeFromBatch(sortIncomingBySeq(descPage))).toBe(false);
    });

    it('a live Enter without Exit resolves to true', () => {
        expect(resolvePlanModeFromBatch(sortIncomingBySeq([planTool('EnterPlanMode', 5)]))).toBe(true);
    });
});
