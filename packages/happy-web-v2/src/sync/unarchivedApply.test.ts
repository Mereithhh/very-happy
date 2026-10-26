import { describe, expect, it } from 'vitest';
import { decodeInChunks, rowsToDecode, UNARCHIVED_DECODE_CHUNK } from './unarchivedApply';

const row = (id: string, updatedAt = 1, metadataVersion = 1, agentStateVersion = 0) => ({ id, updatedAt, metadataVersion, agentStateVersion });

describe('rowsToDecode', () => {
    it('skips rows the store holds at the same versions; keeps unknown and newer ones', () => {
        const current = { a: row('a', 5, 2, 1), b: row('b', 5, 2, 1), c: row('c', 5, 2, 1), d: row('d', 5, 2, 1) };
        const out = rowsToDecode([
            row('a', 5, 2, 1), // same → skipped
            row('b', 6, 2, 1), // newer updatedAt
            row('c', 5, 3, 1), // newer metadata
            row('d', 5, 2, 2), // newer agentState
            row('e'), // unknown
            row('a', 4, 1, 0), // older copy → skipped
        ], current);
        expect(out.map((r) => r.id)).toEqual(['b', 'c', 'd', 'e']);
    });
});

describe('decodeInChunks', () => {
    it('decodes every row once, in order, yielding between chunks only', async () => {
        const rows = Array.from({ length: UNARCHIVED_DECODE_CHUNK * 2 + 7 }, (_, i) => i);
        const events: string[] = [];
        const out = await decodeInChunks(rows, async (chunk) => { events.push(`decode ${chunk[0]}..${chunk.at(-1)}`); return chunk.map((n) => n * 10); }, { yieldFn: async () => { events.push('yield'); } });
        expect(out).toEqual(rows.map((n) => n * 10));
        expect(events).toEqual([
            `decode 0..${UNARCHIVED_DECODE_CHUNK - 1}`,
            'yield',
            `decode ${UNARCHIVED_DECODE_CHUNK}..${UNARCHIVED_DECODE_CHUNK * 2 - 1}`,
            'yield',
            `decode ${UNARCHIVED_DECODE_CHUNK * 2}..${UNARCHIVED_DECODE_CHUNK * 2 + 6}`,
        ]);
    });

    it('nothing to decode → no decode, no yield', async () => {
        let calls = 0;
        expect(await decodeInChunks([], async () => { calls++; return []; }, { yieldFn: async () => { calls++; } })).toEqual([]);
        expect(calls).toBe(0);
    });
});
