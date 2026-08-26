/**
 * askUserQuestion helper tests — B-100: option clicks send plain user messages,
 * so the label-joining and answered-detection logic is locked down here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    areQuestionAnswersComplete,
    detectSelectedLabels,
    formatQuestionAnswers,
    joinSelectedLabels,
    setQuestionAnswer,
    toggleLabel,
    type AskQuestion,
} from './askUserQuestion';

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

describe('multi-question answers', () => {
    const questions: AskQuestion[] = [
        { question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second?', options: [{ label: 'C' }, { label: 'D' }], multiSelect: true },
    ];

    it('keeps sibling answers editable instead of treating the first pick as a global submit', () => {
        const first = setQuestionAnswer({}, 0, ['A']);
        expect(first).toEqual({ 0: ['A'] });
        expect(areQuestionAnswersComplete(questions, first)).toBe(false);

        const both = setQuestionAnswer(first, 1, ['C', 'D']);
        expect(both).toEqual({ 0: ['A'], 1: ['C', 'D'] });
        expect(first).toEqual({ 0: ['A'] });
        expect(areQuestionAnswersComplete(questions, both)).toBe(true);
    });

    it('submits all answers once in stable question order', () => {
        expect(formatQuestionAnswers(questions, { 0: ['B'], 1: ['C', 'D'] })).toBe('1. B\n2. C、D');
    });

    it('preserves the legacy bare-label payload for a single question', () => {
        expect(formatQuestionAnswers([questions[0]], { 0: ['A'] })).toBe('A');
    });
});

describe('multi-question component wiring', () => {
    const source = readFileSync(new URL('./AskUserQuestionView.tsx', import.meta.url), 'utf8');

    it('keeps single-option picks local until the whole form is submitted', () => {
        expect(source).toContain('else if (deferSubmit) onChange([o.label]);');
        expect(source).toContain('multi && !deferSubmit && !disabled');
        expect(source).toContain('onSubmit(formatQuestionAnswers(questions, answers))');
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
