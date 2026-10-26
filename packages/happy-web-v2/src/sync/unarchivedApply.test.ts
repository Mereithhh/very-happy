import { describe, expect, it } from 'vitest';
import { rowsToDecode } from './unarchivedApply';

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
