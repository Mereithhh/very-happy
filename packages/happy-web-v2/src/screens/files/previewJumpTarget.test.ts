import { describe, expect, it } from 'vitest';
import { previewJumpTarget, type PreviewSourceInfo } from './previewPinTarget';

const rows: Record<string, PreviewSourceInfo> = {
    b: { machineId: 'm', archived: false, shared: false },
    other: { machineId: 'm2', archived: false, shared: false },
    old: { machineId: 'm', archived: true, shared: false },
    theirs: { machineId: 'm', archived: false, shared: true },
};
const source = (id: string) => rows[id];
const push = { sessionId: 'b', machineId: 'm', path: '/w/a.md', mode: 'file' as const, fromPush: true };

describe('B-918 a preview pushed by another session takes you to that session', () => {
    it('from session A on the SAME machine it goes to B (no longer docks into A)', () => {
        expect(previewJumpTarget(push, '/session/a', source)).toBe('/session/b?panel=browse&pinFile=%2Fw%2Fa.md&pinSource=push');
    });
    it('from any non-session page too', () => {
        for (const page of ['/', '/board', '/terminal/m', '/settings/channels']) {
            expect(previewJumpTarget(push, page, source), page).toBe('/session/b?panel=browse&pinFile=%2Fw%2Fa.md&pinSource=push');
        }
    });
    it('lands on B without docking when another machine serves the file', () => {
        expect(previewJumpTarget({ ...push, sessionId: 'other' }, '/session/a', source)).toBe('/session/other');
    });
    it('does not jump: already in B, machine/terminal push, unknown / archived / shared source, or opened by you', () => {
        expect(previewJumpTarget(push, '/session/b', source)).toBeNull();
        expect(previewJumpTarget(push, '/session/b/', source)).toBeNull();
        expect(previewJumpTarget({ ...push, sessionId: undefined }, '/session/a', source)).toBeNull();
        expect(previewJumpTarget({ ...push, sessionId: 'gone' }, '/session/a', source)).toBeNull();
        expect(previewJumpTarget({ ...push, sessionId: 'old' }, '/session/a', source)).toBeNull();
        expect(previewJumpTarget({ ...push, sessionId: 'theirs' }, '/session/a', source)).toBeNull();
        expect(previewJumpTarget({ ...push, fromPush: false }, '/session/a', source)).toBeNull();
    });
});
