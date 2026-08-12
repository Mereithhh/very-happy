import { describe, it, expect } from 'vitest';
import { truncateAtSentenceBoundary } from './sentenceTruncate';

describe('truncateAtSentenceBoundary', () => {
    it('returns short text untouched', () => {
        expect(truncateAtSentenceBoundary('hello world.', 100)).toEqual({
            text: 'hello world.',
            truncated: false,
        });
    });

    it('text exactly at the limit is not truncated', () => {
        const text = 'a'.repeat(50);
        expect(truncateAtSentenceBoundary(text, 50)).toEqual({ text, truncated: false });
    });

    it('cuts at the last sentence ender within budget (latin)', () => {
        const text = 'First sentence. Second sentence. Third one that overflows the budget';
        const out = truncateAtSentenceBoundary(text, 40);
        expect(out.truncated).toBe(true);
        expect(out.text).toBe('First sentence. Second sentence.');
    });

    it('cuts at CJK sentence enders', () => {
        const text = '第一句话。第二句话。第三句话会超出预算了';
        const out = truncateAtSentenceBoundary(text, 12);
        expect(out.truncated).toBe(true);
        expect(out.text).toBe('第一句话。第二句话。');
    });

    it('keeps a closing quote that trails the ender', () => {
        const text = '他说「好的。」然后又补充了很多很多别的话',
            out = truncateAtSentenceBoundary(text, 10);
        expect(out.truncated).toBe(true);
        expect(out.text).toBe('他说「好的。」');
    });

    it('falls back to the last space when no sentence ender fits', () => {
        const text = 'one two three four five six seven eight';
        const out = truncateAtSentenceBoundary(text, 20);
        expect(out.truncated).toBe(true);
        expect(out.text).toBe('one two three four');
        expect(out.text.length).toBeLessThanOrEqual(20);
    });

    it('hard-cuts an unbroken run with no punctuation or spaces', () => {
        const text = '这是一段完全没有标点的很长很长的内容一直在继续继续继续';
        const out = truncateAtSentenceBoundary(text, 10);
        expect(out.truncated).toBe(true);
        expect(out.text).toHaveLength(10);
    });

    it('never returns more than maxChars', () => {
        const samples = [
            'First sentence. Second sentence. Third.',
            '第一句。第二句。第三句。',
            'no punctuation here just words '.repeat(20),
            'x'.repeat(500),
        ];
        for (const text of samples) {
            for (const max of [10, 50, 100]) {
                expect(truncateAtSentenceBoundary(text, max).text.length).toBeLessThanOrEqual(max);
            }
        }
    });
});
