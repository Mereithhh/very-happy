import { describe, expect, it } from 'vitest';
import { advanceInboundCursor } from './inboundCursor';

describe('advanceInboundCursor (B-806)', () => {
    it('moves through a contiguous run of handled seqs', () => {
        const handled = new Set([11, 12]);
        expect(advanceInboundCursor(10, handled)).toEqual({ next: 12, gap: false });
        expect(handled.size).toBe(0);
    });

    it('holds at a gap: our ack for N+1 does not skip an unseen N', () => {
        const handled = new Set([12]);
        expect(advanceInboundCursor(10, handled)).toEqual({ next: 10, gap: true });
        expect([...handled]).toEqual([12]);
        // N=11 routed → the held seq is consumed.
        expect(advanceInboundCursor(11, handled)).toEqual({ next: 12, gap: false });
    });

    it('drops seqs at or below the cursor', () => {
        const handled = new Set([3, 9, 15]);
        expect(advanceInboundCursor(9, handled)).toEqual({ next: 9, gap: true });
        expect([...handled]).toEqual([15]);
    });
});
