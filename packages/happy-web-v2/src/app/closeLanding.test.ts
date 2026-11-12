import { afterEach, describe, expect, it } from 'vitest';
import { CLOSE_LANDING_WINDOW_MS, isCloseLanding, markCloseLanding, resetCloseLandingForTest } from './closeLanding';

afterEach(() => resetCloseLandingForTest());

describe('B-933 close landing mark', () => {
    it('marks only the session route it lands on, only briefly', () => {
        markCloseLanding('/session/abc%20d', 1_000);
        expect(isCloseLanding('abc d', 1_000)).toBe(true);
        expect(isCloseLanding('abc d', 1_000 + CLOSE_LANDING_WINDOW_MS)).toBe(true);
        expect(isCloseLanding('abc d', 1_001 + CLOSE_LANDING_WINDOW_MS)).toBe(false);
        expect(isCloseLanding('other', 1_000)).toBe(false);
    });
    it('a project / team / home landing clears the mark', () => {
        markCloseLanding('/session/a', 1_000);
        markCloseLanding('/projects/p', 1_100);
        expect(isCloseLanding('a', 1_100)).toBe(false);
    });
});
