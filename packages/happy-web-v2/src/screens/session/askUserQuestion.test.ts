/**
 * askUserQuestion helper tests — B-100: option clicks send plain user messages,
 * so the label-joining and answered-detection logic is locked down here.
 */
import { describe, expect, it } from 'vitest';
import { detectSelectedLabels, joinSelectedLabels, toggleLabel } from './askUserQuestion';

describe('joinSelectedLabels', () => {
    it('joins picked labels with 、', () => {
        expect(joinSelectedLabels(['A', 'B'])).toBe('A、B');
    });

    it('single label passes through bare', () => {
        expect(joinSelectedLabels(['only'])).toBe('only');
    });

    it('drops empty/whitespace labels', () => {
        expect(joinSelectedLabels(['A', ' ', ''])).toBe('A');
    });
});

describe('toggleLabel', () => {
    it('adds when absent, removes when present, immutably', () => {
        const start: string[] = [];
        const one = toggleLabel(start, 'x');
        expect(one).toEqual(['x']);
        expect(start).toEqual([]);
        expect(toggleLabel(one, 'x')).toEqual([]);
    });

    it('preserves pick order', () => {
        expect(toggleLabel(['b'], 'a')).toEqual(['b', 'a']);
    });
});

describe('detectSelectedLabels', () => {
    it('finds labels contained in the result text', () => {
        expect(detectSelectedLabels('User selected: Option B', ['Option A', 'Option B'])).toEqual(['Option B']);
    });

    it('prefers the longer label when one contains another', () => {
        expect(detectSelectedLabels('answer: Yes, always', ['Yes', 'Yes, always', 'No'])).toEqual(['Yes, always']);
    });

    it('empty result / no match yields empty', () => {
        expect(detectSelectedLabels('', ['A'])).toEqual([]);
        expect(detectSelectedLabels('nothing relevant', ['A'])).toEqual([]);
    });

    it('ignores undefined and blank labels', () => {
        expect(detectSelectedLabels('A picked', [undefined, ' ', 'A'])).toEqual(['A']);
    });
});
