import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './storageTypes';

// B-679: the CLI stamps `exitCursor` on an offline exit and the next wrapper
// replays input stored above it. A web metadata write (rename / tags) re-encodes
// the PARSED object — an undeclared key would be stripped and the message sent
// to the offline session shelved again.
describe('B-679 MetadataSchema keeps exitCursor', () => {
    const base = { path: '/p', host: 'h' };
    it('survives a parse round-trip', () => {
        const parsed = MetadataSchema.parse({ ...base, exitCursor: { at: 1, seq: 21, v: 1 } });
        expect(parsed.exitCursor).toEqual({ at: 1, seq: 21, v: 1 });
    });
    it('a malformed cursor never fails the whole metadata parse', () => {
        const parsed = MetadataSchema.parse({ ...base, exitCursor: { seq: 'x' } });
        expect(parsed.exitCursor).toBeUndefined();
        expect(parsed.path).toBe('/p');
    });
});
