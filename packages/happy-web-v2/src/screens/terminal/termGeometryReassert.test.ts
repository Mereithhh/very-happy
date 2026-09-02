import { describe, it, expect } from 'vitest';
import { shouldReassertGeometry } from './termGeometryReassert';

describe('shouldReassertGeometry', () => {
    const cur = { cols: 45, rows: 30 };

    it('re-asserts when this viewport is wider than the current (foreign) pane width', () => {
        // The desktop (120) returns to a pane a phone shrank to 45.
        expect(shouldReassertGeometry({ hidden: false, want: { cols: 120, rows: 40 }, current: cur })).toBe(true);
    });

    it('does nothing when the pane already matches this viewport (no width fight, no spam)', () => {
        expect(shouldReassertGeometry({ hidden: false, want: { cols: 45, rows: 30 }, current: cur })).toBe(false);
    });

    it('a hidden tab never drives the shared width', () => {
        // A backgrounded phone must not re-narrow the desktop the user now uses.
        expect(shouldReassertGeometry({ hidden: true, want: { cols: 45, rows: 30 }, current: { cols: 120, rows: 40 } })).toBe(false);
        // Even a "wider" hidden tab stays silent.
        expect(shouldReassertGeometry({ hidden: true, want: { cols: 200, rows: 50 }, current: cur })).toBe(false);
    });

    it('skips when proposeFit is null or degenerate', () => {
        expect(shouldReassertGeometry({ hidden: false, want: null, current: cur })).toBe(false);
        expect(shouldReassertGeometry({ hidden: false, want: undefined, current: cur })).toBe(false);
        expect(shouldReassertGeometry({ hidden: false, want: { cols: 1, rows: 30 }, current: cur })).toBe(false);
        expect(shouldReassertGeometry({ hidden: false, want: { cols: 120, rows: 1 }, current: cur })).toBe(false);
    });

    it('a narrower active viewport still re-asserts (the phone reflowing to itself is intended)', () => {
        // Phone (45) is active on a pane a desktop left at 120 — the phone wants
        // its own narrow width; that is the accepted "phone reflows narrow".
        expect(shouldReassertGeometry({ hidden: false, want: { cols: 45, rows: 30 }, current: { cols: 120, rows: 40 } })).toBe(true);
    });

    describe('force (explicit "refit width" button)', () => {
        it('re-sends even when already matching, so the user gets a definite effect', () => {
            expect(shouldReassertGeometry({ hidden: false, want: { cols: 45, rows: 30 }, current: cur, force: true })).toBe(true);
        });
        it('still respects hidden and a missing/degenerate proposal', () => {
            expect(shouldReassertGeometry({ hidden: true, want: { cols: 45, rows: 30 }, current: cur, force: true })).toBe(false);
            expect(shouldReassertGeometry({ hidden: false, want: null, current: cur, force: true })).toBe(false);
            expect(shouldReassertGeometry({ hidden: false, want: { cols: 1, rows: 1 }, current: cur, force: true })).toBe(false);
        });
    });
});
