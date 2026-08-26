import { describe, expect, it } from 'vitest';
import { ReleaseDrainNoticeSchema } from './releaseProtocol';

describe('ReleaseDrainNoticeSchema', () => {
    it('accepts only immutable releases and fixed deployment slots', () => {
        const notice = {
            epoch: 'release-1234',
            fromRelease: 'a'.repeat(40),
            toRelease: 'b'.repeat(40),
            candidateSlot: 'green',
            deadline: Date.now() + 60_000,
            mode: 'make-before-break',
        };
        expect(ReleaseDrainNoticeSchema.parse(notice)).toEqual(notice);
        expect(() => ReleaseDrainNoticeSchema.parse({ ...notice, candidateSlot: 'http://example.com' })).toThrow();
        expect(() => ReleaseDrainNoticeSchema.parse({ ...notice, toRelease: 'latest' })).toThrow();
    });
});
