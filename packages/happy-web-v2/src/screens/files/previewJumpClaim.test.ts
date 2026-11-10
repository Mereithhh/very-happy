import { describe, expect, it } from 'vitest';
import { JUMP_DEDUPE_MS, JumpLedger, previewKey } from './previewJumpClaim';

const req = { sessionId: 'b', machineId: 'm', path: '/a.md', mode: 'file' as const, fromPush: true };

describe('B-918 the same preview jumps once', () => {
    it('keys on session, machine, path, mode and intent', () => {
        expect(previewKey(req)).toBe(previewKey({ ...req }));
        expect(previewKey(req)).not.toBe(previewKey({ ...req, path: '/b.md' }));
        expect(previewKey(req)).not.toBe(previewKey({ ...req, intent: 'download' }));
    });
    it('a jump recorded after this push arrived (here or by a sibling tab) counts; an older one does not', () => {
        const l = new JumpLedger();
        const k = previewKey(req);
        expect(l.seen(k, 1000, 0)).toBe(false);
        l.mark(k, 5000);
        expect(l.seen(k, 5100, 4000)).toBe(true);    // the duplicate delivery / sibling tab
        expect(l.seen(k, 9000, 8000)).toBe(false);   // a later re-push of the same file jumps again
        expect(l.seen(k, 5000 + JUMP_DEDUPE_MS + 1, 0)).toBe(false);
    });
});
