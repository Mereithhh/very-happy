/**
 * codeCollapse tests — B-097 (code block clamp) / B-102 (user bubble clamp).
 * The transcript must never CLIP content invisibly: collapse decisions are
 * pure and locked down here.
 */
import { describe, expect, it } from 'vitest';
import {
    BUBBLE_VISIBLE_LINES,
    CODE_VISIBLE_LINES,
    countLines,
    estimateWrappedLines,
    shouldCollapse,
    shouldCollapseBubble,
    shouldCollapseCode,
} from './codeCollapse';

describe('countLines', () => {
    it('counts newline-separated lines', () => {
        expect(countLines('a')).toBe(1);
        expect(countLines('a\nb\nc')).toBe(3);
    });

    it('empty string is 0 lines', () => {
        expect(countLines('')).toBe(0);
    });

    it('trailing newline counts as an extra (empty) line, matching rendering', () => {
        expect(countLines('a\n')).toBe(2);
    });
});

describe('estimateWrappedLines', () => {
    it('short lines count as 1 each', () => {
        expect(estimateWrappedLines('a\nb')).toBe(2);
    });

    it('long paragraphs wrap into multiple visual lines', () => {
        expect(estimateWrappedLines('x'.repeat(400), 80)).toBe(5);
    });

    it('empty source lines still occupy one visual line', () => {
        expect(estimateWrappedLines('a\n\nb')).toBe(3);
    });

    it('empty string is 0', () => {
        expect(estimateWrappedLines('')).toBe(0);
    });
});

describe('shouldCollapse (slack keeps tiny overflows visible)', () => {
    it('does not collapse at or just over the threshold', () => {
        expect(shouldCollapse(10, 10)).toBe(false);
        expect(shouldCollapse(14, 10, 4)).toBe(false);
    });

    it('collapses once past threshold + slack', () => {
        expect(shouldCollapse(15, 10, 4)).toBe(true);
    });
});

describe('code / bubble presets', () => {
    it('code: under-cap blocks render fully', () => {
        expect(shouldCollapseCode(CODE_VISIBLE_LINES)).toBe(false);
        expect(shouldCollapseCode(CODE_VISIBLE_LINES + 5)).toBe(false);
    });

    it('code: clearly-over blocks collapse', () => {
        expect(shouldCollapseCode(CODE_VISIBLE_LINES + 6)).toBe(true);
        expect(shouldCollapseCode(500)).toBe(true);
    });

    it('bubble: ~10-line messages stay whole, long ones collapse', () => {
        expect(shouldCollapseBubble(BUBBLE_VISIBLE_LINES)).toBe(false);
        expect(shouldCollapseBubble(BUBBLE_VISIBLE_LINES + 4)).toBe(false);
        expect(shouldCollapseBubble(BUBBLE_VISIBLE_LINES + 5)).toBe(true);
    });
});
