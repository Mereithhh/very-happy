import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './storageTypes';

const base = { path: '/repo', host: 'h' };

/**
 * B-531: the CLI waits for `metadata.forkBackfill` before sending a fork's
 * first message. A web metadata write re-encrypts the PARSED metadata, so a
 * field the schema strips is deleted from the server by a rename.
 */
describe('B-531 MetadataSchema keeps forkBackfill', () => {
    it('round-trips the wrapper marker', () => {
        const parsed = MetadataSchema.parse({ ...base, forkBackfill: { done: true, count: 95, completedAt: 1 } });
        expect(parsed.forkBackfill).toEqual({ done: true, count: 95, completedAt: 1 });
    });

    it('a malformed marker never fails the whole metadata parse', () => {
        const parsed = MetadataSchema.safeParse({ ...base, forkBackfill: 'done' });
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.path).toBe('/repo');
    });
});
