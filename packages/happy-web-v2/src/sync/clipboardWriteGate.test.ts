import { describe, it, expect } from 'vitest';
import { canAttemptDirectWrite } from './clipboardWriteGate';

const doc = (visibilityState: string, focused: boolean) =>
    ({ visibilityState, hasFocus: () => focused }) as Pick<Document, 'visibilityState' | 'hasFocus'>;

describe('canAttemptDirectWrite', () => {
    it('allows the silent write path only when visible AND focused', () => {
        expect(canAttemptDirectWrite(doc('visible', true))).toBe(true);
    });

    it('rejects the prod-repro state: hidden document that still reports hasFocus()', () => {
        // macOS Chrome, active tab of a fully occluded window: hasFocus() stays
        // true while visibilityState is 'hidden' — writeText then resolves
        // WITHOUT writing to the OS pasteboard. Must go to the Modal path.
        expect(canAttemptDirectWrite(doc('hidden', true))).toBe(false);
    });

    it('rejects a visible but unfocused document', () => {
        expect(canAttemptDirectWrite(doc('visible', false))).toBe(false);
    });

    it('rejects a hidden unfocused document', () => {
        expect(canAttemptDirectWrite(doc('hidden', false))).toBe(false);
    });

    it('rejects when document is unavailable (SSR/non-DOM)', () => {
        expect(canAttemptDirectWrite(undefined)).toBe(false);
    });
});
